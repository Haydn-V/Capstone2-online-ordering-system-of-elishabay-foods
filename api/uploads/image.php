<?php
declare(strict_types=1);

/**
 * POST /api/uploads/image.php   (multipart/form-data)
 *
 * THE ONLY UPLOAD ENDPOINT IN THE SYSTEM (decision I1).
 *
 * Body (multipart):
 *   file     — the image
 *   purpose  — "products" | "content" | "references"
 *
 * Returns: { ok: true, data: { path: "/uploads/products/<32 hex>.webp",
 *                              bytes: 48213, width: 1200, height: 900 } }
 *
 * WHY ONE ENDPOINT
 * ----------------
 * Before this file the system had four upload controls and zero upload code.
 * Two of them base64'd the file into a JSON body, two sent nothing at all, and
 * each screen had invented its own idea of where an image lives. Three separate
 * "images don't show" defects came out of that. Product photos, landing content
 * and customer payment references all come through here now; there is one place
 * that decides what a valid image is and one place that names the file.
 *
 * WHAT IS STORED, AND WHAT IS RETURNED
 * ------------------------------------
 * The file goes on disk. The database stores a path (I2). The returned path is
 * APPLICATION-root-relative — it starts at the project root, not at the web
 * server root and never at the calling page:
 *
 *     /uploads/products/ab12….webp
 *
 * It is deliberately NOT "/elishabay/uploads/…". The install prefix is
 * `app.base_path` in config and can differ between machines; baking it into
 * every row would mean a database that only resolves on one deployment. The
 * client's imageUrl() in assets/js/core/format.js prepends the prefix, which is
 * the whole reason decision I6 asks for one resolver.
 *
 * Relative paths ("uploads/…" or "../uploads/…") are what caused the original
 * bug where staff screens resolved an image and customer screens 404'd, so a
 * stored value here always begins with a slash.
 *
 * SECURITY (decision I5)
 * ----------------------
 *  - The MIME type is read from the file's own bytes with finfo. $_FILES['type']
 *    is supplied by the browser and is not evidence of anything.
 *  - The extension is derived from the verified MIME, never from the upload's
 *    filename. The client's filename never appears in the path at all (I4).
 *  - Every accepted image is decoded by GD and re-encoded to WebP. That drops
 *    EXIF, ICC profiles, trailing appended data and anything else riding along
 *    in the container — a polyglot JPEG/PHP file does not survive a round trip
 *    through imagecreatefromjpeg().
 *  - uploads/.htaccess removes every PHP handler. An upload directory that can
 *    execute PHP is a shell, and the re-encode above is the second lock on the
 *    same door rather than the only one.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* ---------------------------------------------------------------
   1. Purpose, and who is allowed to use it
   ---------------------------------------------------------------
   The permission is decided by what the image is FOR. A customer may upload a
   payment reference against their own checkout and nothing else; staff need the
   same permission they would need to edit the record the image ends up on.

   Checked before the file is looked at, so an unauthorised caller cannot use
   this endpoint as a free image validator or a disk-filling primitive. */
$PURPOSES = [
    'products'   => ['perm' => 'products.manage', 'who' => 'staff'],
    'content'    => ['perm' => 'landing.manage',  'who' => 'staff'],
    'references' => ['perm' => null,              'who' => 'customer'],
    /* The GCash / bank QR codes customers scan to pay (Landing Page
       Maintenance). Filed with the other landing images, and encoded
       LOSSLESS: every other purpose here is a photo, where WebP q82 is
       invisible, but lossy compression softens the edges of a QR code's
       squares, and a blurred code is one a phone will not scan. */
    'payment-qr' => ['perm' => 'landing.manage',  'who' => 'staff', 'dir' => 'content', 'lossless' => true],
];

$purpose = trim((string) ($_POST['purpose'] ?? ''));
if (!isset($PURPOSES[$purpose])) {
    Response::validation('Unknown upload purpose.', [
        'purpose' => 'Must be one of: ' . implode(', ', array_keys($PURPOSES)) . '.',
    ]);
}

$rule   = $PURPOSES[$purpose];
$actor  = null;
if ($rule['who'] === 'staff') {
    $actor = Rbac::require($rule['perm']);
    $actorLabel = $actor['name'];
} else {
    $customer = Auth::requireCustomer('Sign in to attach a payment reference.');
    $actorLabel = $customer['name'];
}

/* ---------------------------------------------------------------
   2. The upload itself
   --------------------------------------------------------------- */
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;   /* what we accept from the client */
const OUTPUT_MAX_EDGE  = 1600;              /* longest edge after re-encode    */
const OUTPUT_QUALITY   = 82;                /* WebP quality                    */

