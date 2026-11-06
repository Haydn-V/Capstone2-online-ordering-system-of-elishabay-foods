<?php
declare(strict_types=1);

/**
 * tools/psgc-from-json.php — build db/seed-ph-locations.sql from a FLAT PSGC
 * JSON dump. CLI only.
 *
 *     php tools/psgc-from-json.php db/psgc/barangay_flat.json
 *     php tools/psgc-from-json.php <file> --check          # report, write nothing
 *     php tools/psgc-from-json.php <file> --out=path.sql
 *     php tools/psgc-from-json.php <file> --source="…" --edition="…"
 *
 * WHY THIS EXISTS BESIDE tools/psgc-convert.php
 * ---------------------------------------------
 * psgc-convert.php reads the Philippine Statistics Authority's own .xlsx
 * publication and is still the file to use when you have it. It could not be
 * downloaded here: psa.gov.ph sits behind a Cloudflare challenge that answers
 * 403 to anything that is not a person clicking through it.
 *
 * So this reads a published MIRROR of the same classification instead — a flat
 * list of {name, type, psgc_id, parent_psgc_id} — and holds it to the same
 * standard: every row comes from the file, nothing is added, renamed or
 * inferred beyond the parent links, and it REFUSES TO WRITE anything it cannot
 * vouch for. Where the mirror came from and what edition it claims are written
 * into the seed's header, along with a SHA-256 of the exact bytes read, so the
 * provenance of 42,000 rows is never a matter of memory.
 *
 * A mirror is not the PSA's file. Re-run psgc-convert.php against the real
 * publication when it can be downloaded; it writes the same seed and the same
 * tables, and the header will then say so.
 *
 * THE SHAPE IT EXPECTS, and what it does with each type:
 *
 *   region                        -> ph_regions
 *   province                      -> ph_provinces
 *   special_geographic_area       -> ph_provinces. The SGA in BARMM sits at the
 *                                    province level under a region and holds
 *                                    municipalities; that is a province as far
 *                                    as a Region > Province > City picker is
 *                                    concerned, whatever it is called.
 *   municipality                  -> ph_cities, type Municipality
 *   component_city
 *   highly_urbanized_city
 *   independent_component_city    -> ph_cities, type City
 *   barangay                      -> ph_barangays
 *   submunicipality               -> NOT a city. Manila's fourteen districts
 *                                    hold ~900 barangays between them; those
 *                                    barangays are re-parented to Manila and
 *                                    the district name is kept in
 *                                    ph_barangays.sub_municipality.
 *
 * CITIES WITH NO PROVINCE fall out of the parent links rather than a list: a
 * city whose parent is a REGION has province_code NULL. That is the 33 highly
 * urbanised cities, Pateros — the one municipality in Metro Manila — and the
 * City of Isabela.
 *
 * THE CITY OF ISABELA is the one row the PSGC states twice: a province-level
 * "City of Isabela (Not a Province)" under Region IX, containing the city
 * itself. The wrapper is dropped and the city is attached straight to the
 * region as province-less, which is what it actually is. Handled by structure —
 * a city inside a city — not by its name, so a second one would be caught too.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('memory_limit', '1024M');

/* ---------------------------------------------------------------- args */

$args    = array_slice($argv, 1);
$check   = in_array('--check', $args, true);
$out     = dirname(__DIR__) . '/db/seed-ph-locations.sql';
$src     = null;
$source  = 'a published PSGC mirror';
$edition = 'unknown';
foreach ($args as $a) {
    if (str_starts_with($a, '--out='))     { $out     = substr($a, 6);  continue; }
    if (str_starts_with($a, '--source='))  { $source  = substr($a, 9);  continue; }
    if (str_starts_with($a, '--edition=')) { $edition = substr($a, 10); continue; }
    if (str_starts_with($a, '--'))         { continue; }
    $src = $a;
}
if ($src === null || !is_file($src)) {
    fwrite(STDERR, "Usage: php tools/psgc-from-json.php <flat PSGC .json> [--check] [--out=path] [--source=…] [--edition=…]\n");
    exit(2);
}

function fail(string $msg): never
{
    fwrite(STDERR, "\nREFUSED: $msg\n\nNothing was written.\n");
    exit(1);
}

/* ---------------------------------------------------------------- read */

$raw = file_get_contents($src);
if ($raw === false) { fail("could not read $src"); }
$sha = hash('sha256', $raw);

