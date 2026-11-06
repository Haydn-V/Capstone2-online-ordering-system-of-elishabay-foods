<?php
declare(strict_types=1);

/** Tax computes each sale's VAT once at the moment of sale (stored with the order), handling VAT-exempt products, Senior/PWD discounts and withholding tax, with rounding that always adds up to the total. */
final class Tax
{
    public const TAX_TYPES    = ['vatable', 'exempt'];
    public const SC_PWD_TYPES = ['senior', 'pwd'];

    /** Rules, as stored in `settings`; used whenever a row is absent. */
    public const DEFAULTS = [
        'vat_rate'                 => 12.0,
        'sc_pwd_enabled'           => 1.0,
        'sc_pwd_discount_rate'     => 20.0,
        'sc_pwd_vat_exempt'        => 1.0,
        'sc_pwd_weekly_cap'        => 0.0,
        'withholding_default_rate' => 1.0,
        /* Retailer discount needs at least this many items in the order (0 = no minimum). */
        'withholding_min_qty'      => 0.0,
    ];

    /** Accepted ranges, for VAT Maintenance's save and for reading back. */
    public const LIMITS = [
        'vat_rate'                 => [0.0, 50.0],
        'sc_pwd_enabled'           => [0.0, 1.0],
        'sc_pwd_discount_rate'     => [0.0, 100.0],
        'sc_pwd_vat_exempt'        => [0.0, 1.0],
        'sc_pwd_weekly_cap'        => [0.0, 1000000.0],
        'withholding_default_rate' => [0.0, 50.0],
        'withholding_min_qty'      => [0.0, 100000.0],
    ];

    /** @var array<string,float>|null */
    private static ?array $cache = null;

    /** Current tax settings read once per request, falling back to defaults for out-of-range values. */
    public static function rules(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }
        $stored = [];
        foreach (Database::all(
            'SELECT key_name, value_text FROM settings WHERE key_name IN ('
            . implode(',', array_fill(0, count(self::DEFAULTS), '?')) . ')',
            array_keys(self::DEFAULTS)
        ) as $r) {
            $stored[$r['key_name']] = $r['value_text'];
        }

