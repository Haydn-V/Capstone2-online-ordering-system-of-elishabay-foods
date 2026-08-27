<?php
declare(strict_types=1);

/**
 * GET /api/notifications/list.php?unread_only=1&limit=50
 *
 * Requires any signed-in staff member — the bell is in the shared shell, so
 * every role sees it. What each role may ACT on is still gated by the
 * endpoints behind each notification.
 *
 * Read state lives in the database now. It used to be an in-memory Set, so
 * marking something read survived exactly until the next page load, and every
 * staff member saw their own private idea of what was unread.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$q      = $_GET;
$paging = Validate::paging($q, 50, 200);

$where  = [];
$params = [];

if (!empty($q['unread_only'])) {
    $where[] = 'n.is_read = 0';
}
if (!empty($q['type'])) {
    $where[] = 'n.type = ?';
    $params[] = $q['type'];
}

$sql = 'FROM notifications n';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total  = (int) Database::scalar("SELECT COUNT(*) $sql", $params);
$unread = (int) Database::scalar('SELECT COUNT(*) FROM notifications WHERE is_read = 0');

$rows = Database::all(
    "SELECT n.id, n.type, n.order_id, n.return_id, n.product_id,
            n.message, n.created_at, n.is_read
     $sql
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

Response::ok(array_map(static fn(array $r): array => [
    'id'        => $r['id'],
    'type'      => $r['type'],
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
]);
