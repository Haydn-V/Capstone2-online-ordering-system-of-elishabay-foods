<?php
declare(strict_types=1);

/**
 * POST /api/returns/advance.php
 * Body: { "id": "RET-…", "status": "eligible", "note"?, "refund_amount"?,
 *         "refund_method"?, "rejected_reason"? }
 *
 * Requires orders.returns.
 *
 * Same principle as orders/status.php: RETURN_STATUS_STEP in engine.js decides
 * which buttons the screen shows, and that is a rendering decision. The
 * pipeline is enforced here.
 *
 * A return that jumps straight to `processed` skips eligibility assessment and
 * approval — which is how a refund gets paid on a claim nobody checked.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('orders.returns');

$in = Response::input();

$data = Validate::check($in)
    ->required('id', 'Return')
    ->in('status', ['received','validated','eligible','ineligible','approved','rejected','processed'], 'Status')
    ->values();

$note = trim((string) ($in['note'] ?? '')) ?: null;

/* received → validated → (eligible | ineligible) → (approved | rejected) → processed
   Ineligible and rejected are terminal: the claim was refused, and reversing
   that should be a new claim rather than an edit of this one. */
const RETURN_FLOW = [
    'received'   => ['validated', 'rejected'],
    'validated'  => ['eligible', 'ineligible'],
    'eligible'   => ['approved', 'rejected'],
    'ineligible' => [],
    'approved'   => ['processed'],
    'rejected'   => [],
    'processed'  => [],
];

$ret = Database::one(
    'SELECT r.id, r.status, r.qty, r.product_id, r.refund_amount, r.order_id, r.customer_name
       FROM product_returns r WHERE r.id = ?',
    [$data['id']]
);
if ($ret === null) {
    Response::notFound('That return does not exist.');
}

$from = $ret['status'];
$to   = $data['status'];

if ($from === $to) {
    Response::conflict("That return is already {$to}.");
}

$allowed = RETURN_FLOW[$from] ?? [];
if (!in_array($to, $allowed, true)) {
    Response::conflict($allowed === []
        ? "This return is {$from} and cannot be advanced further."
        : sprintf('Cannot move a return from %s to %s. Allowed from %s: %s.',
                  $from, $to, $from, implode(', ', $allowed)));
}

/* Refusing a claim without saying why leaves the customer with no answer and
   the next staff member with no context. */
if (in_array($to, ['rejected', 'ineligible'], true)) {
    $reason = trim((string) ($in['rejected_reason'] ?? '')) ?: $note;
    if ($reason === null) {
        Response::validation('A reason is required.', [
            'rejected_reason' => 'Say why this return is being refused.',
        ]);
    }
} else {
    $reason = null;
}

$refundAmount = $ret['refund_amount'];
$refundMethod = null;

if ($to === 'processed') {
    /* Money is leaving the business here, so the amount and the method are
       both required and the amount is validated rather than accepted. */
    $paid = Validate::check($in)
        ->decimal('refund_amount', 'Refund amount', 0)
        ->in('refund_method', ['cash', 'gcash', 'bank'], 'Refund method')
        ->values();
    $refundAmount = $paid['refund_amount'];
    $refundMethod = $paid['refund_method'];

    /* A refund larger than the line was worth is either a typo or a leak. The
       original line price is what the customer actually paid. */
    $linePaid = Database::scalar(
        'SELECT oi.price_at_purchase * ? FROM order_items oi
          WHERE oi.order_id = ? AND oi.product_id = ? LIMIT 1',
        [$ret['qty'], $ret['order_id'], $ret['product_id']]
    );
    if ($linePaid !== false && $linePaid !== null && $refundAmount > (float) $linePaid + 0.01) {
        Response::conflict(sprintf(
            'Refund of ₱%s exceeds what was paid for this line (₱%s).',
            number_format($refundAmount, 2), number_format((float) $linePaid, 2)
        ));
    }
}

$eligibility = match ($to) {
    'eligible', 'approved', 'processed' => 1,
    'ineligible', 'rejected'            => 0,
    default                             => null,
};

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    Database::run(
        'UPDATE product_returns
            SET status = ?, eligibility = COALESCE(?, eligibility),
                refund_amount = ?, refund_method = COALESCE(?, refund_method),
                notes = COALESCE(?, notes), rejected_reason = COALESCE(?, rejected_reason)
          WHERE id = ? AND status = ?',
        [$to, $eligibility, $refundAmount, $refundMethod, $note, $reason, $ret['id'], $from]
    );

    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this return. Reload and try again.');
    }

    /* Physically returned goods go back on the shelf only once the refund is
       actually processed — not at approval, when the jar may still be with the
       customer. Marked as a `return` adjustment so it shows in the inventory
       log with its reason rather than appearing as unexplained stock. */
    if ($to === 'processed') {
        /* Stock::reverseSale, not a bare stock increment.
           ----------------------------------------------
           This used to be `UPDATE products SET stock = stock + ?` and NOTHING
           ELSE — `sold` was left where it was, so a returned unit counted as
           sold for ever. Meanwhile orders/status.php, restoring stock for a
           CANCELLED order, wrote `sold = GREATEST(sold - ?, 0)`.

           Two implementations of "the goods came back, reverse the sale",
           written months apart, agreeing on the stock half and disagreeing on
           the other. Found by the Phase 4 duplicate-write sweep.

           It was not cosmetic. products.sold drives the Fast/Slow/Non-Moving
           classification on the Inventory Report, the default sort on the
           public storefront, the "N sold" printed on every product card, and
           the Landing editor's Best Sellers ranking and its price x sold
           revenue column. A heavily returned product read as Fast Moving,
           sorted to the front of the shop, and advertised its returns to
           customers as sales.

           Money already got this right — reports/sales.php nets refunds out of
           revenue. Units did not. The two ledgers disagreed. */
        Stock::reverseSale($ret['product_id'], (int) $ret['qty']);
        Database::run(
            'INSERT INTO inventory_adjustments (date, product_id, qty, type, reason, batch_code)
             VALUES (CURDATE(), ?, ?, ?, ?, NULL)',
            [$ret['product_id'], $ret['qty'], 'return',
             sprintf('Customer return %s refunded (order %s).', $ret['id'], $ret['order_id'])]
        );
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('Return %s: %s → %s.%s%s', $ret['id'], $from, $to,
             $to === 'processed'
                 ? sprintf(' Refunded ₱%s via %s.', number_format($refundAmount, 2), $refundMethod)
                 : '',
             $reason ? ' Reason: ' . $reason : ($note ? ' Note: ' . $note : ''))]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::ok([
    'id'          => $ret['id'],
    'from'        => $from,
    'status'      => $to,
    'allowedNext' => RETURN_FLOW[$to] ?? [],
    'stockReturned' => $to === 'processed' ? (int) $ret['qty'] : 0,
]);
