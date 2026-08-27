<?php
declare(strict_types=1);

/**
 * POST /api/orders/status.php
 * Body: { "id": "ORD-20260617-001", "status": "accepted", "note": "optional" }
 *
 * Requires orders.status, or orders.accept for the accept/hold/cancel moves
 * that the Order Queue makes.
 *
 * THE TRANSITION TABLE IS ENFORCED HERE.
 *
 * STATUS_TRANSITIONS in engine.js decides which options the status modal
 * offers. That is a dropdown — it shapes what a careful user picks, and it
 * stops nobody from posting `{"status":"completed"}` against a cancelled
 * order. An order that jumps from pending straight to completed skips payment
 * verification entirely, which is the sort of thing that only shows up in a
 * reconciliation months later. So the same table lives here, and this copy is
 * the one that counts.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::requireAny('orders.status', 'orders.accept');

$in = Response::input();

$data = Validate::check($in)
    ->required('id', 'Order')
    ->in('status', ['pending','on-hold','accepted','shipping','delivered','completed','cancelled'], 'Status')
    ->values();

$note = trim((string) ($in['note'] ?? '')) ?: null;

/* COURIER TRACKING NUMBER (Task 6).

   The stated Limitation says the system does not integrate with courier APIs
   but that "tracking numbers will be issued upon dispatch and will serve as
   proof of shipment". There was no field for one anywhere, so the limitation
   promised something the system could not do at all.

   Required when a DELIVERY order moves to shipping, because that is the moment
   the promise is made and the only moment the number exists. Ignored for a
   pickup order — nothing is dispatched — and for every other transition, so a
   value posted alongside an unrelated status change is discarded rather than
   silently stored against the wrong event. */
$tracking = trim((string) ($in['tracking_number'] ?? '')) ?: null;
if ($tracking !== null && mb_strlen($tracking) > 60) {
    Response::validation('Check the highlighted fields.', [
        'tracking_number' => 'A tracking number is at most 60 characters.',
    ]);
}

/* Same map as STATUS_TRANSITIONS in engine.js. completed and cancelled are
   terminal — an order that has been settled or called off does not move again,
   and reopening one has to be a deliberate new record rather than a quiet edit. */
const TRANSITIONS = [
    'pending'   => ['accepted', 'on-hold', 'cancelled'],
    'accepted'  => ['shipping', 'on-hold', 'cancelled'],
    'shipping'  => ['delivered', 'on-hold'],
    'delivered' => ['completed', 'on-hold'],
    'on-hold'   => ['accepted', 'cancelled'],
    'completed' => [],
    'cancelled' => [],
];

/* Moves that need a reason. Putting an order on hold or cancelling it without
   recording why leaves the next person with no way to act on it. */
const REASON_REQUIRED = ['on-hold', 'cancelled'];

$order = Database::one(
    'SELECT id, status, type, order_type, pay_verified, total, customer_name, tracking_number
       FROM orders WHERE id = ?',
    [$data['id']]
);
if ($order === null) {
    Response::notFound('That order does not exist.');
}

$from = $order['status'];
$to   = $data['status'];

if ($from === $to) {
    Response::conflict("That order is already {$to}.");
}

$allowed = TRANSITIONS[$from] ?? [];
if (!in_array($to, $allowed, true)) {
    Response::conflict($allowed === []
        ? "This order is {$from} and cannot be changed further."
        : sprintf('Cannot move an order from %s to %s. Allowed from %s: %s.',
                  $from, $to, $from, implode(', ', $allowed)));
}

if (in_array($to, REASON_REQUIRED, true) && $note === null) {
    Response::validation('A reason is required.', [
        'note' => $to === 'cancelled'
            ? 'Say why this order is being cancelled.'
            : 'Say why this order is being held.',
    ]);
}

/* Accepting an order with unverified payment is how unpaid goods ship. The
   Payment Verification screen exists precisely to clear this first. */
if ($to === 'accepted' && (int) $order['pay_verified'] !== 1) {
    Response::conflict('Verify the payment before accepting this order.');
}