/* The ñ canary. A file that went through a non-UTF-8 round trip turns
   "Las Piñas" into mojibake, and a seed full of that is worse than no seed. */
if (!mb_check_encoding($raw, 'UTF-8')) {
    fail('the JSON is not UTF-8. Re-download it without opening it in an editor that re-encodes.');
}

try {
    $rows = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    fail('the file is not valid JSON: ' . $e->getMessage());
}
if (!is_array($rows) || !$rows) { fail('the file holds no rows'); }

/* ------------------------------------------------------------ validate */

const TOP = '0000000000';

$REGION    = 'region';
$PROVINCE  = 'province';
$SGA       = 'special_geographic_area';
$SUBMUN    = 'submunicipality';
$BARANGAY  = 'barangay';
$CITY_TYPES = [
    'municipality'               => 'Municipality',
    'component_city'             => 'City',
    'highly_urbanized_city'      => 'City',
    'independent_component_city' => 'City',
];

$byId = [];
$dupes = [];
foreach ($rows as $i => $r) {
    foreach (['name', 'type', 'psgc_id', 'parent_psgc_id'] as $k) {
        if (!array_key_exists($k, $r)) { fail("row $i has no `$k` — this is not a flat PSGC dump"); }
    }
    $id = (string) $r['psgc_id'];
    if (!preg_match('/^\d{10}$/', $id)) {
        fail("`$id` (" . $r['name'] . ") is not a 10-digit PSGC code");
    }
    if (isset($byId[$id])) { $dupes[] = $id; continue; }
    $byId[$id] = [
        'id'     => $id,
        'name'   => trim((string) $r['name']),
        'type'   => (string) $r['type'],
        'parent' => (string) $r['parent_psgc_id'],
    ];
}
if ($dupes) {
    fail(count($dupes) . ' duplicate code(s), e.g. ' . implode(', ', array_slice($dupes, 0, 5)));
}

$known = array_merge([$REGION, $PROVINCE, $SGA, $SUBMUN, $BARANGAY], array_keys($CITY_TYPES));
$unknown = [];
foreach ($byId as $r) {
    if (!in_array($r['type'], $known, true)) { $unknown[$r['type']] = true; }
}
if ($unknown) {
    fail('unhandled level(s): ' . implode(', ', array_keys($unknown))
       . ". This edition of the PSGC has a level this importer has never seen, and guessing where it belongs is how a town goes missing.");
}

$orphans = [];
foreach ($byId as $r) {
    if ($r['parent'] === TOP) { continue; }
    if (!isset($byId[$r['parent']])) { $orphans[] = "{$r['type']} {$r['name']} -> {$r['parent']}"; }
}
if ($orphans) {
    fail(count($orphans) . ' row(s) point at a parent that is not in the file, e.g. '
       . implode(' | ', array_slice($orphans, 0, 3)));
}

/* --------------------------------------------------------------- build */

$regions = $provinces = $cities = $barangays = [];
$warn = [];

/* The province-level wrapper around a city — "City of Isabela (Not a
   Province)". Recognised as a city-like row holding another city-like row. */
$wrappers = [];
foreach ($byId as $r) {
    if (!isset($CITY_TYPES[$r['type']])) { continue; }
    $p = $byId[$r['parent']] ?? null;
    if ($p && isset($CITY_TYPES[$p['type']])) { $wrappers[$p['id']] = $p; }
}

