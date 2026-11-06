<?php
declare(strict_types=1);

/** POST /api/shop/login.php (public) signs in a customer, kept in a separate session key from staff so a shopper can never pass a staff check. */

define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

$email    = trim((string) ($in['email'] ?? ''));
$password = (string) ($in['password'] ?? '');

$fields = [];
if ($email === '')    { $fields['email']    = 'Email is required.'; }
if ($password === '') { $fields['password'] = 'Password is required.'; }
if ($fields !== []) {
    Response::validation('Enter your email and password.', $fields);
}

$customer = Auth::attemptCustomer($email, $password);

Response::ok([
    'customer' => [
        'id'      => $customer['id'],
        'name'    => $customer['name'],
        'email'   => $customer['email'],
        'contact' => $customer['contact'],
        /* Return status here too (as me.php does) so the Payment Schemes link and credit terms show right after sign-in; it is presentation only and re-checked on the server. */
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
]);
