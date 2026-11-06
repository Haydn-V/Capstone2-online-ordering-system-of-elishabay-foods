<?php
declare(strict_types=1);

/** GET /api/reports/transactions.php (needs sales.report) lists orders placed and verified Net payments received in the range as one ledger, sorted and paged together in SQL so it explains the Sales Report's revenue. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('sales.report');

$q      = $_GET;
$paging = Validate::paging($q, 10, 200);

/* Orders filter by order date, payments by paid date. */
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

/* Both halves share one shape for the UNION; sort_at orders them (payments sort from the start of their day, with id as tie-breaker). */
/* Every literal and cast uses the schema's collation, otherwise the UNION fails with "Illegal mix of collations". */
$col = 'COLLATE utf8mb4_unicode_ci';

$union = "
    SELECT 'order' $col AS kind, o.id AS ref, o.date AS d,
           o.datetime AS sort_at, o.customer_name AS who, " . Payments::dueSql('o') . " AS amount,
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

/* Line items for this page's orders in one grouped lookup. */
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

    /* Net orders keep their "₱X received so far" line, linking them to their payment rows. */
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
            /* Prefix payment ids so they cannot be confused with order ids. */
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