foreach ($byId as $r) {
    switch (true) {
        case $r['type'] === $REGION:
            $regions[] = [$r['id'], $r['name']];
            break;

        case $r['type'] === $PROVINCE || $r['type'] === $SGA:
            $regionOf = $byId[$r['parent']] ?? null;
            if (!$regionOf || $regionOf['type'] !== $REGION) {
                fail("province {$r['name']} ({$r['id']}) is not under a region");
            }
            $provinces[] = [$r['id'], $regionOf['id'], $r['name']];
            break;

        case isset($CITY_TYPES[$r['type']]):
            if (isset($wrappers[$r['id']])) { break; }   /* dropped; its child stands in */

            /* Walk up to the first province (or SGA) and the region. A city
               inside a wrapper inherits the wrapper's parent, which is why the
               wrapper can be dropped without orphaning anything. */
            $p = $byId[$r['parent']] ?? null;
            if ($p && isset($CITY_TYPES[$p['type']])) { $p = $byId[$p['parent']] ?? null; }

            if (!$p) { fail("city {$r['name']} ({$r['id']}) has no usable parent"); }

            if ($p['type'] === $PROVINCE || $p['type'] === $SGA) {
                $prov   = $p['id'];
                $region = ($byId[$p['parent']] ?? null)['id'] ?? null;
            } elseif ($p['type'] === $REGION) {
                $prov   = null;                 /* a city with no province */
                $region = $p['id'];
            } else {
                fail("city {$r['name']} ({$r['id']}) sits under a {$p['type']}, which this importer does not handle");
            }
            if ($region === null) { fail("city {$r['name']} ({$r['id']}) has no region"); }

            $cities[] = [$r['id'], $region, $prov, $r['name'], $CITY_TYPES[$r['type']]];
            break;

        case $r['type'] === $BARANGAY:
            $p = $byId[$r['parent']] ?? null;
            if (!$p) { fail("barangay {$r['name']} ({$r['id']}) has no parent"); }

            $submun = null;
            if ($p['type'] === $SUBMUN) {
                /* Manila's districts. The barangay hangs off the CITY; the
                   district is kept so "Barangay 105" can be shown as
                   "Barangay 105 · Tondo I/II", which is how a resident
                   recognises theirs. */
                $submun = $p['name'];
                $p = $byId[$p['parent']] ?? null;
                if (!$p) { fail("sub-municipality {$submun} has no city"); }
            }
            if (!isset($CITY_TYPES[$p['type']])) {
                fail("barangay {$r['name']} ({$r['id']}) sits under a {$p['type']}");
            }
            $barangays[] = [$r['id'], $p['id'], $r['name'], $submun];
            break;

        case $r['type'] === $SUBMUN:
            break;   /* carried on its barangays, never a row of its own */
    }
}

/* Every city a barangay claims, and every province a city claims, has to
   exist in what is about to be written — not merely in the input. */
$cityIds = array_column($cities, 0);
$cityIdx = array_flip($cityIds);
$missing = [];
foreach ($barangays as $b) { if (!isset($cityIdx[$b[1]])) { $missing[] = $b[2] . ' -> ' . $b[1]; } }
if ($missing) {
    fail(count($missing) . ' barangay(s) point at a city that will not be written, e.g. '
       . implode(' | ', array_slice($missing, 0, 3)));
}
$provIdx = array_flip(array_column($provinces, 0));
$missing = [];
foreach ($cities as $c) { if ($c[2] !== null && !isset($provIdx[$c[2]])) { $missing[] = $c[3] . ' -> ' . $c[2]; } }
if ($missing) {
    fail(count($missing) . ' city/cities point at a province that will not be written, e.g. '
       . implode(' | ', array_slice($missing, 0, 3)));
}

/* Counts far from the expected ones are a WARNING, not a failure — a later
   PSGC release is allowed to differ, and refusing to load one would be its own
   bug. Wildly off is worth saying out loud. */
$expect = ['regions' => 18, 'provinces' => 83, 'cities' => 1642, 'barangays' => 42000];
$got    = ['regions' => count($regions), 'provinces' => count($provinces),
           'cities' => count($cities), 'barangays' => count($barangays)];
foreach ($expect as $k => $n) {
    $d = abs($got[$k] - $n) / max(1, $n);
    if ($d > 0.1) { $warn[] = sprintf('%s: %d, expected about %d', $k, $got[$k], $n); }
}

printf("read     %s rows from %s\n", number_format(count($byId)), $src);
printf("sha-256  %s\n", $sha);
printf("regions  %s\nprovinces %s\ncities   %s\nbarangays %s\n",
    number_format($got['regions']), number_format($got['provinces']),
    number_format($got['cities']), number_format($got['barangays']));
printf("province-less cities: %d\n", count(array_filter($cities, static fn($c) => $c[2] === null)));
printf("barangays in a sub-municipality: %d\n", count(array_filter($barangays, static fn($b) => $b[3] !== null)));
foreach ($warn as $w) { fwrite(STDERR, "WARNING: $w\n"); }

if ($check) { echo "\n--check: nothing written.\n"; exit(0); }

/* ---------------------------------------------------------------- write */

$q = static fn(?string $s): string => $s === null ? 'NULL' : "'" . str_replace("'", "''", $s) . "'";

$gen = date('Y-m-d H:i:s T');

