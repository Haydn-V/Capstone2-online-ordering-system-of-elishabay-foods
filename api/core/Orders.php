<?php
declare(strict_types=1);

/**
 * Orders — order-lifecycle rules that run without anybody pressing anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Scope promises that a delivered order becomes completed one hour later if
 * the customer never confirms receipt. Nothing scheduled that, and there was no
 * record of when an order became delivered to measure the hour from — see
 * db/migrations/006 for the column.
 *
 * A SWEEP, NOT A CRON
 * -------------------
 * XAMPP ships no scheduler, and a capstone that only behaves correctly on a
 * machine where somebody remembered to configure Windows Task Scheduler is a
 * capstone that does not behave correctly. So the rule runs opportunistically:
 * any request that lists orders sweeps first.
 *
 * That is not free, which is why it is throttled — see below. And it is not the
 * only way in: api/system/auto-complete.php calls the same function, so a real
 * deployment can attach it to a scheduler and get punctual completion instead
 * of completion-on-next-page-load. Both routes run this one implementation.
 *
 * WHAT "ONE HOUR" MEANS
 * ---------------------
 * Measured in SQL against NOW(), never against a PHP timestamp. Due dates,
 * overdue days and this all have to agree, and the database clock is the one
 * they already share (D1 — the same reason isOverdue() was moved server-side
 * after it spent two months frozen against a hardcoded date).
 */

final class Orders
{
    /** How long a delivered order waits for the customer before completing. */
    private const AUTO_COMPLETE_AFTER = '1 HOUR';

    /** How often the opportunistic sweep is allowed to do real work. */
    private const THROTTLE_SECONDS = 300;

    private const THROTTLE_KEY = 'autocomplete_last_run';

    /**
     * Complete every online order delivered more than an hour ago.
     *
     * Returns the number moved. Safe to call on every request — see
     * sweepIfDue(), which is what the list endpoints actually call.
     *
     * WALK-IN ORDERS ARE EXCLUDED. A walk-in is completed at the till by
     * pos/checkout.php the moment it is paid; one sitting at `delivered` is a
     * delivery a cashier rang up, and the same customer-confirmation rule
     * applies — but `type = 'online'` is what the Scope describes, and widening
     * a rule beyond what was asked for is how a sweep starts closing orders
     * somebody was still working on.
     */
    public static function autoCompleteDelivered(): int
    {
        /* Read first, then update: the audit and history rows need to name the
           orders individually, and doing the UPDATE first would leave nothing
           to name. The window between the two is closed by the conditional
           UPDATE — an order that changes in between simply does not match. */
        $due = Database::all(
            "SELECT id, customer_name, delivered_at
               FROM orders
              WHERE status = 'delivered'
                AND type = 'online'
                AND delivered_at IS NOT NULL
                AND delivered_at <= NOW() - INTERVAL " . self::AUTO_COMPLETE_AFTER
        );
        if ($due === []) {
            return 0;
        }

        $moved = 0;
        $pdo = Database::pdo();

        /* One transaction for the sweep, not one per order: either the batch
           lands with all its audit rows or none of it does. A partial sweep
           that completed three orders and logged one is worse than a sweep that
           did not run. */
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
                /* Conditional, because the customer may be pressing Mark
                   Received at this exact moment (api/shop/confirm-received.php).
                   Either outcome is correct; this one just declines to double-
                   count it. */
                if ((int) $pdo->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
                    continue;
                }
                $moved++;

                if (Database::hasTable('order_status_history')) {
                    Database::run(
                        'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
                         VALUES (?, ?, ?, NULL, ?)',
                        [$o['id'], 'delivered', 'completed',
                         'Auto-completed one hour after delivery.']
                    );
                }

                /* actor "System", actor_user_id NULL. Nobody did this, and
                   attributing it to whichever staff member happened to load a
                   page would make the audit trail actively misleading. */
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

    /**
     * The throttled entry point the list endpoints call.
     *
     * Without a throttle this runs its SELECT on every order-list request from
     * every staff member and every customer — a query per page view for a rule
     * that can only fire once an hour per order.
     *
     * The marker lives in `settings` rather than a file: the application's
     * database user has no filesystem grants and should not need any, and a
     * timestamp in a file is one more thing that can be out of step with the
     * data it describes.
     *
     * Never throws into a request. This is a background rule riding on someone
     * else's page load; a failure here must not turn their order list into a
     * 500. It is logged and the request continues.
     */
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

            /* Claimed before the work, not after. Two requests arriving together
               would otherwise both read a stale marker and both sweep; the
               second finds nothing to do, but it still pays for the query. */
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
