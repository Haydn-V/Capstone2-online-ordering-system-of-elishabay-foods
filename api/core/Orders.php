<?php
declare(strict_types=1);

/** Orders runs automatic lifecycle rules, mainly completing delivered orders one hour after delivery if the customer never confirms, swept when orders are listed (or via api/system/auto-complete.php from a scheduler). */

final class Orders
{
    /** How long a delivered order waits for the customer before completing. */
    private const AUTO_COMPLETE_AFTER = '1 HOUR';

    /** How often the opportunistic sweep is allowed to do real work. */
    private const THROTTLE_SECONDS = 300;

    private const THROTTLE_KEY = 'autocomplete_last_run';

    /** SQL expression for the buyer TIN printed on a Sales Invoice: only a retailer's (from their newest approved partner application, matched by customer id or email); pass a column name or ? placeholder, never a value. */
    /** The order's tracking steps in order with reached steps marked (on-hold pauses the first step; cancelled reaches none). */
    public static function trackingSteps(string $status): array
    {
        $sequence = ['pending', 'accepted', 'shipping', 'delivered', 'completed'];
        $current  = $status === 'on-hold' ? 'pending' : $status;
        $reached  = array_search($current, $sequence, true);
        $out = [];
        foreach ($sequence as $i => $st) {
            $out[] = [
                'key'  => $st,
                'done' => $reached !== false && $i < $reached,
                'now'  => $reached !== false && $i === $reached,
            ];
        }
        return $out;
    }

    /** Name for the invoice's Cashier/Authorized Representative line: the cashier for walk-ins, the first processing staff member for online orders. */
    public static function cashierSql(string $alias): string
    {
        /* orders.cashier holds a users.id (FK); the invoice wants the name. */
        $own = "(SELECT cu.name FROM users cu WHERE cu.id = {$alias}.cashier)";
        if (!Database::hasTable('order_status_history')) {
            return $own;
        }
        return "COALESCE({$own},
                 (SELECT u.name FROM order_status_history h
                    JOIN users u ON u.id = h.changed_by
                   WHERE h.order_id = {$alias}.id
                   ORDER BY h.id LIMIT 1))";
    }

    public static function buyerTinSql(string $customerCol): string
    {
        return "(SELECT a.bir_tin
                   FROM customers bc
                   JOIN b2b_applications a
                     ON a.status = 'approved'
                    AND (a.customer_id = bc.id OR a.email = bc.email)
                  WHERE bc.id = {$customerCol}
                    AND (bc.status = 'retailer'
                         OR (bc.status = 'archived' AND bc.status_before_archive = 'retailer'))
                    AND a.bir_tin IS NOT NULL AND a.bir_tin <> ''
                  ORDER BY a.id DESC
                  LIMIT 1)";
    }

    /** buyerTinSql() for one customer id; null for anyone but a retailer. */
    public static function buyerTin(?string $customerId): ?string
    {
        if ($customerId === null || $customerId === '') {
            return null;
        }
        $tin = Database::scalar('SELECT ' . self::buyerTinSql('?'), [$customerId]);
        return ($tin === false || $tin === null || $tin === '') ? null : (string) $tin;
    }

    /** Complete every online order or walk-in delivery that has been delivered for over an hour, returning how many were moved. */
    public static function autoCompleteDelivered(): int
    {
        /* Read the orders first so audit rows can name each one, while the conditional UPDATE skips any order that changed in between. */
        $due = Database::all(
            "SELECT id, customer_name, delivered_at
               FROM orders
              WHERE status = 'delivered'
                AND (type = 'online' OR order_type = 'delivery')
                AND delivered_at IS NOT NULL
                AND delivered_at <= NOW() - INTERVAL " . self::AUTO_COMPLETE_AFTER
        );
        if ($due === []) {
            return 0;
        }

        $moved = 0;
        $pdo = Database::pdo();

        /* One transaction for the whole sweep, so orders and their audit rows land together or not at all. */
        $ownTransaction = !$pdo->inTransaction();
        if ($ownTransaction) {
            $pdo->beginTransaction();
        }

        try {
            foreach ($due as $o) {
                Database::run(
                    "UPDATE orders SET status = 'completed'
                      WHERE id = ? AND status = 'delivered'",
                    [$o['id']]
                );
                /* Conditional update, in case the customer presses Mark Received at the same moment. */
                if ((int) $pdo->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
                    continue;
                }
                $moved++;
                Returns::stampCompleted($o['id']);   /* starts the 24h return window */

                if (Database::hasTable('order_status_history')) {
                    Database::run(
                        'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
                         VALUES (?, ?, ?, NULL, ?)',
                        [$o['id'], 'delivered', 'completed',
                         'Auto-completed one hour after delivery.']
                    );
                }

                /* Logged as actor "System" with no user id, since no staff member did this. */
                Database::run(
                    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
                     VALUES (NOW(), ?, NULL, ?, ?)',
                    ['System', 'order',
                     sprintf('Order %s auto-completed — delivered %s, not confirmed within one hour.',
                         $o['id'], $o['delivered_at'])]
                );
            }

            if ($ownTransaction) {
                $pdo->commit();
            }
        } catch (Throwable $e) {
            if ($ownTransaction && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return $moved;
    }

    /** Throttled entry point (marker stored in settings) so the sweep runs at most periodically, and any error is logged instead of breaking the page. */
    public static function sweepIfDue(): int
    {
        try {
            $last = Database::scalar(
                'SELECT value_text FROM settings WHERE key_name = ?',
                [self::THROTTLE_KEY]
            );

            if ($last !== null && (time() - strtotime((string) $last)) < self::THROTTLE_SECONDS) {
                return 0;
            }

            /* Claim the run before doing the work so two requests do not both sweep. */
            Database::run(
                'INSERT INTO settings (key_name, value_text) VALUES (?, NOW())
                 ON DUPLICATE KEY UPDATE value_text = NOW()',
                [self::THROTTLE_KEY]
            );

            return self::autoCompleteDelivered();
        } catch (Throwable $e) {
            error_log('[orders] auto-complete sweep failed: ' . $e->getMessage());
            return 0;
        }
    }
}
