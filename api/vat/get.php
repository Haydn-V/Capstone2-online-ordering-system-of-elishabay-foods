<?php
declare(strict_types=1);

/** GET /api/vat/get.php (Super Admin only, vat.manage plus system role) returns VAT rules, product tax types and current retailers with TIN and withholding rate. */

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

/* Current retailers only, since only they can withhold. */
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
        'withholdingMinQty'      => (int) $r['withholding_min_qty'],
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
