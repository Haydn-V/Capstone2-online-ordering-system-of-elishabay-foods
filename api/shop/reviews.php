<?php
declare(strict_types=1);

/**
 * GET /api/shop/reviews.php?product_id=bg-pesto&page=1&limit=10
 *
 * PUBLIC — no session required. The reviews shown on a product.
 *
 * ONLY PUBLISHED ROWS ARE RETURNED, with one exception: a signed-in customer
 * gets their OWN review back in `mine` whatever its status, because a person
 * who cannot see what they wrote cannot edit it, and one whose review is held
 * needs to be told that rather than left to conclude it vanished.
 *
 * `mine` is read with the SESSION's customer id. There is no parameter that
 * selects whose review to return, so there is nothing to tamper with — the same
 * rule the rest of api/shop/ follows.
 *
 * WHAT A REVIEWER IS CALLED
 * -------------------------
 * First name and last initial: "Maria S." The full name is a real person's
 * identity attached to a public opinion and to a purchase, on a page anyone can
 * open and a crawler can index; the initial is enough for two reviews by
 * different people to read as different people. The email and the order id are
 * never sent — the order is the evidence FOR the badge, not part of it.
 *
 * "Verified purchase" is not a flag stored anywhere and is not sent as one. It
 * is true of every row in this table by construction (product_reviews.order_id
 * is NOT NULL and review-save.php derives it), which is why the badge can be
 * rendered unconditionally rather than trusted from a field.
 *
 * THE AVERAGE COMES FROM THIS QUERY, NOT FROM products.rating
 * -----------------------------------------------------------
 * `products.rating` is a cache that Reviews::recompute() maintains. Reading it
 * here would mean a page that lists five reviews could show an average computed
 * from something else if the cache ever drifted. The count is what the caller
 * needs to decide between a score and "No ratings yet", so it is returned
 * beside the average rather than left to be inferred from the page length.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$productId = trim((string) ($_GET['product_id'] ?? ''));
if ($productId === '') {
    Response::badRequest('A product is required.');
}

/* 10 at a time. A product page shows a few and offers more; asking for
   everything on first paint would make a popular product the slowest page. */
$pg = Validate::paging($_GET, 10, 50);

$totals = Database::one(
    'SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg_rating
       FROM product_reviews WHERE product_id = ? AND status = ?',
    [$productId, Reviews::PUBLISHED]
);
$count = (int) ($totals['n'] ?? 0);

/* The 1..5 histogram. Cheap here, and it is what turns a bare "4.2" into
   something a shopper can judge — twenty fives and four ones is a different
   product from twenty-four fours, and both average 4.2. */
$spread = ['1' => 0, '2' => 0, '3' => 0, '4' => 0, '5' => 0];
foreach (Database::all(
    'SELECT rating, COUNT(*) AS n FROM product_reviews
      WHERE product_id = ? AND status = ? GROUP BY rating',
    [$productId, Reviews::PUBLISHED]
) as $r) {
    $spread[(string) (int) $r['rating']] = (int) $r['n'];
}

/* LIMIT/OFFSET are interpolated, not bound: MySQL will not take placeholders
   there under emulated prepares, and both values are integers this file
   produced through Validate::paging(). Same as every other list endpoint. */
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
        /* So the page can say "edited" rather than pass off a rewrite as the
           original. Compared as strings because both come from the same two
           columns and MySQL formats them identically. */
        'edited'  => $r['updated_at'] !== null && $r['updated_at'] !== $r['created_at'],
    ];
}, $rows);

/* The signed-in customer's own review, at any status. Null when not signed in,
   or when they have not written one. */
$mine = null;
$customer = Auth::customer();
if ($customer !== null) {
    $own = Database::one(
        'SELECT id, rating, comment, status, reject_reason, created_at
           FROM product_reviews WHERE customer_id = ? AND product_id = ?',
        [$customer['id'], $productId]
    );
    if ($own !== null) {
        $mine = [
            'id'      => (int) $own['id'],
            'rating'  => (int) $own['rating'],
            'comment' => $own['comment'],
            'status'  => $own['status'],
            /* The moderator's stated reason IS shown to its author. A rejection
               with no reason given to the person rejected is indistinguishable
               from censorship, and the endpoint that writes it requires one
               precisely so this line has something to show. */
            'reason'  => $own['reject_reason'],
            'date'    => $own['created_at'],
        ];
    }
}

/* CAN THIS PERSON REVIEW AT ALL? The same derivation review-save.php performs,
   so the page never offers a control the save would refuse. Presentation, not
   security — the endpoint decides for itself either way. */
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
