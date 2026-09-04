<?php
declare(strict_types=1);

/**
 * Notify — the one place that raises a notification.
 *
 * Same reasoning as Stock (I8) and Payments: `INSERT INTO notifications` was
 * open-coded at three call sites, each spelling the id the same way by
 * coincidence and each free to choose its own columns. Adding `priority` to
 * that arrangement would have meant three independent opinions about how much
 * an event matters, which is the thing the column exists to prevent.
 *
 * THE LEVELS
 * ----------
 * Three, and they are named in the interface rather than being an internal
 * rank, because staff have to act on the difference:
 *
 *   critical  needs action now; money or stock is at risk
 *   warning   needs attention today
 *   info      a record of something that happened
 *
 * THE MAPPING IS NOT CONFIRMED WITH THE ADVISER. It is the group's reading and
 * it lives HERE, once, so that changing it is one edit with a diff. Anything
 * that disagrees with this table is a bug in the caller, not a local override —
 * there is deliberately no way to pass an arbitrary level to create().
 *
 * WHY NOT DERIVE IT IN THE BROWSER. Three screens read these rows — the bell,
 * the dashboard's System Notifications panel and the Notifications module — and
 * a rule living in one screen's script is a rule the other two do not have.
 * It also has to survive paging: "unread first, then by urgency, then newest"
 * is an ORDER BY, and a client cannot order rows it has not been sent.
 */
final class Notify
{
    public const CRITICAL = 'critical';
    public const WARNING  = 'warning';
    public const INFO     = 'info';

    /** Display order, worst first. Also the FIELD() list used to sort. */
    public const LEVELS = [self::CRITICAL, self::WARNING, self::INFO];

    /**
     * type => level.
     *
     * The keys past 'audit' are NOT in the notifications ENUM. They are the
     * pseudo-types the portal derives client-side from live records — expiring
     * batches, failed QA lots, retailer payment schemes — which have no row of
     * their own but appear in the same three lists and must sort against the
     * stored rows on the same scale. They are served to the browser by
     * list.php's meta so the client has no second copy of this table.
     */
    private const BY_TYPE = [
        /* Stored types (the notifications ENUM). */
        'inventory'     => self::CRITICAL,  // hit critical stock, or out of stock
        'new-order'     => self::WARNING,   // awaiting acceptance
        'payment'       => self::WARNING,   // awaiting verification
        'hold'          => self::WARNING,
        'return'        => self::WARNING,   // a request received, not yet judged
        'completed'     => self::INFO,
        'audit'         => self::INFO,
        /* A customer left a low rating on a real, completed order. Warning, not
           critical: it is a real problem worth hearing about today, not one
           that stops the shop trading. The review itself is already published
           — this is the early warning, not a moderation queue item. */
        'review'        => self::WARNING,

        /* Derived pseudo-types, client-side only. */
        'expiry'        => self::WARNING,   // upgraded to critical once EXPIRED
        'batch-qa'      => self::WARNING,
        'scheme-due'    => self::WARNING,   // upgraded to critical once OVERDUE
        'sales-summary' => self::INFO,
    ];

    /**
     * The level an event of this type carries.
     *
     * Unknown types fall to INFO rather than throwing: a notification that
     * arrives at the wrong urgency is a nuisance, one that fails to be raised
     * at all because a type was misspelled is a thing nobody is told about.
     */
    public static function priorityFor(string $type): string
    {
        return self::BY_TYPE[$type] ?? self::INFO;
    }

    /** The whole table, for the client's derived rows. */
    public static function priorityMap(): array
    {
        return self::BY_TYPE;
    }

    /**
     * SQL that orders a notification list the way all three screens show it:
     * unread first, then by urgency, then newest.
     *
     * Unread outranks urgency deliberately. A critical alert somebody has
     * already dealt with should not sit above the thing that just happened —
     * read state is shared across the team (see notifications/read.php), so
     * "read" means somebody handled it, not "I glanced at it".
     */
    public static function orderBy(string $alias = 'n'): string
    {
        $levels = "'" . implode("','", self::LEVELS) . "'";
        return "{$alias}.is_read ASC, FIELD({$alias}.priority, {$levels}) ASC,
                {$alias}.created_at DESC, {$alias}.id DESC";
    }

