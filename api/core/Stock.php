<?php
declare(strict_types=1);

/**
 * Stock — the one place that moves inventory.
 *
 * Same reasoning as Payments (I8), found by the Phase 4 duplicate-write sweep.
 * `products.stock` was written from five places with four different rules:
 *
 *   pos/checkout.php      stock = stock - ?, sold = sold + ?   AND stock >= ?
 *   orders/status.php     stock = stock - ?, sold = sold + ?   AND stock >= ?
 *   orders/status.php     stock = stock + ?, sold = GREATEST(sold - ?, 0)
 *   returns/advance.php   stock = stock + ?                    <-- no sold change
 *   inventory/adjust.php  stock = stock + ?                    AND stock + ? >= 0
 *
 * THE DRIFT THAT MATTERED
 * -----------------------
 * A CANCELLED order restores stock and decrements `sold`. A REFUNDED RETURN
 * restored stock and left `sold` alone — so a returned unit counted as sold for
 * ever. Two implementations of "the goods came back, reverse the sale", written
 * months apart, disagreeing about half of it.
 *
 * That is not cosmetic. `products.sold` drives:
 *   - the Fast / Slow / Non-Moving classification in products/list.php
 *     (>1000 / 200-1000 / <200), on the Inventory Report
 *   - the default "featured" sort on the public storefront (shop/products.php)
 *   - the "N sold" figure printed on every public product card
 *   - the Landing editor's Best Sellers ranking, and its revenue column, which
 *     is price x sold
 *
 * So a heavily returned product read as Fast Moving, sorted to the front of the
 * shop, and advertised its returns to customers as sales.
 *
 * Money already handled this correctly — reports/sales.php nets refunds out of
 * revenue. Units did not. The two ledgers disagreed.
 *
 * WHY A CLASS RATHER THAN A TIDY-UP
 * ---------------------------------
 * The rules are genuinely different per movement and that is the point: naming
 * them makes the difference deliberate instead of accidental. An adjustment is
 * not a sale and must not touch `sold`; a return is a reversed sale and must.
 *
 * Every method here MUST be called inside the caller's transaction. None of
 * them opens one, because stock only ever moves alongside something else — an
 * order, a return, an adjustment — and a stock movement that commits without
 * its reason is how inventory becomes permanently unexplainable.
 */

final class Stock
{
    /**
     * Goods leave: an order is committed, or a walk-in sale rings up.
     *
     * Returns the number of rows affected. **The caller must check it.** The
     * guard `AND stock >= ?` means a request for more than exists changes
     * nothing and returns 0 rather than driving stock negative — which is a
     * refusal the caller has to turn into a message naming the product, not a
     * silent no-op.
     */
    public static function sell(string $productId, int $qty): int
    {
        if ($qty < 1) {
            throw new InvalidArgumentException("Stock::sell needs a positive quantity, got {$qty}.");
        }

        /* Read the band BEFORE the movement. Every path that reduces stock goes
           through this method, which is why the alert is raised here rather
           than in pos/checkout.php and orders/status.php separately — two
           copies of a threshold rule is how the four stock-writing rules this
           class replaced came to disagree in the first place. */
        $before = Inventory::levelForProduct($productId);

        $rows = Database::run(
            'UPDATE products SET stock = stock - ?, sold = sold + ?
              WHERE id = ? AND stock >= ?',
            [$qty, $qty, $productId, $qty]
        );

        if ($rows > 0) {
            self::alertOnBandCrossing($productId, $before);
        }

        return $rows;
    }

    /**
     * Raise a Critical notification when a sale takes a product INTO the
     * critical or out-of-stock band.
     *
     * ON THE TRANSITION, NOT THE STATE. Firing whenever stock is low would put
     * a row in the bell for every jar sold of an already-critical product — on
     * a busy afternoon that is dozens of identical alerts, and a bell nobody
     * reads is worse than no bell, because it also buries the ones that matter.
     * Comparing the band on either side of the movement means one alert per
     * crossing, which is one alert per thing that actually changed.
     *
     * Crossing DOWNWARD only: 'ok' to 'crit' fires, and 'crit' to 'out' fires
     * again because running out is a different problem from running low. A sale
     * cannot move a product upward, so there is no other direction to consider.
     *
     * NOT FATAL. This runs inside the caller's transaction alongside the order
     * it belongs to, and an order must not be lost because the bell could not
     * be rung. A failure here is logged and the sale stands.
     */
    private static function alertOnBandCrossing(string $productId, ?string $before): void
    {
        try {
            $after = Inventory::levelForProduct($productId);
            if ($after !== 'crit' && $after !== 'out') {
                return;
            }
            if ($after === $before) {
                return;
            }

            $row = Database::one('SELECT name, stock FROM products WHERE id = ?', [$productId]);
            if ($row === null) {
                return;
            }

            $stock = (int) $row['stock'];
            $message = $after === 'out'
                ? sprintf('%s is out of stock — 0 units remaining.', $row['name'])
                : sprintf('%s has fallen to critical stock — %d unit(s) left.', $row['name'], $stock);

            /* 'inventory' maps to Critical in Notify's one table; the level is
               not passed from here, deliberately. */
            Notify::createOnceWhileUnread('inventory', $productId, $message);
        } catch (Throwable $e) {
            error_log('[elishabay] stock alert failed for ' . $productId . ': ' . $e->getMessage());
        }
    }

    /**
     * Goods come back and the sale is reversed: a cancellation, or a refunded
     * return.
     *
     * `sold` comes back down. GREATEST(…, 0) because `sold` is also seeded
     * demo data and a return against a pre-seed sale must not push it negative.
     *
     * No stock guard: adding stock cannot make it negative, and refusing to put
     * returned goods back on the shelf because of a race would lose them.
     */
    public static function reverseSale(string $productId, int $qty): void
    {
        if ($qty < 1) {
            throw new InvalidArgumentException("Stock::reverseSale needs a positive quantity, got {$qty}.");
        }

        Database::run(
            'UPDATE products SET stock = stock + ?, sold = GREATEST(sold - ?, 0)
              WHERE id = ?',
            [$qty, $qty, $productId]
        );
    }

    /**
     * A correction, not a sale: a restock, a delivery, spoilage, a stock count.
     *
     * `sold` is deliberately untouched — receiving 200 jars is not 200 sales,
     * and writing off spoilage is not 200 un-sales. This is the one movement
     * where leaving `sold` alone is correct, which is exactly why it needs its
     * own name rather than sharing one with the others.
     *
     * `$delta` is signed. The guard refuses a negative result rather than
     * clamping it: stock that would go below zero means the count is wrong, and
     * quietly writing 0 hides that.
     *
     * Returns rows affected; 0 means the adjustment was refused.
     */
    public static function adjust(string $productId, int $delta): int
    {
        if ($delta === 0) {
            throw new InvalidArgumentException('Stock::adjust needs a non-zero delta.');
        }

        return Database::run(
            'UPDATE products SET stock = stock + ? WHERE id = ? AND stock + ? >= 0',
            [$delta, $productId, $delta]
        );
    }
}
