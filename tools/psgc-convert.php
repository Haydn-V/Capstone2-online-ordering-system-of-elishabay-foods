<?php
declare(strict_types=1);

/**
 * tools/psgc-convert.php — turn the PSA's PSGC publication into
 * db/seed-ph-locations.sql. CLI only.
 *
 *     php tools/psgc-convert.php db/psgc/PSGC-2Q-2025-Publication-Datafile.xlsx
 *     php tools/psgc-convert.php <file> --out=some/other/path.sql
 *     php tools/psgc-convert.php <file> --check      # report only, write nothing
 *
 * The input is the Philippine Standard Geographic Code publication data file,
 * exactly as downloaded from the Philippine Statistics Authority
 * (https://psa.gov.ph/classification/psgc). Do not open it and re-save it:
 * Excel's plain "CSV" is not UTF-8, and a round trip through it turns
 * "Las Piñas" and "Parañaque" into mojibake. A UTF-8 CSV is accepted too, for
 * anyone who has one, but the .xlsx as published is the thing to use.
 *
 * WHY THIS IS A CONVERTER AND NOT A HAND-WRITTEN LIST
 * ---------------------------------------------------
 * ~1,600 cities and municipalities and ~42,000 barangays are not something to
 * type from memory, and a wrong or missing town is exactly what a person finds
 * by typing their own hometown. Every row in the output comes from the PSA
 * file; nothing is added, renamed or inferred beyond the parent links, which are
 * read off the codes themselves.
 *
 * NO ZipArchive. An .xlsx is a zip of XML files, and XAMPP's PHP ships without
 * the zip extension enabled. Rather than make "edit php.ini" a step in loading
 * an address list, this reads the zip's central directory itself and inflates
 * with zlib, which IS built in. It handles the two compression methods an
 * .xlsx actually uses (stored and deflate) and refuses anything else loudly.
 *
 * HOW PARENTS ARE FOUND — from the 10-digit PSGC code, never from names:
 *
 *     RR PPP MM BBB     region · province · city/municipality · barangay
 *
 *   region of any row    RR + 00000000
 *   province of a city   RRPPP + 00000   — only if that is a PROVINCE row
 *   city of a barangay   RRPPPMM + 000
 *
 * CITIES WITH NO PROVINCE. Metro Manila's cities and Pateros, and highly
 * urbanised cities elsewhere, are coded at the province level of their own
 * segment, so the province their code points at is not a Prov row. Those get
 * province_code NULL (region_code is always set). The rule is the same for all
 * of them and comes from the codes — no list of "special" cities is kept here.
 *
 * THE CITY OF MANILA. Its barangays are coded under sub-municipalities
 * (Tondo I, Sampaloc…), which are not cities. Those barangays are re-parented
 * to Manila — SubMun code RRPPP + 00000 — and the district name is kept in
 * ph_barangays.sub_municipality.
 *
 * IT REFUSES TO WRITE A FILE IT CANNOT VOUCH FOR. Duplicate codes, a barangay
 * with no city, a city with no region: any of these means an assumption above
 * is wrong for this edition of the file, and a seed with silent holes in it is
 * worse than no seed. Counts far from the expected ones are reported as
 * warnings rather than failures — a later PSGC release is allowed to differ.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('memory_limit', '1024M');

/* ---------------------------------------------------------------- args */

$args  = array_slice($argv, 1);
$check = in_array('--check', $args, true);
$out   = dirname(__DIR__) . '/db/seed-ph-locations.sql';
$src   = null;
foreach ($args as $a) {
    if (str_starts_with($a, '--out=')) { $out = substr($a, 6); continue; }
    if (str_starts_with($a, '--'))     { continue; }
    $src = $a;
}
if ($src === null || !is_file($src)) {
    fwrite(STDERR, "Usage: php tools/psgc-convert.php <PSGC publication .xlsx or UTF-8 .csv> [--check] [--out=path]\n");
    exit(2);
}

