<?php
declare(strict_types=1);

/**
 * GET /api/shop/me.php
 *
 * DEPRECATED — kept so the storefront keeps working. auth/me.php is the single
 * identity endpoint now (D7) and reports both staff and customers with a `type`
 * field. This file answers only for customers and exists because pages still
 * call it; point new code at auth/me.php.
 *
 * Its response shape is unchanged, so nothing calling it needs to change today.
 */

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
        /* Needed so the profile sidebar can show the Payment Schemes link only
           to an approved retail partner. The status is not a secret — the
           customer's own account type — and shop/my-payments.php re-checks it
           server-side regardless, because a hidden link stops nobody. */
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
]);
