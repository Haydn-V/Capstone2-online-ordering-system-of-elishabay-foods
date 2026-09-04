<?php
declare(strict_types=1);

/**
 * GET /api/reviews/list.php?status=pending&search=&page=1&limit=25
 *
 * The staff moderation queue. Requires `reviews.moderate`.
 *
 * WHY THIS IS NOT PART OF api/shop/reviews.php
 * --------------------------------------------
 * That endpoint is public and returns published rows only. This one returns
 * held and rejected text, the customer's full name, the order behind it and the
 * moderator's reasons. Folding them together would mean one query whose output
 * is trimmed by a flag, and the day somebody gets that flag wrong the shop page
 * serves a rejected review and a customer's full name to anyone who asks.
 * Separate endpoints cannot make that mistake.
 *
 * WHAT THE QUEUE HAS TO SHOW TO BE USABLE
 * ---------------------------------------
 * `hold_reason` names the keyword that held each pending review. A queue that
 * says only "held for review" asks the moderator to guess what the machine
 * objected to, and guessing wrong in the direction of caution means rejecting
 * ordinary text. The word is shown so the moderator can see, immediately, that
 * "this sauce is fire" tripped a list rather than broke a rule.
 *
 * THE ORDER IS OLDEST FIRST FOR PENDING. A moderation queue is a queue: the
 * review that has been waiting longest is the one a customer is currently
 * wondering about. Everything else is newest first, because those lists are
 * records rather than work.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* The endpoint decides for itself. The nav item is hidden from roles without
   this permission, but that is presentation — api/core/Rbac.php says so in its
   header, and hiding a control has never stopped anyone typing a URL. */
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
    /* The product, the customer, the order and the text itself. A moderator
       following up a complaint has one of those four and should not have to
       know which field it lives in. */
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

/* Oldest-first only when looking at the work. See the header. */
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
        /* So the queue can say so. An archived product still collects reviews
           — see the header of review-save.php — and a moderator reading one
           should know the product is no longer on sale. */
        'product_archived' => (int) $r['product_archived'] === 1,
        'customer_id'    => $r['customer_id'],
        'customer_name'  => $r['customer_name'],
        'customer_email' => $r['customer_email'],
        'order_id'       => $r['order_id'],
        /* The evidence, as it stands TODAY. A review whose order has since been
           cancelled is not automatically wrong, but it is worth a second look,
           and the moderator should not have to open another screen to see it. */
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

/* Counts for the tab badges, over ALL rows rather than the filtered page —
   a queue tab whose number changed with the current filter would be useless. */
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
