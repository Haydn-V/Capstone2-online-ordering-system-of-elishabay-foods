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

$rows = Database::all(
    "SELECT c.id, c.name,
            COALESCE(SUM(CASE WHEN pa.paid = 0 THEN pa.balance ELSE 0 END), 0) AS outstanding,
            SUM(CASE WHEN pa.paid = 0 AND DATEDIFF(CURDATE(), pa.due_date) > 0 THEN 1 ELSE 0 END) AS overdue_count
       FROM customers c
       LEFT JOIN payment_accounts pa ON pa.customer_id = c.id
      WHERE c.status = 'retailer'
      GROUP BY c.id, c.name
      ORDER BY c.name"
);

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
