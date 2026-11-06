<?php
declare(strict_types=1);

/**
 * tools/migrate-images.php — one-time data migration, CLI only.
 *
 *     php tools/migrate-images.php            # dry run, reports and changes nothing
 *     php tools/migrate-images.php --apply    # writes files and rewrites columns
 *
 * Normalises every stored image value in every table to the application-root-
 * relative form (decision I3), and decodes the base64 that was living in
 * LONGTEXT into real files under /uploads/ (decision I2).
 *
 * RUN THIS BEFORE db/migrations/003-image-paths.sql. That migration narrows
 * the columns to VARCHAR(255); running it first would truncate a 918KB data
 * URL down to 255 characters with no way back. 003 has a guard that refuses to
 * start until this script has been run, but the ordering is stated in both
 * places because a guard is a backstop, not a plan.
 *
 * CLI ONLY. It is under tools/, which the project .htaccess already 404s
 * except for tools/ui-test/, and it refuses to run over HTTP regardless —
 * an endpoint that rewrites every image path in the database is not something
 * that should be reachable by URL at all.
 *
 * IDEMPOTENT. Values already in /uploads/ form are left alone, so a second run
 * reports "0 changed" rather than double-encoding anything.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require __DIR__ . '/../api/config/db.php';

$apply = in_array('--apply', $argv, true);

$root      = dirname(__DIR__);
$uploads   = $root . '/uploads';

/* Columns this script owns. Adding a new image-bearing column means adding a
   row here, which is the point of the table — the alternative is three
   near-identical loops that drift apart, which is how the original defects
   happened. */
$targets = [
    [
        'table'   => 'products',
        'key'     => 'id',
        'column'  => 'image_url',
        'purpose' => 'products',
        'label'   => 'name',
    ],
    [
        'table'   => 'hero_slides',
        'key'     => 'id',
        /* Before 003 this column is image_data; after it, image_path. Both are
           handled so the script runs correctly on either side of the schema
           change — which matters, because on a fresh install someone will run
           the migration first no matter what the comments say. */
        'column'  => null,
        'candidates' => ['image_data', 'image_path'],
        'purpose' => 'content',
        'label'   => 'title',
    ],
    [
        'table'   => 'orders',
        'key'     => 'id',
        'column'  => null,
        'candidates' => ['proof_image_path'],
        'purpose' => 'references',
        'label'   => 'customer_name',
    ],
];

$db = Database::pdo();

echo $apply
    ? "IMAGE MIGRATION — APPLYING\n"
    : "IMAGE MIGRATION — DRY RUN (pass --apply to write)\n";
echo str_repeat('=', 68), "\n\n";

$totals = ['scanned' => 0, 'converted' => 0, 'normalised' => 0, 'already' => 0,
           'empty' => 0, 'failed' => 0, 'missing_file' => 0];

foreach ($targets as $t) {
    $column = resolveColumn($t);
    if ($column === null) {
        printf("%-14s  column not present yet — skipped\n", $t['table']);
        continue;
    }

    $rows = Database::all(
        sprintf('SELECT %s AS k, %s AS v, %s AS label FROM %s',
            $t['key'], $column, $t['label'], $t['table'])
    );

    printf("%s.%s  (%d rows)\n", $t['table'], $column, count($rows));
    printf("%s\n", str_repeat('-', 68));

    foreach ($rows as $row) {
        $totals['scanned']++;
        $val   = $row['v'];
        $key   = (string) $row['k'];
        $label = (string) ($row['label'] ?? '');

        if ($val === null || trim((string) $val) === '') {
            $totals['empty']++;
            continue;
        }
        $val = trim((string) $val);

        /* Already canonical. */
        if (str_starts_with($val, '/uploads/')) {
            $abs = $root . $val;
            if (!is_file($abs)) {
                $totals['missing_file']++;
                printf("  MISSING FILE  %-18s %s -> %s\n", $key, $label, $val);
            } else {
                $totals['already']++;
            }
            continue;
        }

        /* An absolute URL somebody stored. Left alone — imageUrl() passes it
           through, and rewriting a third-party URL is not this script's call. */
        if (preg_match('#^https?://#i', $val)) {
            $totals['already']++;
            printf("  EXTERNAL URL  %-18s %s (left as-is)\n", $key, $label);
            continue;
        }

        /* A data URL: the format this whole exercise removes. Decode, re-encode
           through GD exactly as api/uploads/image.php does, write, repoint. */
        if (str_starts_with($val, 'data:')) {
            $result = convertDataUrl($val, $uploads . '/' . $t['purpose'], $apply);
            if ($result['ok'] === false) {
                $totals['failed']++;
                printf("  FAILED        %-18s %s — %s\n", $key, $label, $result['error']);
                continue;
            }
            $newPath = '/uploads/' . $t['purpose'] . '/' . $result['name'];
            $totals['converted']++;
            printf("  CONVERT       %-18s %-28s %sKB base64 -> %s (%sKB)\n",
                $key, substr($label, 0, 28),
                number_format(strlen($val) / 1024, 0),
                $result['name'],
                number_format($result['bytes'] / 1024, 0));

            if ($apply) {
                Database::run(
                    sprintf('UPDATE %s SET %s = ? WHERE %s = ?', $t['table'], $column, $t['key']),
                    [$newPath, $key]
                );
            }
            continue;
        }

        /* Anything else is a bare relative path from before any of this
           existed. Normalise the form only; the file, if there ever was one,
           is reported missing rather than invented. */
        $newPath = '/' . ltrim($val, './');
        $totals['normalised']++;
        printf("  NORMALISE     %-18s %s  %s -> %s\n", $key, $label, $val, $newPath);
        if (!is_file($root . $newPath)) {
            $totals['missing_file']++;
            printf("                %-18s   ^ no file at that path\n", '');
        }
        if ($apply) {
            Database::run(
                sprintf('UPDATE %s SET %s = ? WHERE %s = ?', $t['table'], $column, $t['key']),
                [$newPath, $key]
            );
        }
    }
    echo "\n";
}

