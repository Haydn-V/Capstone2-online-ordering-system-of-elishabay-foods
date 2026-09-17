<?php
declare(strict_types=1);

/**
 * POST /api/pos/quote.php
 * Body: { "items": [{id, qty}], "sc_pwd"?: {type, id, name}, "retailer_id"?: "cus-02" }
 *
 * Requires pos.use.
 *
 * The VAT breakdown a sale WOULD have, for the POS to show before the cashier
 * places it: the senior/PWD discount, VAT, any withholding tax and the amount
 * due to tender against. Writes nothing and reserves nothing.
 *
 * WHY A ROUND TRIP AND NOT JAVASCRIPT. The tax rules live in api/core/Tax.php.
 * A copy in the browser would be a second implementation of money rules, and
 * the two would drift — the exact failure that had the POS and the checkout
 * disagreeing about payment methods. pos/checkout.php runs the same compute()
 * again when the order is placed, so what is quoted is what is charged.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
Rbac::require('pos.use');

$in    = Response::input();
$rules = Tax::rules();

/* A preview accepts a half-typed SC/PWD block: the discount shows as soon as
   the type is chosen, and the weekly cap is checked once an ID is present. The
   checkout is where incomplete details are refused. */
$scPwd = null;
$block = $in['sc_pwd'] ?? null;
if ((int) $rules['sc_pwd_enabled'] === 1 && is_array($block)
    && in_array((string) ($block['type'] ?? ''), Tax::SC_PWD_TYPES, true)) {
    $scPwd = [
        'type' => (string) $block['type'],
        'id'   => trim((string) ($block['id'] ?? '')),
        'name' => trim((string) ($block['name'] ?? '')),
    ];
}

$retailerId = trim((string) ($in['retailer_id'] ?? ''));
$tax = Tax::compute(Tax::quoteLines($in['items'] ?? []), $scPwd,
    $retailerId !== '' ? Tax::withholdingRateFor($retailerId) : null);

Response::ok([
    'tax'   => $tax,
    'rules' => [
        'scPwdEnabled'      => (int) $rules['sc_pwd_enabled'] === 1,
        'scPwdDiscountRate' => $rules['sc_pwd_discount_rate'],
        'scPwdVatExempt'    => (int) $rules['sc_pwd_vat_exempt'] === 1,
        'scPwdWeeklyCap'    => $rules['sc_pwd_weekly_cap'],
    ],
]);
