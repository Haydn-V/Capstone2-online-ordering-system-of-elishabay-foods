<?php
declare(strict_types=1);

/**
 * POST /api/shop/register.php
 * Body: { "first_name", "last_name" (or "name"), "email", "password", "contact"?, "address"? }
 *
 * STEP 1 OF 2. Validates everything and emails a verification code; it does
 * NOT create the account. Step 2 is shop/register-verify.php.
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

/* First + last name (the current form). `name` becomes "first last" so the
   rest of this file, and every screen that reads customers.name, is unchanged. */
$nameErrors = [];
$nm = CustomerName::fromInput($in, $nameErrors);
if ($nameErrors) {
    Response::validation('Check the highlighted fields.', $nameErrors);
}
if ($nm !== null) {
    $in['name'] = $nm['full'];
}

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

/* Refused now rather than after the code, so nobody verifies an email only to
   be told it is taken. Checked again at verification — see register-verify.php. */
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
}

/* EMAIL VERIFICATION. Nothing is written to the database here: the validated
   sign-up is held in the session (password as its hash only) and a 6-digit
   code is emailed. shop/register-verify.php creates the account once the code
   is confirmed. See api/core/Signup.php. */
Response::ok(Signup::hold([
    'name'     => $data['name'],
    'email'    => $data['email'],
    'hash'     => $hash,
    'contact'  => $contact,
    'addrCols' => $addrCols,
    'first'    => $nm['first'] ?? null,
    'last'     => $nm['last'] ?? null,
]));
