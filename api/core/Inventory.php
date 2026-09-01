<?php
declare(strict_types=1);

/**
 * Inventory intelligence — movement, cover, stock band and expiry risk.
 *
 * THE PROBLEM THIS REPLACES
 * -------------------------
 * Stock status used to be four fixed piece counts and movement class was a
 * lifetime running total. Both were wrong, in ways that got worse over time.
 *
 * Fixed piece counts ask one number to answer a question that depends on how
 * fast the product sells. Nine units of a product that leaves at thirty a week
 * is a shortage; nine units of a product that sells two a year is three years
 * of cover. The old bands called both "Critical".
 *
 * `products.sold` is a CUMULATIVE LIFETIME COUNTER. It is maintained correctly
 * — Stock.php increments it on commit and decrements it on cancellation — but
 * it never decays. A product that sold well last year stays "Fast Moving"
 * forever on the strength of trade that has stopped, and because the counter
 * only rises, every product eventually crosses the "fast" threshold and the
 * classification stops separating anything at all. This catalogue was already
 * at 430–2100 lifetime units when this was written.
 *
 * WHAT REPLACES IT
 * ----------------
 * One number, measured rather than accumulated: units sold per day over a
 * trailing window, taken from completed orders. Everything else derives from
 * it.
 *
 *   movement   — units/month against two thresholds
 *   daysCover  — stock ÷ units per day: how long the shelf lasts
 *   stockLevel — cover measured against how long a restock takes
 *   expiryRisk — whether the earliest-expiring lot will sell before it expires
 *
 * WHY THERE IS STILL AN ABSOLUTE FLOOR
 * ------------------------------------
 * A pure cover model fails on the case that motivated it. A product with nine
 * units and one sale a month has 270 days of cover, and velocity alone would
 * report it Safe — while the shelf is visibly empty and any single order
 * clears it out. The band is therefore the MORE URGENT of the cover band and
 * an absolute floor. The floor can only escalate a status, never soften one,
 * so adding it cannot hide a shortage the cover model would have caught.
 *
 * WHY SLOW MOVERS GET THEIR OWN SIGNAL
 * ------------------------------------
 * Cover and expiry pull in opposite directions. For a fast mover the risk is
 * running out; for a slow one it is holding stock that spoils first. This is a
 * food business with real expiry dates on every lot, so the second risk is the
 * expensive one, and a stock band alone cannot express it — "Safe" is exactly
 * what a doomed pallet looks like. `expiryRisk` is that second axis.
 *
 * TUNABLES, NOT CONSTANTS
 * -----------------------
 * Every threshold lives in `settings` and is editable without a deployment,
 * the same way `penalty_rate` already is. The defaults below are calibrated
 * against the transaction volume present when this was written; a business
 * trading at real volume should raise the movement thresholds. That is a
 * settings change, not a code change, which is the entire point.
 */
final class Inventory
{
    /** Defaults, used whenever a settings row is absent or unparseable. */
    public const DEFAULTS = [
        /* Trailing window the rate is measured over. Long enough to survive a
           quiet fortnight, short enough to notice a product going cold. */
        'velocity_window_days'    => 90,

        /* How long a restock takes. The band that matters: below this much
           cover, an order placed today arrives after the shelf is empty. */
        'restock_lead_days'       => 14,

        /* Movement thresholds, in units per month. */
        'movement_fast_per_month' => 8.0,
        'movement_slow_per_month' => 2.0,

        /* The absolute floor described above. "Low" is three times this. */
        'stock_floor_critical'    => 10,
    ];

    /** @var array<string,float>|null */
    private static ?array $cache = null;

    /**
     * The tunables, read once per request.
     *
     * Coerced to numbers here and nowhere else. Every value is interpolated
     * into SQL further down — settings hold operator input, so the coercion is
     * what makes that safe, and it happens at the single point of entry rather
     * than being re-asserted at each use.
     *
     * @return array<string,float>
     */
    public static function tunables(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }

        $out = [];
        foreach (self::DEFAULTS as $key => $fallback) {
            $raw = Database::scalar(
                'SELECT value_text FROM settings WHERE key_name = ?',
                [$key]
            );
            $val = ($raw === false || $raw === null || !is_numeric($raw))
                ? $fallback
                : (float) $raw;

            /* A zero or negative window divides by zero; a zero lead time makes
               every product Critical. Refuse nonsense rather than propagate it. */
            if ($val <= 0) {
                $val = $fallback;
            }
            $out[$key] = (float) $val;
        }

