<?php
declare(strict_types=1);

/**
 * POST /api/payments/record.php — staff record a payment received at the counter.
 *
 * Body: { "account_id": "pay-01", "amount": 2000, "method": "cash"|"gcash"|"bank",
 *         "ref_num"?: "…", "note"?: "…", "paid_date"?: "YYYY-MM-DD" }
 *
 * Requires payments.manage.
 *
 * Replaces "Mark Paid". A retailer who walks in with ₱2,000 toward a ₱4,250
 * balance is recorded as exactly that: ₱2,000 paid, ₱2,250 left. The payment is
 * `verified` at once, by the person recording it — they are holding the money,
 * or watched the transfer arrive.
 *
 * `paid_date` is when the money arrived and is the revenue date. It defaults to
 * today; a back-dated entry (money received yesterday, entered this morning) is
 * allowed but never in the future or before the account was opened.
 *
 * A reference number is required for GCash and bank, as it is everywhere else
 * in the system: it is the only thing that ties the entry to a real transfer.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('payments.manage');

$in = Response::input();

$data = Validate::check($in)
    ->required('account_id', 'Account')
    ->decimal('amount', 'Amount', 0.01)
    ->in('method', Payments::PAYMENT_METHODS, 'Payment method')
    ->values();

$ref  = trim((string) ($in['ref_num'] ?? '')) ?: null;
$note = trim((string) ($in['note'] ?? '')) ?: null;
if ($data['method'] !== 'cash' && $ref === null) {
    Response::validation('Add the reference number.', [
        'ref_num' => 'GCash and bank payments need the transfer reference number.',
    ]);
}
if ($ref !== null && mb_strlen($ref) > 100) {
    Response::validation('Check the reference.', ['ref_num' => 'Keep it under 100 characters.']);
}
if ($note !== null && mb_strlen($note) > 500) {
    Response::validation('Keep the note shorter.', ['note' => 'Keep it under 500 characters.']);
}

$paidDate = trim((string) ($in['paid_date'] ?? '')) ?: null;
if ($paidDate !== null) {
    $d = DateTime::createFromFormat('Y-m-d', $paidDate);
    if (!$d || $d->format('Y-m-d') !== $paidDate) {
        Response::validation('Check the date.', ['paid_date' => 'Use YYYY-MM-DD.']);
    }
    if ($paidDate > Dates::today()) {
        Response::validation('Check the date.', ['paid_date' => 'A payment cannot be dated in the future.']);
    }
}

$amount = (float) $data['amount'];

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    $acct = Payments::lockAccount((string) $data['account_id']);
    if ($acct === null) {
        $pdo->rollBack();
        Response::notFound('That payment account does not exist.');
    }
    if ($paidDate !== null && $paidDate < substr((string) $acct['openedAt'], 0, 10)) {
        $pdo->rollBack();
        Response::validation('Check the date.', ['paid_date' => 'That is before this account was opened.']);
    }

    $problem = Payments::amountProblem($amount, $acct);
    if ($problem !== null) {
        $pdo->rollBack();
        Response::validation('Check the amount.', ['amount' => $problem]);
    }

    $paymentId = Payments::addPayment($acct, $amount, $data['method'], $ref, null, 'staff', $user, $note, $paidDate);
    $after     = Payments::refreshAccount($acct['id']);

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('Recorded credit payment #%d: ₱%s %s%s toward %s (%s) for %s — ₱%s left%s.%s',
             $paymentId, number_format($amount, 2), $data['method'], $ref ? " (ref {$ref})" : '',
             $acct['id'], $acct['scheme'], $acct['name'], number_format($after['remaining'], 2),
             $after['settled'] ? ', account settled' : '', $note ? ' Note: ' . $note : '')]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

Response::created([
    'payment' => Payments::describePayment(Database::one(
        'SELECT cp.*, u.name AS decided_by_name FROM credit_payments cp
           LEFT JOIN users u ON u.id = cp.decided_by WHERE cp.id = ?',
        [$paymentId]
    )),
    'account' => $after,
]);
