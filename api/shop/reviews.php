<?php
declare(strict_types=1);

/** GET /api/shop/reviews.php (public) returns published reviews with name shown as "Maria S.", the average and count computed from this query, plus the signed-in customer's own review at any status in mine. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$productId = trim((string) ($_GET['product_id'] ?? ''));
if ($productId === '') {
    Response::badRequest('A product is required.');
}

/* 10 reviews per page. */
$pg = Validate::paging($_GET, 10, 50);

$totals = Database::one(
    'SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg_rating
       FROM product_reviews WHERE product_id = ? AND status = ?',
    [$productId, Reviews::PUBLISHED]
);
$count = (int) ($totals['n'] ?? 0);

/* Include the 1 to 5 star histogram. */
$spread = ['1' => 0, '2' => 0, '3' => 0, '4' => 0, '5' => 0];
foreach (Database::all(
    'SELECT rating, COUNT(*) AS n FROM product_reviews
      WHERE product_id = ? AND status = ? GROUP BY rating',
    [$productId, Reviews::PUBLISHED]
) as $r) {
    $spread[(string) (int) $r['rating']] = (int) $r['n'];
}

/* LIMIT/OFFSET are inserted directly because they are integers from Validate::paging(). */
$rows = Database::all(
    'SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at, c.name AS customer_name
       FROM product_reviews r
       JOIN customers c ON c.id = r.customer_id
      WHERE r.product_id = ? AND r.status = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ' . $pg['limit'] . ' OFFSET ' . $pg['offset'],
    [$productId, Reviews::PUBLISHED]
);

/** "Maria Santos" -> "Maria S." — see the header. */
function reviewerName(string $full): string
{
    $parts = preg_split('/\s+/', trim($full), -1, PREG_SPLIT_NO_EMPTY) ?: [];
    if ($parts === []) {
        return 'Customer';
    }
    if (count($parts) === 1) {
        return $parts[0];
    }
    return $parts[0] . ' ' . mb_strtoupper(mb_substr((string) end($parts), 0, 1)) . '.';
}

$reviews = array_map(static function (array $r): array {
    return [
        'id'      => (int) $r['id'],
        'rating'  => (int) $r['rating'],
        'comment' => $r['comment'],
        'author'  => reviewerName((string) $r['customer_name']),
        'date'    => $r['created_at'],
        /* Mark reviews the customer edited. */
        'edited'  => $r['updated_at'] !== null && $r['updated_at'] !== $r['created_at'],
    ];
}, $rows);

/* The signed-in customer's own review (one per order now, so a held or rejected one is shown first; null if none). */
$mine = null;
$customer = Auth::customer();
if ($customer !== null) {
    $own = Database::one(
        'SELECT id, rating, comment, status, reject_reason, created_at
           FROM product_reviews WHERE customer_id = ? AND product_id = ?
          ORDER BY status = \'published\', updated_at DESC, id DESC LIMIT 1',
        [$customer['id'], $productId]
    );
    if ($own !== null) {
        $mine = [
            'id'      => (int) $own['id'],
            'rating'  => (int) $own['rating'],
            'comment' => $own['comment'],
            'status'  => $own['status'],
            /* Show the moderator's reason to the review's author. */
            'reason'  => $own['reject_reason'],
            'date'    => $own['created_at'],
        ];
    }
}

/* Whether this person may review, using the same rule as review-save.php (presentation only). */
$canReview = false;
if ($customer !== null) {
    $canReview = Database::scalar(
        'SELECT 1 FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE o.customer_id = ? AND oi.product_id = ? AND o.status = ?
          LIMIT 1',
        [$customer['id'], $productId, 'completed']
    ) !== false;
}

Response::ok([
    'product_id'   => $productId,
    'avg_rating'   => $count > 0 ? round((float) $totals['avg_rating'], 2) : 0.0,
    'review_count' => $count,
    'spread'       => $spread,
    'reviews'      => $reviews,
    'mine'         => $mine,
    'can_review'   => $canReview,
], [
    'page'  => $pg['page'],
    'limit' => $pg['limit'],
    'total' => $count,
    'pages' => (int) ceil($count / $pg['limit']),
]);