function fail(string $msg): never
{
    fwrite(STDERR, "\nREFUSED: $msg\n\nNothing was written.\n");
    exit(1);
}

/* ------------------------------------------------------ reading a table */

/**
 * Every row of the first sheet that has a "Geographic Level" column, as arrays
 * of strings indexed by column number. Also returns any "as of" line found
 * above the header, which is where the PSA prints the date the edition covers.
 *
 * @return array{rows: list<array<int,string>>, header_row: int, as_of: ?string}
 */
function read_table(string $path): array
{
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return $ext === 'csv' ? read_csv($path) : read_xlsx($path);
}

function read_csv(string $path): array
{
    $fh = fopen($path, 'rb');
    $rows = [];
    while (($r = fgetcsv($fh, 0, ',', '"', '')) !== false) {
        $rows[] = array_map(static fn($v) => trim((string) $v), $r);
    }
    fclose($fh);
    if ($rows && isset($rows[0][0])) {
        $rows[0][0] = preg_replace('/^\xEF\xBB\xBF/', '', $rows[0][0]);   // BOM
    }
    /* A CSV that went through Excel's non-UTF-8 "CSV" format is the one way
       this input can arrive quietly broken. ñ is the canary. */
    foreach ($rows as $r) {
        foreach ($r as $v) {
            if ($v !== '' && !mb_check_encoding($v, 'UTF-8')) {
                fail("the CSV is not UTF-8 (Excel's plain \"CSV\" format is not). "
                   . "Use the .xlsx as downloaded, or re-save as \"CSV UTF-8\".");
            }
        }
    }
    return locate_header($rows);
}

/** Every entry of a zip, by name, using the central directory. */
function zip_open(string $path): array
{
    $data = file_get_contents($path);
    if ($data === false || strlen($data) < 22) fail("could not read $path");

    /* End-of-central-directory record: search backwards, it may be followed
       by a comment of up to 64KB. */
    $eocd = strrpos($data, "PK\x05\x06");
    if ($eocd === false) fail("$path is not an .xlsx (no zip directory found)");

    $cd = unpack('Vsize/Voffset', substr($data, $eocd + 12, 8));
    $entries = [];
    $p   = $cd['offset'];
    $end = $cd['offset'] + $cd['size'];
    while ($p < $end && substr($data, $p, 4) === "PK\x01\x02") {
        $h = unpack(
            'vmade/vneed/vflag/vmethod/vtime/vdate/Vcrc/Vcsize/Vusize/vnlen/vxlen/vclen/vdisk/vint/Vext/Voffset',
            substr($data, $p + 4, 42)
        );
        $name = substr($data, $p + 46, $h['nlen']);
        $entries[$name] = $h;
        $p += 46 + $h['nlen'] + $h['xlen'] + $h['clen'];
    }
    if (!$entries) fail("$path has an empty zip directory");
    return [$data, $entries];
}

function zip_read(string $data, array $h, string $name): string
{
    $lo = $h['offset'];
    if (substr($data, $lo, 4) !== "PK\x03\x04") fail("corrupt zip entry $name");
    $l = unpack('vneed/vflag/vmethod/vtime/vdate/Vcrc/Vcsize/Vusize/vnlen/vxlen', substr($data, $lo + 4, 26));
    /* Sizes from the CENTRAL directory: a local header written with a data
       descriptor carries zeroes here, and trusting it would read nothing. */
    $body = substr($data, $lo + 30 + $l['nlen'] + $l['xlen'], $h['csize']);
    return match ($h['method']) {
        0 => $body,
        8 => (static function () use ($body, $name) {
            $s = @gzinflate($body);
            if ($s === false) fail("could not inflate $name");
            return $s;
        })(),
        default => fail("$name uses zip compression method {$h['method']}, which an .xlsx should not"),
    };
}

