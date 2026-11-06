<?php
declare(strict_types=1);

/** POST /api/orders/verify-payment.php (needs orders.accept) records a staff member's decision on a payment proof, refusing orders with no proof or already settled. */

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

/* Net orders are not verified here; their payments are checked in Payment Schemes. */
if (Payments::isCredit((string) $order['method'])) {
    Response::conflict('This order is on ' . Payments::schemeLabel((string) $order['method'])
        . ' terms. Its payments are checked in Payment Schemes, not here.');
}

/* Only electronic methods require an uploaded proof (cash has none). */
$needsProof = in_array($order['method'], ['gcash', 'bank'], true);
if ($verified && $needsProof && (int) $order['proof_uploaded'] !== 1) {
    Response::conflict('No payment proof has been uploaded for this order yet.');
}

/* A short payment is recorded and flagged in the audit, not blocked, since staff may accept a partial on purpose. */
$mismatch = null;
if ($verified && $needsProof) {
    /* Compare against the amount due, since a withholding retailer pays the total minus the tax it keeps. */
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

    Database::run('UPDATE orders SET pay_verified = ?, cashier = COALESCE(cashier, ?) WHERE id = ?',
                  [$verified ? 1 : 0, $user['id'], $order['id']]);

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

/* Notify the customer after the commit, so a failed notification never undoes the change. */
CustomerNotify::payment($order['id'], $verified);

Response::ok([
    'id'          => $order['id'],
    'payVerified' => $verified,
    'mismatch'    => $mismatch,
]);
