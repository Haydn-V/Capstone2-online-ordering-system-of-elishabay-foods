<?php
declare(strict_types=1);

/** POST /api/users/me-save.php lets a staff member edit their own name, email and avatar (no id parameter), loudly refusing any attempt to change role or status. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$user = Auth::require();
$in   = Response::input();

/* Refuse role_id or status in the body before doing anything. */
foreach (['role_id', 'role', 'status', 'password', 'id'] as $forbidden) {
    if (array_key_exists($forbidden, $in)) {
        Response::forbidden(
            $forbidden === 'password'
                ? 'Use the password form to change your password.'
                : 'Your role and account status can only be changed by an administrator.'
        );
    }
}

$data = Validate::check($in)
    ->required('name', 'Full name')
    ->maxLen('name', 100, 'Full name')
    ->email('email', 'Email')
    ->values();

/* Email must be unique (excluding yourself). */
$clash = Database::scalar(
    'SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?',
    [$data['email'], $user['id']]
);
if ((int) $clash > 0) {
    Response::conflict('Another account already uses that email address.');
}

/* Avatar is up to two initials, defaulting to the name's initials. */
$avatar = strtoupper(trim((string) ($in['avatar'] ?? '')));
if ($avatar === '') {
    $parts  = preg_split('/\s+/', trim($data['name'])) ?: [];
    $avatar = strtoupper(substr($parts[0] ?? '', 0, 1) . substr($parts[1] ?? '', 0, 1));
}
$avatar = substr($avatar, 0, 2);

$before = Database::one('SELECT name, email, avatar FROM users WHERE id = ?', [$user['id']]);
if ($before === null) {
    Response::notFound('Your account could not be found.');
}

/* Only these three columns can be updated here. */
Database::run(
    'UPDATE users SET name = ?, email = ?, avatar = ? WHERE id = ?',
    [$data['name'], $data['email'], $avatar, $user['id']]
);

/* Audit what actually changed. */
$changes = [];
if ($before['name']   !== $data['name'])  { $changes[] = "name → {$data['name']}"; }
if ($before['email']  !== $data['email']) { $changes[] = "email → {$data['email']}"; }
if ($before['avatar'] !== $avatar)        { $changes[] = "avatar → {$avatar}"; }

if ($changes !== []) {
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$data['name'], $user['id'], 'user',
         'Updated own profile. ' . implode(', ', $changes)]
    );
}

$row = Database::one(
    'SELECT u.id, u.name, u.email, u.avatar, u.status, u.role_id, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?',
    [$user['id']]
);

Response::ok([
    'id'     => $row['id'],
    'name'   => $row['name'],
    'email'  => $row['email'],
    'avatar' => $row['avatar'],
    'role'   => $row['role'],
    'roleId' => $row['role_id'],
    'status' => $row['status'],
    'changed' => $changes,
]);
