<?php
declare(strict_types=1);

/** GET /api/uploads/thumb.php makes and caches a 400px or 800px copy of a product or landing image (never payment proofs), falling back to the original on any problem; it skips session and database to stay fast. */

const THUMB_WIDTHS  = [400, 800];
const THUMB_QUALITY = 78;

$f = (string) ($_GET['f'] ?? '');
$w = (int) ($_GET['w'] ?? 0);

if (!preg_match('~^(products|content)/([0-9a-f]{32})\.webp$~', $f, $m) || !in_array($w, THUMB_WIDTHS, true)) {
    http_response_code(404);
    exit;
}

$root = dirname(__DIR__, 2) . '/uploads/';
$src  = $root . $f;
if (!is_file($src)) {
    http_response_code(404);
    exit;
}

$dir = $root . $m[1] . '/_w' . $w;
$out = $dir . '/' . $m[2] . '.webp';

$fallback = static function () use ($f): void {
    /* The original: same folder as the app, whatever it is mounted under. */
    $base = rtrim(dirname($_SERVER['SCRIPT_NAME'], 3), '/\\');
    header('Location: ' . $base . '/uploads/' . $f, true, 302);
    exit;
};

if (!is_file($out)) {
    try {
        $img = @imagecreatefromwebp($src);
        if (!$img) $fallback();
        $sw = imagesx($img);
        $sh = imagesy($img);
        if ($sw <= $w) {
            /* Already small enough — copying it would only cost quality. */
            $fallback();
        }
        $h   = max(1, (int) round($sh * $w / $sw));
        $dst = imagecreatetruecolor($w, $h);
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagecopyresampled($dst, $img, 0, 0, 0, 0, $w, $h, $sw, $sh);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) $fallback();
        /* Write then rename, so a visitor never reads a half-written file. */
        $tmp = $out . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (!imagewebp($dst, $tmp, THUMB_QUALITY) || !@rename($tmp, $out)) {
            @unlink($tmp);
            $fallback();
        }
    } catch (Throwable $e) {
        error_log('[thumb] ' . $e->getMessage());
        $fallback();
    }
}

header('Content-Type: image/webp');
header('Content-Length: ' . filesize($out));
header('Cache-Control: public, max-age=31536000, immutable');
header('X-Content-Type-Options: nosniff');
readfile($out);
