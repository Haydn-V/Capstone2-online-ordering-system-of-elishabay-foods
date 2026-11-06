<?php
declare(strict_types=1);

/** GET /api/orders/list.php (needs orders.view or transactions.view) backs the order screens, loading all line items for the page in one grouped query. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* Run the one-hour auto-complete sweep here (self-throttled, never throws), since XAMPP has no scheduler. */
Orders::sweepIfDue();
Rbac::requireAny('orders.view', 'transactions.view', 'orders.accept', 'orders.status');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

/* Status accepts one value or a comma list, each checked and bound individually. */
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
    /* with_deliveries also includes walk-in deliveries, which need tracking and shipping like online orders, without changing what type=online means for reports. */
    if ($q['type'] === 'online' && !empty($q['with_deliveries'])) {
        $where[] = "(o.type = 'online' OR (o.type = 'walk-in' AND o.order_type = 'delivery'))";
    } else {
        $where[] = 'o.type = ?';
        $params[] = $q['type'];
    }
}

if (!empty($q['customer_type']) && in_array($q['customer_type'], ['regular', 'retailer'], true)) {
    $where[] = 'o.customer_type = ?';
    $params[] = $q['customer_type'];
}

if (isset($q['pay_verified']) && $q['pay_verified'] !== '') {
    $where[] = 'o.pay_verified = ?';
    $params[] = $q['pay_verified'] ? 1 : 0;
}

/* Filter by whether a payment proof was uploaded, so Payment Verification's count matches what it shows. */
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

/* Validate the date range so a bad date is an error rather than silently matching nothing. */
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
    /* Most recently completed first (falls back to the order date for orders completed before completed_at existed). */
    'completed' => 'COALESCE(o.completed_at, o.datetime) DESC',
];
/* Latest activity: the newest of placed, delivered, completed and any status change (future-dated history is ignored). */
$activitySql = 'GREATEST(o.datetime, COALESCE(o.delivered_at, o.datetime), COALESCE(o.completed_at, o.datetime)'
    . (Database::hasTable('order_status_history')
        ? ', COALESCE((SELECT MAX(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.changed_at <= NOW()), o.datetime)'
        : '')
    . ')';
$sortMap['activity'] = "$activitySql DESC, o.datetime DESC";
$order = $sortMap[$q['sort'] ?? 'newest'] ?? $sortMap['newest'];

$sql = 'FROM orders o';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

/* Total revenue for the whole filtered set (not just this page), excluding cancelled orders. */
/* Per-status counts for the tab badges across the whole set, ignoring the status filter itself. */
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

/* Uses the same revenue definition as the Sales Report; its placeholders are appended to $params in statement order. */
[$revClause, $revParams] = Revenue::clause('o');
$revenueSql    = $sql . ($where ? " AND $revClause" : " WHERE $revClause");
$revenueParams = array_merge($params, $revParams);
$filteredRevenue = (float) Database::scalar("SELECT COALESCE(SUM(" . Payments::dueSql('o') . "),0) $revenueSql", $revenueParams);
/* Add verified payments received on Net orders in this set, since a credit order counts only through its payments. */
[$crClause] = Revenue::creditClause('cp');
$filteredRevenue += (float) Database::scalar(
    "SELECT COALESCE(SUM(cp.amount), 0)
       FROM credit_payments cp
       JOIN payment_accounts pa ON pa.id = cp.account_id
      WHERE $crClause AND pa.order_id IN (SELECT o.id $sql)",
    $params
);

$rows = Database::all(
    "SELECT o.id, o.customer_id, o.customer_name, o.email, o.contact, o.address,
            o.type, o.order_type, o.customer_type, o.method, o.total,
            o.date, o.datetime, o.status, o.notes,
            o.pay_verified, o.proof_uploaded, o.proof_ref_num, o.proof_image_path,
            o.proof_amount,
            " . Orders::cashierSql('o') . " AS cashier, o.batch_code_hint, o.tracking_number, o.delivered_at, o.completed_at, $activitySql AS last_activity,
            " . Orders::buyerTinSql('o.customer_id') . " AS buyer_tin,
            " . Tax::selectColumns('o') . ",
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi WHERE oi.order_id = o.id) AS unit_count
     $sql
     ORDER BY $order
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

/* Fetch every line item for this page in one query, keyed by order id. */
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
    /* Which batches each line's units came from (empty until stock is taken, or for orders before lot tracking). */
    $lotsByOrder = Stock::lotsByOrders($orderIds);
    foreach ($itemRows as $it) {
        $itemsByOrder[$it['order_id']][] = [
            'id'    => $it['product_id'],
            'name'  => $it['name'],
            'qty'   => (int) $it['qty'],
            'price' => (float) $it['price_at_purchase'],
            'lots'  => $lotsByOrder[$it['order_id']][$it['product_id']] ?? [],
        ];
    }
}

/* Net orders include their account figures so screens can show "₱5,000 of ₱13,330 paid". */
$creditByOrder = [];
if ($orderIds !== []) {
    $inList = implode(',', array_fill(0, count($orderIds), '?'));
    $rate   = Payments::penaltyRate();
    foreach (Database::all(Payments::accountSelect() . " WHERE pa.order_id IN ($inList)", $orderIds) as $cr) {
        $acct = Payments::describeAccount($cr, $rate);
        $creditByOrder[$acct['orderId']] = Payments::creditSummary($acct);
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
    /* A retailer's BIR TIN for the Sales Invoice; null for anyone else. */
    'tin'           => $r['buyer_tin'],
    'orderType'     => $r['order_type'],
    'customerType'  => $r['customer_type'],
    'payMethod'     => $r['method'],
    'total'         => (float) $r['total'],
    /* The VAT breakdown stored at the sale (api/core/Tax.php), never recalculated; amountDue already subtracts withholding. */
    'tax'           => Tax::describeOrder($r),
    'date'          => $r['date'],
    'datetime'      => $r['datetime'],
    'status'        => $r['status'],
    'notes'         => $r['notes'],
    'payVerified'   => (bool) $r['pay_verified'],
    'proof'         => [
        'uploaded' => (bool) $r['proof_uploaded'],
        'refNum'   => $r['proof_ref_num'],
        /* The customer's uploaded payment screenshot as an app-root-relative path. */
        'image'    => $r['proof_image_path'],
        'amount'   => (float) $r['proof_amount'],
    ],
    'cashier'       => $r['cashier'],
    'batch'         => $r['batch_code_hint'],
    /* Courier tracking number entered by staff as proof of dispatch (no courier integration). */
    'trackingNumber'=> $r['tracking_number'],
    'deliveredAt'   => $r['delivered_at'],
    'completedAt'   => $r['completed_at'],
    'lastActivity'  => $r['last_activity'],
    'itemCount'     => (int) $r['item_count'],
    'unitCount'     => (int) $r['unit_count'],
    /* Never null — every renderer maps over this without checking. */
    'items'         => $itemsByOrder[$r['id']] ?? [],
    'credit'        => $creditByOrder[$r['id']] ?? null,
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
    'revenue' => round($filteredRevenue, 2),
    'counts'  => $statusCounts,
]);
