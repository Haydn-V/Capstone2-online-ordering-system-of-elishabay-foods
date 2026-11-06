<?php
declare(strict_types=1);

/** GET /api/notifications/list.php (any signed-in staff) returns the shared staff notifications, sorted unread first, then urgency, then newest (Notify::orderBy()), and first creates rows for newly expired batches. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$q      = $_GET;
$paging = Validate::paging($q, 50, 200);

/* Sync expired batches before counting so they appear in this response. */
Notify::syncExpiredBatches();

$where  = [];
$params = [];

if (!empty($q['unread_only'])) {
    $where[] = 'n.is_read = 0';
}
if (!empty($q['type'])) {
    $where[] = 'n.type = ?';
    $params[] = $q['type'];
}
/* Optional filter to one known level; an unknown value is refused rather than returning an empty list. */
if (!empty($q['priority'])) {
    if (!in_array($q['priority'], Notify::LEVELS, true)) {
        Response::validation('Unknown priority.', [
            'priority' => 'Must be one of: ' . implode(', ', Notify::LEVELS) . '.',
        ]);
    }
    $where[] = 'n.priority = ?';
    $params[] = $q['priority'];
}

$sql = 'FROM notifications n';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total  = (int) Database::scalar("SELECT COUNT(*) $sql", $params);
$unread = (int) Database::scalar('SELECT COUNT(*) FROM notifications WHERE is_read = 0');

$rows = Database::all(
    "SELECT n.id, n.type, n.priority, n.order_id, n.return_id, n.product_id,
            n.message, n.created_at, n.is_read
     $sql
     ORDER BY " . Notify::orderBy('n') . "
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

Response::ok(array_map(static fn(array $r): array => [
    'id'        => $r['id'],
    'type'      => $r['type'],
    'priority'  => $r['priority'],
    'orderId'   => $r['order_id'],
    'returnId'  => $r['return_id'],
    'productId' => $r['product_id'],
    'msg'       => $r['message'],
    'time'      => $r['created_at'],
    'read'      => (bool) $r['is_read'],
], $rows), [
    'page'   => $paging['page'],
    'limit'  => $paging['limit'],
    'total'  => $total,
    'pages'  => (int) ceil($total / $paging['limit']),
    'unread' => $unread,
    /* Unread counts per level so the bell can show urgency separately from the total. */
    'unreadByPriority' => Notify::unreadByPriority(),
    /* Send the sort order and level order so screens do not hard-code the ranking. */
    'levels' => Notify::LEVELS,
    /* Send the type-to-level map so notifications built in the browser sort on the same scale. */
    'priorityMap' => Notify::priorityMap(),
]);
