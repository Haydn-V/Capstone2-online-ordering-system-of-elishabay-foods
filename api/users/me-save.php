<?php
declare(strict_types=1);

/**
 * POST /api/users/me-save.php
 * Body: { "name": "...", "email": "...", "avatar": "AB" }
 *
 * The signed-in staff member edits their OWN name, email and avatar initials.
 *
 * WHY THIS IS NOT users/save.php WITH A NARROWER FORM
 * ---------------------------------------------------
 * users/save.php requires `users.manage` and takes an `id`. Reusing it here
 * would mean either granting every staff member the permission to edit every
 * account, or trusting a client-supplied id to be the caller's own. This takes
 * no id at all: the session decides whose row is written, so there is no
 * parameter an attacker can point somewhere else.
 *
 * ROLE AND STATUS ARE REFUSED, NOT IGNORED
 * ----------------------------------------
 * The obvious implementation leaves role_id and status out of the UPDATE and
 * relies on the form not offering them. That is not enough: the form is not the
 * caller. A hand-written POST carrying `role_id: 1` would be silently accepted
 * and silently ignored — which looks identical to being accepted and applied,
 * and leaves nobody any the wiser.
 *
 * So they are rejected LOUDLY, with 403 and a message saying who can change
 * them. A staff member editing their own role is privilege escalation; one
 * archiving themselves is a support call. Both belong to an administrator, and
 * the refusal says so.
 *
 * The UPDATE lists only the three permitted columns as well, so even a bug in
 * the check above cannot write the other two.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$user = Auth::require();
$in   = Response::input();

/* Refused before anything is validated or written, so the caller learns the
   request was wrong rather than watching part of it succeed. Presence is what
   matters, not the value — sending `role_id` at all is the mistake. */
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

/* users.email is UNIQUE, and a duplicate would otherwise surface as a database
   error rather than a field message. Scoped `id <> ?` so saving without
   changing your own email is not a clash with yourself. */
$clash = Database::scalar(
    'SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?',
    [$data['email'], $user['id']]
);
if ((int) $clash > 0) {
    Response::conflict('Another account already uses that email address.');
}

/* Initials only. Two characters is what the avatar circle draws; anything
   longer overflows it. Falls back to the initials of the name, which is what
   applySignedInUser() does in the browser. */
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

/* Three columns, named explicitly. role_id and status are not in this
   statement and cannot be reached from here whatever the body contained. */
Database::run(
    'UPDATE users SET name = ?, email = ?, avatar = ? WHERE id = ?',
    [$data['name'], $data['email'], $avatar, $user['id']]
);

/* What actually changed, not "profile updated". An audit line that does not
   say what moved is a line nobody can act on later. */
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
