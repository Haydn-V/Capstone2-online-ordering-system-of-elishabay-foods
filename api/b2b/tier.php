<?php
declare(strict_types=1);

/** POST /api/b2b/tier.php (needs b2b.review) moves an approved partner to another tier (Bronze, Silver, Gold), which sets their Net credit budget; audited. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('b2b.review');

$data = Validate::check(Response::input())
    ->required('app_id', 'Application')
    ->in('tier', Payments::TIERS, 'Partner tier')
    ->values();

$app = Database::one(
    'SELECT b.id, b.app_id_code, b.business_name, b.applicant_name, b.email, b.status,
            c.id AS customer_id, c.name AS customer_name, c.email AS customer_email, c.retailer_tier, c.status AS customer_status
       FROM b2b_applications b
       LEFT JOIN customers c ON c.id = b.customer_id OR (b.customer_id IS NULL AND c.email = b.email)
      WHERE b.app_id_code = ?',
    [$data['app_id']]
);
if ($app === null) {
    Response::notFound('That application does not exist.');
}
if ($app['status'] !== 'approved' || !$app['customer_id']) {
    Response::conflict('Only an approved partner with an account can change tier.');
}
if ($app['customer_status'] !== 'retailer') {
    Response::conflict('This account is no longer a retailer, so it has no tier to change.');
}

$from = $app['retailer_tier'] ?: 'Bronze';
if ($from !== $data['tier']) {
    Database::run('UPDATE customers SET retailer_tier = ? WHERE id = ?', [$data['tier'], $app['customer_id']]);
    Database::run('UPDATE b2b_applications SET assigned_tier = ? WHERE id = ?', [$data['tier'], $app['id']]);
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description) VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'user', sprintf('%s (%s) moved from %s to %s tier.',
            $app['business_name'], $app['app_id_code'], $from, $data['tier'])]
    );
}

/* Tell the partner about the new tier and budget after the change is saved; a failed email never undoes it. */
$mailed = false;
if ($from !== $data['tier']) {
    $rank    = array_flip(Payments::TIERS);
    $up      = $rank[$data['tier']] > $rank[$from];
    $limit   = Payments::creditLimits()[$data['tier']];
    $toEmail = $app['customer_email'] ?: $app['email'];
    $toName  = $app['customer_name'] ?: $app['applicant_name'];
    $e = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
    $mailed = Mailer::send(
        $toEmail,
        $toName,
        ($up ? 'Your partner tier has been upgraded to ' : 'Your partner tier has changed to ') . $data['tier'],
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px">'
        . '<h2 style="color:#1d4e3f">' . ($up ? 'Congratulations, ' : 'Hello, ') . $e($toName) . '.</h2>'
        . '<p>Your retail partner account for <strong>' . $e($app['business_name']) . '</strong> ('
        . $e($app['app_id_code']) . ') has been ' . ($up ? '<strong>upgraded</strong>' : 'moved')
        . ' from <strong>' . $e($from) . '</strong> to <strong>' . $e($data['tier']) . '</strong> tier.</p>'
        . '<p>Your Net 30 / 60 / 90 credit budget is now <strong>&#8369;' . number_format($limit, 2) . '</strong>: '
        . 'unpaid Net balances plus a new Net order can go up to this amount. It applies to your next Net order; '
        . 'orders already placed are not affected.</p>'
        . '<p>You can see your tier and how much of your budget is left on the <strong>Payment Schemes</strong> page of your account.</p>'
        . '<p style="color:#666;font-size:.9em;margin-top:22px">Elisha Bay — Juris Bay Foods, Inc.<br>148 Brgy. Mangin, Dagupan City, Pangasinan</p></div>'
    );
}

Response::ok([
    'appId'    => $app['app_id_code'],
    'tier'     => $data['tier'],
    'from'     => $from,
    'emailed'  => $mailed,
    'mailLive' => Mailer::isLive(),
]);
