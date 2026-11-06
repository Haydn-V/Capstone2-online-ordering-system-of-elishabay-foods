<?php
declare(strict_types=1);

/** POST /api/uploads/discard.php lets a customer delete a payment screenshot they uploaded but did not use, allowed only if the path exactly matches one issued to this session (and not yet attached to an order); repeating it is harmless. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* Customers only. */
Auth::requireCustomer('Sign in to manage your payment attachment.');

$in   = Response::input();
$path = trim((string) ($in['path'] ?? ''));

if ($path === '') {
    Response::validation('Nothing to discard.', ['path' => 'A path is required.']);
}
if (!preg_match('#^/uploads/references/[a-f0-9]{32}\.webp$#', $path)) {
    Response::validation('That is not a discardable upload path.', [
        'path' => 'Only a payment screenshot this session uploaded can be discarded.',
    ]);
}

$issued = $_SESSION['eb_issued_uploads'] ?? [];
$idx    = is_array($issued) ? array_search($path, $issued, true) : false;

if ($idx === false) {
    /* Same message as a bad path, so nobody can learn whether another customer's file exists. */
    Response::validation('That is not a discardable upload path.', [
        'path' => 'Only a payment screenshot this session uploaded can be discarded.',
    ]);
}

/* Remove it from the list first so the request cannot be replayed. */
unset($issued[$idx]);
$_SESSION['eb_issued_uploads'] = array_values($issued);

/* Built from the matched list entry, not from the request. */
$abs = dirname(__DIR__, 2) . $path;
if (is_file($abs)) {
    @unlink($abs);
}

/* Log the discard to balance the upload's audit row. */
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, NULL, ?, ?)',
    [
        Auth::customer()['name'],
        'system',
        sprintf('Discarded unattached reference image %s.', $path),
    ]
);

Response::ok(['discarded' => true, 'path' => $path]);
