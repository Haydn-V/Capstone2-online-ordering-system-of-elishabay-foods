<?php
declare(strict_types=1);

/** POST /api/shop/password.php changes the signed-in customer's password, re-verifying the current one (rate limited like sign-in) and regenerating the session id. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* Re-authenticates with the current password, throttled on the sign-in counter. */
$in = Response::input();

$current = (string) ($in['current_password'] ?? '');
$new     = (string) ($in['new_password'] ?? '');
$confirm = (string) ($in['confirm_password'] ?? '');

$errors = [];
if ($current === '') {
    $errors['current_password'] = 'Enter your current password.';
}
if ($new === '') {
    $errors['new_password'] = 'Enter a new password.';
}
if ($errors !== []) {
    Response::validation('Please check the highlighted fields.', $errors);
}

/* Check the confirmation match first so a typo does not use up an attempt. */
if ($new !== $confirm) {
    Response::validation('Please check the highlighted fields.', [
        'confirm_password' => 'The two passwords do not match.',
    ]);
}

/* Stops with 401/429 itself; returns the session's customer. */
$customer = Auth::reauthenticateCustomer($current);

/* Reject a same-as-current password only after re-authentication, so it cannot confirm a guess. */
if (hash_equals($current, $new)) {
    Response::validation('Please check the highlighted fields.', [
        'new_password' => 'That is your current password. Choose a different one.',
    ]);
}

/* Hash with Auth::hashPassword, which also enforces the minimum length. */
$hash = Auth::hashPassword($new, 'new_password');

Database::run('UPDATE customers SET password = ? WHERE id = ?', [$hash, $customer['id']]);

/* New session id for this browser and a new password fingerprint for it; other sessions keep the old one and are signed out (Auth::customer()). */
session_regenerate_id(true);
Auth::refreshPasswordStamp();

/* Clear failed attempts after a successful change. */
Database::run(
    'DELETE FROM login_attempts WHERE email = ? AND successful = 0',
    [$customer['email']]
);

/* No audit row, because audit_logs is for staff actions only (a known gap). */

Response::ok(['changed' => true]);
