<?php
declare(strict_types=1);

/** POST /api/shop/verify-code.php applies a held email/contact change once the emailed code matches, checking ownership, used, expiry and attempts (max 5, counted on the row) before comparing the code. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer = Auth::requireCustomer('Sign in to confirm this change.');

$in = Response::input();

$data = Validate::check($in)
    ->required('ticket', 'Verification')
    ->required('code', 'Code')
    ->values();

$code = preg_replace('/\D/', '', (string) $data['code']);
if ($code === '' || strlen((string) $code) !== 6) {
    Response::validation('Please check the code.', [
        'code' => 'Enter the six-digit code from your email.',
    ]);
}

/* Look up by session, with the same answer for a missing ticket or someone else's. */
$vc = Database::one(
    'SELECT id, customer_id, purpose, code_hash, payload, attempts, expires_at, consumed_at
       FROM verification_codes WHERE id = ? AND customer_id = ?',
    [$data['ticket'], $customer['id']]
);
if ($vc === null) {
    Response::notFound('Not found.');
}

if ($vc['consumed_at'] !== null) {
    Response::conflict('That code has already been used. Start the change again if you still need to.');
}
if (strtotime((string) $vc['expires_at']) <= time()) {
    Response::conflict('That code has expired. Start the change again to get a new one.');
}
if ((int) $vc['attempts'] >= 5) {
    Response::rateLimited('Too many incorrect codes. Start the change again to get a new one.');
}

if (!password_verify((string) $code, (string) $vc['code_hash'])) {
    /* Count the attempt outside any transaction so it is never rolled back. */
    Database::run('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?', [$vc['id']]);

    $left = 5 - ((int) $vc['attempts'] + 1);
    Response::validation('That code is not correct.', [
        'code' => $left > 0
            ? sprintf('Incorrect code. %d attempt%s left.', $left, $left === 1 ? '' : 's')
            : 'Incorrect code. Start the change again to get a new one.',
    ]);
}

$payload = json_decode((string) $vc['payload'], true);
if (!is_array($payload) || $payload === []) {
    /* Refuse an unreadable payload rather than apply it. */
    Response::serverError('That change could not be read. Start it again.');
}

/* Only the two allowed fields can be updated from the payload. */
$allowed = ['email' => 'email', 'contact' => 'contact'];
$set     = [];
$params  = [];
$changed = [];
foreach ($payload as $key => $value) {
    if (!isset($allowed[$key])) {
        continue;
    }
    $set[]     = $allowed[$key] . ' = ?';
    $params[]  = $value === '' ? null : $value;
    $changed[] = $key;
}
if ($set === []) {
    Response::serverError('That change could not be applied. Start it again.');
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* Re-check the email is still free, since someone may have registered it meanwhile. */
    if (isset($payload['email'])) {
        $taken = Database::scalar(
            'SELECT id FROM customers WHERE email = ? AND id <> ?',
            [$payload['email'], $customer['id']]
        );
        if ($taken) {
            $pdo->rollBack();
            Response::conflict('That email address was registered by someone else while you were confirming. Try a different one.');
        }
    }

    /* Mark the code used conditionally so a double submit cannot apply the change twice. */
    Database::run(
        'UPDATE verification_codes SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
        [$vc['id']]
    );
    if ((int) $pdo->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('That code has already been used.');
    }

    $params[] = $customer['id'];
    Database::run('UPDATE customers SET ' . implode(', ', $set) . ' WHERE id = ?', $params);

    /* Email changes do get an audit row (with the old address), because they affect account recovery. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$customer['name'], 'user',
         sprintf('Customer %s confirmed an account change by emailed code: %s.',
             $customer['id'],
             implode('; ', array_map(
                 static fn(string $k): string => $k === 'email'
                     ? sprintf('email %s → %s', $customer['email'], $payload['email'])
                     : sprintf('contact number updated'),
                 $changed
             )))]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

$row = Database::one(
    'SELECT id, name, email, contact,
            addr_street, addr_city, addr_province, addr_zip, addr_region
       FROM customers WHERE id = ?',
    [$customer['id']]
);

/* Return the same shape as shop/profile.php (copied, since requiring that file would run it). */
$parts = array_values(array_filter([
    $row['addr_street'], $row['addr_city'], $row['addr_province'],
    $row['addr_zip'], $row['addr_region'],
], static fn(?string $v): bool => $v !== null && trim($v) !== ''));

Response::ok([
    'id'      => $row['id'],
    'name'    => $row['name'],
    'email'   => $row['email'],
    'contact' => $row['contact'],
    'address' => [
        'street'   => $row['addr_street'],
        'city'     => $row['addr_city'],
        'province' => $row['addr_province'],
        'zip'      => $row['addr_zip'],
        'region'   => $row['addr_region'],
        'line'     => $parts === [] ? '' : implode(', ', $parts),
        'hasAny'   => $parts !== [],
    ],
    'changed' => $changed,
    'requiresVerification' => false,
]);
