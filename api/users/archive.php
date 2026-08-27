<?php
declare(strict_types=1);

/**
 * POST /api/users/archive.php
 * Body: { "id": "emp-05", "archived": true }
 *
 * Requires users.manage.
 *
 * Archive, never delete. Orders carry `cashier` as a foreign key to users and
 * audit rows carry actor_user_id — deleting an employee would either fail or
 * detach the record of everything they did. Archiving refuses their login
 * (Auth::attempt checks status) while leaving that history intact.
 *
 * Archiving takes effect immediately, including on an already-signed-in
 * session: Auth::user() re-reads status from the database on every request and
 * logs the account out the moment it turns archived.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which account?', ['id' => 'Account is required.']);
}
if (!array_key_exists('archived', $in)) {
    Response::badRequest('Specify whether to archive or restore.');
}
$archive = filter_var($in['archived'], FILTER_VALIDATE_BOOLEAN);

$user = Database::one(
    'SELECT u.id, u.name, u.status, r.name AS role, r.is_system
       FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
    [$in['id']]
);
if ($user === null) {
    Response::notFound('That account does not exist.');
}

/* Locking yourself out mid-session is not a thing anyone means to do. */
if ($user['id'] === $actor['id']) {
    Response::forbidden('You cannot archive your own account.');
}

if (($user['status'] === 'archived') === $archive) {
    Response::conflict($archive ? 'That account is already archived.' : 'That account is not archived.');
}

/* Never leave the system with no way back in. If this is the last active
   account holding rbac.manage, archiving it means nobody can ever manage roles
   or restore it — a door that locks from the outside with the key inside. */
if ($archive) {
    $remainingAdmins = (int) Database::scalar(
        "SELECT COUNT(*)
           FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE u.status = 'active'
            AND u.id <> ?
            AND (r.is_system = 1
                 OR EXISTS (SELECT 1 FROM role_permissions rp
                              JOIN permissions p ON p.id = rp.permission_id
                             WHERE rp.role_id = r.id AND p.permission_key = 'rbac.manage'))",
        [$user['id']]
    );
    if ($remainingAdmins === 0) {
        Response::conflict(
            'This is the last active account that can manage roles and permissions. ' .
            'Give another account that role before archiving this one.'
        );
    }
}

Database::run('UPDATE users SET status = ? WHERE id = ?',
    [$archive ? 'archived' : 'active', $user['id']]);

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [$actor['name'], $actor['id'], 'user',
     sprintf('%s employee account: %s (%s, %s).',
         $archive ? 'Archived' : 'Restored', $user['name'], $user['id'], $user['role'] ?? 'no role')]
);

Response::ok(['id' => $user['id'], 'status' => $archive ? 'archived' : 'active']);
