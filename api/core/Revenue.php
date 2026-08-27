<?php
declare(strict_types=1);

/**
 * What counts as revenue — one definition, used everywhere.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The system had three different answers to "what is revenue?", all of them
 * `status <> 'cancelled'` written out by hand in a different file:
 *
 *   reports/sales.php      the Sales Report headline figures
 *   orders/list.php        the filtered-revenue meta on every order list
 *   customers/list.php     lifetime spend per customer
 *   customers/save.php     the same, recomputed after an edit
 *
 * Four copies of a business rule is four chances to change three of them. It
 * had already gone wrong once: the Sales Report filtered by date and not by
 * status at all, so every period containing a cancellation was overstated.
 *
 * WHAT CHANGED, AND WHY THE NUMBER MOVES
 * --------------------------------------
 * `status <> 'cancelled'` counts a great deal that is not revenue. An order
 * sitting at `pending` has not been paid. One at `on-hold` has a payment
 * problem — that is usually exactly why it is on hold. `accepted` and
 * `shipping` mean goods have not reached the customer. Booking all of those as
 * earnings is the accounting equivalent of counting a quotation as a sale.
 *
 * Revenue is now the terminal, paid, fulfilled state and nothing else:
 * `completed`. Note that `delivered` is NOT terminal — the transition map in
 * orders/status.php moves `delivered` on to `completed`, so counting it would
 * book the same order twice across a period boundary.
 *
 * This makes reported revenue LOWER than it was, by design. The previous figure
 * included money nobody had received.
 *
 * RETURNS
 * -------
 * Returns are never netted silently into the revenue figure. A report shows the
 * gross figure and the refunds as a separate subtracted line, because "we sold
 * ₱60,000 and refunded ₱4,000" and "we made ₱56,000" describe very different
 * businesses and only the first is actionable.
 */
final class Revenue
{
    /**
     * Order statuses that count as earned revenue.
     *
     * If you add a status to the orders enum, decide explicitly whether it
     * belongs here. The default answer is no.
     */
    public const STATUSES = ['completed'];

    /**
     * Return statuses whose refund has actually been paid out. A return that is
     * merely `received` or `approved` has cost nothing yet.
     */
    public const REFUNDED_STATUSES = ['processed'];

    /**
     * SQL fragment for the revenue filter, e.g. "o.status IN (?)".
     * Returns the clause; push the values onto your params in the same order.
     *
     * @param string $alias table alias used in the query
     * @return array{0:string,1:array<int,string>} [clause, params]
     */
    public static function clause(string $alias = 'o'): array
    {
        $ph = implode(',', array_fill(0, count(self::STATUSES), '?'));
        return ["{$alias}.status IN ($ph)", self::STATUSES];
    }

    /** Same, for refunds against product_returns. */
    public static function refundClause(string $alias = 'r'): array
    {
        $ph = implode(',', array_fill(0, count(self::REFUNDED_STATUSES), '?'));
        return ["{$alias}.status IN ($ph)", self::REFUNDED_STATUSES];
    }
}
