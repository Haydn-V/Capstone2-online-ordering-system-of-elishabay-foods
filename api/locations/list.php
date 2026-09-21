<?php
declare(strict_types=1);

/**
 * GET /api/locations/list.php?level=regions
 * GET /api/locations/list.php?level=provinces&parent=<region code>
 * GET /api/locations/list.php?level=cities&parent=<province code>
 * GET /api/locations/list.php?level=barangays&parent=<city code>
 *
 * PUBLIC — no session. This is published reference data (the PSA's PSGC),
 * needed by forms a visitor fills in before they have an account.
 *
 * ONE PARENT'S CHILDREN, NEVER A WHOLE TABLE
 * ------------------------------------------
 * Every level below regions REQUIRES a parent, validated as a 10-digit code.
 * There is deliberately no way to ask for "all barangays": it is the one query
 * here that would be slow and heavy, and nothing needs it. Picking a city fetches
 * that city's few dozen barangays through idx_barangay_city — the cost does not
 * move with the size of the table, which is the whole argument for keeping this
 * list in the database rather than shipping it to every visitor as a script.
 *
 * THE PROVINCE LIST INCLUDES CITIES THAT HAVE NO PROVINCE
 * -------------------------------------------------------
 * Metro Manila's cities, Pateros, and highly urbanised cities such as Cebu City
 * belong to no province (ph_cities.province_code IS NULL). They are returned in
 * the province list under their own names with `kind: "city"`, beside the real
 * provinces, so the picker never strands an address at a Province step with
 * nothing to choose — and "Cebu City" sits next to "Cebu", where a person looks.
 * The picker, seeing kind "city", fills the City step with that one city.
 *
 * CACHED. The data changes every few years, so each response may be cached for
 * a week (Response::cacheFor); the picker also keeps every list it has fetched
 * for the page's lifetime.
 *
 * Before db/seed-ph-locations.sql is loaded every list is simply empty, and
 * `meta.loaded` is false — the picker reads that and falls back to a free-text
 * address box. See Address::available().
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$level  = (string) ($_GET['level'] ?? '');
$parent = (string) ($_GET['parent'] ?? '');

$levels = ['regions', 'provinces', 'cities', 'barangays'];
if (!in_array($level, $levels, true)) {
    Response::badRequest('level must be one of: ' . implode(', ', $levels) . '.');
}

if ($level !== 'regions') {
    if ($parent === '') {
        Response::badRequest("A parent code is required for $level.");
    }
    /* Exactly ten digits: a PSGC code. Anything else is refused here rather than
       reaching a query as a string that matches nothing. */
    if (!preg_match('/^\d{10}$/', $parent)) {
        Response::badRequest('parent must be a 10-digit PSGC code.');
    }
}

if (!Address::available()) {
    Response::ok([], ['loaded' => false]);
}

$rows = match ($level) {
    'regions' => Database::all(
        "SELECT code, name, 'region' AS kind FROM ph_regions ORDER BY name"
    ),

    /* Real provinces, then the region's province-less cities as their own
       entries, merged and ordered by name together. */
    'provinces' => Database::all(
        "SELECT code, name, kind FROM (
             SELECT code, name, 'province' AS kind
               FROM ph_provinces WHERE region_code = ?
             UNION ALL
             SELECT code, name, 'city' AS kind
               FROM ph_cities WHERE region_code = ? AND province_code IS NULL
         ) x
         ORDER BY name",
        [$parent, $parent]
    ),

    'cities' => Database::all(
        "SELECT code, name, type, 'city' AS kind
           FROM ph_cities WHERE province_code = ? ORDER BY name",
        [$parent]
    ),

    /* sub_municipality is sent so Manila's numbered barangays can be shown as
       "Barangay 105 · Tondo I", which is how a resident recognises theirs. */
    'barangays' => Database::all(
        "SELECT code, name, sub_municipality AS district, 'barangay' AS kind
           FROM ph_barangays WHERE city_code = ? ORDER BY name",
        [$parent]
    ),
};

/* NATURAL ORDER, not the collation's. The City of Manila's ~900 barangays are
   numbered, and ORDER BY name puts "Barangay 10" before "Barangay 2" — a list a
   resident would have to read end to end to find theirs. strnatcmp fixes the
   numbers; comparing an accent-folded key keeps "Parañaque" with the Ps rather
   than after Z, which is where byte order would leave it. The displayed name is
   untouched. */
$fold = static fn(string $s): string => strtr(mb_strtolower($s), [
    'ñ' => 'n', 'á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u', 'ü' => 'u',
]);
usort($rows, static fn(array $a, array $b): int => strnatcmp($fold($a['name']), $fold($b['name'])));

Response::cacheFor(7 * 24 * 3600);
Response::ok($rows, ['loaded' => true, 'level' => $level, 'count' => count($rows)]);
