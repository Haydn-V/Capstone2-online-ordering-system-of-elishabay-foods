<?php
declare(strict_types=1);

/** POST /api/reviews/moderate.php (needs reviews.moderate) publishes, rejects or unpublishes a review (reject/unpublish need a reason shown to the customer), never based on the rating, and every decision is audited. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$user = Rbac::require('reviews.moderate');

$in = Response::input();

$data = Validate::check($in)
    ->required('id', 'Review')
    ->int('id', 'Review', 1)
    ->required('action', 'Action')
    ->in('action', ['publish', 'reject', 'unpublish'], 'Action')
    ->maxLen('reason', 500, 'Reason')
    ->values();

$action = (string) $data['action'];
$reason = trim((string) ($in['reason'] ?? ''));

/* Check for a missing reason before reading the row. */
if ($action !== 'publish' && $reason === '') {
    Response::validation('Please correct the highlighted fields.', [
        'reason' => $action === 'reject'
            ? 'Say why this review is being rejected. The customer is shown this.'
            : 'Say why this review is being taken down. The customer is shown this.',
    ]);
}

$review = Database::one(
    'SELECT r.id, r.product_id, r.customer_id, r.rating, r.status, r.comment,
            p.name AS product_name, c.name AS customer_name
       FROM product_reviews r
       JOIN products p  ON p.id = r.product_id
       JOIN customers c ON c.id = r.customer_id
      WHERE r.id = ?',
    [$data['id']]
);
if ($review === null) {
    Response::notFound('That review no longer exists.');
}

/* Each action's allowed starting statuses, in one table used by both the check and the write. */
$rules = [
    /* Clearing a held review, or restoring one that was taken down. */
    'publish'   => ['to' => Reviews::PUBLISHED, 'from' => [Reviews::PENDING, Reviews::REJECTED]],
    /* Refusing a held review outright. */
    'reject'    => ['to' => Reviews::REJECTED,  'from' => [Reviews::PENDING]],
    /* Unpublish takes down a live review (same stored status as reject, but logged differently). */
    'unpublish' => ['to' => Reviews::REJECTED,  'from' => [Reviews::PUBLISHED]],
];

$rule = $rules[$action];
if (!in_array((string) $review['status'], $rule['from'], true)) {
    Response::conflict(sprintf(
        'This review is %s, so it cannot be %sed. Somebody may have just changed it — reload and look again.',
        $review['status'], $action
    ));
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* updated_at = updated_at stops the timestamp changing, so moderation does not make the storefront say the customer edited the review. */
    Database::run(
        'UPDATE product_reviews
            SET status = ?, reject_reason = ?, hold_reason = NULL,
                moderated_by = ?, moderated_at = NOW(), updated_at = updated_at
          WHERE id = ? AND status = ?',
        [$rule['to'], $action === 'publish' ? null : $reason,
         $user['id'], $review['id'], $review['status']]
    );

    /* Conditional on the status read, so a second moderator is told instead of overwriting the first. */
    if ((int) Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just moderated this review. Reload and try again.');
    }

    /* Update the product's average rating in the same transaction. */
    $totals = Reviews::recompute((string) $review['product_id']);

    $verb = ['publish' => 'Published', 'reject' => 'Rejected', 'unpublish' => 'Unpublished'][$action];
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'review',
         sprintf('%s %s\'s %d/5 review of %s (#%d).%s',
             $verb, $review['customer_name'], (int) $review['rating'],
             $review['product_name'], (int) $review['id'],
             $reason === '' ? '' : ' Reason: ' . $reason)]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::ok([
    'id'           => (int) $review['id'],
    'status'       => $rule['to'],
    'product_id'   => $review['product_id'],
    'avg_rating'   => $totals['rating'],
    'review_count' => $totals['count'],
]);
