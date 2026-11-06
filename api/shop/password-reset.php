<?php
declare(strict_types=1);

/** POST /api/shop/password-reset.php: Forgot password flow (send code, resend, set new password) that answers the same way for unknown emails and signs the customer in on success. */

/* No account session yet, like register.php. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$in = Response::input();

if (!empty($in['resend'])) {
    Response::ok(PasswordReset::issue(true));
}

if (array_key_exists('email', $in)) {
    $email = strtolower(trim((string) $in['email']));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        Response::validation('Please check the highlighted fields.', ['email' => 'Enter a valid email address.']);
    }
    Response::ok(PasswordReset::start($email));
}

$pw      = (string) ($in['password'] ?? '');
$confirm = (string) ($in['confirm'] ?? '');
if ($pw === '') {
    Response::validation('Please check the highlighted fields.', ['password' => 'Enter a new password.']);
}
if ($pw !== $confirm) {
    Response::validation('Please check the highlighted fields.', ['confirm' => 'The two passwords do not match.']);
}
/* Refuses anything under the minimum itself — before the code is spent. */
$hash = Auth::hashPassword($pw, 'password');

$id = PasswordReset::verify(trim((string) ($in['code'] ?? '')));

Database::run('UPDATE customers SET password = ? WHERE id = ?', [$hash, $id]);
$c = Database::one('SELECT email FROM customers WHERE id = ?', [$id]);
/* A successful reset clears failed sign-ins so the owner is not left locked out. */
Database::run('DELETE FROM login_attempts WHERE email = ? AND successful = 0', [$c['email'] ?? '']);

PasswordReset::clear();
$customer = Auth::loginCustomer($id);

Response::ok([
    'customer' => [
        'id'      => $customer['id'],
        'name'    => $customer['name'],
        'email'   => $customer['email'],
        'contact' => $customer['contact'],
        'status'  => $customer['status'] ?? null,
    ],
    'csrf' => Csrf::token(),
]);