/* A delivery cannot be dispatched without the number that proves it was. */
$needsTracking = $to === 'shipping' && $order['order_type'] === 'delivery';
if ($needsTracking && $tracking === null && ($order['tracking_number'] ?? null) === null) {
    Response::validation('Check the highlighted fields.', [
        'tracking_number' => 'Enter the courier tracking number before marking this order shipped.',
    ]);
}
/* Keep whatever is already stored if this move does not carry a new one — a
   later delivered/completed transition must not wipe the number. */
$trackingToStore = $needsTracking ? ($tracking ?? $order['tracking_number']) : ($order['tracking_number'] ?? null);

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* delivered_at is stamped and cleared in the same statement that moves the
       status, so the two can never disagree.

       A column on `orders` rather than a lookup into order_status_history: that
       table is optional and every writer guards on hasTable(), so the one-hour
       auto-complete would silently stop running on a base install if it
       depended on it.

       Cleared when the order leaves `delivered` — otherwise an order sent back
       to shipping keeps an old timestamp and the sweep completes it an hour
       later regardless of where it actually is. */
    Database::run(
        'UPDATE orders
            SET status = ?,
                delivered_at = CASE WHEN ? = 1 THEN NOW() ELSE NULL END,
                tracking_number = ?
          WHERE id = ? AND status = ?',
        /* NOW() rather than a PHP timestamp: the due dates, the overdue
           calculation and this all have to be measured against one clock, and
           the database is the one they already share (D1). */
        [$to, $to === 'delivered' ? 1 : 0, $trackingToStore, $order['id'], $from]
    );

    /* Guard against two staff moving the same order at once: the UPDATE above
       is conditional on the status we read, so if somebody else changed it in
       between, no row matches and we stop rather than overwrite their move. */
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this order. Reload and try again.');
    }

    /* ------------------------------------------------------------------
       Stock moves with the order, for online orders only.

       A walk-in sale already decremented stock at the till (pos/checkout.php)
       because the goods left the counter. An online order is a claim: stock is
       committed when staff ACCEPT it, and returned if it is later cancelled.

       Doing it at order time instead would let anyone zero the inventory by
       placing orders nobody accepts. Doing it never — which is what happened
       before — means the shop can sell the same jar indefinitely.

       `accepted` is the only route into shipping/delivered/completed, so a
       cancellation from any of those means stock was committed and must come
       back.
       ------------------------------------------------------------------ */
    $committedStates = ['accepted', 'shipping', 'delivered', 'completed'];
    $isOnline = $order['type'] === 'online';

    if ($isOnline && $to === 'accepted' && !in_array($from, $committedStates, true)) {
        $items = Database::all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [$order['id']]);
        foreach ($items as $it) {
            $affected = Stock::sell($it['product_id'], (int) $it['qty']);
            /* Stock can have been sold out between the customer ordering and
               staff accepting. Refusing here, with the product named, beats
               driving stock negative or silently shipping nothing. */
            if ($affected < 1) {
                $name = Database::scalar('SELECT name FROM products WHERE id = ?', [$it['product_id']]);
                $have = Database::scalar('SELECT stock FROM products WHERE id = ?', [$it['product_id']]);
                $pdo->rollBack();
                Response::conflict(sprintf(
                    'Not enough stock to accept this order — %s needs %d but only %d remain. Restock first, or put the order on hold.',
                    $name, $it['qty'], $have
                ));
            }
        }
    }

    if ($isOnline && $to === 'cancelled' && in_array($from, $committedStates, true)) {
        $items = Database::all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [$order['id']]);
        foreach ($items as $it) {
            Stock::reverseSale($it['product_id'], (int) $it['qty']);
        }
    }

    if (Database::hasTable('order_status_history')) {
        Database::run(
            'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, ?, ?, ?)',
            [$order['id'], $from, $to, $user['id'], $note]
        );
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('Order %s: %s → %s.%s%s', $order['id'], $from, $to,
             /* The tracking number goes in the audit line because it is the
                proof-of-dispatch the Limitation promises — a shipment recorded
                without it is exactly the gap this field exists to close. */
             $needsTracking && $trackingToStore ? ' Tracking: ' . $trackingToStore . '.' : '',
             $note ? ' Reason: ' . $note : '')]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::ok([
    'id'      => $order['id'],
    'from'    => $from,
    'status'  => $to,
    'note'    => $note,
    /* So the client can rebuild the action buttons without a second request. */
    'allowedNext' => TRANSITIONS[$to] ?? [],
]);
