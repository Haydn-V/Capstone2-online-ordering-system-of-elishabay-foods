<?php
declare(strict_types=1);

/** POST /api/settings/save.php saves known business settings only, each requiring its own permission, and only for the keys actually sent. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

/** key => [permission, label, min, max, integer?]; the bounds only catch impossible typos. The inventory baselines
    were retired: stock level and movement are computed from sales (api/core/Inventory.php). */
$SPEC = [
    'penalty_rate' => [
        'perm' => 'payments.manage', 'label' => 'Penalty rate',
        'min'  => 0, 'max' => 100, 'int' => false,
        'unit' => '% per month',
    ],
    /* Super Admin only (credit.limits): interest for buying on each Net term, added once to the amount due at checkout. */
    'interest_rate_net30' => ['perm' => 'credit.limits', 'label' => 'Net 30 interest', 'min' => 0, 'max' => 100, 'int' => false, 'unit' => '%'],
    'interest_rate_net60' => ['perm' => 'credit.limits', 'label' => 'Net 60 interest', 'min' => 0, 'max' => 100, 'int' => false, 'unit' => '%'],
    'interest_rate_net90' => ['perm' => 'credit.limits', 'label' => 'Net 90 interest', 'min' => 0, 'max' => 100, 'int' => false, 'unit' => '%'],
    /* Super Admin only: the refund amount at or above which an Admin or Super Admin is needed (0 = off). */
    'refund_large_threshold' => [
        'perm' => 'orders.returns', 'system' => true, 'label' => 'Large refund threshold',
        'min'  => 0, 'max' => 10000000, 'int' => false,
        'unit' => ' pesos',
    ],
];

$supplied = array_intersect_key($SPEC, $in);
if ($supplied === []) {
    Response::badRequest('No recognised setting supplied.');
}

/* Require each distinct permission once. */
$user = null;
foreach (array_unique(array_column($supplied, 'perm')) as $perm) {
    $user = Rbac::require($perm);
}
foreach ($supplied as $s) {
    if (!empty($s['system'])) {
        $user = Rbac::requireSystemRole($s['perm']);
    }
}

/* Validate everything before writing anything, so a bad request changes nothing. */
$check = Validate::check($in);
foreach ($supplied as $key => $s) {
    $check->decimal($key, $s['label'], $s['min']);
}
$data = $check->values();

$errors = [];
foreach ($supplied as $key => $s) {
    if ($data[$key] > $s['max']) {
        $errors[$key] = sprintf('%s cannot exceed %s%s.', $s['label'], $s['max'], $s['unit']);
    }
    if ($s['int'] && floor((float) $data[$key]) !== (float) $data[$key]) {
        $errors[$key] = sprintf('%s must be a whole number.', $s['label']);
    }
}

if ($errors !== []) {
    Response::validation('Check the values supplied.', $errors);
}

$out = [];
foreach ($supplied as $key => $s) {
    $value  = $s['int'] ? (string) (int) $data[$key] : (string) $data[$key];
    $before = Database::scalar('SELECT value_text FROM settings WHERE key_name = ?', [$key]);

    if ((string) ($before ?? '') === $value) {
        /* Skip unchanged values so the audit only logs real changes. */
        $out[$key] = $s['int'] ? (int) $value : (float) $value;
        continue;
    }

    Database::run(
        'INSERT INTO settings (key_name, value_text) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
        [$key, $value]
    );

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'system',
         $key === 'penalty_rate'
            /* Keep the audit wording unchanged so the history stays searchable. */
            ? sprintf('Penalty rate changed from %s%% to %s%% per month.', $before ?? 'unset', $value)
            : sprintf('%s changed from %s to %s%s.', $s['label'], $before ?? 'unset', $value, $s['unit'])],
    );

    $out[$key] = $s['int'] ? (int) $value : (float) $value;
}

/* Clear the cached settings since this request may read them again. */
Inventory::forget();

Response::ok($out);
