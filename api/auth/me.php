<?php
declare(strict_types=1);

/** GET /api/auth/me.php is the single identity endpoint for staff and customers (401 when signed out), re-reading role and permissions from the database on every call so changes apply immediately. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$user = Auth::user();
if ($user !== null) {
    Response::ok([
        'type' => 'staff',
        'user' => [
            'id'     => $user['id'],
            'name'   => $user['name'],
            'email'  => $user['email'],
            'avatar' => $user['avatar'],
            'role'   => $user['role'],
            /* Super Admin (the system role); screens use it to hide Super Admin-only controls. */
            'isSystem' => (int) $user['is_system'] === 1,
        ],
        'permissions' => Rbac::forRole((int) $user['role_id'], (bool) $user['is_system']),
        'catalogue'   => Rbac::catalogue(),
        'csrf'        => Csrf::token(),
    ]);
}

$customer = Auth::customer();
if ($customer !== null) {
    Response::ok([
        'type' => 'customer',
        'customer' => [
            'id'      => $customer['id'],
            'name'    => $customer['name'],
            'email'   => $customer['email'],
            'contact' => $customer['contact'],
        ],
        'csrf' => Csrf::token(),
    ]);
}

Response::unauthenticated('Sign in to continue.');
