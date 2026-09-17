<?php
declare(strict_types=1);

/**
 * POST /api/customers/save.php
 * Body, create: { "name", "email", "contact", "status" }
 * Body, update: { "id": "cus-01", "status" } — plus name/email/contact, which
 *               must match what is stored. A different value is refused.
 *
 * Archiving is NOT done here. See customers/archive.php.
 *
 * Requires users.manage.
 *
 * The Customer tab could add, edit and archive customers, and none of it
 * persisted — the rows lived in a JS array until the next reload. This is that
 * screen's missing half.
 *
 * A customer's password is never touched here. Staff manage the record;
 * credentials belong to the customer and are set through shop/register.php.
 * An admin form that could set someone else's password is a way to take over
 * their account.
 *
 * CREATE ONLY, FOR IDENTITY.
 * --------------------------
 * The update path no longer accepts a change to name, email or contact. Those
 * three fields are the customer's own, maintained by them through Profile
 * (shop/profile.php), and the same argument that keeps passwords out of this
 * file applies to the email address: whoever controls the email address
 * controls the password reset, so an administrator who can change it can take
 * the account.
 *
 * Add Customer still needs all three, so the create path is unchanged — a
 * record staff are entering for the first time has to come from somewhere.
 *
 * What is left on the update path is `status`, and only within the limits the
 * $alreadyRetailer guard below already set. Archiving moved out entirely to
 * customers/archive.php, which is why this endpoint can now be this strict:
 * archiving was the one screen that legitimately posted a whole record back.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('name', 'Customer name')
    ->maxLen('name', 100, 'Customer name')
    ->email('email', 'Email')
    ->values();

$contact = trim((string) ($in['contact'] ?? '')) ?: null;
if ($contact !== null && !preg_match('/^[0-9 +\-()]{7,20}$/', $contact)) {
    Response::validation('Check the highlighted fields.', ['contact' => 'Enter a valid contact number.']);
}

/* `retailer` is granted by approving a B2B application, not by typing it into
   this form — that route reviews the business, records a tier and says why.
   Retailer status unlocks wholesale pricing and credit terms, so assigning it
   here would let anyone holding users.manage hand out trade credit with no
   application, no tier and no audit trail explaining it.

   The comment above said exactly this while the whitelist below still accepted
   'retailer', so the rule was documented but not enforced: a plain POST created
   a retailer outright.

   It stays accepted for an EXISTING retailer, because an edit posts the row's
   current status back and rejecting it would make every other field on a
   retailer uneditable. What is refused is PROMOTING somebody. */
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

    /* Identity is the customer's, not the administrator's.

       REFUSED, NOT IGNORED. Quietly dropping the fields and writing the
       existing values back would leave a caller believing the rename had
       worked — and would leave the next reader of this file believing the
       endpoint accepts them. The same rule shop/checkout.php applies to an
       identity in its body, for the same reason.

       Sending the CURRENT value is fine and is not an error: a client that
       round-trips a record it just read has changed nothing. Only a different
       value is refused. `contact` is compared against '' as well as null,
       because an absent field arrives here as null while the column may hold
       either. */
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

    /* Status is all that is left, and archiving is not done here — see
       customers/archive.php. What remains reaching this line is a status
       round-tripped unchanged, or the retailer case the guard above allows. */
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
}

/* Lifetime spend uses the one revenue definition (D2), bound rather than
   inlined — the statuses live in Revenue::STATUSES, not in this string. */
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
], null, $isUpdate ? 200 : 201);


function audit_customer(array $actor, string $description): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$actor['name'], $actor['id'], 'user', $description]
    );
}
