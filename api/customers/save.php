<?php
declare(strict_types=1);

/** POST /api/customers/save.php (needs users.manage) creates customers, but on update only the status may change, because name, email and contact belong to the customer (and never the password). */

require __DIR__ . '/../core/bootstrap.php';
require_once __DIR__ . '/../core/CustomerInvite.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('name', 'Customer name')
    ->maxLen('name', 100, 'Customer name')
    ->email('email', 'Email')
    ->values();

/* Staff-added names are written properly too (CustomerName::proper), the same as a customer's own sign-up. */
if (!$isUpdate) {
    $data['name'] = CustomerName::proper($data['name']);
}
$contact = trim((string) ($in['contact'] ?? '')) ?: null;
if ($contact !== null && !preg_match('/^[0-9 +\-()]{7,20}$/', $contact)) {
    Response::validation('Check the highlighted fields.', ['contact' => 'Enter a valid contact number.']);
}

/* Retailer status can only be granted by approving a B2B application, but an existing retailer may keep it when the record is saved. */
$status = (string) ($in['status'] ?? 'active');
if (!in_array($status, ['active', 'retailer', 'archived'], true)) {
    Response::validation('Check the highlighted fields.', ['status' => 'Unknown status.']);
}
if ($status === 'retailer') {
    $alreadyRetailer = $isUpdate && Database::scalar(
        'SELECT COUNT(*) FROM customers WHERE id = ? AND status = ?',
        [$in['id'], 'retailer']
    );
    if (!$alreadyRetailer) {
        Response::validation('Check the highlighted fields.', [
            'status' => 'Retailer status comes from approving a B2B application, not from this form.',
        ]);
    }
}

$clash = Database::scalar(
    'SELECT COUNT(*) FROM customers WHERE email = ? AND id <> ?',
    [$data['email'], $in['id'] ?? '']
);
if ($clash) {
    Response::conflict('Another customer already uses that email address.');
}

if ($isUpdate) {
    $existing = Database::one(
        'SELECT id, name, email, contact, status FROM customers WHERE id = ?',
        [$in['id']]
    );
    if ($existing === null) {
        Response::notFound('That customer does not exist.');
    }

    /* Refuse (not silently ignore) any change to name, email or contact; sending the current value is fine. */
    $identityErrors = [];
    if ($data['name'] !== $existing['name']) {
        $identityErrors['name'] = 'A customer maintains their own name through their profile.';
    }
    if (strcasecmp($data['email'], (string) $existing['email']) !== 0) {
        $identityErrors['email'] = 'A customer maintains their own email address through their profile.';
    }
    if (($contact ?? '') !== (string) ($existing['contact'] ?? '')) {
        $identityErrors['contact'] = 'A customer maintains their own contact number through their profile.';
    }
    if ($identityErrors !== []) {
        Response::validation(
            'Customer details can only be changed by the customer.',
            $identityErrors
        );
    }

    /* Only status remains here (archiving is in customers/archive.php). */
    Database::run(
        'UPDATE customers SET status = ? WHERE id = ?',
        [$status, $existing['id']]
    );

    $changes = [];
    if ($existing['status'] !== $status) { $changes[] = "status {$existing['status']} → {$status}"; }

    audit_customer($actor, sprintf('Updated customer %s (%s). %s',
        $existing['name'], $existing['id'], $changes ? implode('; ', $changes) : 'No field values changed.'));
    $id = $existing['id'];
} else {
    $n = (int) Database::scalar(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0) FROM customers WHERE id LIKE 'cus-%'"
    );
    $id = sprintf('cus-%02d', $n + 1);

    Database::run(
        'INSERT INTO customers (id, name, email, contact, status, joined)
         VALUES (?, ?, ?, ?, ?, CURDATE())',
        [$id, $data['name'], $data['email'], $contact, $status]
    );
    audit_customer($actor, sprintf('Added customer: %s (%s).', $data['name'], $id));
    /* Invite them to create their password on the website (sent after the insert, so a mail failure never undoes it). */
    $invited = CustomerInvite::send($id);
    audit_customer($actor, sprintf('Invitation to create an online account %s to %s (%s).',
        $invited ? 'emailed' : 'could not be emailed', $data['email'], $id));
}

/* Lifetime spend uses the one revenue definition, with statuses bound from Revenue::STATUSES. */
[$spendSql, $spendParams] = Revenue::spendSql('c.id');
$row = Database::one(
    "SELECT c.id, c.name, c.email, c.contact, c.status, c.joined,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders,
            $spendSql AS spend
       FROM customers c WHERE c.id = ?",
    array_merge($spendParams, [$id])
);

Response::ok([
    'id'      => $row['id'],
    'name'    => $row['name'],
    'email'   => $row['email'],
    'contact' => $row['contact'],
    'status'  => $row['status'],
    'joined'  => $row['joined'],
    'orders'  => (int) $row['orders'],
    'spend'   => (float) $row['spend'],
    /* New customers only: whether the invitation email went out, and whether mail really sends on this install. */
    'invited'  => $invited ?? null,
    'mailLive' => Mailer::isLive(),
], null, $isUpdate ? 200 : 201);


function audit_customer(array $actor, string $description): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$actor['name'], $actor['id'], 'user', $description]
    );
}
