<?php
declare(strict_types=1);

/** POST /api/customers/invite.php {id} (needs users.manage) emails the "create your account" invitation again to a
    customer on record who has not signed up yet (see api/core/CustomerInvite.php). */

require __DIR__ . '/../core/bootstrap.php';
require_once __DIR__ . '/../core/CustomerInvite.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$id = trim((string) (Response::input()['id'] ?? ''));
$c  = Database::one('SELECT id, name, email, password, status FROM customers WHERE id = ?', [$id]);
if ($c === null) {
    Response::notFound('That customer does not exist.');
}
if ($c['password'] !== null) {
    Response::conflict('This customer already has an online account, so there is nothing to invite them to.');
}
if ($c['status'] === 'archived') {
    Response::conflict('This customer is archived. Restore them before sending an invitation.');
}
if (!CustomerInvite::send($c['id'])) {
    Response::error('MAIL_FAILED', 'The invitation could not be emailed: ' . (Mailer::lastError() ?: 'mail is not set up.'), 502);
}

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description) VALUES (NOW(), ?, ?, ?, ?)',
    [$actor['name'], $actor['id'], 'user', sprintf('Invitation to create an online account emailed again to %s (%s).', $c['email'], $c['id'])]
);
Response::ok(['invited' => true, 'mailLive' => Mailer::isLive()]);
