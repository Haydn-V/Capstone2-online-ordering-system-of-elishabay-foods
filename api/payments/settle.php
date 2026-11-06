<?php
declare(strict_types=1);

/** POST /api/payments/settle.php (needs payments.manage) is the old "Mark Paid", now recording a staff payment for whatever is left; paid:false is refused. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('payments.manage');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which account?', ['id' => 'Account is required.']);
}
if (!array_key_exists('paid', $in)) {
    Response::badRequest('Specify whether the account is being marked paid or unpaid.');
}
if (!filter_var($in['paid'], FILTER_VALIDATE_BOOLEAN)) {
    Response::conflict('Accounts are not reopened by hand any more. Reject the payment that settled it in Payment Schemes and the balance reopens.');
}

$method = (string) ($in['method'] ?? 'cash');
if (!in_array($method, Payments::PAYMENT_METHODS, true)) {
    Response::validation('Check the payment method.', ['method' => 'Use cash, gcash or bank.']);
}
$ref  = trim((string) ($in['ref_num'] ?? '')) ?: null;
$note = trim((string) ($in['note'] ?? '')) ?: null;
[$ref, $refErr] = Payments::checkRef($method, $ref);
if ($refErr !== null) {
    Response::validation('Check the reference number.', ['ref_num' => $refErr]);
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    $acct = Payments::lockAccount((string) $in['id']);
    if ($acct === null) {
        $pdo->rollBack();
        Response::notFound('That payment account does not exist.');
    }
    if ($acct['settled']) {
        $pdo->rollBack();
        Response::conflict('That account is already marked paid.');
    }
    if ($acct['payable'] <= 0) {
        $pdo->rollBack();
        Response::conflict(sprintf(
            '₱%s sent by the retailer is waiting for review on this account. Verify or reject it first.',
            number_format($acct['pendingAmount'], 2)
        ));
    }

    $amount = $acct['payable'];
    Payments::addPayment($acct, $amount, $method, $ref, null, 'staff', $user,
        $note ?? 'Marked paid in full.');
    $after = Payments::refreshAccount($acct['id']);

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('Payment recorded: %s (%s) — ₱%s %s, marked paid in full%s.%s',
             $acct['name'], $acct['scheme'], number_format($amount, 2), $method,
             $acct['penalty'] > 0 ? sprintf(' incl. ₱%s penalty', number_format($acct['penalty'], 2)) : '',
             $note ? ' Note: ' . $note : '')]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

Response::ok([
    'id'       => $acct['id'],
    'paid'     => (bool) ($after['settled'] ?? false),
    'balance'  => $acct['billed'],
    'penalty'  => $acct['penalty'],
    'recorded' => $amount,
    'settled'  => $acct['owed'],
]);
