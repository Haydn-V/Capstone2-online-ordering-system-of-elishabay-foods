<?php
declare(strict_types=1);

/**
 * Reviews — the keyword filter and the rating recompute, in one place.
 *
 * Both rules are read by more than one endpoint: review-save.php runs the
 * filter on create AND on edit, and the rating has to be recomputed on save, on
 * publish, on reject and on unpublish. Four call sites for one formula is how
 * `products.sold` came to disagree with itself before Stock was extracted, and
 * REMEDIATION.md is largely a record of that pattern.
 *
 * BE ACCURATE ABOUT WHAT THE FILTER IS. It is a case-insensitive keyword match
 * on word boundaries. It is not content classification, it does not understand
 * context, and it will both miss abuse and flag innocent text. It exists to put
 * a small number of reviews in front of a person, not to make a judgement.
 */
final class Reviews
{
    /** Held for a person to look at. */
    public const PENDING   = 'pending';
    /** Live on the product page, and counted in the average. */
    public const PUBLISHED = 'published';
    /** Refused, with a stated reason. Never counted. */
    public const REJECTED  = 'rejected';

    /** A rating at or below this notifies staff — see review-save.php. */
    public const LOW_RATING = 2;

    /**
     * The flag list, from `settings`.
     *
     * NOT a constant in this file. A hard-coded list cannot be changed without
     * a deploy, and the people who need to change it are not the people who
     * deploy — the same argument that put penalty_rate in `settings`.
     *
     * @return string[] lower-cased, empty entries dropped
     */
    public static function flagWords(): array
    {
        $raw = Database::scalar(
            'SELECT value_text FROM settings WHERE key_name = ?',
            ['review_flag_words']
        );
        if (!is_string($raw) || trim($raw) === '') {
            return [];
        }
        return array_values(array_filter(array_map(
            static fn(string $w): string => strtolower(trim($w)),
            explode(',', $raw)
        ), static fn(string $w): bool => $w !== ''));
    }

    /**
     * Does this comment trip the keyword filter? Returns the word that matched,
     * or null.
     *
     * WORD BOUNDARIES, NOT SUBSTRINGS. A plain `str_contains` would flag
     * "classic" for containing a three-letter word, and "Scunthorpe" is the
     * canonical example of why that is unacceptable. `\b` on both sides means a
     * flagged word only matches when it stands alone.
     *
     * The matched word is returned rather than a boolean so `hold_reason` can
     * name it and the staff queue can show the moderator WHY a review is in
     * front of them — "held: keyword" with no keyword is not reviewable.
     */
    public static function flagged(?string $comment): ?string
    {
        $text = trim((string) $comment);
        if ($text === '') {
            return null;
        }
        foreach (self::flagWords() as $word) {
            $pattern = '/\b' . preg_quote($word, '/') . '\b/iu';
            if (preg_match($pattern, $text) === 1) {
                return $word;
            }
        }
        return null;
    }

    /**
     * Recompute `products.rating` and `products.review_count` from PUBLISHED
     * reviews, and write both.
     *
     * WHY THE COLUMN STAYS. `products.rating` is read by the shop cards, the
     * product detail, the `rating` sort in shop/products.php and the portal's
     * Best Sellers table. Replacing it with a JOIN at every read would be four
     * edits for no gain; keeping it and writing it from evidence means every
     * existing reader keeps working and starts telling the truth.
     *
     * WHY review_count IS NOT OPTIONAL. Without it a product with no reviews
     * still renders whatever is in `rating` — which is how every seeded product
     * came to advertise 4.9 stars it never earned. The count is what lets every
     * surface say "No ratings yet" instead of inventing a score, and that is the
     * entire point of this feature.
     *
     * Zero reviews resets the rating to 0.00 rather than leaving the seeded
     * value standing. A reader that checks the count never sees it; one that
     * forgets to check sees 0, which is visibly wrong rather than plausibly
     * wrong.
     */
    public static function recompute(string $productId): array
    {
        $row = Database::one(
            'SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg_rating
               FROM product_reviews
              WHERE product_id = ? AND status = ?',
            [$productId, self::PUBLISHED]
        );

        $count = (int) ($row['n'] ?? 0);
        $avg   = $count > 0 ? round((float) $row['avg_rating'], 2) : 0.00;

        Database::run(
            'UPDATE products SET rating = ?, review_count = ? WHERE id = ?',
            [$avg, $count, $productId]
        );

        return ['rating' => $avg, 'count' => $count];
    }

    /**
     * The status a comment should be saved with.
     *
     * MODERATION TRIGGERS ON THE TEXT, NEVER ON THE SCORE. A one-star review
     * publishes exactly like a five-star one; it is a signal that something
     * went wrong with a real order, not a safety problem, and holding it back
     * would delay the business learning about a genuine defect while making the
     * product look better than it is. The low-rating response is a staff
     * notification, raised by review-save.php — early warning without anything
     * appearing suppressed.
     *
     * @return array{status:string, hold:?string}
     */
    public static function classify(?string $comment): array
    {
        $word = self::flagged($comment);
        return $word === null
            ? ['status' => self::PUBLISHED, 'hold' => null]
            : ['status' => self::PENDING,   'hold' => 'keyword: ' . $word];
    }
}
