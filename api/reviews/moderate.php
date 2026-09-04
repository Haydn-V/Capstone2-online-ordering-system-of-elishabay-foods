<?php
declare(strict_types=1);

/**
 * POST /api/reviews/moderate.php
 * Body: { "id": 12, "action": "publish" | "reject" | "unpublish", "reason": "…" }
 *
 * A staff decision about one review. Requires `reviews.moderate`.
 *
 * THREE ACTIONS, NOT A STATUS PARAMETER
 * -------------------------------------
 * `{"status": "rejected"}` would be shorter and is the wrong shape: the rules
 * differ per action — publish needs no reason, reject and unpublish both
 * require one — and an endpoint that takes a target state has to rediscover
 * which rules apply by branching on it anyway. Naming the action makes the
 * branch the subject rather than a consequence, and makes "unpublish" a thing
 * the audit log can say instead of "set status to rejected", which is what it
 * would otherwise have to record for two quite different decisions.
 *
 * A REASON IS REQUIRED TO TAKE SOMETHING DOWN
 * -------------------------------------------
 * Both reject and unpublish refuse without one. A review removed with no stated
 * cause is indistinguishable from one removed because staff disliked the score,
 * including to the staff member who has to defend it later, and the customer is
 * shown the reason on their own review (api/shop/reviews.php returns it in
 * `mine`). Publishing needs no reason: it is the outcome the customer already
 * asked for.
 *
 * MODERATION IS FOR ABUSE AND POLICY. NEVER FOR A LOW SCORE.
 * ----------------------------------------------------------
 * Nothing here reads `rating`, and that is deliberate rather than an omission.
 * A one-star review is a signal that something went wrong with a real order;
 * the system's response to it is a Warning notification raised at the moment it
 * was written (review-save.php), not a queue. If a rating could be moderated
 * away, the average would measure which reviews staff were willing to keep.
 *
 * EVERY DECISION IS ON THE RECORD — an audit_logs row, with the reason, the
 * moderator and the review, for all three actions including publish. A
 * moderation log that records only refusals cannot answer "who cleared this".
 */

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

/* Checked before the row is read, so a missing reason is answered the same way
   whether or not the id happens to exist. */
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

/* What each action means, and what it refuses to do. Kept as one table so the
   guard and the write cannot disagree about which transitions are legal. */
$rules = [
    /* Clearing a held review, or restoring one that was taken down. */
    'publish'   => ['to' => Reviews::PUBLISHED, 'from' => [Reviews::PENDING, Reviews::REJECTED]],
    /* Refusing a held review outright. */
    'reject'    => ['to' => Reviews::REJECTED,  'from' => [Reviews::PENDING]],
    /* Taking down something already live. Same stored status as reject; a
       different decision, and the audit log says which. */
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

    /* `updated_at = updated_at` is not a no-op — it is the point.

       The column is ON UPDATE CURRENT_TIMESTAMP, so any write here would bump
       it, and both readers treat updated_at != created_at as "the CUSTOMER
       edited this" (shop/reviews.php sends `edited`, the shop page prints it).
       Without this clause, moderating a review makes the storefront claim its
       author rewrote it. The moderator's own timestamp is moderated_at. */
    Database::run(
        'UPDATE product_reviews
            SET status = ?, reject_reason = ?, hold_reason = NULL,
                moderated_by = ?, moderated_at = NOW(), updated_at = updated_at
          WHERE id = ? AND status = ?',
        [$rule['to'], $action === 'publish' ? null : $reason,
         $user['id'], $review['id'], $review['status']]
    );

    /* Conditional on the status that was read. Two moderators can open the same
       queue, and the second one should be told rather than silently overwrite
       the first. Same pattern as confirm-received.php. */
    if ((int) Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just moderated this review. Reload and try again.');
    }

    /* The average moves with the decision, in the same transaction. A published
       review that is not in the count, or a rejected one that still is, would
       be a shop page disagreeing with the queue. */
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
