<?php
declare(strict_types=1);

/**
 * POST /api/shop/review-save.php
 * Body: { "product_id": "bg-pesto", "rating": 1..5, "comment": "…" }
 *
 * A customer rates a product they have actually bought. Creates the review, or
 * edits the one they already left — see the unique key below.
 *
 * `order_id` IS NOT IN THE BODY, AND THAT IS THE POINT
 * ---------------------------------------------------
 * The client does not get to name the purchase that entitles it. This endpoint
 * goes and finds one: the earliest COMPLETED order belonging to THIS SESSION's
 * customer that contains THIS product. If there is none, there is no review.
 *
 * Taking an order id from the body and checking it would look equivalent and is
 * not — it invites the check to be relaxed later ("the client already knows the
 * order, just trust it") and it is one edit away from a customer reviewing a
 * product on the strength of somebody else's order. api/shop/checkout.php
 * states the same rule about the delivery address: "Always the session's
 * address. Never read from the request."
 *
 * WHY `completed` AND NOT `delivered`
 * -----------------------------------
 * `completed` is the customer's own confirmation that the goods arrived and
 * were what they ordered (api/shop/confirm-received.php, or the one-hour sweep
 * in Orders::autoCompleteDelivered). Reviewing at `delivered` would mean rating
 * a parcel that staff had marked as arrived, which is not the same as the
 * customer saying it did.
 *
 * ONE VOTE PER CUSTOMER PER PRODUCT
 * ---------------------------------
 * uq_review_customer_product. A second submission EDITS the first rather than
 * stacking, so buying the same product five times does not buy five votes on
 * its average. `order_id` is written once and deliberately NOT updated on an
 * edit: it records the purchase that first earned the right, and rewriting it
 * would quietly relabel the provenance every time somebody fixed a typo.
 *
 * WHAT HAPPENS TO AN EDIT WHEN THE ORDER NO LONGER QUALIFIES
 * ----------------------------------------------------------
 * Entitlement is re-derived on EVERY write, edits included, because it is a
 * fact about the present rather than a token issued once.
 *
 *   REFUNDED — the review stands and stays editable. A refund is a row in
 *   product_returns; it does not touch orders.status, so the order is still
 *   `completed` and still qualifies. Deliberate, not incidental: the customer
 *   who was refunded is the one person with first-hand knowledge of what went
 *   wrong, and silencing them at exactly that moment would leave the ratings a
 *   record of the orders that went well.
 *
 *   ARCHIVED — orders are never archived; there is no such column and no such
 *   screen. The archivable thing is the PRODUCT (products.archived), and an
 *   archived product keeps its reviews and stays reviewable by anyone who
 *   bought it. Withdrawing a product from sale does not un-eat it, and staff
 *   have more use for that feedback than for less of it.
 *
 *   CANCELLED — if every qualifying order has since been cancelled, the edit is
 *   REFUSED and the existing review is left exactly as it is. Not deleted. The
 *   customer wrote it while entitled, and destroying somebody's words because a
 *   staff member changed an order's status afterwards is the worse failure. A
 *   staff member who thinks it should go can unpublish it, with a reason, on
 *   the record.
 *
 * MODERATION TRIGGERS ON THE TEXT, NEVER ON THE SCORE — Reviews::classify().
 * A one-star review publishes immediately, exactly like a five-star one, and
 * raises a Warning so staff hear about it. See the note on the notification.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer = Auth::requireCustomer('Sign in to review a product.');

$in = Response::input();

$data = Validate::check($in)
    ->required('product_id', 'Product')
    ->required('rating', 'Rating')
    /* 1..5, refused rather than clamped. A 7 is a broken client or a hand-built
       request, and silently recording a 5 would put a number in the average
       that nobody chose. */
    ->int('rating', 'Rating', 1, 5)
    ->maxLen('comment', 1000, 'Comment')
    ->values();

$productId = (string) $data['product_id'];
$rating    = (int) $data['rating'];