$header = <<<SQL
/* ============================================================================
   db/seed-ph-locations.sql — the Philippine Standard Geographic Code.

   GENERATED. Do not edit by hand; re-run the importer instead.

   Source     : {$source}
   Edition    : {$edition}
   Input file : {$src}
   SHA-256    : {$sha}
   Imported   : {$gen}
   Importer   : tools/psgc-from-json.php

   WHAT THIS IS, EXACTLY. The PSGC is published by the Philippine Statistics
   Authority. The rows below come from a MIRROR of that classification, not
   from the PSA's own .xlsx: psa.gov.ph is behind a Cloudflare challenge that
   refuses automated downloads. The mirror's edition and checksum are recorded
   above so this file can be told apart from one built by tools/psgc-convert.php
   against the official publication — which remains the thing to use when it
   can be downloaded, and which writes this same file and these same tables.

   Nothing here was typed from memory. Every name and every code is from the
   input file; the only thing this importer decided was the parent links, and
   those were read off the file's own parent ids.

   CITIES WITH NO PROVINCE have province_code NULL — the 33 highly urbanised
   cities, Pateros, and the City of Isabela. The picker offers them in its
   Province step under their own name; see api/locations/list.php.

   THE CITY OF MANILA's barangays are coded under fourteen sub-municipalities
   (Tondo I/II, Sampaloc, Binondo…). They are attached to Manila itself and the
   district is kept in ph_barangays.sub_municipality.

   LOAD IT FROM THE COMMAND LINE. This file is megabytes of INSERT; phpMyAdmin
   refuses uploads over 2 MB.

       mysql -u root elisha_bay_db < db/seed-ph-locations.sql

   There is no USE statement, by the same rule as every file in db/migrations:
   name the database on the command line, so the file cannot write to a
   database nobody asked for.
   ============================================================================ */

SET NAMES utf8mb4;
SET autocommit = 0;
START TRANSACTION;

/* Start from empty, so re-running this cannot double anything up and cannot
   leave a stale row behind. Children first. */
DELETE FROM ph_barangays;
DELETE FROM ph_cities;
DELETE FROM ph_provinces;
DELETE FROM ph_regions;

SQL;

$parts = [$header];

$chunk = static function (string $head, array $rows, callable $fmt) use (&$parts): void {
    foreach (array_chunk($rows, 500) as $part) {
        $parts[] = $head . "\nVALUES " . implode(",\n       ", array_map($fmt, $part)) . ";\n";
    }
};

$parts[] = "\n/* ---- regions ---- */";
$chunk('INSERT INTO ph_regions (code, name)', $regions,
    static fn(array $r): string => sprintf("('%s', %s)", $r[0], $q($r[1])));

$parts[] = "\n/* ---- provinces ---- */";
$chunk('INSERT INTO ph_provinces (code, region_code, name)', $provinces,
    static fn(array $r): string => sprintf("('%s', '%s', %s)", $r[0], $r[1], $q($r[2])));

$parts[] = "\n/* ---- cities and municipalities ---- */";
$chunk('INSERT INTO ph_cities (code, region_code, province_code, name, type)', $cities,
    static fn(array $r): string => sprintf("('%s', '%s', %s, %s, '%s')",
        $r[0], $r[1], $r[2] === null ? 'NULL' : "'{$r[2]}'", $q($r[3]), $r[4]));

$parts[] = "\n/* ---- barangays ---- */";
$chunk('INSERT INTO ph_barangays (code, city_code, name, sub_municipality)', $barangays,
    static fn(array $r): string => sprintf("('%s', '%s', %s, %s)", $r[0], $r[1], $q($r[2]), $q($r[3])));

$parts[] = "\nCOMMIT;\n";
$parts[] = sprintf(
    "/* Verification — after loading, these should match:\n"
  . "     SELECT COUNT(*) FROM ph_regions;    -- %d\n"
  . "     SELECT COUNT(*) FROM ph_provinces;  -- %d\n"
  . "     SELECT COUNT(*) FROM ph_cities;     -- %s\n"
  . "     SELECT COUNT(*) FROM ph_barangays;  -- %s\n"
  . "   And nothing should be orphaned:\n"
  . "     SELECT COUNT(*) FROM ph_barangays b LEFT JOIN ph_cities c ON c.code = b.city_code\n"
  . "      WHERE c.code IS NULL;              -- 0\n */\n",
    $got['regions'], $got['provinces'],
    number_format($got['cities']), number_format($got['barangays'])
);

if (file_put_contents($out, implode("\n", $parts)) === false) {
    fail("could not write $out");
}

printf("\nwrote %s (%.1f MB)\n", $out, filesize($out) / 1048576);
printf("load it with:  mysql -u root elisha_bay_db < %s\n", $out);
