<?php
declare(strict_types=1);

/**
 * POST /api/shop/cancel-order.php
 * Body: { "order_id": "ORD-…", "reason": "…" }
 *
 * Requires a customer session. Cancels the customer's own pending order.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The Scope names an "Order Cancellation Module". `public/profile/my-orders.html`
 * rendered a Cancel button for pending orders whose handler called `confirm()`
 * and `showToast("Order cancelled")` — and stopped. Nothing reached the server,
 * no reason was captured, and the order stayed pending. There was no
 * customer-facing cancel endpoint at all; the only way to cancel was staff
 * doing it from the portal.
 *
 * WHY THE REASON IS MANDATORY
 * ---------------------------
 * The Scope says the reason is recorded. It is also the only thing that makes a
 * cancellation useful afterwards: a queue of orders that vanished without
 * explanation tells the business nothing about why people change their minds.
 * `orders/status.php` already refuses a staff cancellation without one, and
 * this matches it rather than holding customers to a lower standard.
 *
 * WHY ONLY `pending`
 * ------------------
 * The Scope says "before they are approved for processing". `accepted` is the
 * point at which staff have committed stock and begun work, and it is a real
 * boundary rather than a policy preference — see the stock note below.
 *
 * STOCK IS DELIBERATELY NOT TOUCHED HERE
 * --------------------------------------
 * Do not add a Stock::reverseSale() call to this file.
 *
 * An online order commits stock when staff ACCEPT it, not when it is placed —
 * see the long comment in api/orders/status.php. A `pending` order has
 * therefore never committed any, so reversing it would credit inventory that
 * was never debited and silently inflate stock by the quantity of every
 * cancelled order.
 *
 * `orders/status.php` reverses stock on cancellation only when the order is
 * coming from a committed state (accepted/shipping/delivered/completed), which
 * this endpoint cannot reach.
 */

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

/* Scoped by the session's customer id, never by anything in the request.
   A missing order and somebody else's order return the SAME message: telling
   the caller "that order exists but is not yours" confirms the id is real,
   which is exactly what an enumeration attempt is looking for. */
$order = Database::one(
    'SELECT id, status, total, customer_name FROM orders WHERE id = ? AND customer_id = ?',
    [$data['order_id'], $customer['id']]
);
if ($order === null) {
    Response::notFound('Not found.');
}

if ($order['status'] !== 'pending') {
    /* The current status is named, because "you cannot cancel this" leaves the
       customer with no idea what to do next. */
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

    /* Conditional on the status we read, so a staff member accepting this order
       in the same second wins and the customer is told to reload rather than
       silently cancelling work that has already started. */
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this order. Reload and try again.');
    }

    /* Optional table — every writer in this codebase guards on it, because an
       install that skipped db/schema-additions.sql must still work. */
    if (Database::hasTable('order_status_history')) {
        Database::run(
            'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, ?, NULL, ?)',
            [$order['id'], 'pending', 'cancelled', $reason]
        );
    }

    /* actor_user_id stays NULL: the actor is a customer, and that column is a
       users.id foreign key. Same shape as the checkout audit row. */
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

/* The new status and the stored reason come back so the page can re-render the
   card without a second round trip. */
Response::ok([
    'id'     => $order['id'],
    'status' => 'cancelled',
    'reason' => $reason,
]);
