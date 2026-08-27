<?php
declare(strict_types=1);

/**
 * POST /api/payments/settle.php
 * Body: { "id": "pay-01", "paid": true, "note"?: "..." }
 *
 * Requires payments.manage. Marks a retailer credit account settled.
 *
 * The amount recorded in the audit trail is computed here, including any
 * penalty, rather than taken from the request — the client displays the figure,
 * it does not decide what was owed.
 */

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
$paid = filter_var($in['paid'], FILTER_VALIDATE_BOOLEAN);
$note = trim((string) ($in['note'] ?? '')) ?: null;

$acct = Database::one(
    'SELECT id, name, scheme, balance, due_date, paid,
            DATEDIFF(CURDATE(), due_date) AS days_past_due
       FROM payment_accounts WHERE id = ?',
    [$in['id']]
);
if ($acct === null) {
    Response::notFound('That payment account does not exist.');
}
if ((bool) $acct['paid'] === $paid) {
    Response::conflict($paid ? 'That account is already marked paid.' : 'That account is already outstanding.');
}

$rate    = (float) (Database::scalar("SELECT value_text FROM settings WHERE key_name = 'penalty_rate'") ?? 2);
$days    = (int) $acct['days_past_due'];
$balance = (float) $acct['balance'];
$penalty = (!$paid || $days <= 0) ? 0.0 : round($balance * ($rate / 100), 2);

Database::run('UPDATE payment_accounts SET paid = ? WHERE id = ?', [$paid ? 1 : 0, $acct['id']]);

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'order',
     $paid
        ? sprintf('Payment settled: %s (%s) — ₱%s%s.%s',
              $acct['name'], $acct['scheme'], number_format($balance + $penalty, 2),
              $penalty > 0 ? sprintf(' incl. ₱%s penalty at %s%%, %d days overdue',
                                     number_format($penalty, 2), $rate, $days) : '',
              $note ? ' Note: ' . $note : '')
        : sprintf('Payment account reopened as outstanding: %s (%s).%s',
              $acct['name'], $acct['scheme'], $note ? ' Note: ' . $note : '')]
);

Response::ok([
    'id'      => $acct['id'],
    'paid'    => $paid,
    'balance' => $balance,
    'penalty' => $penalty,
    'settled' => round($balance + $penalty, 2),
]);
