<?php
declare(strict_types=1);

/**
 * GET /api/pos/retailers.php
 *
 * Requires pos.use. The retailers a cashier may sell to on credit terms.
 *
 * WHY THIS IS NOT customers/list.php
 * ----------------------------------
 * customers/list.php requires `users.manage`, which a Cashier does not hold —
 * and should not. It returns every customer with their email, contact number
 * and join date; a till operator needs none of that to put a Net-30 sale
 * against an account.
 *
 * This returns id and name for retailers only. The same reasoning as
 * shop/products.php against products/list.php: when a screen needs a slice of
 * a table, give it the slice rather than the permission to read the whole
 * thing. Widening the permission on customers/list.php would have been one
 * line and would have handed every cashier the full customer list.
 *
 * Archived customers are never returned. A retailer whose account has been
 * closed should not be offered fresh credit.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('pos.use');

/* What each retailer still owes AFTER the payments staff have verified
   (Payments::describeAccount) — not the billed total of every open account. A
   retailer who has paid half was being shown owing the whole, at exactly the
   moment the cashier decides whether to extend more credit. */
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
    'overdue_count' => $owing[$c['id']]['overdue_count'] ?? 0,
], Database::all("SELECT id, name FROM customers WHERE status = 'retailer' ORDER BY name"));

/* Outstanding balance and overdue count travel with the name so the cashier can
   see, at the moment of choosing, that this retailer already owes money and is
   late with it. Deciding whether to extend more credit is a person's call; not
   showing them the number is how it stops being a call at all.
   Both are computed against CURDATE() at read time — never stored, for the same
   reason payments/list.php derives them. */
Response::ok(array_map(static fn(array $r): array => [
    'id'          => $r['id'],
    'name'        => $r['name'],
    'outstanding' => (float) $r['outstanding'],
    'overdue'     => (int) $r['overdue_count'],
], $rows));
