<?php
declare(strict_types=1);

/**
 * Tax — the one definition of how a sale's VAT is worked out.
 *
 * Every figure on a Sales Invoice comes from compute() below, run on the server
 * at the moment of sale and stored with the order (migration 014). Nothing
 * recalculates an order afterwards: an invoice is a legal record, and a rule
 * changed in VAT Maintenance next year must not rewrite this year's invoices.
 *
 * THE THREE THINGS BEYOND "12% OF EVERYTHING"
 * -------------------------------------------
 *   VAT-exempt products   products.tax_type = 'exempt'. Their shelf price has no
 *                         VAT inside it, so the whole line is VAT-Exempt Sales.
 *   Senior citizen / PWD  a discount on the amount NET of VAT; by default the
 *                         discounted sale is VAT-exempt (RA 9994 / RA 10754).
 *                         Rate, exemption and a weekly peso cap per ID are
 *                         settings, because which rule applies to grocery goods
 *                         is the client's accountant's call, not this file's.
 *   Withholding tax       a retailer registered as a withholding agent keeps a
 *                         percentage of the amount net of VAT and remits it to
 *                         the BIR on the seller's behalf (BIR Form 2307). The
 *                         sale is unchanged; the cash due is less.
 *
 * Zero-rated sales are not handled: they are export sales, and the system does
 * not sell for export. The invoice line prints 0.00.
 *
 * ROUNDING
 * --------
 * Each figure is rounded once, and the last figure of any group is taken as
 * the REMAINDER rather than rounded independently. So VATable Sales + VAT +
 * VAT-Exempt Sales always equals the total to the centavo, and the invoice
 * never shows columns that do not add up.
 */
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
    ];

    /** Accepted ranges, for VAT Maintenance's save and for reading back. */
    public const LIMITS = [
        'vat_rate'                 => [0.0, 50.0],
        'sc_pwd_enabled'           => [0.0, 1.0],
        'sc_pwd_discount_rate'     => [0.0, 100.0],
        'sc_pwd_vat_exempt'        => [0.0, 1.0],
        'sc_pwd_weekly_cap'        => [0.0, 1000000.0],
        'withholding_default_rate' => [0.0, 50.0],
    ];

    /** @var array<string,float>|null */
    private static ?array $cache = null;

    /**
     * The current rules, read once per request and coerced to numbers here —
     * they are operator input, and a value outside its range falls back to the
     * default rather than producing a 500% discount.
     *
     * @return array<string,float>
     */
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

    /**
     * The withholding rate for a buyer, or null when they do not withhold.
     *
     * Only a CURRENT retailer: an agent row left behind for an account later
     * archived or demoted must not start deducting tax from a regular sale.
     */
    public static function withholdingRateFor(?string $customerId): ?float
    {
        if ($customerId === null || $customerId === '') {
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

    /**
     * SC/PWD discount already given to one ID number this week (Monday–Sunday),
     * for the weekly cap. Cancelled orders gave nothing and are not counted.
     */
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

    /**
     * Read and validate a senior citizen / PWD block from a request body.
     *
     * Returns null when the sale is not an SC/PWD sale. Adds messages to
     * $errors and returns null when it is but the details are incomplete —
     * the BIR requires the ID number and the name on the invoice, so a
     * discount without them is not one this system will record.
     *
     * @param array<string,mixed>  $in
     * @param array<string,string> $errors
     * @return array{type:string,id:string,name:string}|null
     */
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
            $errors['sc_pwd'] = 'Senior citizen and PWD discounts are switched off in VAT Maintenance.';
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

    /**
     * The whole VAT breakdown for one sale.
     *
     * @param array<int,array{gross:float,tax_type:string}> $lines  shelf price × qty per line
     * @param array{type:string,id:string,name:string}|null $scPwd
     * @param float|null $withholdingRate  percent, or null when the buyer does not withhold
     * @return array<string,mixed>
     */
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
                /* Not exempt: the discount falls on both parts in proportion,
                   and VAT is charged again on what is left of the VATable part. */
                $share        = $net > 0 ? $afterDiscount / $net : 0.0;
                $vatableSales = self::r2($vatNet * $share);
                $exemptSales  = self::r2($afterDiscount - $vatableSales);
                $vatAmount    = self::r2($vatableSales * $rate);
            }
            /* Stated as the remainder so the invoice's right-hand column —
               net − discount + VAT — lands exactly on the total. */
            $discount = self::r2($net - $vatableSales - $exemptSales);
        } else {
            $discount     = 0.0;
            $vatableSales = $vatNet;
            $vatAmount    = $lessVat;
            $exemptSales  = $exGross;
        }

        $total = self::r2($vatableSales + $vatAmount + $exemptSales);

        $whtRate = ($withholdingRate !== null && $withholdingRate > 0) ? $withholdingRate : null;
        /* Withheld on the amount net of VAT — the tax is on the sale, not on
           the VAT collected for the government. */
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

    /**
     * Priced lines for a PREVIEW (pos/quote.php, shop/quote.php).
     *
     * Reads price and tax type from the database like the checkouts do, but
     * checks no stock and locks nothing: a quote reserves nothing, and the
     * checkout re-reads every figure inside its own transaction anyway.
     *
     * @param mixed $items  [{id, qty}, …] as posted
     * @return array<int,array{gross:float,tax_type:string}>
     */
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

    /**
     * An order row's stored breakdown, in the shape the invoice reads.
     * Every reader of an order that can print an invoice returns this block.
     *
     * @param array<string,mixed> $r  an orders row selected with the 014 columns
     * @return array<string,mixed>
     */
    public static function describeOrder(array $r): array
    {
        $total = (float) $r['total'];
        $wht   = (float) ($r['withholding_tax'] ?? 0);
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
            'amountDue'       => round($total - $wht, 2),
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
        return implode(', ', array_map(static fn(string $c): string => "{$alias}.{$c}", $cols));
    }
}
