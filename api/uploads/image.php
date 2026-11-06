<?php
declare(strict_types=1);

/** POST /api/uploads/image.php is the only upload endpoint: it checks the real file type, re-encodes to WebP with a server-chosen name (stripping hidden data), and returns an app-root-relative path like /uploads/products/<hex>.webp. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* The purpose decides who may upload: customers only payment references, staff need the permission for the record the image belongs to; checked before reading the file. */
$PURPOSES = [
    'products'   => ['perm' => 'products.manage', 'who' => 'staff'],
    'content'    => ['perm' => 'landing.manage',  'who' => 'staff'],
    'references' => ['perm' => null,              'who' => 'customer'],
    /* Staff's screenshot of a completed GCash/bank refund, shown to the customer as proof. */
    'refunds'    => ['perm' => 'orders.returns',  'who' => 'staff'],
    /* Payment QR codes are saved lossless, because compression blurs QR squares and phones then cannot scan them. */
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

/* The upload itself */
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;   /* what we accept from the client */
const OUTPUT_MAX_EDGE  = 1600;              /* longest edge after re-encode    */
const OUTPUT_QUALITY   = 82;                /* WebP quality                    */

if (!isset($_FILES['file'])) {
    /* A request larger than post_max_size arrives empty, so say the file was too large. */
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

/* Translate PHP's upload error codes into clear messages. */
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
    /* Refuse anything that is not a genuine uploaded file. */
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

/* Detect the real type with finfo, not the browser-supplied type. */
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

/* getimagesize double-checks the file and gives its dimensions. */
$size = @getimagesize($tmp);
if ($size === false || (int) $size[0] < 1 || (int) $size[1] < 1) {
    Response::validation('That image could not be read.', [
        'file' => 'The file is corrupt or not a real image.',
    ]);
}
[$srcW, $srcH] = [(int) $size[0], (int) $size[1]];

/* Refuse huge pixel dimensions that would use gigabytes of memory. */
if ($srcW * $srcH > 50_000_000) {
    Response::validation('That image is too large.', [
        'file' => 'Maximum 50 megapixels.',
    ]);
}

/* Decode, downscale and re-encode, reporting GD failures as a validation error instead of a 500. */
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

    /* Keep transparency when resizing. */
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

/* The server names the file; the client's filename is never used. */
$projectRoot = dirname(__DIR__, 2);              /* api/uploads -> api -> root */
/* Some purposes share a folder (payment QR codes live with landing content), always chosen by the server. */
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

/* Remember payment-reference paths issued to this session (max 50) so discard.php can safely delete only the customer's own unused uploads. */
if ($purpose === 'references') {
    $issued   = $_SESSION['eb_issued_uploads'] ?? [];
    $issued[] = $path;
    if (count($issued) > 50) {
        $issued = array_slice($issued, -50);
    }
    $_SESSION['eb_issued_uploads'] = $issued;
}

/* Every upload is audited. */
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [
        $actorLabel,
        /* actor_user_id is NULL for customer uploads (it must be a staff user), but the name is still recorded. */
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
