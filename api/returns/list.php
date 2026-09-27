<?php
declare(strict_types=1);

/**
 * GET /api/returns/list.php?status=&search=&page=&limit=
 *
 * Requires orders.returns.
 *
 * Refund amounts are returned as stored, not recalculated from the product's
 * current price — a refund is for what the customer actually paid, and a later
 * price change must not silently alter what is owed.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('orders.returns');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

$statusIn = trim((string) ($q['status'] ?? ''));
if ($statusIn !== '' && $statusIn !== 'all') {
    $valid  = ['received','validated','eligible','ineligible','approved','rejected','processed'];
    $wanted = array_values(array_intersect(array_map('trim', explode(',', $statusIn)), $valid));
    if (!$wanted) {
        Response::validation('Unknown status filter.', ['status' => 'Not a valid return status.']);
    }
    $where[] = 'r.status IN (' . implode(',', array_fill(0, count($wanted), '?')) . ')';
    $params  = array_merge($params, $wanted);
}

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(r.id LIKE ? OR r.order_id LIKE ? OR r.customer_name LIKE ? OR p.name LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like, $like);
}

$sql = 'FROM product_returns r JOIN products p ON p.id = r.product_id';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

/* Customer requests (migration 016): the photo, whole-order vs picked items,
   and when the order completed, so staff can check the 24-hour window. */
$extraCols = Returns::ready()
    ? ', r.proof_image, r.scope, (SELECT o.completed_at FROM orders o WHERE o.id = r.order_id) AS order_completed_at'
    : '';
if (Returns::refundReady()) {
    $extraCols .= ', r.refund_pref, r.refund_account_name, r.refund_account_number,
                    r.refund_bank_name, r.refund_qr, r.refund_receipt';
}

$rows = Database::all(
    "SELECT r.id, r.order_id, r.customer_id, r.customer_name, r.email, r.phone,
            r.product_id, p.name AS product_name, r.qty, r.batch_code,
            r.purchase_date, r.reason, r.status, r.received_date, r.eligibility,
            r.refund_amount, r.refund_method, r.notes, r.rejected_reason$extraCols
     $sql
     ORDER BY r.received_date DESC, r.id DESC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

/* Counts per status, so the tab badges do not need a second request or a
   client-side pass over rows the page has not loaded. */
$counts = [];
foreach (Database::all('SELECT status, COUNT(*) AS n FROM product_returns GROUP BY status') as $c) {
    $counts[$c['status']] = (int) $c['n'];
}

$itemsById = Returns::itemsFor(array_column($rows, 'id'));

Response::ok(array_map(static fn(array $r): array => [
    'id'             => $r['id'],
    'orderId'        => $r['order_id'],
    'customerId'     => $r['customer_id'],
    'customer'       => $r['customer_name'],
    'email'          => $r['email'],
    'phone'          => $r['phone'],
    'productId'      => $r['product_id'],
    'productName'    => $r['product_name'],
    'qty'            => (int) $r['qty'],
    'batchCode'      => $r['batch_code'],
    'purchaseDate'   => $r['purchase_date'],
    'reason'         => $r['reason'],
    'status'         => $r['status'],
    'receivedDate'   => $r['received_date'],
    'eligibility'    => $r['eligibility'] === null ? null : (bool) $r['eligibility'],
    'refundAmount'   => (float) $r['refund_amount'],
    'refundMethod'   => $r['refund_method'],
    'notes'          => $r['notes'],
    'rejectedReason' => $r['rejected_reason'],
    'proofImage'     => $r['proof_image'] ?? null,
    'scope'          => $r['scope'] ?? 'items',
    'orderCompletedAt' => $r['order_completed_at'] ?? null,
    /* Where the customer asked for the money, and the transfer receipt (017). */
    'refundTo'       => empty($r['refund_pref']) ? null : [
        'method'        => $r['refund_pref'],
        'accountName'   => $r['refund_account_name'],
        'accountNumber' => $r['refund_account_number'],
        'bankName'      => $r['refund_bank_name'],
        'qr'            => $r['refund_qr'],
    ],
    'refundReceipt'  => $r['refund_receipt'] ?? null,
    /* The request's lines; a pre-016 return is its single product. */
    'items'          => $itemsById[$r['id']] ?? [[
        'productId' => $r['product_id'], 'name' => $r['product_name'], 'qty' => (int) $r['qty'],
        'unitPrice' => $r['qty'] ? round((float) $r['refund_amount'] / (int) $r['qty'], 2) : 0.0,
        'subtotal'  => (float) $r['refund_amount'],
    ]],
], $rows), [
    'page'   => $paging['page'],
    'limit'  => $paging['limit'],
    'total'  => $total,
    'pages'  => (int) ceil($total / $paging['limit']),
    'counts' => $counts,
]);
