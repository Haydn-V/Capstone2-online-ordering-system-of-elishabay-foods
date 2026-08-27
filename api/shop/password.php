<?php
declare(strict_types=1);

/**
 * POST /api/shop/password.php
 * Body: { "current_password": "...", "new_password": "...", "confirm_password": "..." }
 *
 * Requires a customer session. Changes the signed-in customer's own password.
 *
 * WHY THIS IS NOT PART OF shop/profile.php
 * ----------------------------------------
 * A profile save changes an address. This changes a credential. Folding them
 * together would mean one endpoint that edits a delivery address is also able
 * to take over the account — and the address save would inherit the
 * re-authentication and rate limiting it does not need, or, far more likely,
 * this would inherit the address save's absence of both.
 *
 * WHAT IT REPLACES
 * ----------------
 * The Security form on public/profile/profile.html was a mock: it validated the
 * fields, cleared them, and showed "Password updated successfully!" while
 * writing nothing. A customer who believed their password had changed would try
 * the new one, fail, and have no way to understand why. It was changed to say
 * plainly that the feature did not exist; this is that feature.
 *
 * THE THREE RULES
 * ---------------
 * 1. THE CURRENT PASSWORD IS RE-VERIFIED. A session cookie proves the browser
 *    was signed in at some point, not that the person at the keyboard is the
 *    account holder. Without this, an unattended logged-in laptop is a
 *    permanent account takeover.
 * 2. IT IS RATE LIMITED, on the same counter as sign-in. Otherwise this is an
 *    unlimited password oracle for anyone holding a stolen session — worse
 *    than the login form, which is throttled.
 * 3. THE SESSION ID IS REGENERATED on success, so any other session riding the
 *    old id is invalidated. Changing a password because you fear someone else
 *    has access must actually remove that access.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* Establishes the session, then proves the current password against it.
   Throttled and recorded inside Auth, on the same counter sign-in uses. */
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

/* Checked before the current password is verified, so a mistyped confirmation
   does not burn a rate-limit attempt. */
if ($new !== $confirm) {
    Response::validation('Please check the highlighted fields.', [
        'confirm_password' => 'The two passwords do not match.',
    ]);
}

/* Refuses with 401/429 on its own. Returns the session's customer. */
$customer = Auth::reauthenticateCustomer($current);

/* Rejected AFTER re-authentication, so the message cannot be used to probe
   whether a guessed current password was right. */
if (hash_equals($current, $new)) {
    Response::validation('Please check the highlighted fields.', [
        'new_password' => 'That is your current password. Choose a different one.',
    ]);
}

/* One rule, one hash — the same Auth::hashPassword that users/save.php and
   shop/register.php use. It refuses anything under the minimum itself. */
$hash = Auth::hashPassword($new, 'new_password');

Database::run('UPDATE customers SET password = ? WHERE id = ?', [$hash, $customer['id']]);

/* Any other session holding the old id is now dead. The customer doing this
   stays signed in — logging them out of the browser they just proved
   themselves in would be a strange punishment for good security hygiene. */
session_regenerate_id(true);

/* Clear the failed-attempt counter. A successful change is at least as strong
   a signal as a successful sign-in that the account holder is present, and
   leaving stale failures behind could lock them out afterwards. */
Database::run(
    'DELETE FROM login_attempts WHERE email = ? AND successful = 0',
    [$customer['email']]
);

/* NO audit row, for the same reason shop/profile.php writes none: audit_logs
   records staff actions and its actor column is a users.id foreign key. A
   customer changing their own password is not that. Customer security events
   deserve their own log; quietly widening the staff audit trail to hold them
   would corrupt what the Audit screen means. Recorded here as a known gap. */

Response::ok(['changed' => true]);
