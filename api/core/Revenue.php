<?php
declare(strict_types=1);

/**
 * Revenue — the one definition of money the business has received.
 *
 * D2 made "completed orders only" the rule, so pending and on-hold orders
 * stopped counting as earnings. That was right for a sale paid at the time and
 * wrong for one sold on Net 30/60/90 terms: a completed Net 60 order counted its
 * whole total on the day it was placed, whether or not a peso had arrived, and
 * the Sales Report could not be matched against a retailer's own receipts.
 *
 * Since 2026-09-11 revenue has two parts:
 *
 *   1. ORDERS PAID AT THE TIME — completed, and not on credit terms. Counted on
 *      the order's date, for its total. Unchanged.
 *   2. PAYMENTS TOWARD NET ACCOUNTS — each VERIFIED row in credit_payments,
 *      counted on its own paid_date, for its own amount. A ₱13,330 Net 60 order
 *      paid in three transfers is three amounts on three dates.
 *
 * A credit ORDER never counts as revenue; its payments do.
 *
 * LEGACY payments (settled before payment tracking existed — migration 013)
 * are excluded from DATED revenue: when that money arrived was never recorded,
 * and inventing a date would put it into a month it may not belong to. They do
 * count toward a customer's lifetime spend, which has no date.
 *
 * Every reader of revenue — reports/sales.php, the dashboard, customer spend and
 * the orders list — uses this class. The JavaScript mirror is isRevenue() plus
 * receivedBetween() in assets/js/portal/engine.js.
 */
final class Revenue
{
    /** Order statuses that count, for an order paid at the time. */
    public const STATUSES = ['completed'];

    /** Return statuses that count as money paid back out. */
    public const REFUNDED_STATUSES = ['processed'];

    /** Methods whose ORDERS are not revenue — their payments are. */
    public static function creditMethods(): array
    {
        return array_keys(Payments::CREDIT);
    }

    /**
     * Orders that are revenue in themselves: completed, and not on credit
     * terms. Returns [sql, params] against `$alias`.
     */
    public static function clause(string $alias = 'o'): array
    {
        $st = implode(',', array_fill(0, count(self::STATUSES), '?'));
        $cm = implode(',', array_fill(0, count(self::creditMethods()), '?'));
        return [
            "{$alias}.status IN ($st) AND {$alias}.method NOT IN ($cm)",
            array_merge(self::STATUSES, self::creditMethods()),
        ];
    }

    /** Net-account payments that are dated revenue: verified, and not legacy. */
    public static function creditClause(string $alias = 'cp'): array
    {
        return ["{$alias}.status = 'verified' AND {$alias}.source <> 'legacy'", []];
    }

    /**
     * A customer's lifetime spend: orders paid at the time, plus every verified
     * payment toward their Net accounts (legacy included — that money arrived).
     * `$customerExpr` is the SQL naming the customer id: a column such as
     * `c.id`, or `?` — in which case bind the id before AND after the params.
     */
    public static function spendSql(string $customerExpr): array
    {
        [$c, $p] = self::clause('o');
        return [
            "((SELECT COALESCE(SUM(o.total), 0) FROM orders o
                WHERE o.customer_id = {$customerExpr} AND $c)
              + (SELECT COALESCE(SUM(cp.amount), 0) FROM credit_payments cp
                  WHERE cp.customer_id = {$customerExpr} AND cp.status = 'verified'))",
            $p,
        ];
    }

    public static function refundClause(string $alias = 'r'): array
    {
        $ph = implode(',', array_fill(0, count(self::REFUNDED_STATUSES), '?'));
        return ["{$alias}.status IN ($ph)", self::REFUNDED_STATUSES];
    }
}
