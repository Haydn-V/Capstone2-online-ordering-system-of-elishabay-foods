<?php
declare(strict_types=1);

/** POST /api/customers/archive.php (needs users.manage) only changes a customer's status, saving the previous status (e.g. retailer) on archive and restoring it on unarchive. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('users.manage');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which customer?', ['id' => 'Customer is required.']);
}
/* Require an explicit boolean so a missing flag is never read as "restore". */
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
    /* Save the old status in the same statement that archives the row. */
    $newStatus = 'archived';
    Database::run(
        'UPDATE customers SET status = ?, status_before_archive = ? WHERE id = ?',
        ['archived', $customer['status'], $customer['id']]
    );
} else {
    $newStatus = $customer['status_before_archive'] ?? 'active';
    /* Clear the saved status on restore. */
    Database::run(
        'UPDATE customers SET status = ?, status_before_archive = NULL WHERE id = ?',
        [$newStatus, $customer['id']]
    );
}

/* Name the restored status in the audit line. */
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
