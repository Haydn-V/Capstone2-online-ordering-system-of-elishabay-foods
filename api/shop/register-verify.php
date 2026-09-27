<?php
declare(strict_types=1);

/**
 * POST /api/shop/register-verify.php
 * Body: { "code": "123456" }   — confirm and create the account
 *    or { "resend": true }     — email a new code (once a minute)
 *
 * STEP 2 OF 2 of sign-up (step 1: shop/register.php). The account is written
 * to customers ONLY here, after the emailed code matches. The held sign-up
 * lives in the session (api/core/Signup.php); nothing exists in the database
 * before this point.
 */

/* No account session yet, like register.php. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$in = Response::input();

if (!empty($in['resend'])) {
    Response::ok(Signup::issue(true));
}

$p = Signup::verify(trim((string) ($in['code'] ?? '')));

/* Re-checked: the email may have been registered in the minutes the code
   was in transit. */
$existing = Database::one('SELECT id, password, status FROM customers WHERE email = ?', [$p['email']]);
if ($existing !== null && $existing['password'] !== null) {
    Signup::clear();
    Response::conflict('An account already exists for that email. Try signing in instead.');
}
if ($existing !== null && $existing['status'] === 'archived') {
    Signup::clear();
    Response::forbidden('That account is no longer active. Please contact us.');
}

$addrCols = is_array($p['addrCols'] ?? null) ? $p['addrCols'] : [];

if ($existing !== null) {
    /* A seeded customer with no password claims their record, so their order
       history follows them in (see register.php's header). */
    Database::run(
        'UPDATE customers SET password = ?, name = ?, contact = COALESCE(?, contact) WHERE id = ?',
        [$p['hash'], $p['name'], $p['contact'], $existing['id']]
    );
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
        [$id, $p['name'], $p['email'], $p['hash'], $p['contact'], 'active', ...array_values($addrCols)]
    );
    $claimed = false;
}

if (!empty($p['first']) && !empty($p['last'])) {
    CustomerName::write($id, $p['first'], $p['last']);
}

Signup::clear();
$customer = Auth::loginCustomer($id);

Response::created([
    'customer' => [
        'id'      => $customer['id'],
        'name'    => $customer['name'],
        'email'   => $customer['email'],
        'contact' => $customer['contact'],
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
    'claimedExistingRecord' => $claimed,
]);
