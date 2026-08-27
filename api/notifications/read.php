<?php
declare(strict_types=1);

/**
 * POST /api/notifications/read.php
 * Body: { "id": "n01" }  or  { "all": true }
 *
 * Requires any signed-in staff member.
 *
 * Read state is shared, not per-user: this is one operations team working one
 * queue, and a notification another member has already dealt with should not
 * still be shouting at everyone else. Per-user read state would need its own
 * table and is a different product decision.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
Auth::require();

$in = Response::input();

if (!empty($in['all'])) {
    $n = Database::run('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
    Response::ok(['marked' => $n, 'unread' => 0]);
}

if (empty($in['id'])) {
    Response::validation('Which notification?', ['id' => 'Notification id is required.']);
}

$exists = Database::scalar('SELECT COUNT(*) FROM notifications WHERE id = ?', [$in['id']]);
if (!$exists) {
    Response::notFound('That notification does not exist.');
}

Database::run('UPDATE notifications SET is_read = 1 WHERE id = ?', [$in['id']]);

Response::ok([
    'id'     => $in['id'],
    'unread' => (int) Database::scalar('SELECT COUNT(*) FROM notifications WHERE is_read = 0'),
]);
