<?php
declare(strict_types=1);

/**
 * GET /api/orders/get.php?id=ORD-20260617-001
 *
 * One order with its line items and its real status history.
 *
 * The history is the point. The Order Status stepper used to be inferred at
 * render time from the current status — so it could show that an order had
 * been accepted, but never who accepted it or when, and a cancelled order's
 * path was unrecoverable. order_status_history records each transition with
 * the user who made it.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireAny('orders.view', 'transactions.view', 'orders.accept', 'orders.status');

$id = trim((string) ($_GET['id'] ?? ''));
if ($id === '') {
    Response::validation('Which order?', ['id' => 'Order id is required.']);
}

$o = Database::one(
    'SELECT o.*, c.name AS customer_record_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = ?',
    [$id]
);
if ($o === null) {
    Response::notFound('That order does not exist.');
}

/* Line items carry price_at_purchase, deliberately: re-deriving the line total
   from the product's current price would silently rewrite order history every
   time somebody edited a price. */
$items = Database::all(
    'SELECT oi.id, oi.product_id, p.name AS product_name, p.tint,
            oi.qty, oi.price_at_purchase
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id',
    [$id]
);

$history = [];
if (Database::hasTable('order_status_history')) {
    $history = Database::all(
        'SELECT h.from_status, h.to_status, h.note, h.changed_at,
                u.name AS changed_by_name
           FROM order_status_history h
           LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.order_id = ?
          ORDER BY h.changed_at ASC, h.id ASC',
        [$id]
    );
}

$lines = array_map(static fn(array $r): array => [
    'id'          => (int) $r['id'],
    'productId'   => $r['product_id'],
    'productName' => $r['product_name'],
    'tint'        => $r['tint'],
    'qty'         => (int) $r['qty'],
    'price'       => (float) $r['price_at_purchase'],
    'lineTotal'   => round((int) $r['qty'] * (float) $r['price_at_purchase'], 2),
], $items);

/* Recomputed from the stored line prices rather than trusting orders.total, so
   a mismatch is visible instead of hidden. */
$computed = round(array_sum(array_column($lines, 'lineTotal')), 2);

/* The Net account this order opened, if it is on terms. */
$creditRow = Database::one(Payments::accountSelect() . ' WHERE pa.order_id = ?', [$o['id']]);
$credit    = $creditRow ? Payments::creditSummary(Payments::describeAccount($creditRow)) : null;

Response::ok([
    'id'           => $o['id'],
    'customerId'   => $o['customer_id'],
    'customer'     => $o['customer_name'],
    'email'        => $o['email'],
    'contact'      => $o['contact'],
    'address'      => $o['address'],
    'type'         => $o['type'],
    'orderType'    => $o['order_type'],
    'customerType' => $o['customer_type'],
    'payMethod'    => $o['method'],
    'total'        => (float) $o['total'],
    /* The VAT breakdown stored at the sale (api/core/Tax.php) — what the Sales
       Invoice prints, never recalculated. `amountDue` nets off withholding. */
    'tax'          => Tax::describeOrder($o),
    'computedTotal'=> $computed,
    'totalsAgree'  => abs($computed - (float) $o['total']) < 0.01,
    'date'         => $o['date'],
    'datetime'     => $o['datetime'],
    'status'       => $o['status'],
    'notes'        => $o['notes'],
    'payVerified'  => (bool) $o['pay_verified'],
    'proof'        => [
        'uploaded' => (bool) $o['proof_uploaded'],
        'refNum'   => $o['proof_ref_num'],
        'image'    => $o['proof_image_path'],
        'amount'   => (float) $o['proof_amount'],
    ],
    'cashier'      => $o['cashier'],
    'trackingNumber'=> $o['tracking_number'],
    'deliveredAt'  => $o['delivered_at'],
    'batch'        => $o['batch_code_hint'],
    'items'        => $lines,
    'credit'       => $credit,
    'history'      => array_map(static fn(array $h): array => [
        'from'      => $h['from_status'],
        'to'        => $h['to_status'],
        'note'      => $h['note'],
        'at'        => $h['changed_at'],
        'by'        => $h['changed_by_name'] ?? 'System',
    ], $history),
]);
