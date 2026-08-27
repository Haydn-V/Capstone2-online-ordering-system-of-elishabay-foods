<?php
declare(strict_types=1);

/**
 * POST /api/users/save.php
 * Body: { "id": "emp-03" (omit to create), "name", "email", "role_id",
 *         "password" (required on create, optional on update), "avatar" }
 *
 * Requires users.manage.
 *
 * This endpoint hands out access to the system, so it is the one place where
 * being strict matters most:
 *
 *   - passwords are hashed here and never stored, logged or echoed back
 *   - a blank password on update means "leave it alone", not "clear it"
 *   - the role must exist, and only rbac.manage holders may grant a role that
 *     itself holds rbac.manage — otherwise any user manager could quietly
 *     promote themselves to full control
 *   - you cannot change your own role or archive yourself
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('name', 'Full name')
    ->maxLen('name', 100, 'Full name')
    ->email('email', 'Email')
    ->int('role_id', 'Role', 1)
    ->values();

$role = Database::one('SELECT id, name, is_system FROM roles WHERE id = ?', [$data['role_id']]);
if ($role === null) {
    Response::validation('Check the highlighted fields.', ['role_id' => 'That role does not exist.']);
}

/* Privilege escalation guard. A Super Admin holds every permission including
   rbac.manage; an Admin holds users.manage but not rbac.manage. Without this
   check an Admin could create a Super Admin account and sign into it. */
$roleGrantsRbac = (int) $role['is_system'] === 1 || (bool) Database::scalar(
    'SELECT COUNT(*) FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ? AND p.permission_key = ?',
    [$role['id'], 'rbac.manage']
);
if ($roleGrantsRbac && !Rbac::has('rbac.manage')) {
    Response::forbidden("You cannot assign the {$role['name']} role — it carries permission management.");
}

/* Email is the login identifier, so a duplicate would be a second account
   nobody can reach. Excludes itself on update. */
$clash = Database::scalar('SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?',
    [$data['email'], $in['id'] ?? '']);
if ($clash) {
    Response::conflict('Another account already uses that email address.');
}

$avatar = strtoupper(trim((string) ($in['avatar'] ?? ''))) ?: null;
if ($avatar !== null && mb_strlen($avatar) > 10) {
    Response::validation('Check the highlighted fields.', ['avatar' => 'Initials must be 10 characters or fewer.']);
}
if ($avatar === null) {
    /* Derive from the name, same rule the UI uses. */
    $parts = preg_split('/\s+/', $data['name']);
    $avatar = strtoupper(mb_substr(($parts[0][0] ?? '') . ($parts[1][0] ?? ''), 0, 2));
}

$password = (string) ($in['password'] ?? '');

if ($isUpdate) {
    $existing = Database::one('SELECT id, name, email, role_id, status FROM users WHERE id = ?', [$in['id']]);
    if ($existing === null) {
        Response::notFound('That account does not exist.');
    }

    /* Changing your own role is how an account locks itself out mid-session,
       or quietly grants itself more. Either way it should be somebody else's
       decision. */
    if ($existing['id'] === $actor['id'] && (int) $existing['role_id'] !== (int) $data['role_id']) {
        Response::forbidden('You cannot change your own role. Ask another administrator.');
    }

    if ($password !== '') {
        /* One rule, one hash (Auth::hashPassword). This was the length check
           and the bcrypt call written out inline — twice in this file alone,
           again in shop/register.php, and about to be a fourth time. */
        Database::run('UPDATE users SET password = ? WHERE id = ?',
            [Auth::hashPassword($password), $existing['id']]);
    }

    Database::run(
        'UPDATE users SET name = ?, email = ?, role_id = ?, avatar = ? WHERE id = ?',
        [$data['name'], $data['email'], $data['role_id'], $avatar, $existing['id']]
    );

    $changes = [];
    if ($existing['name']  !== $data['name'])  { $changes[] = "name → {$data['name']}"; }
    if ($existing['email'] !== $data['email']) { $changes[] = "email → {$data['email']}"; }
    if ((int) $existing['role_id'] !== (int) $data['role_id']) { $changes[] = "role → {$role['name']}"; }
    if ($password !== '') { $changes[] = 'password reset'; }

    audit_user($actor, sprintf('Updated employee %s (%s). %s',
        $data['name'], $existing['id'], $changes ? implode('; ', $changes) : 'No changes.'));

    $id = $existing['id'];
} else {
    if ($password === '') {
        Response::validation('Check the highlighted fields.', ['password' => 'A password is required for a new account.']);
    }

    /* emp-07, emp-08 … continuing the seeded sequence. */
    $n = (int) Database::scalar("SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0) FROM users WHERE id LIKE 'emp-%'");
    $id = sprintf('emp-%02d', $n + 1);

    Database::run(
        'INSERT INTO users (id, role_id, name, email, password, avatar, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$id, $data['role_id'], $data['name'], $data['email'],
         Auth::hashPassword($password), $avatar, 'active']
    );

    audit_user($actor, sprintf('Added employee account: %s (%s) as %s.',
        $data['name'], $id, $role['name']));
}

/* The password hash is never selected. */
$row = Database::one(
    'SELECT u.id, u.name, u.email, u.avatar, u.status, r.id AS role_id, r.name AS role
       FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
    [$id]
);

Response::ok($row, null, $isUpdate ? 200 : 201);


function audit_user(array $actor, string $description): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$actor['name'], $actor['id'], 'user', $description]
    );
}
