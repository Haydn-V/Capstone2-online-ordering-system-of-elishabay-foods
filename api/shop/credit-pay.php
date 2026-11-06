<?php
declare(strict_types=1);

/** POST /api/shop/credit-pay.php lets a retailer submit a payment toward their own Net account as pending until staff verify it, with a screenshot that must have been uploaded by this session. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$customer = Auth::requireCustomer('Sign in to pay your balance.');

$status = Database::scalar('SELECT status FROM customers WHERE id = ?', [$customer['id']]);
if ($status !== 'retailer') {
    Response::forbidden('Payment schemes are available to approved retail partners.');
}

$in = Response::input();

$data = Validate::check($in)
    ->required('account_id', 'Account')
    ->decimal('amount', 'Amount', 0.01)
    ->in('method', ['gcash', 'bank'], 'Payment method')
    ->required('ref_num', 'Reference number')
    ->maxLen('ref_num', 100, 'Reference number')
    ->values();

$proof = trim((string) ($in['proof_image'] ?? ''));
if ($proof === '') {
    Response::validation('Attach the payment screenshot.', [
        'proof_image' => 'Upload a screenshot of the transfer so we can match it.',
    ]);
}
$issued = $_SESSION['eb_issued_uploads'] ?? [];
if (!preg_match('#^/uploads/references/[a-f0-9]{32}\.webp$#', $proof)
    || !in_array($proof, $issued, true)
    || !is_file(dirname(__DIR__, 2) . $proof)) {
    Response::validation('Attach the screenshot again.', [
        'proof_image' => 'That screenshot is not one you uploaded in this session. Choose it again.',
    ]);
}

$amount = (float) $data['amount'];
[$ref, $refErr] = Payments::checkRef($data['method'], trim((string) $data['ref_num']));
if ($refErr !== null) {
    Response::validation('Check the reference number.', ['ref_num' => $refErr]);
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* Same answer for a missing or someone else's account. */
    $acct = Payments::lockAccount((string) $data['account_id']);
    if ($acct === null || (string) $acct['customerId'] !== (string) $customer['id']) {
        $pdo->rollBack();
        Response::notFound('That payment account was not found on your profile.');
    }

    $problem = Payments::amountProblem($amount, $acct);
    if ($problem !== null) {
        $pdo->rollBack();
        Response::validation('Check the amount.', ['amount' => $problem]);
    }

    $paymentId = Payments::addPayment($acct, $amount, $data['method'], $ref, $proof, 'customer', null);

    /* Payment notifications open Payment Schemes, linked to the order when there is one. */
    Notify::create(
        'payment',
        sprintf('%s sent ₱%s by %s toward %s (%s) — waiting for review.',
            $customer['name'] ?? $acct['name'], number_format($amount, 2),
            $data['method'] === 'bank' ? 'bank transfer' : 'GCash',
            $acct['orderId'] ?: $acct['id'], $acct['scheme']),
        $acct['orderId'] ? ['order' => $acct['orderId']] : []
    );

    /* actor_user_id stays NULL because the actor is a customer. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$customer['name'] ?? $acct['name'], 'order',
         sprintf('Credit payment #%d sent: ₱%s %s toward %s (%s), ref %s — pending review.',
             $paymentId, number_format($amount, 2), $data['method'], $acct['id'], $acct['scheme'], $ref)]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

/* Remove the screenshot from the discardable list now that it is attached to a payment. */
$_SESSION['eb_issued_uploads'] = array_values(array_filter(
    $_SESSION['eb_issued_uploads'] ?? [],
    static fn($p) => $p !== $proof
));

$row = Database::one(Payments::accountSelect() . ' WHERE pa.id = ?', [$acct['id']]);

Response::created([
    'payment' => Payments::describePayment(
        Database::one('SELECT cp.*, NULL AS decided_by_name FROM credit_payments cp WHERE cp.id = ?', [$paymentId])
    ),
    'account' => Payments::describeAccount($row),
]);
