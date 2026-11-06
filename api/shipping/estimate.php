<?php
declare(strict_types=1);

/** GET /api/shipping/estimate.php returns the delivery fee for a destination and weight (used by the Shipping Rates "Try it" panel; checkouts use api/core/Shipping.php). */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('shipping.manage');

if (!Shipping::ready()) {
    Response::error('MIGRATION_NEEDED', 'Run db/migrations/021-shipping-fees.sql first.', 409);
}

$dest = trim((string) ($_GET['destination'] ?? '')) ?: null;
$kg   = is_numeric($_GET['kg'] ?? null) ? (float) $_GET['kg'] : 0.0;

Response::ok(Shipping::estimate(min($kg, 10000.0), $dest));
