<?php
declare(strict_types=1);

/**
 * POST /api/shop/login.php
 * Body: { "email", "password" }
 *
 * PUBLIC — customer sign-in. Separate from auth/login.php, which is staff only.
 *
 * A customer session grants no permissions and satisfies no Rbac check. The two
 * identities are kept in different session keys precisely so that a shopper can
 * never be mistaken for a staff member by code that only asks "is somebody
 * signed in?".
 */

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
        /* Same field, same reason, as shop/me.php: the account pages show the
           Payment Schemes link only to a retailer, and the checkout offers
           credit terms only to a retailer.

           Without it here, a customer who signs in through the modal has
           state.auth.status === undefined for the whole of that session — the
           restore path reads it from me.php and this one did not, so the same
           retailer saw the link after a reload and not after signing in. That
           is the shape drift the two assignments in site.js now share a
           helper to prevent.

           Presentation only, in both places. shop/my-payments.php re-checks
           the status server-side and shop/checkout.php re-derives it from the
           database, because a hidden link and an unrendered tile stop nobody. */
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
]);
