<?php
declare(strict_types=1);

/** GET /api/shop/me.php is deprecated (use auth/me.php), kept with the same response shape because pages still call it. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$customer = Auth::requireCustomer('Sign in to view your account.');

Response::ok([
    'type'     => 'customer',
    'customer' => [
        'id'      => $customer['id'],
        'name'    => $customer['name'],
        'email'   => $customer['email'],
        'contact' => $customer['contact'],
        /* Status lets the sidebar show Payment Schemes only to retailers; my-payments.php re-checks it on the server. */
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
]);
