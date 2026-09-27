<?php
declare(strict_types=1);

/**
 * POST /api/orders/verify-payment.php
 * Body: { "id": "ORD-20260617-001", "verified": true, "note": "optional" }
 *
 * Requires orders.accept.
 *
 * Verification is a judgement a person makes by looking at a payment proof
 * against the order total. What the server can do is refuse the cases that are
 * obviously wrong — no proof uploaded at all, or an order already settled — and
 * record who made the call, which is the part that matters when a payment is
 * later disputed.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('orders.accept');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which order?', ['id' => 'Order is required.']);
}
if (!array_key_exists('verified', $in)) {
    Response::badRequest('Specify whether the payment is verified.');
}
$verified = filter_var($in['verified'], FILTER_VALIDATE_BOOLEAN);
$note     = trim((string) ($in['note'] ?? '')) ?: null;

$order = Database::one(
    'SELECT id, status, total, withholding_tax, pay_verified, proof_uploaded, proof_amount, proof_ref_num, method
       FROM orders WHERE id = ?',
    [$in['id']]
);
if ($order === null) {
    Response::notFound('That order does not exist.');
}

if (in_array($order['status'], ['completed', 'cancelled'], true)) {
    Response::conflict("This order is {$order['status']} — its payment cannot be re-verified.");
}

if ((bool) $order['pay_verified'] === $verified) {
    Response::conflict($verified
        ? 'That payment is already verified.'
        : 'That payment is already marked unverified.');
}

/* A Net 30/60/90 order is not verified here. Nothing was paid at the time;
   its payments are sent later and checked one by one in Payment Schemes. */
if (Payments::isCredit((string) $order['method'])) {
    Response::conflict('This order is on ' . Payments::schemeLabel((string) $order['method'])
        . ' terms. Its payments are checked in Payment Schemes, not here.');
}

/* Cash on pickup has no proof to upload, so only electronic methods are held
   to that requirement. */
$needsProof = in_array($order['method'], ['gcash', 'bank'], true);
if ($verified && $needsProof && (int) $order['proof_uploaded'] !== 1) {
    Response::conflict('No payment proof has been uploaded for this order yet.');
}

/* A short payment is a real event, not a validation error — it gets recorded
   and surfaced rather than blocked, because the operator may be accepting a
   partial deliberately. The mismatch goes into the audit trail either way. */
$mismatch = null;
if ($verified && $needsProof) {
    /* Against the AMOUNT DUE: a withholding retailer pays the total less the tax
       it keeps for the BIR (migration 014), and that is a correct payment. */
    $due  = round((float) $order['total'] - (float) $order['withholding_tax'], 2);
    $diff = round((float) $order['proof_amount'] - $due, 2);
    if (abs($diff) >= 0.01) {
        $mismatch = sprintf('Proof %s expected by ₱%s (proof ₱%s vs total ₱%s)',
            $diff < 0 ? 'short of' : 'over',
            number_format(abs($diff), 2),
            number_format((float) $order['proof_amount'], 2),
            number_format($due, 2));
    }
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    Database::run('UPDATE orders SET pay_verified = ? WHERE id = ?', [$verified ? 1 : 0, $order['id']]);

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('Payment %s for order %s (%s%s).%s',
             $verified ? 'VERIFIED' : 'marked unverified',
             $order['id'],
             $order['proof_ref_num'] ?: 'no reference',
             $mismatch ? ' — ' . $mismatch : '',
             $note ? ' Note: ' . $note : '')]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Tell the customer (their bell in the storefront header). After the commit:
   a notification that fails must never undo the change itself. */
CustomerNotify::payment($order['id'], $verified);

Response::ok([
    'id'          => $order['id'],
    'payVerified' => $verified,
    'mismatch'    => $mismatch,
]);
