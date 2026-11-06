<?php
declare(strict_types=1);

/** Notify is the single place staff notifications are created, with the level (critical = act now, warning = today, info = record) decided by type in one table here so all three screens agree. */
final class Notify
{
    public const CRITICAL = 'critical';
    public const WARNING  = 'warning';
    public const INFO     = 'info';

    /** Display order, worst first (also the FIELD() list used for sorting). */
    public const LEVELS = [self::CRITICAL, self::WARNING, self::INFO];

    /** Type to level map, including client-derived types (expiring batches, failed QA, payment schemes) that are sent to the browser so it has no second copy. */
    private const BY_TYPE = [
        /* Stored types (the notifications ENUM). */
        'inventory'     => self::CRITICAL,  // hit critical stock, or out of stock
        'new-order'     => self::WARNING,   // awaiting acceptance
        'payment'       => self::WARNING,   // awaiting verification
        'hold'          => self::WARNING,
        'return'        => self::WARNING,   // a request received, not yet judged
        'completed'     => self::INFO,
        'audit'         => self::INFO,
        /* A low customer rating is a warning (worth seeing today), not critical; the review is already published. */
        'review'        => self::WARNING,

        /* Derived pseudo-types, client-side only. */
        'expiry'        => self::WARNING,   // upgraded to critical once EXPIRED
        'batch-qa'      => self::WARNING,
        'scheme-due'    => self::WARNING,   // upgraded to critical once OVERDUE
        'sales-summary' => self::INFO,
    ];

    /** The level for a type, defaulting to info for unknown types so a misspelled type still gets raised. */
    public static function priorityFor(string $type): string
    {
        return self::BY_TYPE[$type] ?? self::INFO;
    }

    /** The whole table, for the client's derived rows. */
    public static function priorityMap(): array
    {
        return self::BY_TYPE;
    }

    /** SQL ordering used by all three screens: unread first, then urgency, then newest. */
    public static function orderBy(string $alias = 'n'): string
    {
        $levels = "'" . implode("','", self::LEVELS) . "'";
        return "{$alias}.is_read ASC, FIELD({$alias}.priority, {$levels}) ASC,
                {$alias}.created_at DESC, {$alias}.id DESC";
    }

    /** Create one notification and return its id; the level always comes from the type, never from the caller. */
    public static function create(string $type, string $message, array $links = []): string
    {
        $id = 'n-' . strtolower(bin2hex(random_bytes(5)));

        Database::run(
            'INSERT INTO notifications
                 (id, type, priority, order_id, return_id, product_id, message, created_at, is_read)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 0)',
            [
                $id,
                $type,
                self::priorityFor($type),
                $links['order']   ?? null,
                $links['return']  ?? null,
                $links['product'] ?? null,
                $message,
            ]
        );

        return $id;
    }

    /** Create a notification only if an identical unread message for that product does not already exist, preventing duplicates from simultaneous sales. */
    public static function createOnceWhileUnread(string $type, string $productId, string $message): ?string
    {
        $existing = Database::scalar(
            'SELECT COUNT(*) FROM notifications
              WHERE type = ? AND product_id = ? AND message = ? AND is_read = 0',
            [$type, $productId, $message]
        );

        if ((int) $existing > 0) {
            return null;
        }

        return self::create($type, $message, ['product' => $productId]);
    }

    /** Create a Critical notification for each expired batch still counted as stock, generated when the list is opened (no cron available), once per batch and dated on the expiry date. */
    public static function syncExpiredBatches(): int
    {
        /* The level is inserted directly (not bound) because it is an ENUM literal from the constant above, never user input. */
        $level = self::priorityFor('inventory');
        if (!in_array($level, self::LEVELS, true)) {
            throw new LogicException("Notify: refusing to write unknown priority '{$level}'.");
        }

        return Database::run(
            "INSERT INTO notifications
                 (id, type, priority, product_id, message, created_at, is_read)
             SELECT CONCAT('nx-', b.id), 'inventory', '{$level}', b.product_id,
                    CONCAT('Batch ', b.lot_code, ' (', p.name, ') expired on ',
                           DATE_FORMAT(b.expiry_date, '%b %e, %Y'), ' and still counts ',
                           b.remaining_qty, ' unit(s) as sellable stock.'),
                    TIMESTAMP(b.expiry_date), 0
               FROM batches b
               JOIN products p ON p.id = b.product_id
              WHERE b.remaining_qty > 0
                AND b.expiry_date < CURDATE()
                AND NOT EXISTS (
                      SELECT 1 FROM notifications n WHERE n.id = CONCAT('nx-', b.id)
                    )"
        );
    }

    /** Unread counts per level for the bell, always including all three levels even at zero. */
    public static function unreadByPriority(): array
    {
        $out = array_fill_keys(self::LEVELS, 0);

        foreach (Database::all(
            'SELECT priority, COUNT(*) AS n FROM notifications WHERE is_read = 0 GROUP BY priority'
        ) as $row) {
            $out[$row['priority']] = (int) $row['n'];
        }

        return $out;
    }
}