if (!isset($_FILES['file'])) {
    /* A POST larger than post_max_size arrives with $_FILES and $_POST both
       empty and no error code anywhere — the request looks like it was sent
       without a file. Saying so beats "no file was uploaded". */
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($contentLength > 0 && $_POST === []) {
        Response::validation('That file is too large to upload.', [
            'file' => 'The server accepts up to ' . ini_get('post_max_size') . ' per request.',
        ]);
    }
    Response::validation('No file was uploaded.', ['file' => 'Choose an image to upload.']);
}

$file = $_FILES['file'];
if (is_array($file['name'])) {
    Response::validation('Upload one file at a time.', ['file' => 'Multiple files are not accepted here.']);
}

/* PHP's own error codes, translated. UPLOAD_ERR_INI_SIZE in particular used to
   surface as a silent no-op on the storefront, which is precisely the "silent
   failure at checkout" the brief rules out. */
$uploadErrors = [
    UPLOAD_ERR_INI_SIZE   => 'That file is larger than the server accepts (' . ini_get('upload_max_filesize') . ').',
    UPLOAD_ERR_FORM_SIZE  => 'That file is larger than the form allows.',
    UPLOAD_ERR_PARTIAL    => 'The upload was interrupted. Try again.',
    UPLOAD_ERR_NO_FILE    => 'Choose an image to upload.',
    UPLOAD_ERR_NO_TMP_DIR => 'The server has no temporary folder configured.',
    UPLOAD_ERR_CANT_WRITE => 'The server could not write the uploaded file.',
    UPLOAD_ERR_EXTENSION  => 'A PHP extension stopped the upload.',
];
$err = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
if ($err !== UPLOAD_ERR_OK) {
    Response::validation('That file could not be uploaded.', [
        'file' => $uploadErrors[$err] ?? 'Unknown upload error.',
    ]);
}

$tmp = (string) $file['tmp_name'];
if (!is_uploaded_file($tmp)) {
    /* Not a real upload — the only way to reach this is a forged $_FILES or a
       path handed in some other way. Refused rather than read. */
    Response::badRequest('That was not a valid file upload.');
}

$bytes = (int) $file['size'];
if ($bytes <= 0) {
    Response::validation('That file is empty.', ['file' => 'The file contains no data.']);
}
if ($bytes > UPLOAD_MAX_BYTES) {
    Response::validation('That image is too large.', [
        'file' => 'Keep it under ' . (UPLOAD_MAX_BYTES / 1024 / 1024) . 'MB.',
    ]);
}

/* ---------------------------------------------------------------
   3. What the bytes actually are
   ---------------------------------------------------------------
   finfo, not $_FILES['type'] — the posted type is a client-supplied string and
   says nothing about the content. */
$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime  = (string) $finfo->file($tmp);

$ACCEPTED = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp',
];
if (!isset($ACCEPTED[$mime])) {
    Response::validation('That file is not a supported image.', [
        'file' => 'Upload a JPEG, PNG or WebP image.',
    ]);
}

/* getimagesize is a second, independent opinion, and it is what tells us the
   dimensions before allocating anything. A file that finfo calls an image but
   this cannot size is malformed. */
$size = @getimagesize($tmp);
if ($size === false || (int) $size[0] < 1 || (int) $size[1] < 1) {
    Response::validation('That image could not be read.', [
        'file' => 'The file is corrupt or not a real image.',
    ]);
}
[$srcW, $srcH] = [(int) $size[0], (int) $size[1]];

/* A 40,000 x 40,000 PNG compresses to a few hundred KB and expands to about
   6GB in memory. The byte cap above does not catch it; this does. */
if ($srcW * $srcH > 50_000_000) {
    Response::validation('That image is too large.', [
        'file' => 'Maximum 50 megapixels.',
    ]);
}

/* ---------------------------------------------------------------
   4. Decode, downscale, re-encode
   ---------------------------------------------------------------
   bootstrap.php promotes warnings to exceptions, so a GD failure would
   otherwise become a 500 that reads as "the server broke" rather than "that
   file is not usable". Caught and reported as a validation failure. */
$decoders = [
    'image/jpeg' => 'imagecreatefromjpeg',
    'image/png'  => 'imagecreatefrompng',
    'image/webp' => 'imagecreatefromwebp',
];

$src = null;
$dst = null;
try {
    $src = $decoders[$mime]($tmp);
} catch (Throwable $e) {
    error_log('[uploads] decode failed: ' . $e->getMessage());
    Response::validation('That image could not be decoded.', [
        'file' => 'The file is corrupt or uses an unsupported variant.',
    ]);
}
if (!$src) {
    Response::validation('That image could not be decoded.', [
        'file' => 'The file is corrupt or uses an unsupported variant.',
    ]);
}

