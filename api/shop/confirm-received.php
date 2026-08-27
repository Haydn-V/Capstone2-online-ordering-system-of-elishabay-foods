<?php
declare(strict_types=1);

/**
 * POST /api/shop/confirm-received.php
 * Body: { "order_id": "ORD-…" }
 *
 * Requires a customer session. Moves the customer's own delivered order to
 * completed.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The Scope says the customer "confirms receipt by pressing the received
 * button", which completes the order. That button existed on
 * public/profile/my-orders.html for delivered orders and was a stub — a toast
 * and nothing else. A delivered order had no route to `completed` except a
 * staff member doing it by hand, which is the opposite of what the Scope
 * describes.
 *
 * WHY THIS IS NOT A FLAG ON cancel-order.php
 * ------------------------------------------
 * They are both "customer changes their own order's status" and it is tempting
 * to write one endpoint with a `to` parameter. This repo deliberately keeps one
 * endpoint to one job — the reasoning is in the header of api/shop/password.php:
 * merging two operations means the safer one inherits the other's rules, or,
 * far more likely, the riskier one inherits the absence of them.
 *
 * Concretely: cancellation requires a reason and refuses anything but
 * `pending`; confirmation requires no reason and refuses anything but
 * `delivered`. A shared endpoint would carry both sets of branches and a `to`
 * value that decides which apply, which is how a customer eventually cancels a
 * delivered order.
 *
 * NO STOCK MOVEMENT
 * -----------------
 * Stock was committed when staff accepted this order (see api/orders/status.php).
 * Completing it moves nothing — the goods have already left. `completed` is what
 * makes the order count as revenue (Revenue::STATUSES), and that is the whole
 * effect of this endpoint.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer = Auth::requireCustomer('Sign in to manage your orders.');

$in = Response::input();

$data = Validate::check($in)
    ->required('order_id', 'Order')
    ->values();

/* Scoped by session. A missing order and somebody else's order give the same
   answer — see the same note in cancel-order.php. */
$order = Database::one(
    'SELECT id, status, total FROM orders WHERE id = ? AND customer_id = ?',
    [$data['order_id'], $customer['id']]
);
if ($order === null) {
    Response::notFound('Not found.');
}

if ($order['status'] !== 'delivered') {
    $advice = [
        'pending'   => 'This order has not been accepted yet, so there is nothing to confirm.',
        'accepted'  => 'This order has not shipped yet, so there is nothing to confirm.',
        'shipping'  => 'This order is still on its way. You can confirm it once it has been marked delivered.',
        'completed' => 'You have already confirmed this order.',
        'cancelled' => 'This order was cancelled.',
        'on-hold'   => 'This order is on hold with our team. Contact us and we will sort it out.',
    ];
    Response::conflict($advice[$order['status']]
        ?? sprintf('This order is %s, so it cannot be confirmed as received.', $order['status']));
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    Database::run(
        "UPDATE orders SET status = 'completed' WHERE id = ? AND status = 'delivered'",
        [$order['id']]
    );

    /* Conditional on the status we read. The one-hour sweep
       (Orders::autoCompleteDelivered) can move this same order, so the race is
       real rather than theoretical — and either outcome is correct, so the
       customer is simply told to reload. */
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this order. Reload and try again.');
    }

    if (Database::hasTable('order_status_history')) {
        Database::run(
            'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, ?, NULL, ?)',
            [$order['id'], 'delivered', 'completed', 'Confirmed received by customer.']
        );
    }

    /* Staff should see the confirmation without watching the order list. Same
       mechanism, and the same id format, as the new-order notification in
       api/shop/checkout.php. */
    Database::run(
        'INSERT INTO notifications (id, type, order_id, message, created_at, is_read)
         VALUES (?, ?, ?, ?, NOW(), 0)',
        ['n-' . strtolower(bin2hex(random_bytes(5))), 'completed', $order['id'],
         sprintf('%s confirmed receipt of order %s.', $customer['name'], $order['id'])]
    );

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$customer['name'], 'order',
         sprintf('Order %s confirmed received by the customer — ₱%s. Completed.',
             $order['id'], number_format((float) $order['total'], 2))]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::ok([
    'id'     => $order['id'],
    'status' => 'completed',
]);