function read_xlsx(string $path): array
{
    [$data, $entries] = zip_open($path);

    /* Shared strings: most cell text lives here, referenced by index. Rich
       text splits one string into several <t> runs, so they are joined. */
    $shared = [];
    if (isset($entries['xl/sharedStrings.xml'])) {
        $xr = new XMLReader();
        $xr->XML(zip_read($data, $entries['xl/sharedStrings.xml'], 'sharedStrings'));
        $cur = null;
        while ($xr->read()) {
            if ($xr->nodeType === XMLReader::ELEMENT && $xr->localName === 'si') {
                $cur = '';
            } elseif ($xr->nodeType === XMLReader::ELEMENT && $xr->localName === 't' && $cur !== null) {
                $cur .= $xr->readString();
            } elseif ($xr->nodeType === XMLReader::END_ELEMENT && $xr->localName === 'si') {
                $shared[] = $cur;
                $cur = null;
            }
        }
        $xr->close();
    }

    /* Try every worksheet; use the first with a "Geographic Level" header.
       The publication carries notes and summary sheets beside the data. */
    $sheets = array_filter(array_keys($entries), static fn($n) => preg_match('#^xl/worksheets/sheet\d+\.xml$#', $n));
    natsort($sheets);
    foreach ($sheets as $sheet) {
        $rows = read_sheet(zip_read($data, $entries[$sheet], $sheet), $shared);
        try {
            return locate_header($rows);
        } catch (RuntimeException) {
            continue;
        }
    }
    fail("no sheet in $path has a \"Geographic Level\" column — is this the PSGC publication data file?");
}

/** @return list<array<int,string>> */
function read_sheet(string $xml, array $shared): array
{
    $rows = [];
    $xr = new XMLReader();
    $xr->XML($xml);
    $row = null; $col = 0; $type = ''; $val = '';
    while ($xr->read()) {
        if ($xr->nodeType === XMLReader::ELEMENT) {
            switch ($xr->localName) {
                case 'row':
                    $row = [];
                    if ($xr->isEmptyElement) { $rows[] = $row; $row = null; }
                    break;
                case 'c':
                    /* Cells are sparse — an empty cell is simply absent — so the
                       column comes from the reference, not from counting. */
                    $col  = col_index((string) $xr->getAttribute('r'));
                    $type = (string) $xr->getAttribute('t');
                    $val  = '';
                    if ($xr->isEmptyElement && $row !== null) { $row[$col] = ''; }
                    break;
                case 'v':
                    $val = $xr->readString();
                    break;
                case 'is':   // inline string
                    $val = $xr->readString();
                    break;
            }
        } elseif ($xr->nodeType === XMLReader::END_ELEMENT) {
            if ($xr->localName === 'c' && $row !== null) {
                $row[$col] = trim($type === 's' ? (string) ($shared[(int) $val] ?? '') : $val);
            } elseif ($xr->localName === 'row' && $row !== null) {
                $rows[] = $row;
                $row = null;
            }
        }
    }
    $xr->close();
    return $rows;
}

function col_index(string $ref): int
{
    if (!preg_match('/^([A-Z]+)/', $ref, $m)) return 0;
    $n = 0;
    foreach (str_split($m[1]) as $ch) { $n = $n * 26 + (ord($ch) - 64); }
    return $n - 1;
}

function locate_header(array $rows): array
{
    $asOf = null;
    foreach (array_slice($rows, 0, 40) as $i => $r) {
        foreach ($r as $cell) {
            if ($asOf === null && preg_match('/as of\s+(.{4,40})/i', (string) $cell, $m)) {
                $asOf = trim($m[1]);
            }
            if (preg_match('/geographic\s*level/i', (string) $cell)) {
                return ['rows' => $rows, 'header_row' => $i, 'as_of' => $asOf];
            }
        }
    }
    throw new RuntimeException('no header');
}

/* --------------------------------------------------------------- parse */

$started = microtime(true);
$table   = read_table($src);
$header  = $table['rows'][$table['header_row']];

