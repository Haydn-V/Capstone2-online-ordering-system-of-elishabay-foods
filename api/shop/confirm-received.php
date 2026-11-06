<?php
declare(strict_types=1);

/** POST /api/shop/confirm-received.php lets a customer mark their own shipped or delivered order as completed (no stock change), kept separate from cancel-order.php on purpose. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer = Auth::requireCustomer('Sign in to manage your orders.');

$in = Response::input();

$data = Validate::check($in)
    ->required('order_id', 'Order')
    ->values();

/* Look up by session, with the same answer for missing and someone else's order. */
$order = Database::one(
    'SELECT id, status, ' . Payments::dueSql('orders') . ' AS total FROM orders WHERE id = ? AND customer_id = ?',
    [$data['order_id'], $customer['id']]
);
if ($order === null) {
    Response::notFound('Not found.');
}

/* Allowed from shipping or delivered, since the parcel may arrive before staff mark it delivered. */
if (!in_array($order['status'], ['shipping', 'delivered'], true)) {
    $advice = [
        'pending'   => 'This order has not been accepted yet, so there is nothing to confirm.',
        'accepted'  => 'This order has not shipped yet, so there is nothing to confirm.',
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
        "UPDATE orders SET status = 'completed', delivered_at = NULL WHERE id = ? AND status = ?",
        [$order['id'], $order['status']]
    );

    /* Conditional on the status read, since the one-hour sweep may complete it at the same time. */
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this order. Reload and try again.');
    }
    Returns::stampCompleted($order['id']);   /* starts the 24h return window */

    if (Database::hasTable('order_status_history')) {
        Database::run(
            'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, ?, NULL, ?)',
            [$order['id'], $order['status'], 'completed', 'Confirmed received by customer.']
        );
    }

    /* Notify staff (Info level) that the customer confirmed receipt. */
    Notify::create(
        'completed',
        sprintf('%s confirmed receipt of order %s.', $customer['name'], $order['id']),
        ['order' => $order['id']]
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
