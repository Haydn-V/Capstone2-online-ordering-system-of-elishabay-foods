<?php
declare(strict_types=1);

/** POST /api/orders/status.php (needs orders.status, or orders.accept for accept/hold/cancel) enforces the allowed status transitions on the server, mirroring STATUS_TRANSITIONS in engine.js. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::requireAny('orders.status', 'orders.accept');

$in = Response::input();

$data = Validate::check($in)
    ->required('id', 'Order')
    ->in('status', ['pending','on-hold','accepted','shipping','delivered','completed','cancelled'], 'Status')
    ->values();

$note = trim((string) ($in['note'] ?? '')) ?: null;

/* A tracking number is required when a delivery order moves to shipping, and ignored for every other move. */
$tracking = strtoupper(trim((string) ($in['tracking_number'] ?? ''))) ?: null;
/* Courier numbers run about 10–17 characters (LBC, J&T, PhilPost); allow 8–25 letters, digits or dashes. */
if ($tracking !== null && !preg_match('/^(?=.*[0-9])[A-Z0-9-]{8,25}$/', $tracking)) {
    Response::validation('Check the tracking number.', [
        'tracking_number' => 'Tracking numbers are 8–25 letters, numbers or dashes.',
    ]);
}
if ($tracking !== null && mb_strlen($tracking) > 60) {
    Response::validation('Check the highlighted fields.', [
        'tracking_number' => 'A tracking number is at most 60 characters.',
    ]);
}

/* Same map as STATUS_TRANSITIONS in engine.js: one straight line, with cancelling only before acceptance; completed and
   cancelled are final. On Hold was retired, so nothing moves into it; an order already on hold can still be accepted or
   cancelled so it is never stuck. */
const TRANSITIONS = [
    'pending'   => ['accepted', 'cancelled'],
    'accepted'  => ['shipping'],
    'shipping'  => ['delivered'],
    'delivered' => ['completed'],
    'on-hold'   => ['accepted', 'cancelled'],
    'completed' => [],
    'cancelled' => [],
];

/* Online pickup orders have nothing to ship, so staff only complete them at handover or cancel them; mirrors PICKUP_TRANSITIONS in engine.js. */
const PICKUP_TRANSITIONS = [
    'pending'  => ['completed', 'cancelled'],
    'on-hold'  => ['completed', 'cancelled'],
    'accepted' => ['completed'],
];

/* Cancelling an order requires a reason. */
const REASON_REQUIRED = ['cancelled'];

$order = Database::one(
    'SELECT id, status, type, order_type, pay_verified, total, customer_name, tracking_number, method
       FROM orders WHERE id = ?',
    [$data['id']]
);
if ($order === null) {
    Response::notFound('That order does not exist.');
}

/* One tracking number per order: refuse one already on another order (dashes and spaces ignored; old rows are only compared, never changed). */
if ($tracking !== null) {
    $usedBy = Database::scalar(
        "SELECT id FROM orders
          WHERE id <> ? AND REPLACE(REPLACE(UPPER(tracking_number), ' ', ''), '-', '') = ?
          LIMIT 1",
        [$order['id'], str_replace(['-', ' '], '', $tracking)]
    );
    if ($usedBy) {
        Response::validation('Check the tracking number.', [
            'tracking_number' => sprintf('This tracking number is already used on order %s.', $usedBy),
        ]);
    }
}

$from = $order['status'];
$to   = $data['status'];

if ($from === $to) {
    Response::conflict("That order is already {$to}.");
}

$isPickup = $order['type'] === 'online' && $order['order_type'] === 'pickup';
$allowed  = $isPickup ? (PICKUP_TRANSITIONS[$from] ?? []) : (TRANSITIONS[$from] ?? []);
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

/* Payment must be verified before accepting, except Net orders, whose payments are checked later in Payment Schemes. */
/* Cash orders are also exempt, since there is no proof to verify; the cash is counted when handed over. */
$onTerms = Payments::isCredit((string) $order['method']);
$isCash  = (string) $order['method'] === 'cash';
$committedStates = ['accepted', 'shipping', 'delivered', 'completed'];
/* Completing a pickup straight from pending or on hold is its acceptance too, so the same checks and stock commit apply. */
$commitsStock = in_array($to, ['accepted', 'completed'], true) && !in_array($from, $committedStates, true);
if ($commitsStock && !$onTerms && !$isCash && (int) $order['pay_verified'] !== 1) {
    Response::conflict($to === 'completed'
        ? 'Verify the payment before completing this order.'
        : 'Verify the payment before accepting this order.');
}

/* A cash pickup is paid at handover, so completing it is what marks it paid and counts it in sales. */
$cashPaidNow = $isPickup && $isCash && $to === 'completed';