$find = static function (callable $test) use ($header): ?int {
    foreach ($header as $i => $h) { if ($test(strtolower(trim((string) $h)))) return $i; }
    return null;
};
$cCode  = $find(static fn($h) => str_contains($h, 'psgc') && str_contains($h, '10'))
       ?? $find(static fn($h) => str_contains($h, 'psgc'));
$cName  = $find(static fn($h) => $h === 'name');
$cLevel = $find(static fn($h) => (bool) preg_match('/geographic\s*level/', $h));

if ($cCode === null || $cName === null || $cLevel === null) {
    fail('could not find the PSGC code, Name and Geographic Level columns. Header row was: '
       . implode(' | ', array_map('strval', $header)));
}

$regions = $provinces = $cities = $subMuns = $barangays = [];
$levels  = [];     // raw level => count, for the report
$skipped = [];     // level => count of rows not used

foreach (array_slice($table['rows'], $table['header_row'] + 1) as $r) {
    $rawCode = preg_replace('/\D/', '', (string) ($r[$cCode] ?? ''));
    $name    = trim(preg_replace('/\s+/u', ' ', (string) ($r[$cName] ?? '')));
    $level   = trim((string) ($r[$cLevel] ?? ''));
    if ($rawCode === '' && $name === '') continue;       // blank or footnote row
    if ($rawCode === '') { $skipped['(no code)'] = ($skipped['(no code)'] ?? 0) + 1; continue; }

    /* A code stored as a NUMBER in the sheet loses its leading zero — Region I
       is 0100000000 and arrives as 100000000. Padding restores it. Anything
       longer than ten digits is not this edition of the format. */
    if (strlen($rawCode) > 10) fail("code $rawCode is longer than 10 digits");
    $code = str_pad($rawCode, 10, '0', STR_PAD_LEFT);

    $levels[$level === '' ? '(blank)' : $level] = ($levels[$level === '' ? '(blank)' : $level] ?? 0) + 1;

    switch (strtolower($level)) {
        case 'reg':    $regions[$code]   = $name; break;
        case 'prov':
        /* The Special Geographic Area in BARMM holds municipalities and sits
           at province level. Offered in the Province list like a province,
           because that is where its municipalities hang from. */
        case 'sgu':
        case 'sga':    $provinces[$code] = $name; break;
        case 'city':   $cities[$code]    = ['name' => $name, 'type' => 'City']; break;
        case 'mun':    $cities[$code]    = ['name' => $name, 'type' => 'Municipality']; break;
        case 'submun': $subMuns[$code]   = $name; break;
        case 'bgy':    $barangays[$code] = $name; break;
        default:       $skipped[$level === '' ? '(blank)' : $level] = ($skipped[$level === '' ? '(blank)' : $level] ?? 0) + 1;
    }
}

/* The 9-digit codes used before 2021 would pad into nonsense rather than fail
   outright, so check the format on the rows that must look a certain way. */
foreach ($regions as $code => $_) {
    $code = (string) $code;
    if (substr($code, 2) !== '00000000') {
        fail("region code $code does not end in 8 zeroes — this looks like the older "
           . "9-digit PSGC. Download the current publication, which uses 10-digit codes.");
    }
}

/* ------------------------------------------------------------- resolve */

/* PHP TURNS NUMERIC-STRING ARRAY KEYS INTO INTEGERS. "1300000000" used as a key
   comes back from foreach as the int 1300000000, while "0100000000" stays a
   string because of its leading zero — so the same array hands back a mix, and
   the first substr() on an int is a TypeError under strict_types. Every key is
   cast back to a string where it is read, and every sort is SORT_STRING: all
   codes are exactly ten characters, so string order IS code order. */

$errors   = [];
$outProv  = [];
foreach ($provinces as $code => $name) {
    $code = (string) $code;
    $reg = substr($code, 0, 2) . '00000000';
    if (!isset($regions[$reg])) { $errors[] = "province $code ($name) has no region $reg"; continue; }
    $outProv[$code] = ['region' => $reg, 'name' => $name];
}

