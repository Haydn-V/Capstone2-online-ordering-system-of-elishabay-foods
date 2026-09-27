<?php
declare(strict_types=1);

/**
 * Customer return & refund requests — the rules both sides share.
 *
 * A request is one product_returns row (what staff advance through the
 * pipeline) plus its lines in product_return_items. See migration 016.
 *
 * Everything here is inert until that migration has run: ready() is checked by
 * every caller, so the code can reach a server before its database does.
 */
final class Returns
{
    /** How long after `completed` a customer may still ask. */
    public const WINDOW_HOURS = 24;

    /** Requests that still hold their units — a refused one frees them again. */
    private const OPEN = ['received', 'validated', 'eligible', 'approved', 'processed'];

    private static ?bool $ready = null;

    public static function ready(): bool
    {
        return self::$ready ??= Database::hasTable('product_return_items');
    }

    private static ?bool $refundReady = null;

    /** Migration 017: refund destination + staff transfer receipt. */
    public static function refundReady(): bool
    {
        return self::$refundReady ??= (bool) Database::scalar(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [Database::config()['db']['name'], 'product_returns', 'refund_receipt']
        );
    }

    /** Paths api/uploads/image.php issues: /uploads/<folder>/<32 hex>.webp */
    public static function isUploadPath(string $path, string $folder): bool
    {
        return (bool) preg_match('#^/uploads/' . preg_quote($folder, '#') . '/[a-f0-9]{32}\.webp$#', $path);
    }

    /** Called by every writer that moves an order to `completed`. */
    public static function stampCompleted(string $orderId): void
    {
        if (!self::ready()) return;
        Database::run(
            'UPDATE orders SET completed_at = NOW() WHERE id = ? AND completed_at IS NULL',
            [$orderId]
        );
    }

    /**
     * What the customer bought on an order, per product, with how many are
     * still free to return. Unit price is what they actually paid.
     *
     * @return array<string, array{productId:string,name:string,bought:int,returned:int,remaining:int,unitPrice:float}>
     */
    public static function orderLines(string $orderId): array
    {
        $lines = [];
        foreach (Database::all(
            'SELECT oi.product_id, p.name, SUM(oi.qty) AS qty,
                    SUM(oi.qty * oi.price_at_purchase) / SUM(oi.qty) AS unit_price
               FROM order_items oi JOIN products p ON p.id = oi.product_id
              WHERE oi.order_id = ?
              GROUP BY oi.product_id, p.name
              ORDER BY MIN(oi.id)',
            [$orderId]
        ) as $r) {
            $lines[$r['product_id']] = [
                'productId' => $r['product_id'],
                'name'      => $r['name'],
                'bought'    => (int) $r['qty'],
                'returned'  => 0,
                'remaining' => (int) $r['qty'],
                'unitPrice' => round((float) $r['unit_price'], 2),
            ];
        }

        $ph = implode(',', array_fill(0, count(self::OPEN), '?'));
        foreach (Database::all(
            "SELECT i.product_id, SUM(i.qty) AS qty
               FROM product_return_items i JOIN product_returns r ON r.id = i.return_id
              WHERE r.order_id = ? AND r.status IN ($ph)
              GROUP BY i.product_id",
            array_merge([$orderId], self::OPEN)
        ) as $r) {
            if (!isset($lines[$r['product_id']])) continue;
            $lines[$r['product_id']]['returned']  = (int) $r['qty'];
            $lines[$r['product_id']]['remaining'] = max(0, $lines[$r['product_id']]['bought'] - (int) $r['qty']);
        }
        return $lines;
    }

    /**
     * The lines of each request, keyed by return id.
     *
     * @param string[] $ids
     * @return array<string, list<array{productId:string,name:string,qty:int,unitPrice:float,subtotal:float}>>
     */
    public static function itemsFor(array $ids): array
    {
        if (!$ids || !self::ready()) return [];
        $ph  = implode(',', array_fill(0, count($ids), '?'));
        $out = [];
        foreach (Database::all(
            "SELECT i.return_id, i.product_id, p.name, i.qty, i.unit_price
               FROM product_return_items i JOIN products p ON p.id = i.product_id
              WHERE i.return_id IN ($ph) ORDER BY i.id",
            $ids
        ) as $r) {
            $out[$r['return_id']][] = [
                'productId' => $r['product_id'],
                'name'      => $r['name'],
                'qty'       => (int) $r['qty'],
                'unitPrice' => (float) $r['unit_price'],
                'subtotal'  => round((int) $r['qty'] * (float) $r['unit_price'], 2),
            ];
        }
        return $out;
    }

    /** The staff pipeline, said the way a customer would. */
    public static function customerStatus(string $status): array
    {
        return match ($status) {
            'received'              => ['submitted', 'Submitted'],
            'validated', 'eligible' => ['review',    'Under Review'],
            'approved'              => ['approved',  'Approved'],
            'processed'             => ['refunded',  'Refunded'],
            default                 => ['rejected',  'Rejected'],
        };
    }
}
