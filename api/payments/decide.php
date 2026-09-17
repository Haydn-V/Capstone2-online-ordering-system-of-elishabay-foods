<?php
declare(strict_types=1);

/**
 * POST /api/payments/decide.php — verify or reject a payment a retailer sent.
 *
 * Body: { "payment_id": 12, "decision": "verify"|"reject", "reason"?: "…" }
 *
 * Requires payments.manage.
 *
 * Net payments are checked HERE, in Payment Schemes, not in Payment
 * Verification: the question is not "is this order paid" but "does this
 * transfer count toward this account", and the answer needs the account's
 * history beside it.
 *
 *   verify   the amount counts as paid, on the payment's own paid_date. If it
 *            covers what is left, the account settles (Payments::refreshAccount).
 *   reject   a reason is REQUIRED — the retailer reads it on their Payment
 *            Schemes page, and "rejected" with no cause is indistinguishable
 *            from "ignored".
 *
 * Only a `pending` payment can be decided. A decision is final; a wrong
 * rejection is corrected by the retailer sending the payment again.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('payments.manage');

$in = Response::input();

$paymentId = (int) ($in['payment_id'] ?? 0);
$decision  = (string) ($in['decision'] ?? '');
if ($paymentId <= 0) {
    Response::validation('Which payment?', ['payment_id' => 'Payment is required.']);
}
if (!in_array($decision, ['verify', 'reject'], true)) {
    Response::validation('Check the decision.', ['decision' => 'Use verify or reject.']);
}
$reason = trim((string) ($in['reason'] ?? ''));
if ($decision === 'reject') {
    if ($reason === '') {
        Response::validation('Say why.', ['reason' => 'The retailer is shown this reason. Say what is wrong with the payment.']);
    }
    if (mb_strlen($reason) > 500) {
        Response::validation('Keep it shorter.', ['reason' => 'Keep the reason under 500 characters.']);
    }
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    $pay = Database::one('SELECT id, account_id, amount, status, method, ref_num FROM credit_payments WHERE id = ? FOR UPDATE', [$paymentId]);
    if ($pay === null) {
        $pdo->rollBack();
        Response::notFound('That payment does not exist.');
    }
    if ($pay['status'] !== 'pending') {
        $pdo->rollBack();
        Response::conflict("This payment was already {$pay['status']}. Decisions are final.");
    }

    $acct = Payments::lockAccount($pay['account_id']);
    $amount = (float) $pay['amount'];

    if ($decision === 'verify') {
        /* Another payment may have been verified since this one was sent, so
           what is left can now be less than this transfer. Counting it anyway
           would record the account as overpaid with nowhere for the extra to go. */
        if ($amount > $acct['remaining'] + 0.004) {
            $pdo->rollBack();
            Response::conflict(sprintf(
                'This payment (₱%s) is more than what is left on the account (₱%s). Reject it and ask the retailer to send the right amount.',
                number_format($amount, 2), number_format($acct['remaining'], 2)
            ));
        }
        Database::run(
            "UPDATE credit_payments SET status = 'verified', decided_by = ?, decided_at = NOW()
              WHERE id = ? AND status = 'pending'",
            [$user['id'], $paymentId]
        );
    } else {
        Database::run(
            "UPDATE credit_payments SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = NOW()
              WHERE id = ? AND status = 'pending'",
            [$reason, $user['id'], $paymentId]
        );
    }

    $after = Payments::refreshAccount($pay['account_id']);

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         $decision === 'verify'
            ? sprintf('Verified credit payment #%d: ₱%s %s (ref %s) toward %s (%s) — ₱%s left%s.',
                $paymentId, number_format($amount, 2), $pay['method'] ?? '', $pay['ref_num'] ?? '—',
                $acct['id'], $acct['scheme'], number_format($after['remaining'], 2),
                $after['settled'] ? ', account settled' : '')
            : sprintf('Rejected credit payment #%d: ₱%s toward %s (%s). Reason: %s',
                $paymentId, number_format($amount, 2), $acct['id'], $acct['scheme'], $reason)]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

Response::ok([
    'payment' => Payments::describePayment(Database::one(
        'SELECT cp.*, u.name AS decided_by_name FROM credit_payments cp
           LEFT JOIN users u ON u.id = cp.decided_by WHERE cp.id = ?',
        [$paymentId]
    )),
    'account' => $after,
]);
