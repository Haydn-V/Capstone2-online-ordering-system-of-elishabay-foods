<?php
declare(strict_types=1);

/** GET /api/shop/my-orders.php returns only the signed-in customer's own orders, scoped by session and taking no customer id. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* Run the one-hour auto-complete sweep here (self-throttled, never throws), since XAMPP has no scheduler. */
Orders::sweepIfDue();

$customer = Auth::requireCustomer();

$paging = Validate::paging($_GET, 20, 100);

$total = (int) Database::scalar(
    'SELECT COUNT(*) FROM orders WHERE customer_id = ?',
    [$customer['id']]
);

$rows = Database::all(
    "SELECT o.id, o.datetime, o.date, o.status, o.total, o.order_type, o.customer_name, o.type,
            " . Orders::buyerTinSql('o.customer_id') . " AS buyer_tin,
            " . Orders::cashierSql('o') . " AS cashier,
            " . Tax::selectColumns('o') . ",
            o.method, o.address, o.notes, o.pay_verified,
            o.tracking_number, o.delivered_at" . (Returns::ready() ? ", o.completed_at,
            o.completed_at >= NOW() - INTERVAL " . Returns::WINDOW_HOURS . " HOUR AS return_open" : "") . "
       FROM orders o
      WHERE o.customer_id = ?
      ORDER BY o.datetime DESC
      LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    [$customer['id']]
);

/* Cancellation reason from order_status_history (guarded, since that table is optional). */
$reasonByOrder = [];
$itemsByOrder = [];
if ($rows !== []) {
    $ids = array_column($rows, 'id');
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    /* Which batches each line's units came from (shown to the customer under the product). */
    $lotsByOrder = Stock::lotsByOrders($ids);
    /* Each line's own review from that order (one per product per order), fetched here to avoid one request per item. */
    foreach (Database::all(
        "SELECT oi.order_id, oi.product_id, oi.qty, oi.price_at_purchase,
                p.name, p.tint, p.image_url,
                r.rating AS my_rating, r.comment AS my_comment, r.status AS my_status
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           LEFT JOIN product_reviews r
                  ON r.order_id = oi.order_id AND r.product_id = oi.product_id AND r.customer_id = ?
          WHERE oi.order_id IN ($ph) ORDER BY oi.id",
        array_merge([$customer['id']], $ids)
    ) as $it) {
        $itemsByOrder[$it['order_id']][] = [
            /* Which product the rating control rates (review-save.php re-checks the order). */
            'productId' => $it['product_id'],
            'name'  => $it['name'],
            'tint'  => $it['tint'],
            /* The product photo for the order line (resolved client-side by imageUrl). */
            'image' => $it['image_url'],
            'qty'   => (int) $it['qty'],
            'price' => (float) $it['price_at_purchase'],
            'lots'  => $lotsByOrder[$it['order_id']][$it['product_id']] ?? [],
            /* This order's existing review of the product (null if none), so the form opens filled in. */
            'myRating'  => $it['my_rating'] === null ? null : (int) $it['my_rating'],
            'myComment' => $it['my_comment'],
            'myStatus'  => $it['my_status'],
        ];
    }

    if (Database::hasTable('order_status_history')) {
        foreach (Database::all(
            "SELECT order_id, note FROM order_status_history
              WHERE order_id IN ($ph) AND to_status = 'cancelled' AND note IS NOT NULL
              ORDER BY id DESC",
            $ids
        ) as $h) {
            /* Newest first, keeping only the final cancellation reason. */
            $reasonByOrder[$h['order_id']] ??= $h['note'];
        }
    }
}

Response::ok(array_map(static fn(array $o): array => [
    'id'          => $o['id'],
    /* The buyer name saved on the order (the invoice's Registered Name), not the current profile name. */
    'customerName'=> $o['customer_name'],
    'type'        => $o['type'],
    'tin'         => $o['buyer_tin'],
    'date'        => $o['date'],
    'datetime'    => $o['datetime'],
    'status'      => $o['status'],
    /* Staff member who processed it — the invoice's signature line. */
    'cashier'     => $o['cashier'] ?? null,
    /* What the customer pays: a retailer's discount already taken off (matches the invoice's Total Amount Due). */
    'total'       => (float) Tax::describeOrder($o)['amountDue'],
    /* The VAT breakdown stored at the sale (api/core/Tax.php), never recalculated; amountDue already subtracts withholding. */
    'tax'         => Tax::describeOrder($o),
    'orderType'   => $o['order_type'],
    'payMethod'   => $o['method'],
    'address'     => $o['address'],
    'notes'       => $o['notes'],
    'payVerified' => (bool) $o['pay_verified'],
    /* Courier tracking number for the customer to check on the courier's site. */
    'trackingNumber' => $o['tracking_number'],
    'deliveredAt'    => $o['delivered_at'],
    /* Inside the return window (api/shop/returns.php decides per unit). */
    'completedAt'    => $o['completed_at'] ?? null,
    'returnOpen'     => $o['status'] === 'completed' && !empty($o['return_open']),
    'cancelReason'   => $reasonByOrder[$o['id']] ?? null,
    'steps'          => Orders::trackingSteps($o['status']),
    'items'       => $itemsByOrder[$o['id']] ?? [],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / max(1, $paging['limit'])),
]);
