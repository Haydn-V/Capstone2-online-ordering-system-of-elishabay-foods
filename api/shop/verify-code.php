<?php
declare(strict_types=1);

/**
 * POST /api/shop/verify-code.php
 * Body: { "ticket": "vc-…", "code": "123456" }
 *
 * Requires a customer session. Completes a change that api/shop/profile.php
 * held back pending an emailed code.
 *
 * WHY THE CHANGE WAITS HERE RATHER THAN BEING APPLIED AND ROLLED BACK
 * ------------------------------------------------------------------
 * profile.php writes nothing sensitive. The pending values live in
 * verification_codes.payload as JSON until a correct code arrives, so an
 * abandoned verification leaves the account exactly as it was — no half-applied
 * email address, nothing to reconcile, and no window in which the account is
 * reachable at an address the owner has not confirmed.
 *
 * WHAT IS CHECKED, AND IN WHICH ORDER
 * -----------------------------------
 * Ownership first: the ticket must belong to the session's customer. A ticket
 * id is a random 10-hex string, but "unguessable" is not "authorised", and the
 * customer this code was issued for is the only one who may spend it.
 *
 * Then consumed, then expired, then attempt count — cheap checks before the
 * bcrypt comparison, and each one refused with a message that says what to do
 * next rather than a bare "invalid".
 *
 * FIVE ATTEMPTS
 * -------------
 * A six-digit code is one in a million per guess; unlimited tries turn that
 * into a certainty. The counter lives on the row, not in the session, because a
 * lockout a client can reset by clearing a cookie is not a lockout.
 *
 * A wrong code increments even when the request later fails for another reason.
 * The alternative — only counting "clean" wrong guesses — is a counter an
 * attacker can avoid.
 */

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

/* Scoped by session. A ticket that does not exist and one belonging to somebody
   else give the same answer, for the same reason cancel-order.php does. */
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
    /* Counted outside any transaction, so it survives whatever happens next —
       a counter that rolls back with a failed attempt counts nothing. */
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
    /* Should be impossible — profile.php writes it — but applying an unreadable
       payload would be worse than refusing. */
    Response::serverError('That change could not be read. Start it again.');
}

/* Only the two fields this purpose is allowed to touch. The payload is written
   by this application and never by a client, but a whitelist here means a bug
   upstream cannot turn a verified code into an arbitrary UPDATE. */
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

    /* Re-checked here, not only when the code was issued. customers.email is
       UNIQUE and somebody else can register the address during the ten minutes
       a code is live — without this the UPDATE fails on the constraint and the
       customer sees a 500 instead of an explanation. */
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

    /* Consumed conditionally: a second request carrying the same correct code
       — a double-clicked button, a retried request — must not apply the change
       twice or reopen a spent code. */
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

    /* This one DOES get an audit row, where an address change does not.

       shop/profile.php explains why ordinary profile edits are not written to
       audit_logs: it is a staff trail with a users.id actor column. The same
       objection applies here — and is outweighed. An email change moves where
       password resets and order confirmations go; if it happens without the
       owner's knowledge there has to be something to find afterwards. The actor
       is the customer's name with actor_user_id NULL, the shape checkout.php
       already uses.

       The old address is recorded because after this row is written it is the
       only place it still exists. */
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

/* The same payload shape shop/profile.php returns, so the page re-renders from
   one code path whichever endpoint answered. profilePayload() lives in
   profile.php; this repeats it rather than requiring that file, because
   requiring it would execute its request handling. */
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
