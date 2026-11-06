<?php
declare(strict_types=1);

/** Revenue is the one definition of money received: completed non-credit orders count on the order date, and each verified Net-account payment counts on its own paid date (credit orders themselves never count); mirrored in JS by isRevenue()/receivedBetween() in engine.js. */
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

    /** Orders that count as revenue themselves (completed and not on credit), returned as [sql, params]. */
    public static function clause(string $alias = 'o'): array
    {
        $st = implode(',', array_fill(0, count(self::STATUSES), '?'));
        $cm = implode(',', array_fill(0, count(self::creditMethods()), '?'));
        return [
            "{$alias}.status IN ($st) AND {$alias}.method NOT IN ($cm)",
            array_merge(self::STATUSES, self::creditMethods()),
        ];
    }

    /** The Sales Report export's sale set, as [sql, params]: a completed order paid at the time, or a Net order once
        accepted (it committed stock). Shared by api/reports/sales-export.php and api/reports/net-income.php. */
    public static function saleClause(string $alias = 'o'): array
    {
        $credit = self::creditMethods();
        $ph     = implode(',', array_fill(0, count($credit), '?'));
        return [
            "(({$alias}.status = 'completed' AND {$alias}.method NOT IN ($ph))
              OR ({$alias}.method IN ($ph) AND {$alias}.status IN ('accepted','shipping','delivered','completed')))",
            array_merge($credit, $credit),
        ];
    }

    /** Net-account payments that are dated revenue: verified, and not legacy. */
    public static function creditClause(string $alias = 'cp'): array
    {
        return ["{$alias}.status = 'verified' AND {$alias}.source <> 'legacy'", []];
    }

    /** A customer's lifetime spend: paid-at-sale orders plus all verified Net payments; with a ? placeholder bind the id before and after the params. */
    public static function spendSql(string $customerExpr): array
    {
        [$c, $p] = self::clause('o');
        return [
            "((SELECT COALESCE(SUM(" . Payments::dueSql('o') . "), 0) FROM orders o
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

    /** The day a refund comes off revenue: when it was paid out (030), else the request date. */
    public static function refundDateSql(string $alias = 'r'): string
    {
        return Database::hasColumn('product_returns', 'processed_at')
            ? "DATE(COALESCE({$alias}.processed_at, {$alias}.received_date))"
            : "DATE({$alias}.received_date)";
    }

    /** Units and revenue per product for a period, ranked by revenue or units; a Net order's units are counted in proportion to its payments, in the period the money arrived. */
    public static function productTotals(
        ?string $from,
        ?string $to,
        string $rank = 'revenue',
        int $limit = 10
    ): array {
        /* The sort column comes from a whitelist, since identifiers cannot be bound. */
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
