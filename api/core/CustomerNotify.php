<?php
declare(strict_types=1);

/** The customer's own bell notifications (migration 018), saved best-effort after the order change commits so a failed notification never undoes the order change. */
final class CustomerNotify
{
    private static ?bool $ready = null;

    public static function ready(): bool
    {
        return self::$ready ??= Database::hasTable('customer_notifications');
    }

    public static function push(string $customerId, string $type, string $title, string $message,
                                ?string $link = null, ?string $orderId = null, ?string $returnId = null): void
    {
        if (!self::ready() || $customerId === '') return;
        try {
            Database::run(
                'INSERT INTO customer_notifications
                     (customer_id, type, title, message, link, order_id, return_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
                [$customerId, $type, mb_substr($title, 0, 120), mb_substr($message, 0, 500),
                 $link, $orderId, $returnId]
            );
        } catch (Throwable $e) {
            error_log('[CustomerNotify] ' . $e->getMessage());
        }
    }

    /** An order moved to a new status (staff action). */
    public static function orderStatus(string $orderId, string $status, ?string $note = null): void
    {
        if (!self::ready()) return;
        $customerId = (string) (Database::scalar('SELECT customer_id FROM orders WHERE id = ?', [$orderId]) ?: '');
        if ($customerId === '') return;   /* walk-in sale with no account */

        [$title, $msg] = match ($status) {
            'accepted'  => ['Order confirmed',    "Your order #$orderId has been confirmed and is being prepared."],
            'shipping'  => ['Order on its way',   "Your order #$orderId has been shipped."],
            'delivered' => ['Order delivered',    "Your order #$orderId has been delivered. Tap Order Received once you have it."],
            'completed' => ['Order completed',    "Your order #$orderId is complete. You can request a return within 24 hours if something is wrong."],
            'on-hold'   => ['Order on hold',      "Your order #$orderId is on hold." . ($note ? " Reason: $note" : ' We will contact you.')],
            'cancelled' => ['Order cancelled',    "Your order #$orderId was cancelled." . ($note ? " Reason: $note" : '')],
            default     => [null, null],
        };
        if ($title === null) return;
        self::push($customerId, 'order', $title, $msg, 'profile/my-orders.html', $orderId);
    }

    /** Staff checked the payment proof. */
    public static function payment(string $orderId, bool $verified): void
    {
        if (!self::ready()) return;
        $customerId = (string) (Database::scalar('SELECT customer_id FROM orders WHERE id = ?', [$orderId]) ?: '');
        if ($customerId === '') return;
        self::push($customerId, 'payment',
            $verified ? 'Payment verified' : 'Payment not verified',
            $verified ? "We received your payment for order #$orderId. Thank you!"
                      : "We could not verify the payment for order #$orderId. Please check your reference or contact us.",
            'profile/dashboard.html', $orderId);
    }

    /** Retailer payment reminders (3 days before, day before, due day, overdue), created when the customer's bell loads and sent at most once per stage per account. */
    public static function dueReminders(string $customerId): void
    {
        if (!self::ready() || $customerId === '' || !Database::hasTable('payment_accounts')) return;
        try {
            $rows = Database::all(
                Payments::accountSelect() . ' WHERE pa.customer_id = ? AND pa.paid = 0
                   AND pa.due_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)',
                [$customerId]
            );
            foreach ($rows as $r) {
                $f = Payments::figures((float) $r['balance'], (float) $r['paid_amt'],
                    (float) $r['paid_by_due'], (float) $r['pending_amt'], (int) $r['days_past_due']);
                if ($f['settled'] || $f['payable'] <= 0) continue;   /* paid, or proof awaiting review */

                $d = $f['daysUntilDue'];
                $title = match (true) {
                    $d < 0   => 'Payment overdue',
                    $d === 0 => 'Payment due today',
                    $d === 1 => 'Payment due tomorrow',
                    default  => 'Payment due in 3 days',
                };
                $orderId = (string) ($r['order_id'] ?? '');
                $link = 'profile/my-payments.html#' . $r['id'];
                $sent = Database::scalar(
                    'SELECT 1 FROM customer_notifications
                      WHERE customer_id = ? AND type = ? AND title = ? AND link = ?',
                    [$customerId, 'payment', $title, $link]
                );
                if ($sent) continue;

                $amt  = '₱' . number_format($f['payable'], 2);
                $due  = date('j M Y', strtotime((string) $r['due_date']));
                $ref  = $orderId !== '' ? " for order #$orderId" : '';
                $msg  = $d < 0
                    ? "Your {$r['scheme']} balance of $amt$ref was due on $due. Please pay now to avoid further penalties."
                    : "Your {$r['scheme']} balance of $amt$ref is due on $due. Pay on time to avoid a late penalty.";
                self::push($customerId, 'payment', $title, $msg, $link,
                    $orderId !== '' ? $orderId : null);
            }
        } catch (Throwable $e) {
            error_log('[CustomerNotify] dueReminders ' . $e->getMessage());
        }
    }

    /** A return request moved through the staff pipeline. */
    public static function returnStatus(string $returnId, string $status, ?string $reason = null): void
    {
        if (!self::ready()) return;
        $r = Database::one('SELECT customer_id, order_id FROM product_returns WHERE id = ?', [$returnId]);
        if (!$r || empty($r['customer_id'])) return;

        [$title, $msg] = match ($status) {
            'validated', 'eligible' => ['Return under review', "Your return request #$returnId is being reviewed."],
            'approved'   => ['Return approved',  "Your return request #$returnId was approved. Your refund is being prepared."],
            'processed'  => ['Refund sent',      "Your refund for request #$returnId has been sent. View the receipt in Returns & Refunds."],
            'ineligible', 'rejected' => ['Return not accepted',
                             "Your return request #$returnId was not accepted." . ($reason ? " Reason: $reason" : '')],
            default      => [null, null],
        };
        if ($title === null) return;
        self::push((string) $r['customer_id'], 'return', $title, $msg,
            'profile/my-orders.html#returns', $r['order_id'], $returnId);
    }
}
