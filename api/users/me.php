<?php
declare(strict_types=1);

/**
 * GET /api/users/me.php
 *
 * The signed-in staff member's own record.
 *
 * NO ID PARAMETER, DELIBERATELY. This reads whoever the session says you are
 * and nothing else. An `?id=` would make it users/list.php with a weaker guard:
 * every caller would then have to be trusted to pass their own id, and the one
 * that did not would be reading a colleague's record. The session is the only
 * input, so there is nothing to get wrong.
 *
 * Requires any signed-in staff member — every one of them owns an account, so
 * there is no permission to check beyond being signed in. That is why neither
 * this nor its two siblings calls Rbac::require().
 *
 * The password hash is never selected, let alone returned.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$user = Auth::require();

/* Re-read rather than trusting the session copy. Auth::user() caches for the
   request, and an administrator may have changed this person's role or name
   between page loads; the profile screen should show what is stored now. */
$row = Database::one(
    'SELECT u.id, u.name, u.email, u.avatar, u.status, u.role_id,
            r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?',
    [$user['id']]
);

if ($row === null) {
    Response::notFound('Your account could not be found.');
}

Response::ok([
    'id'     => $row['id'],
    'name'   => $row['name'],
    'email'  => $row['email'],
    'avatar' => $row['avatar'],
    /* Sent so the screen can SHOW them, never so it can change them — both are
       read-only here and me-save.php refuses them outright. */
    'role'   => $row['role'],
    'roleId' => $row['role_id'],
    'status' => $row['status'],
]);
