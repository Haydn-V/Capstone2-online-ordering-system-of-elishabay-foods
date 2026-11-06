<?php
declare(strict_types=1);

/** GET /api/pos/customers.php?q=rain (needs pos.use) finds regular customers on record by name, email or phone, so a
    walk-in sale can be filed under them (their order history and lifetime spend). A search of at least 1 character
    returning at most 10 matches, never the full customer list. Retailers are picked through pos/retailers.php. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('pos.use');

$q = trim((string) ($_GET['q'] ?? ''));
if ($q === '') {
    Response::ok([]);
}
$like   = '%' . addcslashes($q, '%_\\') . '%';
/* Phone digits without the 0 / 63 prefix, so 0926… finds a number saved as +63 926… and the other way round. */
$digits = preg_replace('/^(?:63|0)/', '', preg_replace('/\D+/', '', $q));

/* The phone match is added only when digits were typed, decided here rather than by comparing a bound value in SQL
   (the live database's collation mix refuses `? <> ''`). */
$phoneSql    = $digits !== '' ? " OR REPLACE(REPLACE(REPLACE(contact, ' ', ''), '-', ''), '+', '') LIKE ?" : '';
$phoneParams = $digits !== '' ? ['%' . $digits . '%'] : [];

$rows = Database::all(
    "SELECT id, name, email, contact, password IS NOT NULL AS has_account,
            addr_street, addr_barangay, addr_city, addr_province, addr_zip
       FROM customers
      WHERE status = 'active'
        AND (name LIKE ? OR email LIKE ?$phoneSql)
      ORDER BY name
      LIMIT 10",
    array_merge([$like, $like], $phoneParams)
);

Response::ok(array_map(static fn(array $c): array => [
    'id'         => $c['id'],
    'name'       => $c['name'],
    'email'      => $c['email'],
    'contact'    => $c['contact'],
    'hasAccount' => (bool) $c['has_account'],
    'address'    => implode(', ', array_filter(array_map('trim', [
        (string) $c['addr_street'], (string) $c['addr_barangay'], (string) $c['addr_city'],
        (string) $c['addr_province'], (string) $c['addr_zip'],
    ]), 'strlen')),
], $rows));
