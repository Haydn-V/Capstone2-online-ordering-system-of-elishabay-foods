<?php
declare(strict_types=1);

/**
 * POST /api/settings/save.php
 * Body: any subset of the keys in SPEC below, e.g. { "penalty_rate": 2.5 }
 *
 * The penalty rate previously lived only in `adminState.penaltyRate` in the
 * browser, so it reset on every reload and the penalties displayed were
 * computed from a number nobody had actually saved. It is a stored business
 * setting, and so are the inventory thresholds that joined it here.
 *
 * Only known keys are writable. A settings endpoint that accepts arbitrary
 * key/value pairs from the client is a way to write anything into the table.
 *
 * PERMISSION IS PER KEY, NOT PER REQUEST
 * --------------------------------------
 * The penalty rate is a finance decision and the inventory thresholds are an
 * operations one. A cashier who may record a settlement has no business
 * redefining what "Critical" means, and the inventory staff who own the
 * restock model should not need the finance permission to tune it. Each key
 * therefore carries its own permission and only the ones actually present in
 * the body are demanded — asking for every permission on every request would
 * mean the union of them, which is a role nobody has.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

/**
 * key => [permission, label, min, max, integer?]
 *
 * The bounds are typo guards rather than policy. Each one is a value that
 * cannot be meant: a zero-day measurement window divides by zero, a zero-day
 * lead time makes every product Critical forever, and 200% per month is a
 * missing decimal point rather than an interest rate.
 */
$SPEC = [
    'penalty_rate' => [
        'perm' => 'payments.manage', 'label' => 'Penalty rate',
        'min'  => 0, 'max' => 100, 'int' => false,
        'unit' => '% per month',
    ],
    'velocity_window_days' => [
        'perm' => 'inventory.manage', 'label' => 'Sales window',
        'min'  => 7, 'max' => 730, 'int' => true,
        'unit' => ' days',
    ],
    'restock_lead_days' => [
        'perm' => 'inventory.manage', 'label' => 'Restock lead time',
        'min'  => 1, 'max' => 365, 'int' => true,
        'unit' => ' days',
    ],
    'movement_fast_per_month' => [
        'perm' => 'inventory.manage', 'label' => 'Fast-moving threshold',
        'min'  => 0.1, 'max' => 100000, 'int' => false,
        'unit' => ' units/month',
    ],
    'movement_slow_per_month' => [
        'perm' => 'inventory.manage', 'label' => 'Slow-moving threshold',
        'min'  => 0.1, 'max' => 100000, 'int' => false,
        'unit' => ' units/month',
    ],
    'stock_floor_critical' => [
        'perm' => 'inventory.manage', 'label' => 'Critical stock floor',
        'min'  => 0, 'max' => 100000, 'int' => true,
        'unit' => ' units',
    ],
];

$supplied = array_intersect_key($SPEC, $in);
if ($supplied === []) {
    Response::badRequest('No recognised setting supplied.');
}

/* Demand each distinct permission once. Rbac::require() returns the actor, and
   every branch returns the same one. */
$user = null;
foreach (array_unique(array_column($supplied, 'perm')) as $perm) {
    $user = Rbac::require($perm);
}

/* Validate everything before writing anything. A request that sets the fast
   threshold below the slow one must fail whole, not leave one of the two
   applied — the bands would overlap and "slow" would become unreachable. */
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

/* Cross-key rule. Read the value being written where one is supplied and the
   stored one otherwise, so changing only the fast threshold is still checked
   against the slow threshold actually in force. */
$fast = $data['movement_fast_per_month'] ?? Inventory::tunables()['movement_fast_per_month'];
$slow = $data['movement_slow_per_month'] ?? Inventory::tunables()['movement_slow_per_month'];
if (isset($data['movement_fast_per_month']) || isset($data['movement_slow_per_month'])) {
    if ((float) $fast <= (float) $slow) {
        $errors['movement_fast_per_month'] =
            'The fast-moving threshold must be above the slow-moving one, or nothing can be slow moving.';
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
        /* Unchanged. Skipped rather than rewritten so the audit log records
           decisions and not form submissions. */
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
            /* Wording preserved verbatim — this string is what the existing
               audit history reads, and a log whose phrasing changes halfway
               through is harder to search than one that repeats itself. */
            ? sprintf('Penalty rate changed from %s%% to %s%% per month.', $before ?? 'unset', $value)
            : sprintf('%s changed from %s to %s%s.', $s['label'], $before ?? 'unset', $value, $s['unit'])],
    );

    $out[$key] = $s['int'] ? (int) $value : (float) $value;
}

/* The cached copy is per request, but this request may go on to read the
   thresholds it just changed. */
Inventory::forget();

Response::ok($out);
