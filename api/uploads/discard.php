<?php
declare(strict_types=1);

/**
 * POST /api/uploads/discard.php
 *
 * Delete a payment screenshot that was uploaded but never attached to an order.
 *
 * Body: { "path": "/uploads/references/<32 hex>.webp" }
 *
 * WHY THIS EXISTS
 * ---------------
 * api/uploads/image.php writes the file the moment the shopper picks it,
 * because uploading at submit time would mean a checkout that fails halfway
 * with the order already priced. The cost of that choice is orphans: every
 * screenshot the shopper removes or replaces before placing the order is a
 * file on disk that no row will ever point at, accumulating in
 * uploads/references/ for ever. The checkout's Remove and Replace controls
 * call this.
 *
 * WHY IT IS SAFE TO LET A CLIENT NAME A FILE TO DELETE
 * ----------------------------------------------------
 * Because it does not. The path in the body is never used to build a
 * filesystem path on its own — it is compared, as a whole string, against the
 * list of paths api/uploads/image.php actually issued to THIS session
 * ($_SESSION['eb_issued_uploads']). Only an exact match proceeds, and the
 * absolute path is then built from the matched entry.
 *
 * The regex below is defence in depth, not the gate. Shape proves only that a
 * string LOOKS like one of ours, and `/uploads/references/<32 hex>.webp` is a
 * shape anyone can type; it stops a traversal attempt from ever reaching the
 * comparison, and the comparison is what stops everything else. A caller
 * cannot delete another customer's screenshot, cannot delete a product photo
 * (image.php records `references` paths only, so nothing else is ever in the
 * list), and cannot delete anything outside the folder.
 *
 * A PATH THAT REACHED AN ORDER IS NOT DISCARDABLE. api/shop/checkout.php
 * removes the proof it used from this list inside the same request that writes
 * the order, so a shopper cannot place an order and then delete the evidence
 * staff are meant to verify.
 *
 * IDEMPOTENT. A second discard of the same path, or a path whose file has
 * already gone from disk, answers 200. The caller asked for the file to be
 * gone; it is gone. Making Remove fail because the shopper double-clicked
 * would be a worse outcome than the no-op.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* Customers only. The other two upload purposes are staff flows that attach
   the image to a record and have no use for this. */
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
    /* Not ours to delete. Deliberately the same message as the shape failure
       above: distinguishing "that file does not exist" from "that file exists
       but is not yours" would confirm the existence of another customer's
       upload to anyone willing to guess. */
    Response::validation('That is not a discardable upload path.', [
        'path' => 'Only a payment screenshot this session uploaded can be discarded.',
    ]);
}

/* Off the list first. If the unlink below fails the file stays on disk as an
   orphan — which is exactly where we were before this endpoint existed — but
   the entry cannot be replayed. */
unset($issued[$idx]);
$_SESSION['eb_issued_uploads'] = array_values($issued);

/* Built from the matched list entry, not from the request. */
$abs = dirname(__DIR__, 2) . $path;
if (is_file($abs)) {
    @unlink($abs);
}

/* Balances the upload row image.php writes (D13). Without it the log shows a
   file being created and never mentions that it was thrown away, which reads
   as a file that should still be there. */
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