        /* Fast must outrank slow. If an operator inverts them the bands would
           silently overlap and "slow" would become unreachable. */
        if ($out['movement_fast_per_month'] <= $out['movement_slow_per_month']) {
            $out['movement_fast_per_month'] = $out['movement_slow_per_month'] * 2;
        }

        return self::$cache = $out;
    }

    /** Forget the cached tunables — for a request that has just written one. */
    public static function forget(): void
    {
        self::$cache = null;
    }

    /**
     * The next lot code, assigned by the system.
     *
     * WHY THE SYSTEM ASSIGNS IT
     * -------------------------
     * The restock form used to prefill `JBF-2026-B` plus `Math.random()` over
     * 900 values and let the operator edit it. `batches.lot_code` is UNIQUE, so
     * that is a birthday problem waiting behind a 409: at a few dozen lots a
     * year the odds of a clash stop being theoretical, and the operator's only
     * clue is a rejected form. It also meant two people could invent two
     * different schemes for the same shelf.
     *
     * The bulk replenish form was worse — it asked for a lot code and collected
     * no expiry date, so ANY code typed there failed validation. The field
     * could not be used successfully at all.
     *
     * A lot code identifies a production run. It is the system's fact to state,
     * not something to be typed twice and reconciled.
     *
     * Sequential within the year, continuing whatever numbering is already
     * there rather than restarting: the seeded lots are JBF-2026-B102 upward
     * and a generator that began at 100 would collide with them immediately.
     *
     * The loop is the concurrency guard. Two restocks a moment apart read the
     * same maximum, and only the UNIQUE index would notice — as a 500 on the
     * insert rather than a message. Stepping past a taken code is cheaper than
     * locking the table for a value nobody is waiting on.
     */
    public static function nextLotCode(): string
    {
        $prefix = 'JBF-' . substr(Dates::today(), 0, 4) . '-B';

        /* SUBSTRING is 1-indexed and the offset must clear the prefix. Bound
           rather than concatenated even though the prefix is built here — the
           year comes from a configured timezone, and this is the file that
           should not be the exception to the rule. */
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

        /* A hundred consecutive collisions is not contention, it is a numbering
           scheme that has stopped meaning anything. Refuse rather than invent. */
        Response::serverError('Could not allocate a lot code. Check the batch numbering.');
    }

    /* ==========================================================
       SQL
       ----------------------------------------------------------
       The bands are computed in SQL rather than over a page of results,
       for the reason products/list.php already learned the hard way: a
       filter applied after paging returns "everything critical" from the
       current page only. Sorting by cover has the same requirement.
       ========================================================== */

    /**
     * Units sold per product inside the window.
     *
     * Completed orders only, matching Revenue::STATUSES — a pending or
     * cancelled order has not consumed anything, and counting it would let an
     * abandoned basket suppress a restock alert.
     */
    public static function velocityJoin(): string
    {
        $win = (int) self::tunables()['velocity_window_days'];

        return "LEFT JOIN (
                    SELECT oi.product_id, SUM(oi.qty) AS units
                      FROM order_items oi
                      JOIN orders o ON o.id = oi.order_id
                     WHERE o.status = 'completed'
                       AND o.date >= (CURDATE() - INTERVAL {$win} DAY)
                     GROUP BY oi.product_id
                ) vel ON vel.product_id = p.id";
    }

    /**
     * The earliest-expiring lot that still holds stock.
     *
     * Correlated subqueries rather than a join. Joining on MIN(expiry_date)
     * duplicates the product row whenever two lots share that date, which
     * silently inflates every count and page on the screen. `LIMIT 1` with a
     * deterministic tiebreak cannot.
     */
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

    /** Derived rate and cover columns, for the layer above the base select. */
    public static function derivedSelect(): string
    {
        $win = (int) self::tunables()['velocity_window_days'];

        return "COALESCE(window_units, 0) / {$win}                AS per_day,
                (COALESCE(window_units, 0) * 30.0) / {$win}       AS per_month,
                CASE WHEN COALESCE(window_units, 0) = 0 THEN NULL
                     ELSE stock / (COALESCE(window_units, 0) / {$win})
                END                                               AS days_cover";
    }

    /**
     * Band and movement, as sortable ranks.
     *
     * A rank rather than a label so the outer query can filter and order on it
     * without repeating the CASE. 0 is the most urgent, which makes
     * `ORDER BY level_rank` read as "worst first" with no DESC to forget.
     */
    public static function rankSelect(): string
    {
        $t      = self::tunables();
        $lead   = (float) $t['restock_lead_days'];
        $lead2  = $lead * 2;
        $floor  = (float) $t['stock_floor_critical'];
        $floor3 = $floor * 3;
        $fast   = (float) $t['movement_fast_per_month'];
        $slow   = (float) $t['movement_slow_per_month'];

        return "CASE
                    WHEN stock <= 0 THEN 0
                    WHEN (days_cover IS NOT NULL AND days_cover < {$lead})
                      OR stock <= {$floor}  THEN 1
                    WHEN (days_cover IS NOT NULL AND days_cover < {$lead2})
                      OR stock <= {$floor3} THEN 2
                    ELSE 3
                END AS level_rank,
                CASE
                    WHEN per_month >= {$fast} THEN 2
                    WHEN per_month >= {$slow} THEN 1
                    ELSE 0
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

    /* ==========================================================
       Interpretation
       ========================================================== */

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

    /**
     * Turn one row of derived columns into the shape the client renders.
     *
     * @param array<string,mixed> $r
     * @return array<string,mixed>
     */
    public static function describe(array $r): array
    {
        $t       = self::tunables();
        $perDay  = (float) ($r['per_day'] ?? 0);
        $cover   = $r['days_cover'] === null ? null : (int) round((float) $r['days_cover']);
        $stock   = (int) ($r['stock'] ?? 0);

        $lvl = self::LEVELS[(int) ($r['level_rank'] ?? 3)]   ?? self::LEVELS[3];
        $mov = self::MOVEMENTS[(int) ($r['movement_rank'] ?? 0)] ?? self::MOVEMENTS[0];

        /* WHY the band says what it says. Without this the screen can show
           "Critical" against a healthy-looking count and give the reader no way
           to tell whether that came from the shelf being low or from the
           product selling faster than it can be replaced. */
        $reason = null;
        if ($lvl['level'] === 'out') {
            $reason = 'No stock on hand.';
        } elseif ($lvl['level'] !== 'ok') {
            $lead     = (int) $t['restock_lead_days'];
            $byFloor  = $stock <= (int) $t['stock_floor_critical'] * ($lvl['level'] === 'crit' ? 1 : 3);
            $byCover  = $cover !== null && $cover < $lead * ($lvl['level'] === 'crit' ? 1 : 2);
            if ($byCover && $byFloor) {
                $reason = sprintf('%d left — about %d day%s of cover, under the %d-day restock lead time.',
                    $stock, $cover, $cover === 1 ? '' : 's', $lead);
            } elseif ($byCover) {
                $reason = sprintf('About %d day%s of cover at the current rate; a restock takes %d.',
                    $cover, $cover === 1 ? '' : 's', $lead);
            } else {
                $reason = sprintf('Only %d unit%s on hand.', $stock, $stock === 1 ? '' : 's');
            }
        }

        /* Expiry risk: will the earliest-expiring lot sell before its date?
           Measured against THAT LOT's remaining quantity, not the product's
           whole stock, because it is the lot that expires — under FIFO it is
           also the one being sold right now. */
        $expiry     = $r['first_expiry'] ?? null;
        $expiryQty  = $r['first_expiry_qty'] === null ? null : (int) $r['first_expiry_qty'];
        $expiryRisk = null;

        if ($expiry !== null && $expiryQty !== null && $expiryQty > 0) {
            $daysToExpiry = (int) floor(
                (strtotime($expiry) - strtotime(Dates::today())) / 86400
            );
            if ($perDay <= 0) {
                /* Nothing has sold in the window, so nothing will clear the lot
                   before its date on the evidence available. */
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
                        : sprintf('No sales in the last %d days — lot %s expires in %d day(s) with %d unit(s) on hand.',
                            (int) $t['velocity_window_days'], $r['first_expiry_lot'], $daysToExpiry, $expiryQty),
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
            'windowDays'  => (int) $t['velocity_window_days'],
            'daysCover'   => $cover,
            'leadDays'    => (int) $t['restock_lead_days'],
            'expiryRisk'  => $expiryRisk,
        ];
    }
}