$outCity = [];
$noProvince = [];
foreach ($cities as $code => $c) {
    $code = (string) $code;
    $reg  = substr($code, 0, 2) . '00000000';
    $prov = substr($code, 0, 5) . '00000';
    if (!isset($regions[$reg])) { $errors[] = "city $code ({$c['name']}) has no region $reg"; continue; }
    $p = isset($outProv[$prov]) ? $prov : null;
    if ($p === null) { $noProvince[$regions[$reg]][] = $c['name']; }
    $outCity[$code] = ['region' => $reg, 'province' => $p, 'name' => $c['name'], 'type' => $c['type']];
}

$outBgy = [];
$reparented = 0;
foreach ($barangays as $code => $name) {
    $code = (string) $code;
    $city = substr($code, 0, 7) . '000';
    $sub  = null;
    if (!isset($outCity[$city])) {
        if (isset($subMuns[$city])) {
            $parent = substr($city, 0, 5) . '00000';
            if (!isset($outCity[$parent])) {
                $errors[] = "barangay $code ($name) is under sub-municipality $city, whose city $parent does not exist";
                continue;
            }
            $sub  = $subMuns[$city];
            $city = $parent;
            $reparented++;
        } else {
            $errors[] = "barangay $code ($name) has no city $city";
            continue;
        }
    }
    $outBgy[$code] = ['city' => $city, 'name' => $name, 'sub' => $sub];
}

/* ------------------------------------------------------------- report */

$fmt = static fn(int $n) => number_format($n);
echo "\nPSGC conversion report\n";
echo str_repeat('=', 60), "\n";
echo "Source      : ", realpath($src), "\n";
echo "SHA-256     : ", hash_file('sha256', $src), "\n";
echo "Covers      : ", $table['as_of'] ?? '(no "as of" line found in the sheet)', "\n";
if (preg_match('/(\d)Q[-_ ]?(\d{4})/i', basename($src), $m)) {
    echo "File name   : quarter {$m[1]} of {$m[2]}\n";
}
echo "\nLevels in the file:\n";
ksort($levels);
foreach ($levels as $lv => $n) { printf("  %-10s %s\n", $lv, $fmt($n)); }
if ($skipped) {
    echo "\nRows not loaded (not a level the picker uses):\n";
    foreach ($skipped as $lv => $n) { printf("  %-10s %s\n", $lv, $fmt($n)); }
}

echo "\nWritten:\n";
printf("  regions    %6s   (expected about 17)\n",     $fmt(count($regions)));
printf("  provinces  %6s   (expected about 82)\n",     $fmt(count($outProv)));
printf("  cities     %6s   (expected about 1,600)\n",  $fmt(count($outCity)));
printf("  barangays  %6s   (expected about 42,000)\n", $fmt(count($outBgy)));
printf("  barangays re-parented from a sub-municipality: %s\n", $fmt($reparented));

echo "\nCities with no province (offered in the Province list under their own name):\n";
ksort($noProvince);
foreach ($noProvince as $reg => $names) {
    sort($names);
    echo "  $reg — ", count($names), ": ", implode(', ', array_slice($names, 0, 20)),
         count($names) > 20 ? ', …' : '', "\n";
}

$warn = [];
if (count($regions)  < 15    || count($regions)  > 20)    $warn[] = 'region count';
if (count($outProv)  < 75    || count($outProv)  > 95)    $warn[] = 'province count';
if (count($outCity)  < 1500  || count($outCity)  > 1750)  $warn[] = 'city count';
if (count($outBgy)   < 41000 || count($outBgy)   > 43500) $warn[] = 'barangay count';
if ($warn) {
    echo "\nWARNING: ", implode(', ', $warn), " outside the expected range. A newer PSGC\n",
         "edition may genuinely differ; an older or partial file will too. Check before loading.\n";
}

if ($errors) {
    echo "\n", count($errors), " integrity error(s):\n";
    foreach (array_slice($errors, 0, 25) as $e) echo "  - $e\n";
    if (count($errors) > 25) echo "  … and ", count($errors) - 25, " more\n";
    fail('the file does not resolve cleanly — see above.');
}
if (!$regions || !$outBgy) fail('no regions or no barangays were found.');

