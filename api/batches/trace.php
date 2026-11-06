<?php
declare(strict_types=1);

/** GET /api/batches/trace.php?lot=JBF-2026-B860 (needs batches.manage) is the recall look-up: every order that took
    units from that batch (order_item_lots, migration 028), who bought them, how many, where they went and how to reach
    the buyer, plus returns already made from the batch. Read-only; each look-up is written to the audit log because it
    shows customers' contact details. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
$user = Rbac::require('batches.manage');

$lot = strtoupper(trim((string) ($_GET['lot'] ?? '')));
if ($lot === '') {
    Response::validation('Choose a batch.', ['lot' => 'Pick the batch code to trace.']);
}

$batch = Database::one(
    'SELECT b.lot_code, b.product_id, p.name AS product_name, b.production_date, b.expiry_date,
            b.total_qty, b.remaining_qty, b.lab_status
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.lot_code = ?',
    [$lot]
);
if ($batch === null) {
    Response::notFound('No batch with that code is on record.');
}

if (!Stock::lotsReady()) {
    Response::conflict('Batch tracing needs migration 028 (order_item_lots). Run it in phpMyAdmin first.');
}

/* Every order line taken from this batch, one row per order (an order can list the batch on more than one line). */
$rows = Database::all(
    "SELECT o.id, o.date, o.datetime, o.type, o.order_type, o.status, o.customer_id,
            o.customer_name, o.email, o.contact, o.address, o.ship_city, o.ship_province, o.tracking_number,
            c.retailer_tier, SUM(l.qty) AS qty
       FROM order_item_lots l
       JOIN orders o ON o.id = l.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE l.lot_code = ? AND l.product_id = ?
      GROUP BY o.id
      ORDER BY o.datetime DESC, o.id DESC",
    [$lot, $batch['product_id']]
);

/* Units already sent back from this batch, per order (customer returns that name the batch). */
$returned = [];
foreach (Database::all(
    "SELECT r.order_id, i.qty, r.status, r.id
       FROM product_return_items i JOIN product_returns r ON r.id = i.return_id
      WHERE i.batch_code = ? AND i.product_id = ?",
    [$lot, $batch['product_id']]
) as $r) {
    $o = (string) $r['order_id'];
    $returned[$o]['qty']     = ($returned[$o]['qty'] ?? 0) + (int) $r['qty'];
    $returned[$o]['returns'][] = ['id' => $r['id'], 'status' => $r['status'], 'qty' => (int) $r['qty']];
}

$buyers = [];
$units  = 0;
$customers = [];
foreach ($rows as $r) {
    $qty = (int) $r['qty'];
    $units += $qty;
    $who = $r['customer_id'] ?: ('walk-in:' . $r['id']);
    $customers[$who] = true;
    $place = trim(implode(', ', array_filter([$r['ship_city'], $r['ship_province']])));
    $buyers[] = [
        'orderId'   => $r['id'],
        'date'      => $r['datetime'] ?: $r['date'],
        'channel'   => $r['type'] === 'walk-in' ? 'Walk-in' : 'Online',
        'fulfil'    => $r['order_type'] === 'delivery' ? 'Delivery' : 'Pickup',
        'status'    => $r['status'],
        'customer'  => $r['customer_name'],
        'customerId'=> $r['customer_id'],
        'retailer'  => $r['retailer_tier'] !== null && $r['retailer_tier'] !== '',
        'email'     => $r['email'],
        'contact'   => $r['contact'],
        /* Where the units went: the delivery address, or the shop for pickups and walk-ins. */
        'shipTo'    => $r['order_type'] === 'delivery' ? ($r['address'] ?: $place) : 'Picked up at the store',
        'area'      => $place,
        'tracking'  => $r['tracking_number'],
        'qty'       => $qty,
        'returned'  => $returned[$r['id']]['qty'] ?? 0,
        'returns'   => $returned[$r['id']]['returns'] ?? [],
    ];
}
$unitsReturned = array_sum(array_column($buyers, 'returned'));

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description) VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'product', sprintf(
        'Batch %s (%s) traced: %d order(s), %d unit(s) sold to %d customer(s).',
        $lot, $batch['product_name'], count($buyers), $units, count($customers)
    )]
);

Response::ok([
    'batch' => [
        'lotCode'        => $batch['lot_code'],
        'productId'      => $batch['product_id'],
        'productName'    => $batch['product_name'],
        'productionDate' => $batch['production_date'],
        'expiryDate'     => $batch['expiry_date'],
        'totalQty'       => (int) $batch['total_qty'],
        'remainingQty'   => (int) $batch['remaining_qty'],
        'labStatus'      => $batch['lab_status'],
    ],
    'summary' => [
        'orders'        => count($buyers),
        'customers'     => count($customers),
        'unitsSold'     => $units,
        'unitsReturned' => $unitsReturned,
        /* Still out with buyers: sold minus already returned. */
        'unitsOut'      => max(0, $units - $unitsReturned),
    ],
    'buyers' => $buyers,
]);
