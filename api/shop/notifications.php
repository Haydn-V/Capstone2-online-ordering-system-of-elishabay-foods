<?php
declare(strict_types=1);

/**
 * The signed-in customer's notification bell (migration 018).
 *
 *   GET  /api/shop/notifications.php
 *        → { items: [...latest 30], unread: n }
 *   POST /api/shop/notifications.php   { "action": "read", "id": 12 }
 *                                      { "action": "read_all" }
 *
 * Scoped by the session; takes no customer id. A mark-read for somebody
 * else's row simply matches nothing.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod(['GET', 'POST']);
$customer = Auth::requireCustomer('Sign in to see your notifications.');

if (!CustomerNotify::ready()) {
    Response::ok(['items' => [], 'unread' => 0]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = Response::input();
    $action = (string) ($in['action'] ?? '');
    if ($action === 'read_all') {
        Database::run('UPDATE customer_notifications SET is_read = 1 WHERE customer_id = ? AND is_read = 0',
            [$customer['id']]);
    } elseif ($action === 'read') {
        Database::run('UPDATE customer_notifications SET is_read = 1 WHERE id = ? AND customer_id = ?',
            [(int) ($in['id'] ?? 0), $customer['id']]);
    } else {
        Response::validation('Unknown action.', ['action' => 'Use "read" or "read_all".']);
    }
}

/* ?all=1 — the History page: read ones too, further back. The bell leaves
   it off and gets unread only (read ones drop off the bell). */
$all = ($_GET['all'] ?? '') === '1';
$rows = Database::all(
    'SELECT id, type, title, message, link, order_id, return_id, is_read, created_at,
            TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds
       FROM customer_notifications
      WHERE customer_id = ?' . ($all ? '' : ' AND is_read = 0') . '
      ORDER BY created_at DESC, id DESC
      LIMIT ' . ($all ? 200 : 30),
    [$customer['id']]
);
$unread = (int) Database::scalar(
    'SELECT COUNT(*) FROM customer_notifications WHERE customer_id = ? AND is_read = 0',
    [$customer['id']]
);

Response::ok([
    'items' => array_map(static fn(array $r): array => [
        'id'        => (int) $r['id'],
        'type'      => $r['type'],
        'title'     => $r['title'],
        'message'   => $r['message'],
        'link'      => $r['link'],
        'orderId'   => $r['order_id'],
        'returnId'  => $r['return_id'],
        'read'      => (bool) $r['is_read'],
        'createdAt' => $r['created_at'],
        /* Measured on the database clock that stamped it — the browser's clock
           and timezone need not match the server's. */
        'ageSeconds'=> max(0, (int) $r['age_seconds']),
    ], $rows),
    'unread' => $unread,
]);