$scale = min(1.0, OUTPUT_MAX_EDGE / max($srcW, $srcH));
$outW  = max(1, (int) round($srcW * $scale));
$outH  = max(1, (int) round($srcH * $scale));

try {
    $dst = imagecreatetruecolor($outW, $outH);

    /* Transparency survives the resample. Flattening to white here is what the
       old client-side encoder did, and it turned every logo with an alpha
       channel into a white box. */
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $outW, $outH, $srcW, $srcH);
} catch (Throwable $e) {
    if ($src) { imagedestroy($src); }
    if ($dst) { imagedestroy($dst); }
    error_log('[uploads] resample failed: ' . $e->getMessage());
    Response::serverError('That image could not be processed.');
}
imagedestroy($src);

/* ---------------------------------------------------------------
   5. Where it goes, and what it is called
   ---------------------------------------------------------------
   The server names the file (I4). The client's filename is used for nothing —
   not the path, not the extension, not a stored "original name" field. There is
   no traversal to defend against because no caller-supplied string reaches the
   path at all. */
$projectRoot = dirname(__DIR__, 2);              /* api/uploads -> api -> root */
/* A purpose may file into another purpose's folder: payment QR codes live with
   the rest of the landing content. The folder still comes from the table
   above, never from the request. */
$folder      = $rule['dir'] ?? $purpose;
$dir         = $projectRoot . '/uploads/' . $folder;

if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
    error_log('[uploads] cannot create ' . $dir);
    Response::serverError('The upload folder could not be created.');
}

$name = bin2hex(random_bytes(16)) . '.webp';
$abs  = $dir . '/' . $name;

$written = false;
try {
    $written = imagewebp($dst, $abs, !empty($rule['lossless']) ? IMG_WEBP_LOSSLESS : OUTPUT_QUALITY);
} catch (Throwable $e) {
    error_log('[uploads] encode failed: ' . $e->getMessage());
}
imagedestroy($dst);

if (!$written || !is_file($abs)) {
    @unlink($abs);
    Response::serverError('The image could not be saved.');
}

$finalBytes = (int) filesize($abs);
$path       = '/uploads/' . $folder . '/' . $name;

/* ---------------------------------------------------------------
   6. Remember that WE issued this path, so it can be discarded
   ---------------------------------------------------------------
   A payment screenshot is written to disk the moment the shopper picks it,
   because uploading at submit time means a checkout that fails halfway with
   the order already priced. The cost of that choice is orphans: every
   screenshot the shopper then removes or replaces is a file no order will ever
   point at. api/uploads/discard.php deletes those, and this list is what makes
   deleting them safe.

   The membership test is the gate, not the regex. A path arriving at
   discard.php is a client-supplied string; matching its SHAPE would only prove
   it looks like one of ours, and `/uploads/references/<32 hex>.webp` is a
   shape anybody can type. Matching it against paths this endpoint actually
   issued to THIS session proves it is theirs. No caller-supplied string is
   ever used to build a filesystem path.

   ONLY `references`. Recording every purpose would mean a staff member who
   uploaded a product photo and is also signed in as a customer in the same
   browser could discard that photo through the customer-facing endpoint. The
   two other purposes are staff flows that attach the image to a record; they
   have no discard path and do not want one here.

   Capped, because a session is not storage. Fifty is far more attachments than
   a checkout can plausibly involve, and the oldest entry falling off the list
   only costs an orphan — the same orphan we had before this existed. */
if ($purpose === 'references') {
    $issued   = $_SESSION['eb_issued_uploads'] ?? [];
    $issued[] = $path;
    if (count($issued) > 50) {
        $issued = array_slice($issued, -50);
    }
    $_SESSION['eb_issued_uploads'] = $issued;
}

/* Every write is auditable (D13). Uploads are how a file gets onto the server;
   an unattributed one is not something anyone should have to reconstruct from
   file timestamps. */
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [
        $actorLabel,
        /* NULL for a customer upload — actor_user_id is a users.id foreign key
           and a shopper is not a user. The display name still records who.
           Written as an explicit null check rather than `$actor['id'] ?? null`
           because bootstrap promotes "array offset on null" to an exception. */
        $actor !== null ? $actor['id'] : null,
        'system',
        sprintf('Uploaded %s image %s (%dx%d, %s KB).',
            $purpose, $path, $outW, $outH, number_format($finalBytes / 1024, 0)),
    ]
);

Response::created([
    'path'   => $path,
    'bytes'  => $finalBytes,
    'width'  => $outW,
    'height' => $outH,
]);
