<?php
declare(strict_types=1);

/** Estimated delivery fee (the business's own rule): distance-zone base fee from Dagupan (straight-line distance x ROAD_FACTOR) plus a weight fee, with rates edited in the Shipping Rates module and always computed on the server.
    Also the estimated arrival (migration 038): packing days + the zone's delivery days, counted Monday to Saturday, and
    island / remote areas (e.g. Batanes) with their own extra fee and days, a note, and a pause switch. All of it is an
    estimate until the courier's (LBC) own API can be used. */
final class Shipping
{
    public const ORIGIN      = [16.0433, 120.3333];
    public const ORIGIN_NAME = 'Dagupan City, Pangasinan';
    public const ROAD_FACTOR = 1.3;

    /** Destination => [lat, lng]: province capitals, Metro Manila and cities outside any province. */
    private const PLACES = [
        'Metro Manila' => [14.5995, 120.9842],
        'Abra' => [17.597, 120.618], 'Agusan del Norte' => [9.12, 125.53], 'Agusan del Sur' => [8.5, 125.97],
        'Aklan' => [11.707, 122.364], 'Albay' => [13.139, 123.743], 'Antique' => [10.745, 121.941],
        'Apayao' => [18.02, 121.17], 'Aurora' => [15.759, 121.562], 'Basilan' => [6.65, 122.13],
        'Bataan' => [14.676, 120.536], 'Batanes' => [20.449, 121.97], 'Batangas' => [13.756, 121.058],
        'Benguet' => [16.45, 120.59], 'Biliran' => [11.58, 124.47], 'Bohol' => [9.65, 123.85],
        'Bukidnon' => [8.157, 125.127], 'Bulacan' => [14.843, 120.811], 'Cagayan' => [17.613, 121.727],
        'Camarines Norte' => [14.112, 122.955], 'Camarines Sur' => [13.62, 123.19], 'Camiguin' => [9.25, 124.72],
        'Capiz' => [11.585, 122.751], 'Catanduanes' => [13.58, 124.23], 'Cavite' => [14.43, 120.94],
        'Cebu' => [10.316, 123.886], 'Cotabato' => [7.01, 125.09], 'Davao de Oro' => [7.53, 126.0],
        'Davao del Norte' => [7.448, 125.809], 'Davao del Sur' => [6.77, 125.35], 'Davao Occidental' => [6.1, 125.61],
        'Davao Oriental' => [6.95, 126.22], 'Dinagat Islands' => [10.13, 125.6], 'Eastern Samar' => [11.61, 125.43],
        'Guimaras' => [10.59, 122.63], 'Ifugao' => [16.83, 121.11], 'Ilocos Norte' => [18.197, 120.593],
        'Ilocos Sur' => [17.574, 120.387], 'Iloilo' => [10.72, 122.56], 'Isabela' => [17.15, 121.89],
        'Kalinga' => [17.41, 121.44], 'La Union' => [16.616, 120.316], 'Laguna' => [14.27, 121.41],
        'Lanao del Norte' => [8.07, 123.75], 'Lanao del Sur' => [8.0, 124.29], 'Leyte' => [11.18, 124.99],
        'Maguindanao del Norte' => [7.2, 124.23], 'Maguindanao del Sur' => [6.87, 124.46], 'Marinduque' => [13.44, 121.84],
        'Masbate' => [12.37, 123.62], 'Misamis Occidental' => [8.34, 123.71], 'Misamis Oriental' => [8.48, 124.65],
        'Mountain Province' => [17.09, 120.98], 'Negros Occidental' => [10.676, 122.95], 'Negros Oriental' => [9.31, 123.3],
        'Northern Samar' => [12.5, 124.64], 'Nueva Ecija' => [15.54, 121.08], 'Nueva Vizcaya' => [16.48, 121.15],
        'Occidental Mindoro' => [13.22, 120.6], 'Oriental Mindoro' => [13.41, 121.18], 'Palawan' => [9.74, 118.73],
        'Pampanga' => [15.03, 120.69], 'Pangasinan' => [15.93, 120.4], 'Quezon' => [13.94, 121.62],
        'Quirino' => [16.49, 121.54], 'Rizal' => [14.62, 121.17], 'Romblon' => [12.58, 122.27],
        'Samar' => [11.78, 124.88], 'Sarangani' => [5.93, 125.28], 'Siquijor' => [9.2, 123.51],
        'Sorsogon' => [12.97, 124.0], 'South Cotabato' => [6.5, 124.85], 'Southern Leyte' => [10.13, 124.84],
        'Special Geographic Area' => [7.1, 124.6], 'Sultan Kudarat' => [6.63, 124.6], 'Sulu' => [6.05, 121.0],
        'Surigao del Norte' => [9.79, 125.49], 'Surigao del Sur' => [9.08, 126.2], 'Tarlac' => [15.48, 120.59],
        'Tawi-Tawi' => [5.03, 119.77], 'Zambales' => [15.33, 119.98], 'Zamboanga del Norte' => [8.59, 123.34],
        'Zamboanga del Sur' => [7.83, 123.44], 'Zamboanga Sibugay' => [7.8, 122.68],
        /* Cities that belong to no province in PSGC. */
        'Angeles City' => [15.145, 120.586], 'Olongapo City' => [14.83, 120.28], 'Lucena City' => [13.94, 121.62],
        'Iloilo City' => [10.72, 122.56], 'Cebu City' => [10.316, 123.886], 'Lapu-Lapu City' => [10.31, 123.95],
        'Mandaue City' => [10.33, 123.93], 'Tacloban City' => [11.24, 125.0], 'Isabela City' => [6.7, 121.97],
        'Zamboanga City' => [6.92, 122.08], 'Cagayan de Oro City' => [8.48, 124.65], 'Iligan City' => [8.23, 124.24],
        'Davao City' => [7.07, 125.61], 'General Santos City' => [6.12, 125.17], 'Baguio City' => [16.41, 120.6],
        'Butuan City' => [8.95, 125.54], 'Puerto Princesa City' => [9.74, 118.73], 'Bacolod City' => [10.676, 122.95],
    ];

