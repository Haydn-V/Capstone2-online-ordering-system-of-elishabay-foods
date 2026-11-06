<?php
declare(strict_types=1);

/** Inventory intelligence: classifies each product from its own sales over a recent window (yesterday, 7 or 30 days),
    with no hand-set baselines. Movement compares a product with the store's average product in the same window; stock
    level is how many days the shelf lasts at the product's sales rate, with a fixed 5-unit floor so a nearly empty
    shelf is never "Safe". */
final class Inventory
{
    /** The fixed rules (not settings): Critical under 7 days of stock left, Low under 14, and 5 units or fewer is
        always Critical. A product with no sales in the window falls back to its last-30-days rate. */
    public const CRITICAL_DAYS = 7;
    public const LOW_DAYS      = 14;
    public const MIN_UNITS     = 5;
    public const FALLBACK_DAYS = 30;

    /** Shelf life of a new lot, by category: bottled bangus keeps a year, deboned (boneless) bangus six months. The
        expiry date is always computed from the production date, never typed in. */
    public const SHELF_LIFE_MONTHS = ['cat-bg' => 12, 'cat-db' => 6];

    public static function shelfLifeMonths(string $productId): int
    {
        $c = Database::one('SELECT c.id, c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?', [$productId]);
        if ($c === null) {
            return 6;
        }
        return self::SHELF_LIFE_MONTHS[$c['id']] ?? (stripos((string) $c['name'], 'bottled') !== false ? 12 : 6);
    }

    /** The expiry date of a lot of this product produced on $productionDate. */
    public static function autoExpiry(string $productId, string $productionDate): string
    {
        $m = self::shelfLifeMonths($productId);
        return (new DateTimeImmutable($productionDate))->modify("+{$m} months")->format('Y-m-d');
    }

    /** A production date may be today or up to one month back, never in the future; null when it is allowed. */
    public static function productionDateError(string $productionDate): ?string
    {
        $today    = Dates::today();
        $earliest = (new DateTimeImmutable($today))->modify('-1 month')->format('Y-m-d');
        if ($productionDate > $today) {
            return 'The production date cannot be later than today.';
        }
        if ($productionDate < $earliest) {
            return sprintf('The production date can be at most one month back (%s or later).', date('M j, Y', strtotime($earliest)));
        }
        return null;
    }

    /** @var array<string,float>|null */
    private static ?array $cache = null;

    /* The sales window is chosen per request (falling back to the stored setting), and "yesterday" means the last complete day so a partial today does not drag rates down. */

    /** Windows a caller may ask for, in days, keyed by API value. */
    public const WINDOWS = [
        'yesterday' => 1,
        'week'      => 7,
        'month'     => 30,
    ];

    /** The window in force for THIS request; the last 30 days unless the screen asks for another. */
    private static ?string $window = 'month';

    /** Pick this request's window; an unknown key is an error rather than silently using the default. */
    public static function useWindow(?string $key): void
    {
        if ($key === null || $key === '' || $key === 'default') {
            self::$window = 'month';
            return;
        }
        if (!isset(self::WINDOWS[$key])) {
            Response::validation('Unknown sales window.', [
                'window' => 'Use yesterday, week, month or default.',
            ]);
        }
        self::$window = $key;
    }

    /** The window key in force. */
    public static function windowKey(): ?string
    {
        return self::$window;
    }

    /** How many days the rate is divided by. */
    public static function windowDays(): int
    {
        return self::WINDOWS[self::$window ?? 'month'];
    }

    /** The window as readable text, so screens never say "last 1 days". */
    public static function windowLabel(): string
    {
        if (self::$window === 'yesterday') {
            return 'yesterday';
        }
        return sprintf('the last %d days', self::windowDays());
    }

    /** SQL date condition for the window, counting back from today inclusive so a week is exactly seven days. */
    public static function windowSql(string $alias = 'o'): string
    {
        if (self::$window === 'yesterday') {
            return "{$alias}.date = (CURDATE() - INTERVAL 1 DAY)";
        }
        $back = self::windowDays() - 1;
        return "{$alias}.date >= (CURDATE() - INTERVAL {$back} DAY)";
    }

