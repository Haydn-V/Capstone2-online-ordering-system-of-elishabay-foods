<?php
declare(strict_types=1);

/**
 * GET /api/shop/my-orders.php
 *
 * The signed-in customer's own orders. Requires a customer session.
 *
 * Scoped by the session's customer id, never by anything in the request. An
 * `?customer_id=` parameter here would let anyone read anyone else's order
 * history by changing a number in the URL — the classic broken-object-level-
 * authorisation bug, and the reason this endpoint takes no identifying input
 * at all.
 *
 * my-orders.html previously rendered a MOCK_ORDERS array: the same four
 * invented orders for every visitor, related to nothing they had bought.
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

$customer = Auth::requireCustomer();

$paging = Validate::paging($_GET, 20, 100);

$total = (int) Database::scalar(
    'SELECT COUNT(*) FROM orders WHERE customer_id = ?',
    [$customer['id']]
);

$rows = Database::all(
    "SELECT o.id, o.datetime, o.date, o.status, o.total, o.order_type,
            o.method, o.address, o.notes, o.pay_verified,
            o.tracking_number, o.delivered_at
       FROM orders o
      WHERE o.customer_id = ?
      ORDER BY o.datetime DESC
      LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    [$customer['id']]
);

/* Why a cancelled order was cancelled, for the card that displays it.

   Read from order_status_history rather than stored on `orders`: the reason
   belongs to the transition, not to the order, and the same order can be held
   and released before it is finally cancelled. Guarded, because that table is
   optional everywhere else in this codebase and this must not be the one place
   that assumes it. */
$reasonByOrder = [];
$itemsByOrder = [];
if ($rows !== []) {
    $ids = array_column($rows, 'id');
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    foreach (Database::all(
        "SELECT oi.order_id, oi.qty, oi.price_at_purchase, p.name, p.tint
           FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN ($ph) ORDER BY oi.id",
        $ids
    ) as $it) {
        $itemsByOrder[$it['order_id']][] = [
            'name'  => $it['name'],
            'tint'  => $it['tint'],
            'qty'   => (int) $it['qty'],
            'price' => (float) $it['price_at_purchase'],
        ];
    }

    if (Database::hasTable('order_status_history')) {
        foreach (Database::all(
            "SELECT order_id, note FROM order_status_history
              WHERE order_id IN ($ph) AND to_status = 'cancelled' AND note IS NOT NULL
              ORDER BY id DESC",
            $ids
        ) as $h) {
            /* Ordered newest first and only the first kept: an order cancelled
               more than once in its life shows the reason it ended on. */
            $reasonByOrder[$h['order_id']] ??= $h['note'];
        }
    }
}

Response::ok(array_map(static fn(array $o): array => [
    'id'          => $o['id'],
    'date'        => $o['date'],
    'datetime'    => $o['datetime'],
    'status'      => $o['status'],
    'total'       => (float) $o['total'],
    'orderType'   => $o['order_type'],
    'payMethod'   => $o['method'],
    'address'     => $o['address'],
    'notes'       => $o['notes'],
    'payVerified' => (bool) $o['pay_verified'],
    /* Proof of dispatch. The courier is not integrated (a stated Limitation);
       this is the number the customer takes to the courier's own site. */
    'trackingNumber' => $o['tracking_number'],
    'deliveredAt'    => $o['delivered_at'],
    'cancelReason'   => $reasonByOrder[$o['id']] ?? null,
    'items'       => $itemsByOrder[$o['id']] ?? [],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / max(1, $paging['limit'])),
]);