/* A delivery cannot be dispatched without the number that proves it was. */
$needsTracking = $to === 'shipping' && $order['order_type'] === 'delivery';
if ($needsTracking && $tracking === null && ($order['tracking_number'] ?? null) === null) {
    Response::validation('Check the highlighted fields.', [
        'tracking_number' => 'Enter the courier tracking number before marking this order shipped.',
    ]);
}
/* Keep the stored tracking number when this move does not bring a new one. */
$trackingToStore = $needsTracking ? ($tracking ?? $order['tracking_number']) : ($order['tracking_number'] ?? null);

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* delivered_at is set and cleared in the same statement as the status, so the one-hour auto-complete always measures from the real delivery. */
    Database::run(
        'UPDATE orders
            SET status = ?,
                delivered_at = CASE WHEN ? = 1 THEN NOW() ELSE NULL END,
                tracking_number = ?,
                cashier = COALESCE(cashier, ?)
          WHERE id = ? AND status = ?',
        /* Use the database's NOW() so all date rules share one clock. */
        /* The first staff member to process an online order signs its invoice; COALESCE keeps a walk-in's till cashier. */
        [$to, $to === 'delivered' ? 1 : 0, $trackingToStore, $user['id'], $order['id'], $from]
    );

    /* The update is conditional on the status we read, so if another staff member changed it meanwhile we stop instead of overwriting. */
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this order. Reload and try again.');
    }
    /* Handed to the courier: the arrival window restarts from today (Shipping::markShipped). */
    if ($to === 'shipping') {
        Shipping::markShipped($order['id']);
    }
    if ($to === 'completed') {
        Returns::stampCompleted($order['id']);   /* starts the 24h return window */
    }

    /* Online orders commit stock when accepted (or a pickup when completed) and return it if cancelled after that (walk-ins already took stock at the till). */
    $isOnline = $order['type'] === 'online';

    if ($isOnline && $commitsStock) {
        $items = Database::all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [$order['id']]);
        foreach ($items as $it) {
            $affected = Stock::sell($it['product_id'], (int) $it['qty']);
            /* Refuse acceptance and name the product if stock ran out since the order was placed. */
            if ($affected < 1) {
                $name = Database::scalar('SELECT name FROM products WHERE id = ?', [$it['product_id']]);
                $have = Database::scalar('SELECT stock FROM products WHERE id = ?', [$it['product_id']]);
                $pdo->rollBack();
                Response::conflict(sprintf(
                    'Not enough stock to accept this order — %s needs %d but only %d remain. Restock first, or cancel the order.',
                    $name, $it['qty'], $have
                ));
            }
            /* Record which lots the units came from (earliest expiry first). */
            Stock::allocateLots($order['id'], $it['product_id'], (int) $it['qty']);
        }
    }

    /* A cancelled walk-in delivery already took its stock at the till, so always put it back. */
    $stockOut = $isOnline ? in_array($from, $committedStates, true) : true;
    if ($to === 'cancelled' && $stockOut) {
        $items = Database::all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [$order['id']]);
        foreach ($items as $it) {
            Stock::reverseSale($it['product_id'], (int) $it['qty']);
        }
        /* The units go back into the same lots they were taken from. */
        Stock::releaseLots($order['id']);
    }
    /* A cancelled Net order owes nothing: close its account so Payment Schemes stops billing it. */
    if ($to === 'cancelled' && $onTerms) {
        Payments::closeForCancelledOrder($order['id']);
    }

    if ($cashPaidNow) {
        Database::run('UPDATE orders SET pay_verified = 1 WHERE id = ?', [$order['id']]);
    }
    $finalStatus = $to;

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
         sprintf('Order %s: %s → %s.%s%s%s', $order['id'], $from, $finalStatus,
              $cashPaidNow ? ' Cash paid on pickup and counted in sales.' : '',
             /* Include the tracking number in the audit line as proof of dispatch. */
             $needsTracking && $trackingToStore ? ' Tracking: ' . $trackingToStore . '.' : '',
             $note ? ' Reason: ' . $note : '')]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Notify the customer after the commit, so a failed notification never undoes the change. */
CustomerNotify::orderStatus($order['id'], $to, $note);

Response::ok([
    'id'      => $order['id'],
    'from'    => $from,
    'status'  => $finalStatus,
    'autoCompleted' => $cashPaidNow,
    'note'    => $note,
    /* So the client can rebuild the action buttons without a second request. */
    'allowedNext' => $isPickup ? (PICKUP_TRANSITIONS[$finalStatus] ?? []) : (TRANSITIONS[$finalStatus] ?? []),
]);
