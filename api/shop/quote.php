<?php
declare(strict_types=1);

/**
 * POST /api/shop/quote.php
 * Body: { "items": [{id, qty}] }
 *
 * Requires a customer session.
 *
 * What the signed-in customer's order would come to — used by the storefront
 * checkout to tell a retailer registered as a withholding agent how much to
 * actually transfer. Without it they would send the full total, and Payment
 * Verification would find a screenshot that does not match the amount due.
 *
 * No senior/PWD discount here: that is applied at the counter, where the ID
 * can be checked (shop/checkout.php refuses it too).
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$buyer = Auth::requireCustomer('Sign in to see your order total.');

$in = Response::input();

Response::ok([
    'tax' => Tax::compute(
        Tax::quoteLines($in['items'] ?? []),
        null,
        Tax::withholdingRateFor((string) $buyer['id'])
    ),
]);
