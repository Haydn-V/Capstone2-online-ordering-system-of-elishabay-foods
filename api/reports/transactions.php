<?php
declare(strict_types=1);

/**
 * GET /api/reports/transactions.php?from=&to=&page=1&limit=10
 *
 * Requires sales.report.
 *
 * THE LEDGER BEHIND THE SALES REPORT'S REVENUE FIGURE.
 *
 * "Transactions in Period" used to be orders/list.php filtered by order date,
 * which told only half the story once Net 30/60/90 terms existed. Revenue is
 * counted when the money arrives (api/core/Revenue.php), so a retailer paying
 * ₱25,629 against a July order raised September's revenue while September's
 * transaction list showed nothing at all — the takings appeared to come from
 * nowhere, and nobody could point at the row that explained them.
 *
 * So this endpoint returns BOTH kinds of event, on one clock — the date the
 * thing happened:
 *
 *   kind "order"   — an order placed in the range, whatever its status. The
 *                    list is activity, not only revenue: a cancelled order is
 *                    something that happened and the reader has to see it to
 *                    reconcile the day.
 *   kind "payment" — a VERIFIED, non-legacy payment toward a Net account,
 *                    dated by paid_date. The same rows reports/sales.php adds
 *                    to revenue, so the list and the total cannot disagree.
 *
 * Legacy payments are excluded here exactly as they are from dated revenue:
 * when that money arrived was never recorded, so it belongs to no period.
 *
 * PAGED OVER THE UNION, NOT OVER EACH HALF. Merging a page of orders with a
 * list of payments in the browser would repeat the mistake this codebase has
 * made twice already — a filter applied to one page answers for that page
 * only. The union is sorted and paged in SQL, so page 3 means page 3 of the
 * period rather than page 3 of the orders plus whatever payments happened to
 * be loaded.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('sales.report');

$q      = $_GET;
$paging = Validate::paging($q, 10, 200);

/* Both halves take the same range, each against its own date column: an order
   by the day it was placed, a payment by the day it was paid. */
$orderWhere  = ['1=1'];
$orderParams = [];
$payWhere    = [Revenue::creditClause('cp')[0]];
$payParams   = [];

foreach (['from' => '>=', 'to' => '<='] as $key => $op) {
    $value = trim((string) ($q[$key] ?? ''));
    if ($value === '') {
        continue;
    }
    $d = DateTime::createFromFormat('Y-m-d', $value);
    if (!$d || $d->format('Y-m-d') !== $value) {
        Response::validation('Check the date range.', [$key => 'Use YYYY-MM-DD.']);
    }
    $orderWhere[]  = "o.date $op ?";
    $orderParams[] = $value;
    $payWhere[]    = "cp.paid_date $op ?";
    $payParams[]   = $value;
}

$orderSql = implode(' AND ', $orderWhere);
$paySql   = implode(' AND ', $payWhere);

/* One shape for both halves so they can be UNIONed. `sort_at` is the instant
   the row is ordered by — an order has a datetime, a payment has only the date
   it was paid for, so the payment sorts from the start of its day and the
   id breaks any remaining tie. */
/* EVERY LITERAL AND CAST CARRIES THE SCHEMA'S COLLATION.
   The columns are utf8mb4_unicode_ci (db/schema.sql), while a bare literal
   and a CAST(... AS CHAR) arrive in the CONNECTION's collation — so a UNION of
   the two is refused outright with "Illegal mix of collations", and the whole
   report 500s. Spelled out rather than left to the connection, which differs
   between the PHP client and the command line. */
$col = 'COLLATE utf8mb4_unicode_ci';

$union = "
    SELECT 'order' $col AS kind, o.id AS ref, o.date AS d,
           o.datetime AS sort_at, o.customer_name AS who, o.total AS amount,
           o.method AS method, o.status AS status, o.type AS otype,
           NULL AS scheme, NULL AS order_ref
      FROM orders o
     WHERE $orderSql
    UNION ALL
    SELECT 'payment' $col, CAST(cp.id AS CHAR) $col, cp.paid_date,
           CAST(cp.paid_date AS DATETIME), pa.name, cp.amount,
           cp.method, 'verified' $col, NULL,
           pa.scheme, pa.order_id
      FROM credit_payments cp
      JOIN payment_accounts pa ON pa.id = cp.account_id
     WHERE $paySql";

$allParams = array_merge($orderParams, $payParams);

$total = (int) Database::scalar("SELECT COUNT(*) FROM ($union) x", $allParams);

$rows = Database::all(
    "SELECT * FROM ($union) x
      ORDER BY x.d DESC, x.sort_at DESC, x.ref DESC
      LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $allParams
);

/* Line items for the ORDER rows on this page only — the same grouped lookup
   orders/list.php does, rather than a query per row. */
$orderIds = array_values(array_unique(array_map(
    static fn(array $r): string => (string) $r['ref'],
    array_filter($rows, static fn(array $r): bool => $r['kind'] === 'order')
)));

$itemsByOrder = [];
$creditByOrder = [];
if ($orderIds !== []) {
    $ph = implode(',', array_fill(0, count($orderIds), '?'));
    foreach (Database::all(
        "SELECT oi.order_id, oi.qty, p.name
           FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN ($ph) ORDER BY oi.id",
        $orderIds
    ) as $it) {
        $itemsByOrder[$it['order_id']][] = ['name' => $it['name'], 'qty' => (int) $it['qty']];
    }

    /* A Net order keeps the "₱X received so far" line it has on every other
       order screen — which is now also the link between this order row and the
       payment rows that settle it. */
    $rate = Payments::penaltyRate();
    foreach (Database::all(Payments::accountSelect() . " WHERE pa.order_id IN ($ph)", $orderIds) as $cr) {
        $acct = Payments::describeAccount($cr, $rate);
        $creditByOrder[$acct['orderId']] = Payments::creditSummary($acct);
    }
}

$out = array_map(static function (array $r) use ($itemsByOrder, $creditByOrder): array {
    if ($r['kind'] === 'payment') {
        return [
            'kind'      => 'payment',
            /* Prefixed so it cannot be mistaken for an order reference in a
               column headed "TX ID" — and so the two halves of the ledger
               cannot collide on a bare integer. */
            'id'        => 'PAY-' . str_pad((string) $r['ref'], 4, '0', STR_PAD_LEFT),
            'paymentId' => (int) $r['ref'],
            'customer'  => $r['who'],
            'orderId'   => $r['order_ref'],
            'scheme'    => $r['scheme'],
            'total'     => round((float) $r['amount'], 2),
            'payMethod' => $r['method'],
            'date'      => $r['d'],
            'items'     => [],
            'status'    => 'completed',
            'type'      => 'payment',
            'credit'    => null,
        ];
    }

    return [
        'kind'      => 'order',
        'id'        => $r['ref'],
        'customer'  => $r['who'],
        'orderId'   => null,
        'scheme'    => null,
        'total'     => round((float) $r['amount'], 2),
        'payMethod' => $r['method'],
        'date'      => $r['d'],
        'items'     => $itemsByOrder[$r['ref']] ?? [],
        'status'    => $r['status'],
        'type'      => $r['otype'],
        'credit'    => $creditByOrder[$r['ref']] ?? null,
    ];
}, $rows);

Response::ok($out, [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / max(1, $paging['limit'])),
]);
