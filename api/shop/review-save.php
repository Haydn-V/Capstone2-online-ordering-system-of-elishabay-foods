<?php
declare(strict_types=1);

/** POST /api/shop/review-save.php rates a product within one of the customer's completed orders: one review per product per order (resubmitting edits that order's review only), and only the text can trigger moderation. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer = Auth::requireCustomer('Sign in to review a product.');

$in = Response::input();

$data = Validate::check($in)
    ->required('order_id', 'Order')
    ->required('product_id', 'Product')
    ->required('rating', 'Rating')
    /* Rating must be 1 to 5, refused rather than clamped. */
    ->int('rating', 'Rating', 1, 5)
    ->maxLen('comment', 1000, 'Comment')
    ->values();

$orderId   = (string) $data['order_id'];
$productId = (string) $data['product_id'];
$rating    = (int) $data['rating'];

/* An empty comment is stored as null. */
$comment = trim((string) ($in['comment'] ?? ''));
if ($comment === '') { $comment = null; }

/* Archived products are deliberately NOT excluded — see the header. */
$product = Database::one('SELECT id, name FROM products WHERE id = ?', [$productId]);
if ($product === null) {
    Response::notFound('That product no longer exists.');
}

/* The named order must be this customer's, completed, and contain the product (checked here, never trusted from the body). */
$qualifying = Database::one(
    'SELECT o.id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = ?
        AND o.customer_id = ?
        AND oi.product_id = ?
        AND o.status = ?
      LIMIT 1',
    [$orderId, $customer['id'], $productId, 'completed']
);

/* Only this order's review of the product, so editing never touches another order's rating. */
$existing = Database::one(
    'SELECT id, order_id, status FROM product_reviews
      WHERE order_id = ? AND product_id = ? AND customer_id = ?',
    [$orderId, $productId, $customer['id']]
);

if ($qualifying === null) {
    /* Different messages for "never bought" and "order no longer qualifies". */
    if ($existing !== null) {
        Response::conflict(
            'Your review is still published, but the order behind it is no longer '
            . 'completed, so it cannot be edited. Contact us if you need it changed.'
        );
    }
    Response::forbidden(
        'Only customers who have bought this product can review it. '
        . 'You can leave a review once your order is completed.'
    );
}

/* Flagged words only send the review to a person; they do not reject it. */
$verdict = Reviews::classify($comment);

/* An edited rejected review goes back to the queue instead of reappearing. */
if ($existing !== null && $existing['status'] === Reviews::REJECTED) {
    $verdict = ['status' => Reviews::PENDING, 'hold' => 'edited after rejection'];
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    if ($existing === null) {
        Database::run(
            'INSERT INTO product_reviews
                 (product_id, customer_id, order_id, rating, comment, status, hold_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$productId, $customer['id'], $qualifying['id'], $rating, $comment,
             $verdict['status'], $verdict['hold']]
        );
    } else {
        /* Edit this order's review in place and clear old moderation notes. */
        Database::run(
            'UPDATE product_reviews
                SET rating = ?, comment = ?, status = ?, hold_reason = ?,
                    reject_reason = NULL, moderated_by = NULL, moderated_at = NULL
              WHERE id = ?',
            [$rating, $comment, $verdict['status'], $verdict['hold'], $existing['id']]
        );
    }

    /* Recompute rating and count from published reviews only. */
    $totals = Reviews::recompute($productId);

    /* A low rating raises a staff Warning (the review is already live). */
    if ($rating <= Reviews::LOW_RATING && $verdict['status'] === Reviews::PUBLISHED) {
        Notify::create(
            'review',
            sprintf('%s rated %s %d/5 on order %s.',
                $customer['name'], $product['name'], $rating, $qualifying['id']),
            ['product' => $productId, 'order' => $qualifying['id']]
        );
    }

    /* actor_user_id is NULL because the actor is a customer. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$customer['name'], 'review',
         sprintf('%s a %d/5 review of %s (%s) from order %s. Saved as %s.',
             $existing === null ? 'Left' : 'Edited',
             $rating, $product['name'], $productId, $qualifying['id'],
             $verdict['status'])]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Tell the customer honestly when the review is held, without revealing the matched word. */
Response::ok([
    'order_id'     => $orderId,
    'product_id'   => $productId,
    'rating'       => $rating,
    'status'       => $verdict['status'],
    'held'         => $verdict['status'] !== Reviews::PUBLISHED,
    'edited'       => $existing !== null,
    'avg_rating'   => $totals['rating'],
    'review_count' => $totals['count'],
]);