    /** Migration 021 applied (tables + order columns). */
    public static function ready(): bool
    {
        static $ready = null;
        return $ready ??= Database::hasTable('shipping_zones') && Database::hasColumn('orders', 'shipping_fee');
    }

    /** Migration 038 applied: zone delivery days, remote areas and the order's estimated arrival. */
    public static function etaReady(): bool
    {
        static $ready = null;
        return $ready ??= self::ready() && Database::hasColumn('shipping_zones', 'eta_min_days')
            && Database::hasTable('shipping_remote_areas') && Database::hasColumn('orders', 'eta_from');
    }

    /** Days to accept an order and hand it to the courier, before the zone's delivery days start. */
    public static function packDays(): int
    {
        $v = Database::scalar("SELECT value_text FROM settings WHERE key_name = 'shipping_pack_days'");
        return max(0, min(14, (int) ($v ?? 1)));
    }

    /** Island / remote destinations with their extra fee and days. @return array<int,array<string,mixed>> */
    public static function remoteAreas(): array
    {
        return self::etaReady()
            ? Database::all('SELECT destination, extra_fee, extra_min_days, extra_max_days, paused, note
                               FROM shipping_remote_areas ORDER BY destination')
            : [];
    }

    /** The remote-area row for a destination, or null. */
    public static function remoteArea(?string $dest): ?array
    {
        if ($dest === null || !self::etaReady()) {
            return null;
        }
        return Database::one('SELECT destination, extra_fee, extra_min_days, extra_max_days, paused, note
                                FROM shipping_remote_areas WHERE destination = ?', [$dest]);
    }

    /** Holidays with no pickup or delivery (Shipping Rates), as a set of Y-m-d dates. @return array<string,string> date => name */
    public static function holidays(): array
    {
        static $cache = null;
        if ($cache === null) {
            $cache = [];
            if (Database::hasTable('shipping_holidays')) {
                foreach (Database::all('SELECT holiday_date, name FROM shipping_holidays ORDER BY holiday_date') as $h) {
                    $cache[$h['holiday_date']] = $h['name'];
                }
            }
        }
        return $cache;
    }

    /** $from plus $n working days, skipping Sundays and holidays (the courier neither picks up nor delivers then). */
    public static function addWorkDays(string $from, int $n): string
    {
        $off = self::holidays();
        $d   = new DateTimeImmutable($from);
        while ($n > 0) {
            $d = $d->modify('+1 day');
            if ((int) $d->format('w') !== 0 && !isset($off[$d->format('Y-m-d')])) {
                $n--;
            }
        }
        return $d->format('Y-m-d');
    }

    /** Holidays falling inside an arrival window, so the customer knows why it is longer. @return string[] */
    public static function holidaysBetween(string $from, string $to): array
    {
        return array_values(array_filter(self::holidays(),
            static fn(string $name, string $date): bool => $date >= $from && $date <= $to, ARRAY_FILTER_USE_BOTH));
    }

    /** Arrival window for a [min, max] day range, from $start (default today); $pack adds the packing days first. */
    public static function etaWindow(int $min, int $max, ?string $start = null, bool $pack = true): array
    {
        $start = $start ?? Dates::today();
        $p     = $pack ? self::packDays() : 0;
        return ['from' => self::addWorkDays($start, $p + $min), 'to' => self::addWorkDays($start, $p + max($min, $max))];
    }

    /** When an order is handed to the courier, restart its arrival window from today (no packing days left). */
    public static function markShipped(string $orderId): void
    {
        if (!self::etaReady()) {
            return;
        }
        $o = Database::one('SELECT shipping_eta_min_days AS mn, shipping_eta_max_days AS mx FROM orders WHERE id = ?', [$orderId]);
        if ($o === null || $o['mn'] === null) {
            return;
        }
        $w = self::etaWindow((int) $o['mn'], (int) $o['mx'], null, false);
        Database::run('UPDATE orders SET eta_from = ?, eta_to = ? WHERE id = ?', [$w['from'], $w['to'], $orderId]);
    }

    /** Every destination the calculator knows, for the POS picker. @return string[] */
    public static function destinations(): array
    {
        $names = array_keys(self::PLACES);
        sort($names, SORT_NATURAL | SORT_FLAG_CASE);
        return $names;
    }

    /** "City of Cebu" / "Cebu City" / "Quezon City" -> a PLACES key, or null. */
    private static function cityKey(string $city): ?string
    {
        $c = preg_replace('/^City of\s+/i', '', trim($city));
        $c = preg_replace('/\s+City$/i', '', $c);
        foreach (array_keys(self::PLACES) as $k) {
            if (strcasecmp($k, $c . ' City') === 0) {
                return $k;
            }
        }
        return null;
    }

    /** Destination for a verified checkout address: Metro Manila by region, otherwise the province, or the city if it has no province. */
    public static function destinationFromAddress(?array $ship): ?string
    {
        if (!$ship) {
            return null;
        }
        $region = (string) ($ship['region'] ?? '');
        if (stripos($region, 'NCR') !== false || stripos($region, 'National Capital') !== false) {
            return 'Metro Manila';
        }
        $prov = trim((string) ($ship['province'] ?? ''));
        if ($prov !== '' && isset(self::PLACES[$prov])) {
            return $prov;
        }
        if (!empty($ship['city']) && ($k = self::cityKey((string) $ship['city']))) {
            return $k;
        }
        /* An older free-text address line: find a place named in it. */
        return self::destinationFromText((string) ($ship['line'] ?? ''));
    }

    /** Destination from the address picker's raw codes, for a preview while the address may be incomplete. */
    public static function destinationFromCodes($addr): ?string
    {
        if (!is_array($addr)) {
            return null;
        }
        if (!empty($addr['line']) && empty($addr['province']) && empty($addr['city'])) {
            return self::destinationFromText((string) $addr['line']);
        }
        $code = static fn(string $k): string => preg_replace('/\D/', '', (string) ($addr[$k] ?? ''));
        $name = static function (string $table, string $c): ?string {
            if ($c === '' || !Database::hasTable($table)) {
                return null;
            }
            $v = Database::scalar("SELECT name FROM {$table} WHERE code = ?", [$c]);
            return $v === false || $v === null ? null : (string) $v;
        };
        return self::destinationFromAddress([
            'region'   => $name('ph_regions', $code('region')),
            'province' => $name('ph_provinces', $code('province')),
            'city'     => $name('ph_cities', $code('city')),
        ]);
    }

    /** A POS destination: the picked one if it is known, else read from the typed address. */
    public static function destinationFromPos($picked, ?string $address): ?string
    {
        $p = trim((string) $picked);
        if ($p !== '' && isset(self::PLACES[$p])) {
            return $p;
        }
        return self::destinationFromText((string) $address);
    }

    /** [productId => qty] from posted cart lines [{id, qty}]. @return array<string,int> */
    public static function wanted($items): array
    {
        $out = [];
        foreach (is_array($items) ? array_slice($items, 0, 100) : [] as $l) {
            $id = trim((string) ($l['id'] ?? ''));
            $q  = (int) ($l['qty'] ?? 0);
            if ($id !== '' && $q > 0) {
                $out[$id] = ($out[$id] ?? 0) + $q;
            }
        }
        return $out;
    }

    /** Best guess from a free-text address: the longest place name it contains. */
    public static function destinationFromText(string $text): ?string
    {
        if (trim($text) === '') {
            return null;
        }
        if (preg_match('/\b(Metro Manila|NCR|Manila|Quezon City|Makati|Pasig|Taguig|Caloocan|Pasay|Para[nñ]aque|Mandaluyong|Marikina|Muntinlupa|Las Pi[nñ]as|Valenzuela|Malabon|Navotas|San Juan|Pateros)\b/iu', $text)) {
            return 'Metro Manila';
        }
        $best = null;
        foreach (array_keys(self::PLACES) as $k) {
            $needle = preg_replace('/\s+City$/', '', $k);
            if (stripos($text, $needle) !== false && ($best === null || strlen($k) > strlen($best))) {
                $best = $k;
            }
        }
        return $best;
    }

    /** Estimated road distance in km from Dagupan, or null for an unknown place. */
    public static function distanceKm(?string $dest): ?float
    {
        if ($dest === null || !isset(self::PLACES[$dest])) {
            return null;
        }
        [$la1, $lo1] = self::ORIGIN;
        [$la2, $lo2] = self::PLACES[$dest];
        $r  = 6371.0;
        $dl = deg2rad($la2 - $la1);
        $dn = deg2rad($lo2 - $lo1);
        $a  = sin($dl / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dn / 2) ** 2;
        return round(2 * $r * asin(min(1.0, sqrt($a))) * self::ROAD_FACTOR, 1);
    }

    /** @return array<int,array<string,mixed>> */
    public static function zones(bool $activeOnly = true): array
    {
        $eta = self::etaReady() ? ', eta_min_days, eta_max_days' : '';
        return Database::all("SELECT id, name, min_km, max_km, base_fee, active{$eta} FROM shipping_zones"
            . ($activeOnly ? ' WHERE active = 1' : '') . ' ORDER BY min_km, id');
    }

    /** @return array<int,array<string,mixed>> */
    public static function weightFees(bool $activeOnly = true): array
    {
        return Database::all('SELECT id, min_kg, max_kg, fee, per_kg_above, active FROM shipping_weight_fees'
            . ($activeOnly ? ' WHERE active = 1' : '') . ' ORDER BY min_kg, id');
    }

    /** Total weight in kg for [productId => qty]. */
    public static function weightKg(array $wanted): float
    {
        if ($wanted === []) {
            return 0.0;
        }
        $hasW = Database::hasColumn('products', 'net_weight_g');
        $ph   = implode(',', array_fill(0, count($wanted), '?'));
        $grams = 0.0;
        foreach (Database::all(
            'SELECT p.id, ' . ($hasW ? 'p.net_weight_g' : 'NULL AS net_weight_g') . ', c.name AS cat
               FROM products p LEFT JOIN categories c ON c.id = p.category_id
              WHERE p.id IN (' . $ph . ')',
            array_map('strval', array_keys($wanted))
        ) as $p) {
            $g = (int) ($p['net_weight_g'] ?? 0);
            if ($g <= 0) {
                $g = stripos((string) $p['cat'], 'bottle') !== false ? 220 : 700;
            }
            $grams += $g * (int) $wanted[$p['id']];
        }
        return round($grams / 1000, 2);
    }

    /** The delivery fee estimate for a cart and destination. */
    public static function quote(array $wanted, ?string $dest): array
    {
        return self::estimate(self::weightKg($wanted), $dest);
    }

    /** The estimate for a weight already known (Shipping Rates "Try it"). @return array<string,mixed> */
    public static function estimate(float $kg, ?string $dest): array
    {
        $kg = round(max(0.0, $kg), 2);
        $km = self::distanceKm($dest);

        $zone = null;
        if ($km !== null) {
            $whole = round($km);
            $zones = self::zones();
            foreach ($zones as $z) {
                if ($z['max_km'] === null || $whole <= (float) $z['max_km']) {
                    $zone = $z;
                    break;
                }
            }
            /* Past every configured range: the farthest zone. */
            $zone ??= $zones ? $zones[count($zones) - 1] : null;
        } elseif ($dest !== null) {
            /* An unknown destination is charged as the farthest zone, not free. */
            $zones = self::zones();
            $zone  = $zones ? $zones[count($zones) - 1] : null;
        }

        $weightFee = 0.0;
        foreach (self::weightFees() as $b) {
            if ($b['max_kg'] === null || $kg <= (float) $b['max_kg']) {
                $weightFee = (float) $b['fee'];
                if ((float) $b['per_kg_above'] > 0) {
                    $over = $kg - floor((float) $b['min_kg']);
                    $weightFee += max(0, (int) ceil(round($over, 2))) * (float) $b['per_kg_above'];
                }
                break;
            }
        }

        $base = $zone ? (float) $zone['base_fee'] : 0.0;

        /* Island / remote area: an extra fee and extra days on top of the zone, and possibly paused. */
        $remote    = self::remoteArea($dest);
        $remoteFee = $remote ? (float) $remote['extra_fee'] : 0.0;

        /* Estimated arrival: packing days + the zone's days (+ the remote area's), Monday to Saturday. */
        $eta = null;
        if ($zone && isset($zone['eta_min_days']) && $zone['eta_min_days'] !== null) {
            $mn = (int) $zone['eta_min_days'] + ($remote ? (int) $remote['extra_min_days'] : 0);
            $mx = max($mn, (int) $zone['eta_max_days'] + ($remote ? (int) $remote['extra_max_days'] : 0));
            $eta = ['minDays' => $mn, 'maxDays' => $mx, 'packDays' => self::packDays()] + self::etaWindow($mn, $mx);
            /* Holidays the window skips over, named at checkout ("includes the Christmas Day holiday"). */
            $eta['holidays'] = self::holidaysBetween(Dates::today(), $eta['to']);
        }

        return [
            'ok'          => $zone !== null,
            'origin'      => self::ORIGIN_NAME,
            'destination' => $dest,
            'distanceKm'  => $km,
            'weightKg'    => $kg,
            'zone'        => $zone['name'] ?? null,
            'zoneFee'     => round($base, 2),
            'weightFee'   => round($weightFee, 2),
            'fee'         => $zone ? round($base + $weightFee + $remoteFee, 2) : 0.0,
            'remoteFee'   => round($remoteFee, 2),
            'remote'      => $remote ? [
                'extraFee' => (float) $remote['extra_fee'],
                'paused'   => (int) $remote['paused'] === 1,
                'note'     => $remote['note'],
            ] : null,
            'paused'      => $remote !== null && (int) $remote['paused'] === 1,
            'eta'         => $eta,
        ];
    }

    /** Refuse a delivery to an area that is paused right now; call before taking the order. */
    public static function refuseIfPaused(?array $q): void
    {
        if ($q && !empty($q['paused'])) {
            Response::conflict(sprintf('Deliveries to %s are paused right now%s. Please try again later.',
                $q['destination'], !empty($q['remote']['note']) ? ' (' . $q['remote']['note'] . ')' : ''));
        }
    }

    /** Add the delivery fee to a Tax::compute() total and amount due, leaving VAT and withholding on the goods only. */
    public static function applyTo(array $tax, ?array $q): array
    {
        $fee = $q ? (float) $q['fee'] : 0.0;
        $tax['shippingFee'] = $fee;
        $tax['shipping']    = $q;
        $tax['total']       = round((float) $tax['total'] + $fee, 2);
        $tax['amountDue']   = round((float) $tax['amountDue'] + $fee, 2);
        return $tax;
    }

    /** Values for the order's shipping columns. @return array<string,mixed> */
    public static function orderColumns(?array $q): array
    {
        return [
            'shipping_fee'         => $q ? (float) $q['fee'] : 0.0,
            'shipping_zone'        => $q['zone'] ?? null,
            'shipping_km'          => $q['distanceKm'] ?? null,
            'shipping_weight_kg'   => $q['weightKg'] ?? null,
            'shipping_destination' => $q['destination'] ?? null,
        ];
    }

    /** Write the shipping columns onto an order just inserted. */
    public static function saveOnOrder(string $orderId, ?array $q): void
    {
        if (!self::ready()) {
            return;
        }
        $c = self::orderColumns($q);
        Database::run(
            'UPDATE orders SET shipping_fee = ?, shipping_zone = ?, shipping_km = ?, shipping_weight_kg = ?,
                               shipping_destination = ? WHERE id = ?',
            [$c['shipping_fee'], $c['shipping_zone'], $c['shipping_km'], $c['shipping_weight_kg'],
             $c['shipping_destination'], $orderId]
        );
        /* The arrival estimate given at checkout (migration 038). */
        if (self::etaReady() && $q) {
            $e = $q['eta'] ?? null;
            Database::run(
                'UPDATE orders SET shipping_eta_min_days = ?, shipping_eta_max_days = ?, shipping_remote = ?,
                                   eta_from = ?, eta_to = ? WHERE id = ?',
                [$e['minDays'] ?? null, $e['maxDays'] ?? null, !empty($q['remote']) ? 1 : 0,
                 $e['from'] ?? null, $e['to'] ?? null, $orderId]
            );
        }
    }
}
