<?php
declare(strict_types=1);

/** POST /api/shop/quote.php previews the signed-in customer's order total, including the delivery fee and the amount a withholding retailer should actually transfer (no Senior/PWD discount online). */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$buyer = Auth::requireCustomer('Sign in to see your order total.');

$in = Response::input();

$qty = Tax::itemCount($in['items'] ?? []);
$tax = Tax::compute(
    Tax::quoteLines($in['items'] ?? []),
    null,
    Tax::withholdingRateFor((string) $buyer['id'], $qty)
);
/* Set when the retailer discount is missed only because the order is under the minimum item count. */
$tax['discountShortfall'] = Tax::discountShortfall((string) $buyer['id'], $qty);
if (($in['order_type'] ?? '') === 'delivery' && Shipping::ready()) {
    $tax = Shipping::applyTo($tax, Shipping::quote(
        Shipping::wanted($in['items'] ?? []),
        Shipping::destinationFromCodes($in['address'] ?? null)
    ));
}

/* A Net term chosen at checkout shows its interest in the breakdown. */
$tax = Payments::applyInterest($tax, (string) ($in['pay_method'] ?? ''));

Response::ok(['tax' => $tax]);
