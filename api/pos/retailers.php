<?php
declare(strict_types=1);

/** GET /api/pos/retailers.php (needs pos.use) returns only active retailers with what the cashier needs, instead of giving cashiers the full customer list. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('pos.use');

/* Show what each retailer still owes after verified payments, not the billed total. */
$rate  = Payments::penaltyRate();
$owing = [];
foreach (Database::all(Payments::accountSelect() . ' WHERE pa.paid = 0') as $r) {
    $a   = Payments::describeAccount($r, $rate);
    $cid = (string) $a['customerId'];
    $owing[$cid]['outstanding']   = ($owing[$cid]['outstanding'] ?? 0.0) + $a['remaining'];
    $owing[$cid]['overdue_count'] = ($owing[$cid]['overdue_count'] ?? 0) + ($a['overdue'] ? 1 : 0);
}
$rows = array_map(static fn(array $c): array => [
    'id'            => $c['id'],
    'name'          => $c['name'],
    'outstanding'   => round($owing[$c['id']]['outstanding'] ?? 0.0, 2),
    'tier'          => $c['retailer_tier'] ?: 'Bronze',
    'overdue_count' => $owing[$c['id']]['overdue_count'] ?? 0,
    /* Contact and saved address prefill the payment form once a retailer is picked. */
    'contact'       => $c['contact'],
    'address'       => implode(', ', array_filter(array_map('trim', [
        (string) $c['addr_street'], (string) $c['addr_barangay'], (string) $c['addr_city'],
        (string) $c['addr_province'], (string) $c['addr_zip'],
    ]), 'strlen')),
], Database::all("SELECT id, name, retailer_tier, contact, addr_street, addr_barangay, addr_city, addr_province, addr_zip
                  FROM customers WHERE status = 'retailer' ORDER BY name"));

$limits = Payments::creditLimits();
/* Show the outstanding balance and overdue count (computed at read time) so the cashier can decide whether to extend more credit. */
Response::ok(array_map(static fn(array $r): array => [
    'id'          => $r['id'],
    'name'        => $r['name'],
    'outstanding' => (float) $r['outstanding'],
    'overdue'     => (int) $r['overdue_count'],
    /* Tier and its Net credit budget, so the cashier sees how much Net credit is left. */
    'tier'        => $r['tier'],
    'creditLimit' => $limits[$r['tier']],
    'creditLeft'  => Payments::creditStanding($r['id'])['available'],
    'contact'     => $r['contact'],
    'address'     => $r['address'],
], $rows));
