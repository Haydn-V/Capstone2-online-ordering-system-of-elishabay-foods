<?php
declare(strict_types=1);

/**
 * POST /api/shop/credit-pay.php — a retailer pays toward one of their Net accounts.
 *
 * Body: { "account_id": "pay-05", "amount": 5000, "method": "gcash"|"bank",
 *         "ref_num": "…", "proof_image": "/uploads/references/<32 hex>.webp" }
 *
 * Requires a customer session, and the customer must be a retailer.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Nothing. A retailer could see what they owed on Payment Schemes and had no way
 * to pay any of it from the site — settling a Net balance meant a phone call,
 * and a cashier pressing "Mark Paid" on an account with no record of how much
 * had arrived or when.
 *
 * WHAT IT DOES
 * ------------
 * Records ONE payment as `pending`. Nothing about the balance changes until
 * staff verify it in Payment Schemes (payments/decide.php) — a screenshot is a
 * claim, exactly as it is at checkout. A part payment is normal: any amount up
 * to what is still payable (Payments::amountProblem), so ₱13,330 can arrive as
 * three transfers.
 *
 * The screenshot must be one api/uploads/image.php issued to THIS session under
 * `references`. Matching the path's shape alone would let a retailer attach any
 * file whose name they could guess; matching the issued list proves it is
 * theirs.
 *
 * `paid_date` is today — the day they paid, which is the day it counts as
 * revenue once verified.
 */

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
$ref    = trim((string) $data['ref_num']);

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* Same answer for "no such account" and "not yours": telling the two apart
       would let anyone enumerate account ids. */
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

    /* `payment` notifications open Payment Schemes in the portal. Linked to
       the order when the account has one, so the bell can name it. */
    Notify::create(
        'payment',
        sprintf('%s sent ₱%s by %s toward %s (%s) — waiting for review.',
            $customer['name'] ?? $acct['name'], number_format($amount, 2),
            $data['method'] === 'bank' ? 'bank transfer' : 'GCash',
            $acct['orderId'] ?: $acct['id'], $acct['scheme']),
        $acct['orderId'] ? ['order' => $acct['orderId']] : []
    );

    /* Actor is the customer, so actor_user_id stays NULL — the same shape
       shop/checkout.php uses for a customer-initiated write. */
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

/* Attached to a payment now, so it stops being discardable — the same step
   shop/checkout.php takes for an order's screenshot. */
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
