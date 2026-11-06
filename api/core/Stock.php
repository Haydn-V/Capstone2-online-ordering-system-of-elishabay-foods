<?php
declare(strict_types=1);

/** Stock is the only place inventory moves, with named rules per movement (a sale changes stock and sold, a reversal restores both, an adjustment changes stock only), always inside the caller's transaction. */

final class Stock
{
    /* Lot tracking (migration 028): which batch every sold unit came from. Skipped until the table exists. */
    private static ?bool $lotsReady = null;

    public static function lotsReady(): bool
    {
        return self::$lotsReady ??= Database::hasTable('order_item_lots');
    }

    /** Take $qty units of a product from its lots, earliest expiry first (lots that failed lab testing are skipped),
        lowering each lot's remaining count and recording the lots against the order. Units not in any lot are recorded
        with no lot code. Call inside the caller's transaction, right after a successful sell(). */
    public static function allocateLots(string $orderId, string $productId, int $qty): void
    {
        if ($qty < 1 || !self::lotsReady()) {
            return;
        }
        $left = $qty;
        foreach (Database::all(
            "SELECT id, lot_code, remaining_qty FROM batches
              WHERE product_id = ? AND remaining_qty > 0 AND lab_status <> 'failed'
              ORDER BY expiry_date ASC, production_date ASC, id ASC
              FOR UPDATE",
            [$productId]
        ) as $b) {
            if ($left <= 0) { break; }
            $take = min($left, (int) $b['remaining_qty']);
            Database::run('UPDATE batches SET remaining_qty = remaining_qty - ? WHERE id = ?', [$take, $b['id']]);
            Database::run('INSERT INTO order_item_lots (order_id, product_id, lot_code, qty) VALUES (?, ?, ?, ?)',
                [$orderId, $productId, $b['lot_code'], $take]);
            $left -= $take;
        }
        if ($left > 0) {
            Database::run('INSERT INTO order_item_lots (order_id, product_id, lot_code, qty) VALUES (?, ?, NULL, ?)',
                [$orderId, $productId, $left]);
        }
    }

    /** Put a cancelled order's units back into the lots they came from and forget the allocation. */
    public static function releaseLots(string $orderId): void
    {
        if (!self::lotsReady()) {
            return;
        }
        foreach (Database::all('SELECT lot_code, qty FROM order_item_lots WHERE order_id = ? AND lot_code IS NOT NULL', [$orderId]) as $r) {
            Database::run('UPDATE batches SET remaining_qty = remaining_qty + ? WHERE lot_code = ?', [(int) $r['qty'], $r['lot_code']]);
        }
        Database::run('DELETE FROM order_item_lots WHERE order_id = ?', [$orderId]);
    }

    /** Lots for many orders at once: [orderId][productId] => [['lot' => ?string, 'qty' => int], ...]. */
    public static function lotsByOrders(array $orderIds): array
    {
        if ($orderIds === [] || !self::lotsReady()) {
            return [];
        }
        $out = [];
        $ph  = implode(',', array_fill(0, count($orderIds), '?'));
        foreach (Database::all("SELECT order_id, product_id, lot_code, qty FROM order_item_lots WHERE order_id IN ($ph) ORDER BY id", $orderIds) as $r) {
            $out[$r['order_id']][$r['product_id']][] = ['lot' => $r['lot_code'], 'qty' => (int) $r['qty']];
        }
        return $out;
    }

    /** The lots one product of an order was taken from, in the order they were used: [['lot' => ?string, 'qty' => int], ...]. */
    public static function lotsFor(string $orderId, string $productId): array
    {
        if (!self::lotsReady()) {
            return [];
        }
        return array_map(static fn(array $r): array => ['lot' => $r['lot_code'], 'qty' => (int) $r['qty']],
            Database::all('SELECT lot_code, qty FROM order_item_lots WHERE order_id = ? AND product_id = ? ORDER BY id',
                [$orderId, $productId]));
    }

    /* Online orders not yet accepted (pending or on hold) reserve their items: shoppers see stock minus reservations,
       accepting turns the reservation into a real sale, and cancelling simply drops it, so nothing needs putting back. */
    public const RESERVING_STATUSES = ['pending', 'on-hold'];

    /** SQL for the units of product `$alias`.id reserved by unaccepted online orders. */
    public static function reservedSql(string $alias = 'p'): string
    {
        return "(SELECT COALESCE(SUM(roi.qty), 0)
                   FROM order_items roi
                   JOIN orders ro ON ro.id = roi.order_id
                  WHERE roi.product_id = {$alias}.id AND ro.type = 'online'
                    AND ro.status IN ('pending', 'on-hold'))";
    }

    /** SQL for what shoppers can still order: stock minus reservations, never below 0. */
    public static function availableSql(string $alias = 'p'): string
    {
        return 'GREATEST(' . $alias . '.stock - ' . self::reservedSql($alias) . ', 0)';
    }

    /** Goods leave (order committed or walk-in sale); returns affected rows, and the caller must treat 0 as "not enough stock". */
    public static function sell(string $productId, int $qty): int
    {
        if ($qty < 1) {
            throw new InvalidArgumentException("Stock::sell needs a positive quantity, got {$qty}.");
        }

        /* Read the stock band before the movement so a low-stock alert can be raised here for every sale path. */
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

    /** Raise a Critical notification only when a sale moves a product down into critical or out-of-stock, logging (not failing) if that errors. */
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

            /* 'inventory' maps to Critical in Notify's table; the level is not passed from here. */
            Notify::createOnceWhileUnread('inventory', $productId, $message);
        } catch (Throwable $e) {
            error_log('[elishabay] stock alert failed for ' . $productId . ': ' . $e->getMessage());
        }
    }

    /** Goods come back and the sale is reversed (cancellation or refunded return), lowering sold but never below 0. */
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

    /** A correction, not a sale (restock, delivery, spoilage, count): sold is untouched and a result below zero is refused; returns 0 when refused. */
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
