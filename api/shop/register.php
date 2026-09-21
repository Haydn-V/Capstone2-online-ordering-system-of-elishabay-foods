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
 *
 * THE ADDRESS IS NOW SAVED. It was documented in this header's Body line, sent
 * by the Create Account form, and never read — every address typed at sign-up
 * was discarded, and the new customer met an empty checkout. It now arrives as
 * the picker's codes and is resolved by Address::resolve, the same rule every
 * other address in the system goes through. Region through barangay are
 * required — the form always required an address, it just never saved one —
 * while street and ZIP are optional, as the old box never asked for them. It is
 * checked BEFORE the account is written, so a half-picked address cannot leave
 * a half-made account.
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

/* Before any write — see the header. `address` is an object from the picker;
   anything else (a stale page posting the old free-text string) is treated as
   no address rather than refused, because a sign-up should not fail over it. */
/* LOCATION: region through barangay required, street and ZIP optional. The old
   Create Account box asked for exactly "barangay, city, province" and the page
   required it; that requirement is kept, and now it is also enforced here
   instead of only in the browser. */
$addr = Address::resolve(is_array($in['address'] ?? null) ? $in['address'] : null, Address::LOCATION);
$legacyAddr = $addr !== null && $addr['barangay_code'] === null;
$addrCols = $addr === null ? [] : [
    'addr_street'        => $legacyAddr ? $addr['line'] : $addr['street'],
    'addr_barangay'      => $addr['barangay'],
    'addr_city'          => $addr['city'],
    'addr_province'      => $addr['province'],
    'addr_region'        => $addr['region'],
    'addr_zip'           => $addr['zip'],
    'addr_region_code'   => $addr['region_code'],
    'addr_province_code' => $addr['province_code'],
    'addr_city_code'     => $addr['city_code'],
    'addr_barangay_code' => $addr['barangay_code'],
];

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
    /* An address given at sign-up replaces the record's; none given leaves
       whatever the record already had. Written as one set of columns, never
       column by column — a new barangay beside an old city is not an address. */
    if ($addrCols) {
        Database::run(
            'UPDATE customers SET ' . implode(', ', array_map(static fn($c) => "$c = ?", array_keys($addrCols)))
            . ' WHERE id = ?',
            [...array_values($addrCols), $existing['id']]
        );
    }
    $id = $existing['id'];
    $claimed = true;
} else {
    /* cus-11, cus-12 … continuing the seeded sequence. */
    $n = (int) Database::scalar(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0) FROM customers WHERE id LIKE 'cus-%'"
    );
    $id = sprintf('cus-%02d', $n + 1);

    $cols = ['id', 'name', 'email', 'password', 'contact', 'status', ...array_keys($addrCols)];
    Database::run(
        'INSERT INTO customers (' . implode(', ', $cols) . ', joined)
         VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ', CURDATE())',
        [$id, $data['name'], $data['email'], $hash, $contact, 'active', ...array_values($addrCols)]
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
