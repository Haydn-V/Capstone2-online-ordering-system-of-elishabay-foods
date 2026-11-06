<?php
declare(strict_types=1);

/** Customer return and refund rules shared by both sides (migration 016); every caller checks ready() first so this is inert until the migration runs. */
final class Returns
{
    /** How long after `completed` a customer may still ask. */
    public const WINDOW_HOURS = 24;

    /** Requests that still hold their units — a refused one frees them again. */
    private const OPEN = ['received', 'validated', 'eligible', 'approved', 'processed'];

    private static ?bool $ready = null;

    /** Large refunds (migration 022): refunds at or above the threshold can only be approved or paid by the Super Admin or a role with refunds.large (0 = no limit). */
    public static function largeThreshold(): float
    {
        return (float) (Database::scalar(
            "SELECT value_text FROM settings WHERE key_name = 'refund_large_threshold'"
        ) ?? 0);
    }

    public static function isLarge(float $amount): bool
    {
        $t = self::largeThreshold();
        return $t > 0 && $amount >= $t;
    }

    /** May the signed-in staff member approve / pay a large refund? */
    public static function canHandleLarge(?array $user): bool
    {
        return $user !== null && ((int) ($user['is_system'] ?? 0) === 1 || Rbac::has('refunds.large'));
    }

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

    /** Per product on an order: what was bought, how many can still be returned, and the unit price actually paid. */
    public static function orderLines(string $orderId): array
    {
        $lines = [];
        foreach (Database::all(
            'SELECT oi.product_id, p.name, p.image_url, SUM(oi.qty) AS qty,
                    SUM(oi.qty * oi.price_at_purchase) / SUM(oi.qty) AS unit_price
               FROM order_items oi JOIN products p ON p.id = oi.product_id
              WHERE oi.order_id = ?
              GROUP BY oi.product_id, p.name, p.image_url
              ORDER BY MIN(oi.id)',
            [$orderId]
        ) as $r) {
            $lines[$r['product_id']] = [
                'productId' => $r['product_id'],
                'name'      => $r['name'],
                'image'     => $r['image_url'],   /* photo in the return form */
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

        /* Per batch (lot) the units came from, how many can still be returned, so the customer can pick the batch.
           Empty for orders from before lot tracking; a NULL lot holds units that were in no batch. */
        $claimed = [];
        foreach (Database::all(
            "SELECT i.product_id, i.batch_code, SUM(i.qty) AS qty
               FROM product_return_items i JOIN product_returns r ON r.id = i.return_id
              WHERE r.order_id = ? AND r.status IN ($ph)
              GROUP BY i.product_id, i.batch_code",
            array_merge([$orderId], self::OPEN)
        ) as $r) {
            $claimed[$r['product_id']][(string) $r['batch_code']] = (int) $r['qty'];
        }
        foreach ($lines as $pid => &$line) {
            $byLot = [];
            foreach (Stock::lotsFor($orderId, $pid) as $l) {
                $k = (string) $l['lot'];
                $byLot[$k] = ($byLot[$k] ?? 0) + $l['qty'];
            }
            $line['lots'] = [];
            if (!array_filter(array_keys($byLot), 'strlen')) { continue; }   /* no real batch recorded */
            foreach ($byLot as $k => $bought) {
                $line['lots'][] = [
                    'lot'       => $k === '' ? null : $k,
                    'bought'    => $bought,
                    'remaining' => max(0, $bought - ($claimed[$pid][$k] ?? 0)),
                ];
            }
        }
        unset($line);
        return $lines;
    }

    /** The lines of each return request, keyed by return id. */
    public static function itemsFor(array $ids): array
    {
        if (!$ids || !self::ready()) return [];
        $ph  = implode(',', array_fill(0, count($ids), '?'));
        $out = [];
        foreach (Database::all(
            "SELECT i.return_id, i.product_id, p.name, i.qty, i.unit_price, i.batch_code
               FROM product_return_items i JOIN products p ON p.id = i.product_id
              WHERE i.return_id IN ($ph) ORDER BY i.id",
            $ids
        ) as $r) {
            $out[$r['return_id']][] = [
                'productId' => $r['product_id'],
                'name'      => $r['name'],
                'batchCode' => $r['batch_code'],
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
