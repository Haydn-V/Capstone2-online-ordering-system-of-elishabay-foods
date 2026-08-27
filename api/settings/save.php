<?php
declare(strict_types=1);

/**
 * POST /api/settings/save.php
 * Body: { "penalty_rate": 2.5 }
 *
 * Requires payments.manage for the penalty rate.
 *
 * The rate previously lived only in `adminState.penaltyRate` in the browser, so
 * it reset on every reload and the penalties displayed were computed from a
 * number nobody had actually saved. It is a stored business setting.
 *
 * Only known keys are writable. A settings endpoint that accepts arbitrary
 * key/value pairs from the client is a way to write anything into the table.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('payments.manage');

$in = Response::input();

if (!array_key_exists('penalty_rate', $in)) {
    Response::badRequest('No recognised setting supplied.');
}

$data = Validate::check($in)
    ->decimal('penalty_rate', 'Penalty rate', 0)
    ->values();

/* An upper bound as a typo guard: 200% per month is not a policy, it is a
   missing decimal point. */
if ($data['penalty_rate'] > 100) {
    Response::validation('Check the rate.', [
        'penalty_rate' => 'A rate above 100% is almost certainly a mistake.',
    ]);
}

$before = Database::scalar("SELECT value_text FROM settings WHERE key_name = 'penalty_rate'");

Database::run(
    "INSERT INTO settings (key_name, value_text) VALUES ('penalty_rate', ?)
     ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)",
    [(string) $data['penalty_rate']]
);

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'system',
     sprintf('Penalty rate changed from %s%% to %s%% per month.',
         $before ?? 'unset', $data['penalty_rate'])]
);

Response::ok(['penalty_rate' => $data['penalty_rate']]);
