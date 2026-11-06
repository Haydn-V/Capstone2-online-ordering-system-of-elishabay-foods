<?php
declare(strict_types=1);

/**
 * tools/prune-uploads.php — find and remove uploaded files nothing points at.
 *
 *     php tools/prune-uploads.php                 # report only, deletes nothing
 *     php tools/prune-uploads.php --apply         # delete the orphans
 *     php tools/prune-uploads.php --grace=120     # change the safety window
 *
 * WHY THIS EXISTS
 * ---------------
 * api/uploads/image.php writes the file first and the database row second,
 * because that is the only order that lets the client show what it actually
 * stored before committing the record (decision I7). The consequence is that
 * every abandoned edit leaves a file behind:
 *
 *   - an administrator uploads a product photo and closes the modal
 *   - a shopper attaches a payment screenshot and does not place the order
 *   - any image is REPLACED — the new path is stored, the old file is not
 *     deleted, because the column no longer names it
 *
 * Nothing is exposed by this: the names are 32 random hex characters and the
 * directory refuses listing. But it grows monotonically and nothing else will
 * ever clean it.
 *
 * THE GRACE WINDOW IS THE WHOLE SAFETY MECHANISM
 * ----------------------------------------------
 * A file uploaded five seconds ago is unreferenced *and in active use* — the
 * modal is open and the administrator has not pressed Save yet. Deleting it
 * would break a save that was about to succeed, and the symptom would be
 * "that upload is no longer on the server" on a file they just chose.
 *
 * So only files older than --grace minutes (default 60) are ever considered.
 * An hour is longer than any realistic editing session and short enough that a
 * nightly run keeps the directory flat.
 *
 * CLI ONLY. tools/ is 404 in the project .htaccess except tools/ui-test/, and
 * this refuses to run over HTTP regardless — a URL that deletes files is not
 * something to leave reachable.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require __DIR__ . '/../api/config/db.php';

$apply = in_array('--apply', $argv, true);

$grace = 60;
foreach ($argv as $a) {
    if (preg_match('/^--grace=(\d+)$/', $a, $m)) {
        $grace = (int) $m[1];
    }
}

$root    = dirname(__DIR__);
$cutoff  = time() - ($grace * 60);

/* Every column that can name a file. Adding an image-bearing column means
   adding a line here — and forgetting to is why this is a table rather than
   three hand-written queries: a missed column would make this script DELETE
   live images, which is the one failure mode it must not have. */
$columns = [
    ['table' => 'products',    'column' => 'image_url'],
    ['table' => 'hero_slides', 'column' => 'image_path'],
    ['table' => 'orders',      'column' => 'proof_image_path'],
];

echo $apply ? "PRUNE UPLOADS — APPLYING\n" : "PRUNE UPLOADS — DRY RUN (pass --apply to delete)\n";
echo "Grace window: {$grace} minutes — files newer than that are never touched.\n";
echo str_repeat('=', 74), "\n\n";

/* ---- 1. What the database points at -------------------------------- */
$referenced = [];
foreach ($columns as $c) {
    $exists = Database::scalar(
        'SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [$c['table'], $c['column']]
    );
    if (!$exists) {
        /* Loud, not skipped. A column that has been renamed means this script's
           idea of "referenced" is incomplete, and continuing would delete live
           files. */
        fwrite(STDERR, "ABORT: {$c['table']}.{$c['column']} does not exist. "
            . "Update the \$columns table in this script before running it.\n");
        exit(2);
    }

    $rows = Database::all(
        sprintf('SELECT %s AS v FROM %s WHERE %s IS NOT NULL AND %s <> ""',
            $c['column'], $c['table'], $c['column'], $c['column'])
    );
    foreach ($rows as $r) {
        $referenced[trim((string) $r['v'])] = "{$c['table']}.{$c['column']}";
    }
    printf("%-32s %d reference(s)\n", "{$c['table']}.{$c['column']}", count($rows));
}
echo "\n";

/* ---- 2. What is on disk -------------------------------------------- */
$onDisk = [];
foreach (['products', 'content', 'references'] as $purpose) {
    $dir = $root . '/uploads/' . $purpose;
    if (!is_dir($dir)) {
        continue;
    }
    foreach (scandir($dir) ?: [] as $f) {
        if ($f === '.' || $f === '..' || $f === '.htaccess') {
            continue;
        }
        $abs = $dir . '/' . $f;
        if (!is_file($abs)) {
            continue;
        }
        $onDisk['/uploads/' . $purpose . '/' . $f] = $abs;
    }
}

/* ---- 3. Orphans: on disk, named by nothing -------------------------- */
$orphans = [];
$young   = 0;
$keptBytes = 0;
foreach ($onDisk as $path => $abs) {
    if (isset($referenced[$path])) {
        $keptBytes += (int) filesize($abs);
        continue;
    }
    if (filemtime($abs) > $cutoff) {
        $young++;                       /* inside the grace window — left alone */
        continue;
    }
    $orphans[$path] = $abs;
}

/* ---- 4. Dangling: named by a row, missing from disk ------------------ */
$dangling = [];
foreach ($referenced as $path => $where) {
    if (!is_file($root . $path)) {
        $dangling[$path] = $where;
    }
}

/* ---- 5. Report and act ---------------------------------------------- */
printf("files on disk        %d\n", count($onDisk));
printf("referenced           %d  (%s)\n", count($onDisk) - count($orphans) - $young,
    fmtBytes($keptBytes));
printf("inside grace window  %d  (younger than %d min, never touched)\n", $young, $grace);
printf("ORPHANED             %d\n", count($orphans));
printf("DANGLING             %d  (a row names a file that is not there)\n\n", count($dangling));

if ($dangling !== []) {
    echo "DANGLING — these rows point at nothing. Not fixable here; the image\n";
    echo "must be re-uploaded, or the column cleared.\n";
    foreach ($dangling as $path => $where) {
        printf("  %-58s %s\n", $path, $where);
    }
    echo "\n";
}

$freed = 0;
if ($orphans === []) {
    echo "No orphans. Nothing to do.\n";
} else {
    foreach ($orphans as $path => $abs) {
        $size = (int) filesize($abs);
        $age  = round((time() - filemtime($abs)) / 3600, 1);
        printf("  %-58s %8s  %sh old\n", $path, fmtBytes($size), $age);
        if ($apply) {
            if (@unlink($abs)) {
                $freed += $size;
            } else {
                fwrite(STDERR, "  could not delete {$abs}\n");
            }
        } else {
            $freed += $size;
        }
    }
    echo "\n";
    printf("%s %d file(s), %s\n",
        $apply ? 'Deleted' : 'Would delete',
        count($orphans), fmtBytes($freed));
}

echo $apply ? "\nApplied.\n" : "\nDry run — nothing was deleted. Re-run with --apply.\n";

exit(0);


function fmtBytes(int $b): string
{
    if ($b >= 1048576) return round($b / 1048576, 1) . ' MB';
    if ($b >= 1024)    return round($b / 1024) . ' KB';
    return $b . ' B';
}
