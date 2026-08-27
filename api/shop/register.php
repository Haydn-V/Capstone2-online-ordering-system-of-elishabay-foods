<?php
declare(strict_types=1);

/**
 * POST /api/shop/register.php
 * Body: { "name", "email", "password", "contact"?, "address"? }
 *
 * PUBLIC — customer signup.
 *
 * The storefront's register form previously called signIn(name) and stored a
 * display name in localStorage. There was no account: nothing to sign back
 * into, nothing linking an order to a person, and "logged in" meant a string
 * in the browser.
 *
 * Ten seeded customers exist with NULL passwords — they shopped before
 * accounts existed. Registering with one of those addresses CLAIMS that record
 * rather than creating a duplicate, so their order history follows them in.
 * An address that already has a password is refused; taking it over would be
 * account takeover by signup.
 */

/* No session exists yet, so there is nothing to forge. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

$data = Validate::check($in)
    ->required('name', 'Your name')
    ->maxLen('name', 100, 'Your name')
    ->email('email', 'Email')
    ->required('password', 'Password')
    ->values();

$contact = trim((string) ($in['contact'] ?? '')) ?: null;
if ($contact !== null && !preg_match('/^[0-9 +\-()]{7,20}$/', $contact)) {
    Response::validation('Check the highlighted fields.', [
        'contact' => 'Enter a valid contact number.',
    ]);
}

$existing = Database::one(
    'SELECT id, name, password, status FROM customers WHERE email = ?',
    [$data['email']]
);

/* One rule, one hash — see Auth::hashPassword. */
$hash = Auth::hashPassword($data['password']);

if ($existing !== null) {
    if ($existing['password'] !== null) {
        /* Deliberately explicit rather than vague: this address is one the
           person is presumably trying to use, and "sign in instead" is the
           useful answer. It reveals only what a failed sign-in would. */
        Response::conflict('An account already exists for that email. Try signing in instead.');
    }
    if ($existing['status'] === 'archived') {
        Response::forbidden('That account is no longer active. Please contact us.');
    }

    Database::run(
        'UPDATE customers SET password = ?, name = ?, contact = COALESCE(?, contact) WHERE id = ?',
        [$hash, $data['name'], $contact, $existing['id']]
    );
    $id = $existing['id'];
    $claimed = true;
} else {
    /* cus-11, cus-12 … continuing the seeded sequence. */
    $n = (int) Database::scalar(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0) FROM customers WHERE id LIKE 'cus-%'"
    );
    $id = sprintf('cus-%02d', $n + 1);

    Database::run(
        'INSERT INTO customers (id, name, email, password, contact, status, joined)
         VALUES (?, ?, ?, ?, ?, ?, CURDATE())',
        [$id, $data['name'], $data['email'], $hash, $contact, 'active']
    );
    $claimed = false;
}

/* Sign them straight in — being made to log in immediately after signing up is
   a pointless extra step. */
$customer = Auth::attemptCustomer($data['email'], $data['password']);

Response::created([
    'customer' => [
        'id'      => $customer['id'],
        'name'    => $customer['name'],
        'email'   => $customer['email'],
        'contact' => $customer['contact'],
        /* Always 'active' for a genuinely new account, but NOT for one that
           claimed an existing customer row — a seeded retailer registering for
           the first time keeps their status, and the page has to know. See the
           note in shop/login.php. */
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
    /* So the page can say "welcome back, we found your previous orders". */
    'claimedExistingRecord' => $claimed,
]);
