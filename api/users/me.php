<?php
declare(strict_types=1);

/** GET /api/users/me.php returns the signed-in staff member's own record (no id parameter, any signed-in staff, never the password hash). */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$user = Auth::require();

/* Re-read from the database so recent admin changes show. */
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
    /* Role and status are sent for display only; me-save.php refuses changes to them. */
    'role'   => $row['role'],
    'roleId' => $row['role_id'],
    'status' => $row['status'],
]);
