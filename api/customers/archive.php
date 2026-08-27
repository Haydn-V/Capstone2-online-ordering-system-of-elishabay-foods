<?php
declare(strict_types=1);

/**
 * POST /api/customers/archive.php
 * Body: { "id": "cus-01", "archived": true }
 *
 * Requires users.manage.
 *
 * WHY THIS EXISTS SEPARATELY FROM customers/save.php
 * --------------------------------------------------
 * A customer record belongs to the customer. They maintain their own name,
 * email and contact number through Profile, and an administrator has no
 * business rewriting them — the legitimate administrative need is to close an
 * account, not to edit a person.
 *
 * Archiving used to go through customers/save.php, which meant the portal
 * posted the whole record back with `status: "archived"` just to change one
 * field. That is why save.php could rename a customer at all: the screen that
 * needed it was the archive button. Splitting the two lets save.php's update
 * path refuse identity changes outright, which is the actual fix.
 *
 * This endpoint changes `customers.status` and nothing else. There is no name,
 * email or contact parameter to send.
 *
 * WHAT A RESTORE RESTORES TO
 * --------------------------
 * Not 'active'. api/users/archive.php can hardcode that because `users.status`
 * is only ever 'active' or 'archived'; here the same column also carries
 * 'retailer', so archiving overwrites the answer to "what kind of customer is
 * this" with the answer to "is this account open".
 *
 * Restoring a retailer to 'active' would strip their wholesale pricing and
 * their credit terms with nothing in the interface saying so — the retailer
 * would find out at checkout, when Net 30 stopped being offered.
 *
 * So the previous value is RECORDED on the way in, in
 * `customers.status_before_archive` (migration 008), and read back on the way
 * out. Recording beats inferring: "do they have an approved b2b_application?"
 * is wrong in both directions — a partnership that was later ended still has
 * its approved row, and a retailer granted through any future route that does
 * not write an application would not be restored at all.
 *
 * A row archived before migration 008 has NULL there and comes back as
 * 'active'. That under-grants rather than over-grants, which is the right way
 * round for a value that unlocks trade credit.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which customer?', ['id' => 'Customer is required.']);
}
/* Explicit boolean — an absent flag must not be read as "restore". Same rule
   as products/archive.php and users/archive.php. */
if (!array_key_exists('archived', $in)) {
    Response::badRequest('Specify whether to archive or restore.');
}
$archive = filter_var($in['archived'], FILTER_VALIDATE_BOOLEAN);

$customer = Database::one(
    'SELECT id, name, status, status_before_archive FROM customers WHERE id = ?',
    [$in['id']]
);
if ($customer === null) {
    Response::notFound('That customer does not exist.');
}

$isArchived = $customer['status'] === 'archived';
if ($isArchived === $archive) {
    Response::conflict($archive
        ? 'That customer is already archived.'
        : 'That customer is not archived.');
}

if ($archive) {
    /* The status being replaced is saved in the same statement that replaces
       it. Two statements would leave a window in which the row is archived and
       nothing remembers what it was. */
    $newStatus = 'archived';
    Database::run(
        'UPDATE customers SET status = ?, status_before_archive = ? WHERE id = ?',
        ['archived', $customer['status'], $customer['id']]
    );
} else {
    $newStatus = $customer['status_before_archive'] ?? 'active';
    /* Cleared on restore. Leaving it set would make a later restore read a
       value from two archives ago if the recording step were ever skipped. */
    Database::run(
        'UPDATE customers SET status = ?, status_before_archive = NULL WHERE id = ?',
        [$newStatus, $customer['id']]
    );
}

/* Named in the audit line, because "restored customer" without it does not say
   whether a trade account came back with its terms. */
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [
        $actor['name'], $actor['id'], 'user',
        sprintf('%s customer account: %s (%s). Status %s → %s.',
            $archive ? 'Archived' : 'Restored',
            $customer['name'], $customer['id'], $customer['status'], $newStatus),
    ]
);

Response::ok([
    'id'     => $customer['id'],
    'status' => $newStatus,
]);
