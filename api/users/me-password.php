<?php
declare(strict_types=1);

/**
 * POST /api/users/me-password.php
 * Body: { "current_password": "...", "new_password": "...", "confirm_password": "..." }
 *
 * The signed-in staff member changes their OWN password.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Only users/save.php could set a staff password, and it requires
 * `users.manage`. So a staff member wanting to change their own password had to
 * ask an administrator — who then knew it. A password a second person has typed
 * is not a password; this removes the need to ever share one.
 *
 * WHY IT IS NOT PART OF me-save.php
 * ---------------------------------
 * The same reason api/shop/password.php is separate from shop/profile.php, and
 * its header explains it better than this one can: a profile save changes a
 * display name, this changes a credential. Folded together, the endpoint that
 * edits a name would also be able to take over the account, and the name save
 * would either inherit re-authentication and rate limiting it does not need or
 * — far more likely — this would inherit their absence.
 *
 * THE THREE RULES, same as the customer endpoint:
 *
 * 1. THE CURRENT PASSWORD IS RE-VERIFIED. A session cookie proves the browser
 *    was signed in at some point, not that the person at the keyboard is the
 *    account holder. Without it, an unattended signed-in terminal — which is
 *    what a POS station IS — is a permanent account takeover.
 * 2. IT IS RATE LIMITED on the same counter sign-in uses, so a stolen session
 *    cannot be turned into an unlimited password oracle. Both live inside
 *    Auth::reauthenticateStaff().
 * 3. THE SESSION ID IS REGENERATED on success, so any other session riding the
 *    old id dies. Changing a password because you fear someone else has access
 *    must actually remove that access.
 */

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

/* Checked before the current password is verified, so a mistyped confirmation
   does not burn a rate-limit attempt. */
if ($new !== $confirm) {
    Response::validation('Please check the highlighted fields.', [
        'confirm_password' => 'The two passwords do not match.',
    ]);
}

/* Refuses with 401/429 on its own. Returns the session's staff member. */
$user = Auth::reauthenticateStaff($current);

/* Rejected AFTER re-authentication, so the message cannot be used to probe
   whether a guessed current password was right. */
if (hash_equals($current, $new)) {
    Response::validation('Please check the highlighted fields.', [
        'new_password' => 'That is your current password. Choose a different one.',
    ]);
}

/* One rule, one hash — the same Auth::hashPassword users/save.php uses. It
   refuses anything under the minimum itself. */
$hash = Auth::hashPassword($new, 'new_password');

Database::run('UPDATE users SET password = ? WHERE id = ?', [$hash, $user['id']]);

/* Any other session holding the old id is now dead. The person doing this stays
   signed in — logging them out of the browser they just proved themselves in
   would be a strange punishment for good security hygiene. */
session_regenerate_id(true);

/* Clear the failed-attempt counter. A successful change is at least as strong a
   signal as a successful sign-in that the account holder is present, and stale
   failures could lock them out immediately afterwards. */
Database::run(
    'DELETE FROM login_attempts WHERE email = ? AND successful = 0',
    [$user['email']]
);

/* THE ROW RECORDS THAT IT HAPPENED, NEVER WHAT WAS SET. Not the old password,
   not the new one, not its length — an audit trail that leaks credentials is
   worse than none, because it concentrates them somewhere people browse.
   Unlike the customer endpoint, this one CAN write to audit_logs: actor_user_id
   is a users.id foreign key and a staff member is exactly what that column
   means. */
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'user', 'Changed own password.']
);

Response::ok(['changed' => true]);
