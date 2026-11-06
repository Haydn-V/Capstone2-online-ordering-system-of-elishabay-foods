<?php
declare(strict_types=1);

/** Reviews: the keyword filter (a simple word-boundary match that only flags reviews for a person to check) and the rating recompute, kept in one place for every endpoint. */
final class Reviews
{
    /** Held for a person to look at. */
    public const PENDING   = 'pending';
    /** Live on the product page, and counted in the average. */
    public const PUBLISHED = 'published';
    /** Rejected with a stated reason and never counted. */
    public const REJECTED  = 'rejected';

    /** A rating at or below this notifies staff — see review-save.php. */
    public const LOW_RATING = 2;

    /** The flagged-word list comes from settings so staff can change it without a deploy. */
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

    /** Return the flagged word a comment contains (or null), matching whole words only so innocent words are not flagged. */
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

    /** Recompute products.rating and products.review_count from published reviews only, so products with no reviews show "No ratings yet" instead of a made-up score. */
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

    /** Status a review is saved with: held only for flagged text, never for a low score (low ratings notify staff instead). */
    public static function classify(?string $comment): array
    {
        $word = self::flagged($comment);
        return $word === null
            ? ['status' => self::PUBLISHED, 'hold' => null]
            : ['status' => self::PENDING,   'hold' => 'keyword: ' . $word];
    }
}