    /**
     * Raise one notification.
     *
     * `$priority` is not a parameter. The level follows from the type, and a
     * caller able to override it is a caller able to disagree with the table
     * above — which is how the three screens started disagreeing in the first
     * place. If an event needs a different level it needs a different type.
     *
     * Returns the id, so a caller can reference the row it just made.
     *
     * @param array{order?:?string,return?:?string,product?:?string} $links
     */
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

    /**
     * Raise one notification only if the same unread one is not already
     * standing against that product.
     *
     * Stock::sell() fires on the TRANSITION into a band, so it should not need
     * this — but two concurrent sales can both observe the same crossing and
     * would then write the same alert twice.
     *
     * THE KEY IS THE MESSAGE, NOT THE PRODUCT. Keying on type + product alone
     * was tried and is wrong in a way that matters: it swallowed the
     * critical → out-of-stock alert, because the critical one raised minutes
     * earlier was still unread. Running out is a different problem from running
     * low — it is the point at which the product stops earning — and it has to
     * arrive as its own alert. The two messages differ, the two concurrent
     * writes of one crossing do not, so the message is exactly the right
     * discriminator.
     *
     * `is_read = 0` in the key means a fresh alert IS raised once somebody has
     * dealt with the previous one, which is the whole point of read state being
     * shared across the team.
     *
     * Returns the new id, or null when an unread one already says this.
     */
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

    /**
     * Raise a Critical notification for every batch that has already expired
     * and is still counted as sellable stock.
     *
     * WHY THIS IS NOT A SCHEDULER, AND WHY IT IS SAFE.
     * -----------------------------------------------
     * Expiry is the one event on the Critical list with no user action behind
     * it: a lot goes bad because a date passed, and there is no request to hang
     * a producer off. XAMPP has no cron and the MySQL event scheduler is off by
     * default, so a background job would be a piece of infrastructure the
     * project does not have and could not be relied on to be running during a
     * defence.
     *
     * Instead the rows are materialised lazily, when somebody opens the list
     * they would appear in. api/shop/cart.php already does exactly this — a GET
     * that reconciles what it is about to return and writes the result back —
     * so the pattern is established here rather than invented.
     *
     * IDEMPOTENT BY CONSTRUCTION. The id is derived from the batch id, and the
     * NOT EXISTS clause keys on it, so a batch gets one row however many times
     * this runs and marking it read does not resurrect it. One statement, no
     * PHP loop, nothing to half-apply.
     *
     * created_at is the EXPIRY DATE, not now. The event happened when the lot
     * went bad; stamping it with the moment it was noticed would make an old
     * problem look like a new one, and would reshuffle the feed on every page
     * load. Ordering is unaffected either way, because unread + critical puts
     * it at the top regardless.
     *
     * The 30-day "expiring soon" Warning is deliberately NOT stored. It is
     * still derived in the browser from BATCHES, where it can recount days
     * against today without a write; only the crossing into EXPIRED — the point
     * at which stock on the shelf becomes unsellable — earns a durable row.
     */
    public static function syncExpiredBatches(): int
    {
        /* Interpolated, not bound: an ENUM literal cannot be a placeholder in
           the SELECT list without MySQL widening the column to text. It comes
           from the constant above and is asserted to be one of the three
           levels, so there is no caller input anywhere near this string. */
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

    /**
     * Unread counts per level, for the topbar bell.
     *
     * Every level is present in the result even at zero, so the client can read
     * `counts.critical` without guarding for a missing key — an absent key and
     * a zero mean the same thing here and only one of them is safe to render.
     *
     * @return array{critical:int,warning:int,info:int}
     */
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
