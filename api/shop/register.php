<?php
declare(strict_types=1);

/** POST /api/shop/register.php is sign-up step 1: validate everything (including the address, region to barangay required) and email a code, without creating the account; registering an email with no password claims that record, one with a password is refused. */

/* No session exists yet, so there is nothing to forge. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

/* First and last name are joined into name so other code is unchanged. */
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

/* Age (18+, or a parent's consent) and Terms and Conditions consent from the Create Account checkbox. */
if (($in['agree_terms'] ?? false) !== true) {
    Response::validation('Check the highlighted fields.', [
        'agree_terms' => 'Please confirm your age and agree to the Terms and Conditions to continue.',
    ]);
}

$contact = trim((string) ($in['contact'] ?? '')) ?: null;
if ($contact !== null && !preg_match('/^[0-9 +\-()]{7,20}$/', $contact)) {
    Response::validation('Check the highlighted fields.', [
        'contact' => 'Enter a valid contact number.',
    ]);
}

/* A non-object address (old free-text form) is treated as no address, not an error. */
/* Region through barangay required, street and ZIP optional, now enforced on the server. */
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

/* Refuse a taken email now (and again at verification). */
if ($existing !== null) {
    if ($existing['password'] !== null) {
        /* Say plainly to sign in instead; this reveals no more than a failed sign-in would. */
        Response::conflict('An account already exists for that email. Try signing in instead.');
    }
    if ($existing['status'] === 'archived') {
        Response::forbidden('That account is no longer active. Please contact us.');
    }
}

/* Hold the validated sign-up in the session and email a code; register-verify.php creates the account (see api/core/Signup.php). */
Response::ok(Signup::hold([
    'name'     => $data['name'],
    'email'    => $data['email'],
    'hash'     => $hash,
    'contact'  => $contact,
    'addrCols' => $addrCols,
    'first'    => $nm['first'] ?? null,
    'last'     => $nm['last'] ?? null,
    'middle'   => $nm['middle'] ?? null,
]));