/* Trimmed to null rather than kept as ''. A rating with no comment is the
   common case and should be one thing in the column, not two. */
$comment = trim((string) ($in['comment'] ?? ''));
if ($comment === '') { $comment = null; }

/* Archived products are deliberately NOT excluded — see the header. */
$product = Database::one('SELECT id, name FROM products WHERE id = ?', [$productId]);
if ($product === null) {
    Response::notFound('That product no longer exists.');
}

/* THE ENTITLEMENT. Scoped by the session's customer id, filtered on the order
   status, and joined to order_items so the product actually has to be in it.
   Earliest first: `order_id` is provenance, so it should name the purchase that
   first earned the right, not whichever one happens to sort first today. */
$qualifying = Database::one(
    'SELECT o.id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_id = ?
        AND oi.product_id = ?
        AND o.status = ?
      ORDER BY o.datetime ASC, o.id ASC
      LIMIT 1',
    [$customer['id'], $productId, 'completed']
);

$existing = Database::one(
    'SELECT id, order_id, status FROM product_reviews
      WHERE customer_id = ? AND product_id = ?',
    [$customer['id'], $productId]
);

if ($qualifying === null) {
    /* Two different situations, two different answers. Telling somebody who has
       never bought this that their review "can no longer be edited" would be
       nonsense; telling somebody mid-edit that they never bought it would be a
       lie. */
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

/* THE FILTER IS A KEYWORD LIST. Case-insensitive, on word boundaries, read from
   `settings`. It is not content classification: it will miss abuse and it will
   flag innocent text, which is exactly why what it does is put the review in
   front of a person rather than make a decision. */
$verdict = Reviews::classify($comment);

/* A review a moderator has already rejected does not quietly reappear because
   its author edited it. It re-enters the queue instead, so the same decision is
   made again by a person with the new text in front of them. */
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
        /* order_id is absent from the SET clause on purpose. Provenance.
           The moderation columns ARE cleared: they describe a decision about
           text that no longer exists, and leaving a stale reject_reason beside
           new words would misrepresent both the customer and the moderator. */
        Database::run(
            'UPDATE product_reviews
                SET rating = ?, comment = ?, status = ?, hold_reason = ?,
                    reject_reason = NULL, moderated_by = NULL, moderated_at = NULL
              WHERE id = ?',
            [$rating, $comment, $verdict['status'], $verdict['hold'], $existing['id']]
        );
    }

    /* Both columns, from PUBLISHED rows only. Held and rejected reviews are not
       in the average — a review nobody has cleared is not yet a rating. */
    $totals = Reviews::recompute($productId);

    /* LOW RATING => STAFF ARE TOLD. The review is already live at this point;
       this is early warning, not a gate. Something went wrong with a real,
       completed order and the people who could put it right should not have to
       find out by reading the shop page.

       Warning rather than critical: worth today's attention, not a stop-trading
       event. The level follows from the type and cannot be overridden here —
       see the note on Notify::create(). */
    if ($rating <= Reviews::LOW_RATING && $verdict['status'] === Reviews::PUBLISHED) {
        Notify::create(
            'review',
            sprintf('%s rated %s %d/5 on order %s.',
                $customer['name'], $product['name'], $rating, $qualifying['id']),
            ['product' => $productId, 'order' => $qualifying['id']]
        );
    }

    /* actor_user_id is NULL: the column is a users.id foreign key and a customer
       is not a staff member. Same shape as confirm-received.php. */
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

/* `held` is reported honestly rather than dressed up as success. A customer
   whose review is waiting should be told so plainly; one who is told "posted"
   and then cannot find it learns that the shop lies to them. The matched word
   is NOT returned — naming it turns the filter into a list to be probed. */
Response::ok([
    'product_id'   => $productId,
    'rating'       => $rating,
    'status'       => $verdict['status'],
    'held'         => $verdict['status'] !== Reviews::PUBLISHED,
    'edited'       => $existing !== null,
    'avg_rating'   => $totals['rating'],
    'review_count' => $totals['count'],
]);
