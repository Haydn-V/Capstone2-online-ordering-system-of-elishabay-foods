<?php
declare(strict_types=1);

/** GET /api/locations/list.php (public, cached a week) returns PSGC regions, then provinces (including province-less cities as kind "city"), cities and barangays for one parent at a time; meta.loaded is false before the data is seeded. */

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
    /* Parent codes must be exactly ten digits (a PSGC code). */
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

    /* Real provinces plus the region's province-less cities, sorted together by name. */
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

    /* Include sub_municipality so Manila barangays show as "Barangay 105 · Tondo I". */
    'barangays' => Database::all(
        "SELECT code, name, sub_municipality AS district, 'barangay' AS kind
           FROM ph_barangays WHERE city_code = ? ORDER BY name",
        [$parent]
    ),
};

/* Sort naturally (Barangay 2 before Barangay 10) and accent-insensitively (Parañaque with the P's), without changing the displayed name. */
$fold = static fn(string $s): string => strtr(mb_strtolower($s), [
    'ñ' => 'n', 'á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u', 'ü' => 'u',
]);
usort($rows, static fn(array $a, array $b): int => strnatcmp($fold($a['name']), $fold($b['name'])));

Response::cacheFor(7 * 24 * 3600);
Response::ok($rows, ['loaded' => true, 'level' => $level, 'count' => count($rows)]);
