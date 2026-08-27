<?php
declare(strict_types=1);

/**
 * POST /api/auth/login.php
 * Body: { "email": "...", "password": "...", "portal_role": "Cashier" (optional) }
 *
 * Returns the signed-in user plus their permission keys, so the portal can
 * render its nav without a second round trip.
 */

/* No session exists at this point, so there is nothing for an attacker to
   ride; the credentials are the proof here. Must be defined before bootstrap,
   which enforces the check. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

/* Deliberately not run through Validate's email() rule: a malformed address is
   simply a failed sign-in, and saying "that is not a valid email" tells an
   attacker their input was parsed. Only emptiness is worth its own message. */
$email    = trim((string) ($in['email'] ?? ''));
$password = (string) ($in['password'] ?? '');

$fields = [];
if ($email === '')    { $fields['email']    = 'Email is required.'; }
if ($password === '') { $fields['password'] = 'Password is required.'; }
if ($fields !== []) {
    Response::validation('Enter your email and password.', $fields);
}

$user = Auth::attempt($email, $password);

/* Portal entry gating, previously role-gate.js's job alone. The browser check
   stays for the immediate error message, but it is re-run here because a
   client-side refusal stops nobody from posting straight to this endpoint. */
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