    /** Units the average product sold in the window: everything sold in completed orders over the window, spread
        across every product on sale. The line between Fast and Slow moving; cached per window for the request. */
    private static array $avgCache = [];

    public static function averageUnits(): float
    {
        $key = self::$window ?? 'month';
        if (!isset(self::$avgCache[$key])) {
            $sold = (float) Database::scalar(
                "SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE o.status = 'completed' AND " . self::windowSql('o')
            );
            $products = (int) Database::scalar('SELECT COUNT(*) FROM products WHERE archived = 0');
            self::$avgCache[$key] = $products > 0 ? $sold / $products : 0.0;
        }
        return self::$avgCache[$key];
    }

    /** The rules in force, echoed to screens and exports so their legends describe exactly what was applied. */
    public static function model(): array
    {
        $days = self::windowDays();
        $avg  = self::averageUnits();
        return [
            'windowDays'      => $days,
            'criticalDays'    => self::CRITICAL_DAYS,
            'lowDays'         => self::LOW_DAYS,
            'minUnits'        => self::MIN_UNITS,
            'fallbackDays'    => self::FALLBACK_DAYS,
            /* The store average for this window, as units in the window and per month. */
            'averageUnits'    => round($avg, 2),
            'averagePerMonth' => round($avg * 30 / $days, 2),
        ];
    }

    /** Forget the per-request cache — for a request that has just changed sales or stock. */
    public static function forget(): void
    {
        self::$avgCache = [];
        self::$window   = 'month';
    }

    /** Generate the next lot code (continuing the current year's numbering), retrying past any code already taken so two simultaneous restocks never clash. */
    public static function nextLotCode(): string
    {
        $prefix = 'JBF-' . substr(Dates::today(), 0, 4) . '-B';

        /* SUBSTRING is 1-indexed and must skip the prefix; the value is bound rather than concatenated. */
        $max = (int) Database::scalar(
            'SELECT COALESCE(MAX(CAST(SUBSTRING(lot_code, ?) AS UNSIGNED)), 0)
               FROM batches WHERE lot_code LIKE ?',
            [strlen($prefix) + 1, $prefix . '%']
        );

        $n = max(100, $max + 1);
        for ($i = 0; $i < 100; $i++, $n++) {
            $code   = $prefix . $n;
            $taken  = (bool) Database::scalar(
                'SELECT COUNT(*) FROM batches WHERE lot_code = ?', [$code]
            );
            if (!$taken) {
                return $code;
            }
        }

        /* Give up after 100 consecutive collisions, since that means the numbering is broken. */
        Response::serverError('Could not allocate a lot code. Check the batch numbering.');
    }

    /* Bands are computed in SQL, not after paging, so filters and sorting cover every product rather than only the current page. */

