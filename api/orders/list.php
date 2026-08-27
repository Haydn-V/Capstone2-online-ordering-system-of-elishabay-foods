<?php
declare(strict_types=1);

/**
 * GET /api/orders/list.php
 *
 * Query: ?page=1&limit=25&status=&type=online|walk-in&customer_type=
 *        &search=&from=&to&pay_verified=0|1&sort=newest|oldest|total
 *
 * Requires orders.view or transactions.view — the same list backs the Order
 * Queue, Online Transactions and Transaction History screens, which different
 * roles reach.
 *
 * Line items ARE included, because every order screen renders item chips — but
 * fetched in ONE grouped query for the whole page rather than one per row.
 * A 25-row page costs 3 queries (count, orders, items) instead of 27.
 *
 * Item shape is { id, qty, price, name } where `id` is the product id: 23 call
 * sites across orders.js, engine.js and pos.js already read `it.id` and
 * `it.qty`, and changing the key name would be churn for no gain.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* The Scope's one-hour auto-complete rides here.

   XAMPP has no scheduler, so the rule runs opportunistically on any request
   that lists orders. Orders::sweepIfDue() throttles itself to once every five
   minutes and never throws — a background rule must not turn somebody's order
   list into a 500. api/system/auto-complete.php calls the same function for a
   real deployment with Task Scheduler. */
Orders::sweepIfDue();
Rbac::requireAny('orders.view', 'transactions.view', 'orders.accept', 'orders.status');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

/* Accepts one status or a comma-separated set, so the Queue screen can ask for
   pending,accepted,on-hold in a single request. Each value is checked against
   the known set and bound individually — never interpolated. */
$statusIn = trim((string) ($q['status'] ?? ''));
if ($statusIn !== '' && $statusIn !== 'all') {
    $valid = ['pending','on-hold','accepted','shipping','delivered','completed','cancelled'];
    $wanted = array_values(array_intersect(array_map('trim', explode(',', $statusIn)), $valid));
    if (!$wanted) {
        Response::validation('Unknown status filter.', ['status' => 'Not a valid order status.']);
    }
    $where[] = 'o.status IN (' . implode(',', array_fill(0, count($wanted), '?')) . ')';
    $params = array_merge($params, $wanted);
}

if (!empty($q['type']) && in_array($q['type'], ['online', 'walk-in'], true)) {
    $where[] = 'o.type = ?';
    $params[] = $q['type'];
}

if (!empty($q['customer_type']) && in_array($q['customer_type'], ['regular', 'retailer'], true)) {
    $where[] = 'o.customer_type = ?';
    $params[] = $q['customer_type'];
}

if (isset($q['pay_verified']) && $q['pay_verified'] !== '') {
    $where[] = 'o.pay_verified = ?';
    $params[] = $q['pay_verified'] ? 1 : 0;
}

/* Whether a payment proof has been uploaded. The Payment Verification screen
   only shows orders that have something to verify; without this filter the
   count said "5 entries" while four cards rendered, because the fifth had no
   proof and the client skipped it. A count that disagrees with what is on
   screen is worse than either number alone. */
if (isset($q['proof_uploaded']) && $q['proof_uploaded'] !== '') {
    $where[] = 'o.proof_uploaded = ?';
    $params[] = $q['proof_uploaded'] ? 1 : 0;
}

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(o.id LIKE ? OR o.customer_name LIKE ? OR o.email LIKE ? OR o.proof_ref_num LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like, $like);
}

/* Date range on the order date. Validated rather than passed through — a
   malformed date would otherwise silently match nothing and look like "no
   orders that week". */
foreach (['from' => '>=', 'to' => '<='] as $key => $op) {
    if (!empty($q[$key])) {
        $d = DateTime::createFromFormat('Y-m-d', $q[$key]);
        if (!$d || $d->format('Y-m-d') !== $q[$key]) {
            Response::validation('Check the date range.', [$key => 'Use YYYY-MM-DD.']);
        }
        $where[] = "o.date $op ?";
        $params[] = $q[$key];
    }
}

$sortMap = [
    'newest' => 'o.datetime DESC',
    'oldest' => 'o.datetime ASC',
    'total'  => 'o.total DESC',
];
$order = $sortMap[$q['sort'] ?? 'newest'] ?? $sortMap['newest'];

$sql = 'FROM orders o';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

/* Revenue across the WHOLE filtered set, not just this page.

   The Transaction History screen shows "matching orders" and "total revenue"
   above the table. While paging was client-side those figures were correct
   because the browser held every row; moving to server paging without this
   would silently reduce them to a per-page sum — a stat that looks right and
   quietly under-reports. Cancelled orders are excluded, as everywhere else. */
/* Per-status counts for the tab badges.

   The Queue, Payment Verification and Order Status screens each show a row of
   tabs with a count on every one — "Pending 4", "On Hold 1". Those counts are
   for the WHOLE set, not the current page, so paging the rows without them
   would leave every badge showing at most the page size. Computed in one
   grouped query against the same filters, minus the status filter itself
   (a tab row that only counted the selected tab would be pointless). */
