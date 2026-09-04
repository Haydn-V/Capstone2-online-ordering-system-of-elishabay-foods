<?php
declare(strict_types=1);

/**
 * GET /api/notifications/list.php?unread_only=1&limit=50&priority=critical
 *
 * Requires any signed-in staff member — the bell is in the shared shell, so
 * every role sees it. What each role may ACT on is still gated by the
 * endpoints behind each notification.
 *
 * Read state lives in the database now. It used to be an in-memory Set, so
 * marking something read survived exactly until the next page load, and every
 * staff member saw their own private idea of what was unread.
 *
 * ORDER IS THE POINT OF THIS ENDPOINT.
 * ------------------------------------
 * It used to be `created_at DESC` alone, which made every notification equal:
 * a batch that had already expired sorted underneath an order somebody had
 * completed an hour later. The order is now unread first, then urgency, then
 * newest — one rule, in Notify::orderBy(), used by every screen that shows
 * these rows, because an order expressed in a client cannot survive paging.
 *
 * IT ALSO WRITES. Expired batches have no user action to hang a producer off,
 * so they are materialised here, on read — see Notify::syncExpiredBatches()
 * for why that is a lazy INSERT rather than a scheduler.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$q      = $_GET;
$paging = Validate::paging($q, 50, 200);

/* Before the counts and the page are read, so a batch that expired since the
   last page load appears in both rather than in the next request's. */
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
/* Filtering to one level, for a "show me only what is on fire" view. Checked
   against the known levels rather than passed through, so an unknown value is
   a refusal instead of an empty list that looks like "nothing is critical". */
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
    /* Per level, so the bell can say "something is on fire" separately from
       "three things happened" without counting rows it was not sent. */
    'unreadByPriority' => Notify::unreadByPriority(),
    /* The order the client must render in, and the levels in display order, so
       a screen sorting a mixed list does not have to hardcode the ranking. */
    'levels' => Notify::LEVELS,
    /* The type→level table itself. The portal derives some notifications in the
       browser from live records (expiring batches, failed QA lots, retailer
       payment schemes) — those have no row here, but they appear in the same
       lists and must sort on the same scale. Serving the map means the browser
       has no second copy of it to drift from. */
    'priorityMap' => Notify::priorityMap(),
]);