if ($check) {
    echo "\n--check: nothing written.\n";
    exit(0);
}

/* -------------------------------------------------------------- write */

$q = static fn(?string $s) => $s === null ? 'NULL' : "'" . str_replace(["\\", "'"], ["\\\\", "''"], $s) . "'";

$fh = fopen($out, 'wb');
if (!$fh) fail("cannot write $out");

$gen = date('Y-m-d H:i:s');
$asOf = $table['as_of'] ?? 'unknown';
$hash = hash_file('sha256', $src);
$base = basename($src);
fwrite($fh, <<<SQL
-- ---------------------------------------------------------------------------
-- Philippine locations — GENERATED, DO NOT EDIT BY HAND.
--
-- Source : $base
--          Philippine Standard Geographic Code, Philippine Statistics Authority
--          https://psa.gov.ph/classification/psgc
-- Covers : $asOf
-- SHA-256: $hash
-- Built  : $gen by tools/psgc-convert.php
--
-- Regenerate from a newer PSA publication rather than editing rows here — a
-- hand edit is lost on the next refresh, and a hand-typed town is exactly the
-- kind of error this file exists to avoid.
--
-- REQUIRES db/migrations/015-ph-locations.sql, which creates the tables.
--
-- LOAD FROM THE COMMAND LINE. This file is several megabytes and phpMyAdmin on
-- XAMPP refuses uploads over 2 MB by default, with an error that does not say
-- that is the problem:
--
--     C:\\xampp\\mysql\\bin\\mysql -u root elisha_bay_db < db\\seed-ph-locations.sql
--
-- NO `USE` statement, on purpose: the database named on the command line is the
-- one written to. Re-runnable — it replaces the four tables' contents.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4;
START TRANSACTION;

DELETE FROM ph_barangays;
DELETE FROM ph_cities;
DELETE FROM ph_provinces;
DELETE FROM ph_regions;


SQL);

$batch = static function ($fh, string $head, array $tuples): void {
    foreach (array_chunk($tuples, 1000) as $chunk) {
        fwrite($fh, $head . "\n  " . implode(",\n  ", $chunk) . ";\n\n");
    }
};

ksort($regions, SORT_STRING); ksort($outProv, SORT_STRING);
ksort($outCity, SORT_STRING); ksort($outBgy, SORT_STRING);
$keys = static fn(array $a): array => array_map('strval', array_keys($a));

$batch($fh, 'INSERT INTO ph_regions (code, name) VALUES',
    array_map(static fn($c, $n) => "({$q($c)}, {$q($n)})", $keys($regions), $regions));
$batch($fh, 'INSERT INTO ph_provinces (code, region_code, name) VALUES',
    array_map(static fn($c, $p) => "({$q($c)}, {$q($p['region'])}, {$q($p['name'])})", $keys($outProv), $outProv));
$batch($fh, 'INSERT INTO ph_cities (code, region_code, province_code, name, type) VALUES',
    array_map(static fn($c, $x) => "({$q($c)}, {$q($x['region'])}, {$q($x['province'])}, {$q($x['name'])}, {$q($x['type'])})",
        $keys($outCity), $outCity));
$batch($fh, 'INSERT INTO ph_barangays (code, city_code, name, sub_municipality) VALUES',
    array_map(static fn($c, $b) => "({$q($c)}, {$q($b['city'])}, {$q($b['name'])}, {$q($b['sub'])})",
        $keys($outBgy), $outBgy));

fwrite($fh, "COMMIT;\n");
fclose($fh);

printf("\nWrote %s (%s KB) in %.1fs.\n", $out, number_format(filesize($out) / 1024), microtime(true) - $started);
echo "Load it with:\n    C:\\xampp\\mysql\\bin\\mysql -u root elisha_bay_db < db\\seed-ph-locations.sql\n";
