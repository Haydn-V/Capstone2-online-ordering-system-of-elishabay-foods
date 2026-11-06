<?php
declare(strict_types=1);

/** GET /api/payments/tiers.php (payments.manage or b2b.review) returns the Net credit budget for each retailer tier; POST (Super Admin only, credit.limits) saves them, audited. */

require __DIR__ . '/../core/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    /* B2B reviewers see the budgets too, to pick a tier when approving. */
    if (!Rbac::has('b2b.review')) { Rbac::require('payments.manage'); }
    Response::ok(['limits' => Payments::creditLimits()]);
}

Response::requireMethod('POST');
$user = Rbac::requireSystemRole('credit.limits');

$in     = Response::input();
$posted = $in['limits'] ?? null;
if (!is_array($posted)) {
    Response::validation('Nothing to save.', ['limits' => 'Send a budget for each tier.']);
}

$errors = [];
$next   = [];
foreach (Payments::TIERS as $tier) {
    $v = $posted[$tier] ?? null;
    if (!is_numeric($v) || (float) $v < 0 || (float) $v > 100000000) {
        $errors[$tier] = 'Enter an amount from 0 to 100,000,000.';
        continue;
    }
    $next[$tier] = round((float) $v, 2);
}
/* A higher tier should never get less credit than a lower one. */
if ($errors === [] && !($next['Bronze'] <= $next['Silver'] && $next['Silver'] <= $next['Gold'])) {
    $errors['Silver'] = 'Budgets must go up by tier: Bronze ≤ Silver ≤ Gold.';
}
if ($errors !== []) {
    Response::validation('Check the highlighted budgets.', $errors);
}

$before  = Payments::creditLimits();
$changed = [];
foreach ($next as $tier => $amount) {
    if ($before[$tier] === $amount) { continue; }
    Database::run(
        'INSERT INTO settings (key_name, value_text) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
        ['credit_limit_' . strtolower($tier), (string) $amount]
    );
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description) VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'system', sprintf('%s tier credit budget changed from ₱%s to ₱%s.',
            $tier, number_format($before[$tier], 2), number_format($amount, 2))]
    );
    $changed[] = $tier;
}

Response::ok(['limits' => Payments::creditLimits(), 'changed' => $changed]);
