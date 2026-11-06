<?php
declare(strict_types=1);

/** POST /api/pos/quote.php (needs pos.use) previews a sale's VAT, discounts, withholding and amount due using the same Tax.php rules as checkout, writing nothing. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
Rbac::require('pos.use');

$in    = Response::input();
$rules = Tax::rules();

/* A preview accepts incomplete Senior/PWD details; checkout is where they are required. */
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
$qty = Tax::itemCount($in['items'] ?? []);
$tax = Tax::compute(Tax::quoteLines($in['items'] ?? []), $scPwd,
    $retailerId !== '' ? Tax::withholdingRateFor($retailerId, $qty) : null);
/* Set when the retailer discount is missed only because the sale is under the minimum item count. */
$tax['discountShortfall'] = $retailerId !== '' ? Tax::discountShortfall($retailerId, $qty) : null;

/* Estimated Delivery Fee for a walk-in delivery (api/core/Shipping.php). */
if (($in['order_type'] ?? '') === 'delivery' && Shipping::ready()) {
    $tax = Shipping::applyTo($tax, Shipping::quote(
        Shipping::wanted($in['items'] ?? []),
        Shipping::destinationFromPos($in['destination'] ?? '', (string) ($in['address'] ?? ''))
    ));
}

/* A Net term for a retailer shows its interest in the breakdown. */
if ($retailerId !== '') {
    $tax = Payments::applyInterest($tax, (string) ($in['pay_method'] ?? ''));
}

Response::ok([
    'tax'   => $tax,
    'rules' => [
        'scPwdEnabled'      => (int) $rules['sc_pwd_enabled'] === 1,
        'scPwdDiscountRate' => $rules['sc_pwd_discount_rate'],
        'scPwdVatExempt'    => (int) $rules['sc_pwd_vat_exempt'] === 1,
        'scPwdWeeklyCap'    => $rules['sc_pwd_weekly_cap'],
    ],
]);