        $out = [];
        foreach (self::DEFAULTS as $key => $fallback) {
            $raw = $stored[$key] ?? null;
            [$lo, $hi] = self::LIMITS[$key];
            $val = is_numeric($raw) ? (float) $raw : $fallback;
            $out[$key] = ($val < $lo || $val > $hi) ? $fallback : $val;
        }
        /* Senior/PWD discounts are not offered, whatever the stored setting says. */
        $out['sc_pwd_enabled'] = 0.0;
        return self::$cache = $out;
    }

    public static function forget(): void
    {
        self::$cache = null;
    }

    private static function r2(float $n): float
    {
        return round($n + ($n >= 0 ? 1e-9 : -1e-9), 2);
    }

    /** The buyer's withholding rate, only for a current retailer (null otherwise). */
    public static function withholdingRateFor(?string $customerId, ?int $qty = null): ?float
    {
        if ($customerId === null || $customerId === '') {
            return null;
        }
        /* Below the minimum item count the retailer discount does not apply. */
        if ($qty !== null && $qty < self::minDiscountQty()) {
            return null;
        }
        $rate = Database::scalar(
            "SELECT wa.rate
               FROM withholding_agents wa
               JOIN customers c ON c.id = wa.customer_id
              WHERE wa.customer_id = ? AND c.status = 'retailer'",
            [$customerId]
        );
        return ($rate === false || $rate === null) ? null : (float) $rate;
    }

    /** Items an order needs before the retailer discount applies (0 = no minimum). */
    public static function minDiscountQty(): int
    {
        return (int) self::rules()['withholding_min_qty'];
    }

    /** Total item count of a request's items list ([{id, qty}, ...]). */
    public static function itemCount($items): int
    {
        $n = 0;
        foreach (is_array($items) ? array_slice($items, 0, 100) : [] as $line) {
            $n += max(0, (int) ($line['qty'] ?? 0));
        }
        return $n;
    }

    /** For a retailer with a discount who is under the minimum: how far short they are, so screens can say so; null otherwise. */
    public static function discountShortfall(?string $customerId, int $qty): ?array
    {
        $min = self::minDiscountQty();
        if ($qty >= $min || self::withholdingRateFor($customerId) === null) {
            return null;
        }
        return ['minQty' => $min, 'qty' => $qty, 'short' => $min - $qty,
                'rate' => self::withholdingRateFor($customerId)];
    }

    /** Senior/PWD discount already given to one ID this week (Mon to Sun) for the weekly cap, ignoring cancelled orders. */
    public static function weeklyDiscountUsed(string $scPwdId): float
    {
        return (float) Database::scalar(
            "SELECT COALESCE(SUM(sc_pwd_discount), 0)
               FROM orders
              WHERE sc_pwd_id = ?
                AND status <> 'cancelled'
                AND YEARWEEK(date, 1) = YEARWEEK(CURDATE(), 1)",
            [$scPwdId]
        );
    }

    /** Read and validate a Senior/PWD block (ID number and name are required by BIR), returning null when not an SC/PWD sale. */
    public static function scPwdFrom(array $in, array &$errors): ?array
    {
        $block = $in['sc_pwd'] ?? null;
        if (!is_array($block) || empty($block['type'])) {
            return null;
        }
        $type = (string) $block['type'];
        $id   = trim((string) ($block['id'] ?? ''));
        $name = trim((string) ($block['name'] ?? ''));

        if ((int) self::rules()['sc_pwd_enabled'] !== 1) {
            $errors['sc_pwd'] = 'Senior citizen and PWD discounts are not offered.';
            return null;
        }
        if (!in_array($type, self::SC_PWD_TYPES, true)) {
            $errors['sc_pwd'] = 'Choose Senior Citizen or PWD.';
        }
        if ($id === '' || mb_strlen($id) > 40) {
            $errors['sc_pwd_id'] = $id === '' ? 'Enter the ID number shown on their card.' : 'An ID number is at most 40 characters.';
        }
        if ($name === '' || mb_strlen($name) > 100) {
            $errors['sc_pwd_name'] = $name === '' ? 'Enter the name on the ID.' : 'A name is at most 100 characters.';
        }
        return isset($errors['sc_pwd']) || isset($errors['sc_pwd_id']) || isset($errors['sc_pwd_name'])
            ? null
            : ['type' => $type, 'id' => $id, 'name' => $name];
    }

    /** The full VAT breakdown for one sale. */
    public static function compute(array $lines, ?array $scPwd, ?float $withholdingRate): array
    {
        $rules = self::rules();
        $rate  = $rules['vat_rate'] / 100;

        $vatGross = 0.0;
        $exGross  = 0.0;
        foreach ($lines as $l) {
            if (($l['tax_type'] ?? 'vatable') === 'exempt') {
                $exGross += (float) $l['gross'];
            } else {
                $vatGross += (float) $l['gross'];
            }
        }
        $vatGross = self::r2($vatGross);
        $exGross  = self::r2($exGross);
        $gross    = self::r2($vatGross + $exGross);

        /* The VAT inside the VATable shelf prices, as a remainder. */
        $vatNet  = self::r2($vatGross / (1 + $rate));
        $lessVat = self::r2($vatGross - $vatNet);
        $net     = self::r2($vatNet + $exGross);

        $capped = false;
        if ($scPwd !== null) {
            $discount = self::r2($net * $rules['sc_pwd_discount_rate'] / 100);

            $cap = $rules['sc_pwd_weekly_cap'];
            if ($cap > 0) {
                $left = max(0.0, self::r2($cap - self::weeklyDiscountUsed($scPwd['id'])));
                if ($discount > $left) {
                    $discount = $left;
                    $capped   = true;
                }
            }

            $afterDiscount = self::r2($net - $discount);
            if ((int) $rules['sc_pwd_vat_exempt'] === 1) {
                /* Exempt: the whole discounted sale carries no VAT. */
                $vatableSales = 0.0;
                $vatAmount    = 0.0;
                $exemptSales  = $afterDiscount;
            } else {
                /* Not exempt: the discount applies proportionally and VAT is recharged on the remaining VATable part. */
                $share        = $net > 0 ? $afterDiscount / $net : 0.0;
                $vatableSales = self::r2($vatNet * $share);
                $exemptSales  = self::r2($afterDiscount - $vatableSales);
                $vatAmount    = self::r2($vatableSales * $rate);
            }
            /* Computed as the remainder so net - discount + VAT lands exactly on the total. */
            $discount = self::r2($net - $vatableSales - $exemptSales);
        } else {
            $discount     = 0.0;
            $vatableSales = $vatNet;
            $vatAmount    = $lessVat;
            $exemptSales  = $exGross;
        }

        $total = self::r2($vatableSales + $vatAmount + $exemptSales);

        $whtRate = ($withholdingRate !== null && $withholdingRate > 0) ? $withholdingRate : null;
        /* Withholding is calculated on the amount net of VAT. */
        $withholding = $whtRate !== null ? self::r2(($vatableSales + $exemptSales) * $whtRate / 100) : 0.0;

        return [
            'grossTotal'      => $gross,
            'vatRate'         => $rules['vat_rate'],
            'lessVat'         => $lessVat,
            'netOfVat'        => $net,
            'scPwdDiscount'   => $discount,
            'scPwdCapped'     => $capped,
            'vatableSales'    => $vatableSales,
            'vatAmount'       => $vatAmount,
            'vatExemptSales'  => $exemptSales,
            'zeroRatedSales'  => 0.0,
            'total'           => $total,
            'withholdingRate' => $whtRate,
            'withholdingTax'  => $withholding,
            'amountDue'       => self::r2($total - $withholding),
            'scPwd'           => $scPwd,
        ];
    }

    /** Priced lines for a preview (quote endpoints): reads prices like checkout but checks no stock and locks nothing. */
    public static function quoteLines($items): array
    {
        if (!is_array($items)) {
            return [];
        }
        $wanted = [];
        foreach (array_slice($items, 0, 100) as $line) {
            $id  = trim((string) ($line['id'] ?? ''));
            $qty = (int) ($line['qty'] ?? 0);
            if ($id !== '' && $qty > 0) {
                $wanted[$id] = ($wanted[$id] ?? 0) + $qty;
            }
        }
        if ($wanted === []) {
            return [];
        }
        $ph = implode(',', array_fill(0, count($wanted), '?'));
        $out = [];
        foreach (Database::all(
            "SELECT id, price, tax_type FROM products WHERE archived = 0 AND id IN ($ph)",
            array_keys($wanted)
        ) as $p) {
            $out[] = ['gross' => round((float) $p['price'] * $wanted[$p['id']], 2), 'tax_type' => $p['tax_type']];
        }
        return $out;
    }

    /** The order columns for a computed breakdown, in INSERT order. @return array<string,mixed> */
    public static function orderColumns(array $t): array
    {
        return [
            'gross_total'      => $t['grossTotal'],
            'vat_rate'         => $t['vatRate'],
            'less_vat'         => $t['lessVat'],
            'net_of_vat'       => $t['netOfVat'],
            'sc_pwd_discount'  => $t['scPwdDiscount'],
            'vatable_sales'    => $t['vatableSales'],
            'vat_amount'       => $t['vatAmount'],
            'vat_exempt_sales' => $t['vatExemptSales'],
            'sc_pwd_type'      => $t['scPwd']['type'] ?? null,
            'sc_pwd_id'        => $t['scPwd']['id'] ?? null,
            'sc_pwd_name'      => $t['scPwd']['name'] ?? null,
            'withholding_rate' => $t['withholdingRate'],
            'withholding_tax'  => $t['withholdingTax'],
        ];
    }

    /** An order's stored tax breakdown, in the shape the invoice reads. */
    public static function describeOrder(array $r): array
    {
        $total = (float) $r['total'];
        $wht   = (float) ($r['withholding_tax'] ?? 0);
        /* Interest for buying on Net terms (Payments::applyInterest), part of what the retailer owes. */
        $int   = (float) ($r['term_interest'] ?? 0);
        return [
            'grossTotal'      => (float) ($r['gross_total'] ?? $total),
            'vatRate'         => $r['vat_rate'] === null ? null : (float) $r['vat_rate'],
            'lessVat'         => (float) ($r['less_vat'] ?? 0),
            'netOfVat'        => (float) ($r['net_of_vat'] ?? 0),
            'scPwdDiscount'   => (float) ($r['sc_pwd_discount'] ?? 0),
            'vatableSales'    => (float) ($r['vatable_sales'] ?? 0),
            'vatAmount'       => (float) ($r['vat_amount'] ?? 0),
            'vatExemptSales'  => (float) ($r['vat_exempt_sales'] ?? 0),
            'zeroRatedSales'  => 0.0,
            'total'           => $total,
            'withholdingRate' => $r['withholding_rate'] === null ? null : (float) $r['withholding_rate'],
            'withholdingTax'  => $wht,
            'termInterestRate' => isset($r['term_interest_rate']) ? (float) $r['term_interest_rate'] : null,
            'termInterest'    => $int,
            'amountDue'       => round($total - $wht + $int, 2),
            'shippingFee'     => (float) ($r['shipping_fee'] ?? 0),
            'shipping'        => (float) ($r['shipping_fee'] ?? 0) > 0 ? [
                'fee'         => (float) $r['shipping_fee'],
                'zone'        => $r['shipping_zone'] ?? null,
                'distanceKm'  => isset($r['shipping_km']) ? (float) $r['shipping_km'] : null,
                'weightKg'    => isset($r['shipping_weight_kg']) ? (float) $r['shipping_weight_kg'] : null,
                'destination' => $r['shipping_destination'] ?? null,
                /* Estimated arrival and island/remote flag (migration 038). */
                'remote'      => !empty($r['shipping_remote']),
                'etaFrom'     => $r['eta_from'] ?? null,
                'etaTo'       => $r['eta_to'] ?? null,
            ] : null,
            'scPwd'           => $r['sc_pwd_type'] === null ? null : [
                'type' => $r['sc_pwd_type'],
                'id'   => $r['sc_pwd_id'],
                'name' => $r['sc_pwd_name'],
            ],
        ];
    }

    /** The column list every order reader selects for describeOrder(). */
    public static function selectColumns(string $alias = 'o'): string
    {
        $cols = ['gross_total', 'vat_rate', 'less_vat', 'net_of_vat', 'sc_pwd_discount', 'vatable_sales',
                 'vat_amount', 'vat_exempt_sales', 'sc_pwd_type', 'sc_pwd_id', 'sc_pwd_name',
                 'withholding_rate', 'withholding_tax'];
        /* Estimated delivery fee (migration 021), when applied. */
        if (class_exists('Shipping') && Shipping::ready()) {
            array_push($cols, 'shipping_fee', 'shipping_zone', 'shipping_km', 'shipping_weight_kg', 'shipping_destination');
        }
        /* Estimated arrival (migration 038), when applied. */
        if (class_exists('Shipping') && Shipping::etaReady()) {
            array_push($cols, 'shipping_remote', 'eta_from', 'eta_to');
        }
        /* Interest for buying on Net terms (migration 037), when applied. */
        if (class_exists('Payments') && Payments::interestReady()) {
            array_push($cols, 'term_interest_rate', 'term_interest');
        }
        return implode(', ', array_map(static fn(string $c): string => "{$alias}.{$c}", $cols));
    }
}
