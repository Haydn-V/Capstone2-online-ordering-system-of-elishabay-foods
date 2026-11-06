<?php
declare(strict_types=1);

/** GET /api/reviews/list.php (needs reviews.moderate) is the staff moderation queue, separate from the public reviews endpoint, showing which keyword held each review, with pending sorted oldest first. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* The endpoint checks permission itself, since hiding the menu item is not security. */
Rbac::require('reviews.moderate');

$q  = $_GET;
$pg = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

$status = trim((string) ($q['status'] ?? ''));
if ($status !== '' && $status !== 'all') {
    if (!in_array($status, [Reviews::PENDING, Reviews::PUBLISHED, Reviews::REJECTED], true)) {
        Response::badRequest('Unknown status filter.');
    }
    $where[] = 'r.status = ?';
    $params[] = $status;
}

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    /* Search across product, customer, order and review text. */
    $where[] = '(p.name LIKE ? OR c.name LIKE ? OR r.order_id LIKE ? OR r.comment LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like, $like);
}

$whereSql = $where === [] ? '' : ' WHERE ' . implode(' AND ', $where);

$total = (int) Database::scalar(
    'SELECT COUNT(*) FROM product_reviews r
       JOIN products p ON p.id = r.product_id
       JOIN customers c ON c.id = r.customer_id' . $whereSql,
    $params
);

/* Oldest first only for pending reviews. */
$order = $status === Reviews::PENDING
    ? 'r.created_at ASC, r.id ASC'
    : 'r.created_at DESC, r.id DESC';

$rows = Database::all(
    'SELECT r.id, r.product_id, r.customer_id, r.order_id, r.rating, r.comment,
            r.status, r.hold_reason, r.reject_reason, r.moderated_at,
            r.created_at, r.updated_at,
            p.name AS product_name, p.archived AS product_archived,
            c.name AS customer_name, c.email AS customer_email,
            u.name AS moderator_name,
            o.status AS order_status
       FROM product_reviews r
       JOIN products p  ON p.id = r.product_id
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN users u ON u.id = r.moderated_by
       LEFT JOIN orders o ON o.id = r.order_id' . $whereSql . '
      ORDER BY ' . $order . '
      LIMIT ' . $pg['limit'] . ' OFFSET ' . $pg['offset'],
    $params
);

$reviews = array_map(static function (array $r): array {
    return [
        'id'             => (int) $r['id'],
        'product_id'     => $r['product_id'],
        'product_name'   => $r['product_name'],
        /* Flag reviews on archived products. */
        'product_archived' => (int) $r['product_archived'] === 1,
        'customer_id'    => $r['customer_id'],
        'customer_name'  => $r['customer_name'],
        'customer_email' => $r['customer_email'],
        'order_id'       => $r['order_id'],
        /* Show the order's current status so a cancelled order behind a review is visible. */
        'order_status'   => $r['order_status'],
        'rating'         => (int) $r['rating'],
        'comment'        => $r['comment'],
        'status'         => $r['status'],
        'hold_reason'    => $r['hold_reason'],
        'reject_reason'  => $r['reject_reason'],
        'moderator'      => $r['moderator_name'],
        'moderated_at'   => $r['moderated_at'],
        'date'           => $r['created_at'],
        'edited'         => $r['updated_at'] !== null && $r['updated_at'] !== $r['created_at'],
    ];
}, $rows);

/* Tab counts over all rows, not just the filtered page. */
$counts = ['pending' => 0, 'published' => 0, 'rejected' => 0];
foreach (Database::all('SELECT status, COUNT(*) AS n FROM product_reviews GROUP BY status') as $c) {
    $counts[(string) $c['status']] = (int) $c['n'];
}
$counts['all'] = array_sum($counts);

Response::ok($reviews, [
    'page'   => $pg['page'],
    'limit'  => $pg['limit'],
    'total'  => $total,
    'pages'  => (int) ceil($total / $pg['limit']),
    'counts' => $counts,
]);
