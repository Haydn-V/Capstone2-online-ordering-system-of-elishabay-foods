<?php
declare(strict_types=1);

/**
 * GET /api/vat/get.php
 *
 * Everything VAT Maintenance edits, in one response: the rules, every product's
 * tax type, and every current retailer with its TIN and withholding rate.
 *
 * SUPER ADMIN ONLY. vat.manage is a SYSTEM_ONLY permission (api/core/Rbac.php):
 * no other role can hold it, and this endpoint checks the role as well as the
 * permission, so neither check alone is what keeps it closed.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireSystemRole('vat.manage');

$r = Tax::rules();

$products = Database::all(
    'SELECT p.id, p.name, p.price, p.tax_type, p.archived, c.name AS category
       FROM products p
       JOIN categories c ON c.id = p.category_id
      ORDER BY p.archived ASC, c.name ASC, p.name ASC'
);

/* Current retailers only. A withholding agent is a retailer by definition —
   Tax::withholdingRateFor() ignores the rate of anyone who is not one now. */
$retailers = Database::all(
    "SELECT c.id, c.name, c.email, wa.rate,
            " . Orders::buyerTinSql('c.id') . " AS tin
       FROM customers c
       LEFT JOIN withholding_agents wa ON wa.customer_id = c.id
      WHERE c.status = 'retailer'
      ORDER BY c.name ASC"
);

Response::ok([
    'rules' => [
        'vatRate'                => $r['vat_rate'],
        'scPwdEnabled'           => (int) $r['sc_pwd_enabled'] === 1,
        'scPwdDiscountRate'      => $r['sc_pwd_discount_rate'],
        'scPwdVatExempt'         => (int) $r['sc_pwd_vat_exempt'] === 1,
        'scPwdWeeklyCap'         => $r['sc_pwd_weekly_cap'],
        'withholdingDefaultRate' => $r['withholding_default_rate'],
    ],
    'products' => array_map(static fn(array $p): array => [
        'id'       => $p['id'],
        'name'     => $p['name'],
        'category' => $p['category'],
        'price'    => (float) $p['price'],
        'taxType'  => $p['tax_type'],
        'archived' => (bool) $p['archived'],
    ], $products),
    'retailers' => array_map(static fn(array $c): array => [
        'id'              => $c['id'],
        'name'            => $c['name'],
        'email'           => $c['email'],
        'tin'             => $c['tin'],
        'withholdingRate' => $c['rate'] === null ? null : (float) $c['rate'],
    ], $retailers),
]);
