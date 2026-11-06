<?php
declare(strict_types=1);

/** POST /api/users/me-password.php lets a staff member change their own password, re-verifying the current one (rate limited like sign-in); this session stays signed in and every other session of the account is signed out. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

$current = (string) ($in['current_password'] ?? '');
$new     = (string) ($in['new_password'] ?? '');
$confirm = (string) ($in['confirm_password'] ?? '');

$errors = [];
if ($current === '') { $errors['current_password'] = 'Enter your current password.'; }
if ($new === '')     { $errors['new_password']     = 'Enter a new password.'; }
if ($errors !== []) {
    Response::validation('Please check the highlighted fields.', $errors);
}

/* Check the confirmation match first so a typo does not use up an attempt. */
if ($new !== $confirm) {
    Response::validation('Please check the highlighted fields.', [
        'confirm_password' => 'The two passwords do not match.',
    ]);
}

/* Stops with 401/429 itself; returns the session's staff member. */
$user = Auth::reauthenticateStaff($current);

/* Reject a same-as-current password only after re-authentication. */
if (hash_equals($current, $new)) {
    Response::validation('Please check the highlighted fields.', [
        'new_password' => 'That is your current password. Choose a different one.',
    ]);
}

/* Hash with Auth::hashPassword, which also enforces the minimum length. */
$hash = Auth::hashPassword($new, 'new_password');

Database::run('UPDATE users SET password = ? WHERE id = ?', [$hash, $user['id']]);

/* New session id for this browser, and a new password fingerprint for it: every other session still holds the old
   fingerprint, so Auth::user() signs it out on its next request. */
session_regenerate_id(true);
Auth::refreshPasswordStamp();

/* Clear failed attempts after a successful change. */
Database::run(
    'DELETE FROM login_attempts WHERE email = ? AND successful = 0',
    [$user['email']]
);

/* Audit that the password changed, never any password details. */
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'user', 'Changed own password.']
);

Response::ok(['changed' => true]);
