<?php
declare(strict_types=1);

/** POST /api/auth/login.php: signs a user in and returns their permission keys so the portal can draw its menu without a second request. */

/* No session exists yet, so CSRF is not checked here (the credentials are the proof); must be defined before bootstrap. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

/* Only check for an empty email, because saying "invalid email" would tell an attacker how their input was parsed. */
$email    = trim((string) ($in['email'] ?? ''));
$password = (string) ($in['password'] ?? '');

$fields = [];
if ($email === '')    { $fields['email']    = 'Email is required.'; }
if ($password === '') { $fields['password'] = 'Password is required.'; }
if ($fields !== []) {
    Response::validation('Enter your email and password.', $fields);
}

$user = Auth::attempt($email, $password);

/* Re-check the portal role on the server, because the browser check alone can be bypassed by posting here directly. */
$portalRole = trim((string) ($in['portal_role'] ?? ''));
if ($portalRole !== '' && $user['role'] !== $portalRole) {
    Auth::logout();
    Response::forbidden(
        "This portal is for {$portalRole} accounts only. Sign in from the landing page to reach your own dashboard."
    );
}

Response::ok([
    'user' => [
        'id'     => $user['id'],
        'name'   => $user['name'],
        'email'  => $user['email'],
        'avatar' => $user['avatar'],
        'role'   => $user['role'],
    ],
    'permissions' => Rbac::forRole((int) $user['role_id'], (bool) $user['is_system']),
    'csrf'        => Csrf::token(),
]);