echo str_repeat('=', 68), "\n";
printf("scanned            %d\n", $totals['scanned']);
printf("empty / NULL       %d\n", $totals['empty']);
printf("already canonical  %d\n", $totals['already']);
printf("converted          %d   (base64 -> file on disk)\n", $totals['converted']);
printf("normalised         %d   (path form corrected)\n", $totals['normalised']);
printf("rows changed       %d\n", $totals['converted'] + $totals['normalised']);
printf("pointing at a file that does not exist   %d\n", $totals['missing_file']);
printf("failed             %d\n", $totals['failed']);
echo $apply ? "\nApplied.\n" : "\nDry run — nothing was written. Re-run with --apply.\n";

exit($totals['failed'] > 0 ? 1 : 0);


/* ------------------------------------------------------------------ */

/** Which of the candidate column names this table actually has right now. */
function resolveColumn(array $t): ?string
{
    $names = $t['column'] !== null ? [$t['column']] : ($t['candidates'] ?? []);
    foreach ($names as $n) {
        $found = Database::scalar(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [$t['table'], $n]
        );
        if ((int) $found === 1) {
            return $n;
        }
    }
    return null;
}

/**
 * Decode a data URL and write it as a WebP, by the same rules the live
 * endpoint uses: verified MIME, GD round trip, server-chosen random name.
 *
 * The GD round trip is not cosmetic here. These rows were written by a client
 * that posted the untouched original file, EXIF and all, with only a regex
 * between it and the column — so they are the least-trusted bytes in the
 * database and they get the same treatment a fresh upload gets.
 */
function convertDataUrl(string $dataUrl, string $destDir, bool $apply): array
{
    if (!preg_match('#^data:([a-z0-9.+/-]+);base64,#i', $dataUrl, $m)) {
        return ['ok' => false, 'error' => 'not a base64 data URL'];
    }
    $payload = substr($dataUrl, strlen($m[0]));
    $binary  = base64_decode(preg_replace('/\s+/', '', $payload), true);
    if ($binary === false || $binary === '') {
        return ['ok' => false, 'error' => 'base64 did not decode'];
    }

    /* The declared type in the data URL is no more trustworthy than a posted
       Content-Type. Read the bytes. */
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime  = (string) $finfo->buffer($binary);
    $decoders = [
        'image/jpeg' => 'imagecreatefromstring',
        'image/png'  => 'imagecreatefromstring',
        'image/webp' => 'imagecreatefromstring',
        'image/gif'  => 'imagecreatefromstring',
    ];
    if (!isset($decoders[$mime])) {
        return ['ok' => false, 'error' => "unsupported content: {$mime}"];
    }

    $src = @imagecreatefromstring($binary);
    if ($src === false) {
        return ['ok' => false, 'error' => 'GD could not decode the image'];
    }

    $srcW = imagesx($src);
    $srcH = imagesy($src);
    $scale = min(1.0, 1600 / max($srcW, $srcH));
    $outW = max(1, (int) round($srcW * $scale));
    $outH = max(1, (int) round($srcH * $scale));

    $dst = imagecreatetruecolor($outW, $outH);
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $outW, $outH, $srcW, $srcH);
    imagedestroy($src);

    $name = bin2hex(random_bytes(16)) . '.webp';

    if (!$apply) {
        /* Encode to memory so the dry run reports the real output size rather
           than a guess, without touching the disk. */
        ob_start();
        imagewebp($dst, null, 82);
        $bytes = strlen((string) ob_get_clean());
        imagedestroy($dst);
        return ['ok' => true, 'name' => $name, 'bytes' => $bytes];
    }

    if (!is_dir($destDir) && !@mkdir($destDir, 0775, true) && !is_dir($destDir)) {
        imagedestroy($dst);
        return ['ok' => false, 'error' => "cannot create {$destDir}"];
    }

    $abs = $destDir . '/' . $name;
    $ok  = imagewebp($dst, $abs, 82);
    imagedestroy($dst);

    if (!$ok || !is_file($abs)) {
        return ['ok' => false, 'error' => 'could not write the file'];
    }
    return ['ok' => true, 'name' => $name, 'bytes' => (int) filesize($abs)];
}