    /** Units sold per product within the window (vel.units) and over the last 30 days (vel.units30, the fallback rate
        for a product with no sales in a shorter window), from completed orders only. Every window is within 30 days. */
    public static function velocityJoin(): string
    {
        $when = self::windowSql('o');
        $back = self::FALLBACK_DAYS - 1;

        return "LEFT JOIN (
                    SELECT oi.product_id,
                           SUM(CASE WHEN {$when} THEN oi.qty ELSE 0 END) AS units,
                           SUM(oi.qty)                                   AS units30
                      FROM order_items oi
                      JOIN orders o ON o.id = oi.order_id
                     WHERE o.status = 'completed'
                       AND o.date >= (CURDATE() - INTERVAL {$back} DAY)
                     GROUP BY oi.product_id
                ) vel ON vel.product_id = p.id";
    }

    /** The base-select columns the layers above need: window units and the 30-day fallback. */
    public static function velocityColumns(): string
    {
        return 'COALESCE(vel.units, 0) AS window_units, COALESCE(vel.units30, 0) AS units_30';
    }

    /** The earliest-expiring lot that still has stock, using LIMIT 1 subqueries so products are never duplicated. */
    public static function expirySelect(): string
    {
        $pick = "FROM batches b
                  WHERE b.product_id = p.id AND b.remaining_qty > 0
                  ORDER BY b.expiry_date ASC, b.id ASC
                  LIMIT 1";

        return "(SELECT b.expiry_date   $pick) AS first_expiry,
                (SELECT b.remaining_qty $pick) AS first_expiry_qty,
                (SELECT b.lot_code      $pick) AS first_expiry_lot";
    }

    /** Derived rate and cover columns: the window's rate, or the 30-day rate when the window had no sales; no rate at
        all means nothing is running out (days_cover NULL). */
    public static function derivedSelect(): string
    {
        $win = self::windowDays();
        $fb  = self::FALLBACK_DAYS;

        return "COALESCE(window_units, 0) / {$win}                AS per_day,
                (COALESCE(window_units, 0) * 30.0) / {$win}       AS per_month,
                CASE WHEN COALESCE(window_units, 0) > 0 THEN stock / (window_units / {$win})
                     WHEN COALESCE(units_30, 0) > 0     THEN stock / (units_30 / {$fb})
                     ELSE NULL
                END                                               AS days_cover";
    }

    /** Band and movement as numeric ranks (0 = most urgent) so queries can filter and sort on them directly. */
    public static function rankSelect(): string
    {
        $crit = self::CRITICAL_DAYS;
        $low  = self::LOW_DAYS;
        $min  = self::MIN_UNITS;
        $avg  = self::averageUnits();

        return "CASE
                    WHEN stock <= 0 THEN 0
                    WHEN stock <= {$min} OR (days_cover IS NOT NULL AND days_cover < {$crit}) THEN 1
                    WHEN days_cover IS NOT NULL AND days_cover < {$low} THEN 2
                    ELSE 3
                END AS level_rank,
                CASE
                    WHEN COALESCE(window_units, 0) <= 0 THEN 0
                    WHEN window_units >= {$avg} THEN 2
                    ELSE 1
                END AS movement_rank";
    }

    /** Filter predicates, keyed by the value the client sends. */
    public static function levelPredicate(string $level): ?string
    {
        return [
            'out'  => 'level_rank = 0',
            'crit' => 'level_rank = 1',
            'warn' => 'level_rank = 2',
            'ok'   => 'level_rank = 3',
        ][$level] ?? null;
    }

    public static function movementPredicate(string $movement): ?string
    {
        return [
            'non'  => 'movement_rank = 0',
            'slow' => 'movement_rank = 1',
            'fast' => 'movement_rank = 2',
        ][$movement] ?? null;
    }

    /* Interpretation */

    private const LEVELS = [
        0 => ['level' => 'out',  'label' => 'Out of Stock'],
        1 => ['level' => 'crit', 'label' => 'Critical'],
        2 => ['level' => 'warn', 'label' => 'Low'],
        3 => ['level' => 'ok',   'label' => 'Safe'],
    ];

    private const MOVEMENTS = [
        0 => ['movement' => 'non',  'label' => 'Non-Moving'],
        1 => ['movement' => 'slow', 'label' => 'Slow Moving'],
        2 => ['movement' => 'fast', 'label' => 'Fast Moving'],
    ];

    /** The current stock band of one product ('out'|'crit'|'warn'|'ok', or null if gone), built from the same SQL as the list screens so it can never disagree with the Inventory Report. */
    public static function levelForProduct(string $productId): ?string
    {
        $base = 'SELECT p.id, p.stock, ' . self::velocityColumns() . '
                   FROM products p
                   ' . self::velocityJoin() . '
                  WHERE p.id = ?';

        $derived = 'SELECT b.*, ' . self::derivedSelect() . ' FROM (' . $base . ') b';
        $ranked  = 'SELECT d.*, ' . self::rankSelect()    . ' FROM (' . $derived . ') d';

        $rank = Database::scalar("SELECT level_rank FROM ($ranked) r", [$productId]);
        if ($rank === false || $rank === null) {
            return null;
        }

        return self::LEVELS[(int) $rank]['level'] ?? null;
    }

    /** The stock line a shopper sees (with the quantity), where the wording follows the actual count and only the colour follows the band, and zero always reads Out of Stock. */
    public static function shopLabel(string $level, int $stock): string
    {
        if ($stock <= 0) {
            return 'Out of Stock';
        }

        if ($stock <= self::MIN_UNITS) {
            return sprintf('Only %s left', number_format($stock));
        }
        if ($level === 'crit' || $level === 'warn') {
            return sprintf('Low stock · %s left', number_format($stock));
        }
        return sprintf('In Stock · %s available', number_format($stock));
    }

    /** Turn one row of computed columns into the shape the client renders. */
    public static function describe(array $r): array
    {
        $perDay  = (float) ($r['per_day'] ?? 0);
        $cover   = $r['days_cover'] === null ? null : (int) round((float) $r['days_cover']);
        $stock   = (int) ($r['stock'] ?? 0);

        $lvl = self::LEVELS[(int) ($r['level_rank'] ?? 3)]   ?? self::LEVELS[3];
        $mov = self::MOVEMENTS[(int) ($r['movement_rank'] ?? 0)] ?? self::MOVEMENTS[0];

        /* Explain why the band was chosen (low shelf vs. selling faster than restock), so "Critical" next to a decent count makes sense. */
        $reason = null;
        if ($lvl['level'] === 'out') {
            $reason = 'No stock on hand.';
        } elseif ($lvl['level'] !== 'ok') {
            if ($stock <= self::MIN_UNITS) {
                $reason = sprintf('Only %d unit%s on hand (%d or fewer is always Critical).', $stock, $stock === 1 ? '' : 's', self::MIN_UNITS);
            } else {
                $reason = sprintf('About %d day%s of stock left at its sales rate (Critical under %d days, Low under %d).',
                    $cover, $cover === 1 ? '' : 's', self::CRITICAL_DAYS, self::LOW_DAYS);
            }
        }

        /* Expiry risk checks whether the earliest-expiring lot's own remaining quantity will sell before its date. */
        $expiry     = $r['first_expiry'] ?? null;
        $expiryQty  = $r['first_expiry_qty'] === null ? null : (int) $r['first_expiry_qty'];
        $expiryRisk = null;

        if ($expiry !== null && $expiryQty !== null && $expiryQty > 0) {
            $daysToExpiry = (int) floor(
                (strtotime($expiry) - strtotime(Dates::today())) / 86400
            );
            if ($perDay <= 0) {
                /* No sales in the window, so nothing suggests the lot will sell before it expires. */
                $expiryRisk = [
                    'atRisk'       => true,
                    'lot'          => $r['first_expiry_lot'],
                    'expiry'       => $expiry,
                    'daysToExpiry' => $daysToExpiry,
                    'qty'          => $expiryQty,
                    'daysToSell'   => null,
                    'note'         => $daysToExpiry < 0
                        ? sprintf('Lot %s expired %d day(s) ago with %d unit(s) unsold.',
                            $r['first_expiry_lot'], abs($daysToExpiry), $expiryQty)
                        : sprintf('No sales in %s — lot %s expires in %d day(s) with %d unit(s) on hand.',
                            self::windowLabel(), $r['first_expiry_lot'], $daysToExpiry, $expiryQty),
                ];
            } else {
                $daysToSell = (int) ceil($expiryQty / $perDay);
                if ($daysToSell > $daysToExpiry) {
                    $expiryRisk = [
                        'atRisk'       => true,
                        'lot'          => $r['first_expiry_lot'],
                        'expiry'       => $expiry,
                        'daysToExpiry' => $daysToExpiry,
                        'qty'          => $expiryQty,
                        'daysToSell'   => $daysToSell,
                        'note'         => sprintf(
                            'Lot %s holds %d unit(s) and expires in %d day(s); at the current rate it takes %d day(s) to sell.',
                            $r['first_expiry_lot'], $expiryQty, $daysToExpiry, $daysToSell),
                    ];
                }
            }
        }

        return [
            'level'       => $lvl['level'],
            'levelLabel'  => $lvl['label'],
            'levelReason' => $reason,
            'movement'    => $mov['movement'],
            'movementLabel' => $mov['label'],
            'perDay'      => round($perDay, 3),
            'perMonth'    => round((float) ($r['per_month'] ?? 0), 1),
            'windowUnits' => (int) ($r['window_units'] ?? 0),
            'windowDays'  => self::windowDays(),
            /* Use the readable window phrase, not just a number. */
            'windowLabel' => self::windowLabel(),
            'daysCover'   => $cover,
            /* The day counts the level was judged against. */
            'criticalDays' => self::CRITICAL_DAYS,
            'lowDays'      => self::LOW_DAYS,
            'expiryRisk'  => $expiryRisk,
        ];
    }
}
