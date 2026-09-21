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

    /**
     * What each product sold in a period: units and revenue, ranked.
     *
     * ONE COPY. The Sales Report's "Best Sellers in Period" and the inventory
     * dashboard's "Product Rankings" ask the same question of the same rows and
     * differ only in what they order by — the report by revenue, because it is
     * deciding what earned; the dashboard by units, because it is deciding what
     * to reorder. Two hand-written copies of this query would agree on the day
     * they were written and drift the first time either was touched, which is
     * the failure this file exists to prevent.
     *
     * UNITS AND REVENUE ARE ON THE SAME CLOCK, and it is the money's.
     *
     * They were not, briefly, and the Units column paid for it. Revenue moved to
     * the payment's date when Net terms arrived; units stayed on the order's. A
     * Net 60 order placed in July and paid in September then showed September
     * revenue against ZERO September units — a best seller that sold nothing —
     * while the July report showed its units earning nothing. Both halves were
     * individually defensible and the row was unreadable.
     *
     * So a payment buys a SHARE of its order: the same proportion of each line's
     * units as of its money. ₱6,665 against a ₱13,330 order of 100 jars is 50
     * jars and half the revenue, in the period the money arrived. Paid in three
     * transfers, the jars arrive in three pieces too.
     *
     * A part-paid Net order therefore contributes a FRACTION of a jar per line.
     * Rounding is left to the caller and belongs at the end, once the pieces
     * have been added up — rounding each line first drifts the total away from
     * the units the order actually holds.
     *
     * @param ?string $from  YYYY-MM-DD, or null for no lower bound
     * @param ?string $to    YYYY-MM-DD, or null for no upper bound
     * @param string  $rank  'revenue' or 'units' — what to order by
     * @param int     $limit how many rows to return
     *
     * @return list<array{id:string, name:string, units:string, revenue:string}>
     */
    public static function productTotals(
        ?string $from,
        ?string $to,
        string $rank = 'revenue',
        int $limit = 10
    ): array {
        /* An identifier cannot be bound, so it is chosen from a whitelist and
           never interpolated from the request. */
        $order = $rank === 'units' ? 'units DESC, revenue DESC' : 'revenue DESC, units DESC';
        $limit = max(1, min(100, $limit));

        /* Part 1, dated by the order. */
        [$revClause, $params] = self::clause('o');
        $where = [$revClause];
        if ($from !== null) { $where[] = 'o.date >= ?'; $params[] = $from; }
        if ($to   !== null) { $where[] = 'o.date <= ?'; $params[] = $to; }
        $clause = 'WHERE ' . implode(' AND ', $where);

        /* Part 2, dated by the payment. */
        [$crClause] = self::creditClause('cp');
        $crWhere  = [$crClause];
        $crParams = [];
        if ($from !== null) { $crWhere[] = 'cp.paid_date >= ?'; $crParams[] = $from; }
        if ($to   !== null) { $crWhere[] = 'cp.paid_date <= ?'; $crParams[] = $to; }
        $crSql = 'WHERE ' . implode(' AND ', $crWhere);

        return Database::all(
            "SELECT p.id, p.name, SUM(x.units) AS units, SUM(x.revenue) AS revenue
               FROM (
                    SELECT oi.product_id, oi.qty AS units, oi.qty * oi.price_at_purchase AS revenue
                      FROM order_items oi JOIN orders o ON o.id = oi.order_id $clause
                    UNION ALL
                    SELECT oi.product_id,
                           oi.qty * cp.amount / NULLIF(lt.line_total, 0) AS units,
                           cp.amount * (oi.qty * oi.price_at_purchase) / NULLIF(lt.line_total, 0) AS revenue
                      FROM credit_payments cp
                      JOIN payment_accounts pa ON pa.id = cp.account_id
                      JOIN order_items oi ON oi.order_id = pa.order_id
                      JOIN (SELECT order_id, SUM(qty * price_at_purchase) AS line_total
                              FROM order_items GROUP BY order_id) lt ON lt.order_id = pa.order_id
                     $crSql
               ) x
               JOIN products p ON p.id = x.product_id
              GROUP BY p.id, p.name
              ORDER BY $order
              LIMIT $limit",
            array_merge($params, $crParams)
        );
    }
}