$countWhere  = [];
$countParams = [];
foreach ($where as $i => $clause) {
    if (str_starts_with($clause, 'o.status IN')) { continue; }
    $countWhere[] = $clause;
}
/* Rebuild params in step with the retained clauses. */
if ($countWhere !== $where) {
    $countParams = [];
    $skip = $statusIn !== '' && $statusIn !== 'all' ? count(explode(',', $statusIn)) : 0;
    $countParams = array_slice($params, $skip);
} else {
    $countParams = $params;
}
$countSql = 'FROM orders o' . ($countWhere ? ' WHERE ' . implode(' AND ', $countWhere) : '');
$statusCounts = [];
foreach (Database::all("SELECT o.status, COUNT(*) AS n $countSql GROUP BY o.status", $countParams) as $c) {
    $statusCounts[$c['status']] = (int) $c['n'];
}

/* D2 — the same constant the Sales Report uses, so the two figures cannot
   drift apart.

   The revenue placeholders are APPENDED to $params, matching the order they
   appear in the statement: $sql's own conditions come first, then the status
   clause bolted on after. Reusing $params alone left the statement with more
   placeholders than values and every order list answered
   "SQLSTATE[HY093]: Invalid parameter number". */
[$revClause, $revParams] = Revenue::clause('o');
$revenueSql    = $sql . ($where ? " AND $revClause" : " WHERE $revClause");
$revenueParams = array_merge($params, $revParams);
$filteredRevenue = (float) Database::scalar("SELECT COALESCE(SUM(o.total),0) $revenueSql", $revenueParams);

$rows = Database::all(
    "SELECT o.id, o.customer_id, o.customer_name, o.email, o.contact, o.address,
            o.type, o.order_type, o.customer_type, o.method, o.total,
            o.date, o.datetime, o.status, o.notes,
            o.pay_verified, o.proof_uploaded, o.proof_ref_num, o.proof_image_path,
            o.proof_amount,
            o.cashier, o.batch_code_hint, o.tracking_number, o.delivered_at,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi WHERE oi.order_id = o.id) AS unit_count
     $sql
     ORDER BY $order
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

/* One grouped fetch of every line item for the orders on this page. Keyed by
   order id so the mapping below is a lookup rather than a query. */
$itemsByOrder = [];
$orderIds = array_column($rows, 'id');
if ($orderIds !== []) {
    $placeholders = implode(',', array_fill(0, count($orderIds), '?'));
    $itemRows = Database::all(
        "SELECT oi.order_id, oi.product_id, oi.qty, oi.price_at_purchase, p.name
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN ($placeholders)
          ORDER BY oi.id",
        $orderIds
    );
    foreach ($itemRows as $it) {
        $itemsByOrder[$it['order_id']][] = [
            'id'    => $it['product_id'],
            'name'  => $it['name'],
            'qty'   => (int) $it['qty'],
            'price' => (float) $it['price_at_purchase'],
        ];
    }
}

Response::ok(array_map(static fn(array $r): array => [
    'id'            => $r['id'],
    'customerId'    => $r['customer_id'],
    'customer'      => $r['customer_name'],
    'email'         => $r['email'],
    'contact'       => $r['contact'],
    'address'       => $r['address'],
    'type'          => $r['type'],
    'orderType'     => $r['order_type'],
    'customerType'  => $r['customer_type'],
    'payMethod'     => $r['method'],
    'total'         => (float) $r['total'],
    'date'          => $r['date'],
    'datetime'      => $r['datetime'],
    'status'        => $r['status'],
    'notes'         => $r['notes'],
    'payVerified'   => (bool) $r['pay_verified'],
    'proof'         => [
        'uploaded' => (bool) $r['proof_uploaded'],
        'refNum'   => $r['proof_ref_num'],
        /* The customer's uploaded screenshot, as an application-root-relative
           path. Payment Verification rendered the words "Proof Uploaded" and a
           reference number and had no image element at all — there was nothing
           to render, because nothing could be uploaded. */
        'image'    => $r['proof_image_path'],
        'amount'   => (float) $r['proof_amount'],
    ],
    'cashier'       => $r['cashier'],
    'batch'         => $r['batch_code_hint'],
    /* Proof of dispatch. The courier is not integrated (a stated Limitation);
       this is the number staff quote and the customer takes to the courier. */
    'trackingNumber'=> $r['tracking_number'],
    'deliveredAt'   => $r['delivered_at'],
    'itemCount'     => (int) $r['item_count'],
    'unitCount'     => (int) $r['unit_count'],
    /* Never null — every renderer maps over this without checking. */
    'items'         => $itemsByOrder[$r['id']] ?? [],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
    'revenue' => round($filteredRevenue, 2),
    'counts'  => $statusCounts,
]);
