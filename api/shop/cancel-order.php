<?php
declare(strict_types=1);

/** POST /api/shop/cancel-order.php lets a customer cancel their own pending order with a required reason, and deliberately does not touch stock because pending orders never committed any. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer = Auth::requireCustomer('Sign in to manage your orders.');

$in = Response::input();

$data = Validate::check($in)
    ->required('order_id', 'Order')
    ->required('reason', 'Reason')
    ->maxLen('reason', 500, 'Reason')
    ->values();

$reason = trim($data['reason']);
if ($reason === '') {
    Response::validation('Please check the highlighted fields.', [
        'reason' => 'Tell us why you are cancelling.',
    ]);
}

/* Look up the order by the session's customer only, giving the same message for missing and someone else's order. */
$order = Database::one(
    'SELECT id, status, ' . Payments::dueSql('orders') . ' AS total, customer_name FROM orders WHERE id = ? AND customer_id = ?',
    [$data['order_id'], $customer['id']]
);
if ($order === null) {
    Response::notFound('Not found.');
}

if ($order['status'] !== 'pending') {
    /* Name the current status so the customer knows why it cannot be cancelled. */
    $advice = [
        'accepted'  => 'This order is already accepted and can no longer be cancelled. Contact us if you need to change it.',
        'shipping'  => 'This order is already on its way and can no longer be cancelled. Contact us if you need to change it.',
        'delivered' => 'This order has already been delivered. If something is wrong with it, please raise a return instead.',
        'completed' => 'This order is already completed. If something is wrong with it, please raise a return instead.',
        'cancelled' => 'This order was already cancelled.',
        'on-hold'   => 'This order is on hold with our team. Contact us and we will sort it out.',
    ];
    Response::conflict($advice[$order['status']]
        ?? sprintf('This order is %s and can no longer be cancelled.', $order['status']));
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    Database::run(
        "UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        [$order['id']]
    );
    /* A Net order's account goes too, so Payment Schemes stops billing it. */
    Payments::closeForCancelledOrder($order['id']);

    /* Conditional on the status read, so staff accepting at the same moment wins. */
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this order. Reload and try again.');
    }

    /* Optional history table, guarded so installs without it still work. */
    if (Database::hasTable('order_status_history')) {
        Database::run(
            'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, ?, NULL, ?)',
            [$order['id'], 'pending', 'cancelled', $reason]
        );
    }

    /* actor_user_id stays NULL because the actor is a customer. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$customer['name'], 'order',
         sprintf('Order %s cancelled by the customer — ₱%s. Reason: %s',
             $order['id'], number_format((float) $order['total'], 2), $reason)]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Return the new status and reason so the page can update without another request. */
Response::ok([
    'id'     => $order['id'],
    'status' => 'cancelled',
    'reason' => $reason,
]);
