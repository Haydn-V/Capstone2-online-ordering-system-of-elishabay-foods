<?php
declare(strict_types=1);

/**
 * Address — a Philippine address, resolved from PSGC codes, in one place.
 *
 * Four endpoints take an address: shop/checkout.php (delivery), shop/register.php
 * (the new account's), shop/profile.php (the saved one) and b2b/apply.php (the
 * business's). Four copies of "check the barangay belongs to the city" would
 * disagree within a release; this is the one copy.
 *
 * THE CLIENT SENDS CODES. NAMES COME FROM HERE.
 * --------------------------------------------
 * The picker posts region, province, city and barangay CODES plus the typed
 * street and ZIP. Every name that ends up stored — and printed on an invoice —
 * is looked up from ph_* by code. A name taken from the request would be a free
 * text field again with extra steps: "Makati" posted beside Dagupan's code.
 *
 * THE CHAIN IS CHECKED, NOT ASSUMED. The barangay must be in the city, the city
 * in the province (or, for a city with no province, in the region), the province
 * in the region. The picker cannot produce a broken chain; a stale form, a
 * PSGC refresh between page load and submit, or a hand-built request can. Each
 * is refused against the field that is wrong.
 *
 * CITIES WITH NO PROVINCE — Metro Manila, and highly urbanised cities
 * elsewhere — have province_code NULL. The picker offers them in its Province
 * list under their own name, so what it posts in the province slot is the
 * CITY's code. Accepted, and stored as a NULL province: see 015's header.
 *
 * BEFORE THE LOCATION DATA IS LOADED
 * ----------------------------------
 * db/seed-ph-locations.sql is generated from the PSA's file and loaded
 * separately. Until it is, there is nothing to pick from, and a checkout that
 * cannot take an address is a shop that cannot sell. So when ph_barangays is
 * empty this accepts the single free-text line the forms used to take, and the
 * picker shows that box instead of four empty dropdowns. The moment the seed is
 * loaded, both switch over with no deploy.
 */
final class Address
{
    /* How much of an address a form insists on.
         true        everything — a delivery, a business: couriers need the
                     street and the ZIP
         LOCATION    region through barangay, street and ZIP optional — the
                     Create Account form, whose old box asked only for
                     "barangay, city, province" and required it
         false       none of it — Profile — but anything started must be
                     finished */
    public const LOCATION = 'location';

    /** The error keys the picker maps back onto its own fields. */
    public const FIELD = [
        'region'   => 'addr_region',
        'province' => 'addr_province',
        'city'     => 'addr_city',
        'barangay' => 'addr_barangay',
        'street'   => 'addr_street',
        'zip'      => 'addr_zip',
        'line'     => 'addr_line',
    ];

    private static ?bool $available = null;

    /** Is there location data to resolve against? Cached per request. */
    public static function available(): bool
    {
        if (self::$available !== null) {
            return self::$available;
        }
        try {
            return self::$available = Database::hasTable('ph_barangays')
                && Database::scalar('SELECT 1 FROM ph_barangays LIMIT 1') !== false;
        } catch (Throwable) {
            return self::$available = false;
        }
    }

    /**
     * Resolve a posted address, or refuse with field errors.
     *
     * @param array|null $in        the `address` object from the request body
     * @param bool       $required  true: all of it must be present (a delivery,
     *                              a business). false: entirely empty is fine
     *                              and returns null, but anything STARTED must
     *                              be finished — half an address saved to a
     *                              profile would prefill half a checkout.
     *
     * @return array{region_code:?string, region:?string, province_code:?string,
     *   province:?string, city_code:?string, city:?string, barangay_code:?string,
     *   barangay:?string, sub_municipality:?string, street:?string, zip:?string,
     *   line:string}|null
     */
    public static function resolve(?array $in, bool|string $required): ?array
    {
        [$address, $errors] = self::check($in, $required);
        if ($errors) {
            Response::validation('Please complete the address.', $errors);
        }
        return $address;
    }

    /**
     * resolve(), without stopping: returns [address|null, errors].
     *
     * For an endpoint that validates several things and reports them TOGETHER.
     * shop/checkout.php collects its field errors before refusing, and an
     * address refused on its own first would make a customer fix it, resubmit,
     * and only then learn the contact number was wrong too.
     *
     * @return array{0: ?array, 1: array<string,string>}
     */
    public static function check(?array $in, bool|string $required): array
    {
        $in = $in ?? [];

        if (!self::available()) {
            return self::checkLegacyLine($in, $required);
        }

        $code = static function (string $k) use ($in): ?string {
            $v = preg_replace('/\D/', '', (string) ($in[$k] ?? ''));
            return $v === '' ? null : $v;
        };
        $region   = $code('region');
        $province = $code('province');
        $city     = $code('city');
        $barangay = $code('barangay');
        $street   = trim(preg_replace('/\s+/u', ' ', (string) ($in['street'] ?? '')));
        $zip      = trim((string) ($in['zip'] ?? ''));

        $touched = $region || $province || $city || $barangay || $street !== '' || $zip !== '';
        if (!$touched && $required === false) {
            return [null, []];
        }
        /* Street and ZIP are demanded only when the whole address is. */
        $full = $required === true;

        $err = [];
        /* In order, and one message per field, so the first thing a person sees
           is the first thing to fix. */
        if (!$region)   { $err[self::FIELD['region']]   = 'Choose your region.'; }
        if (!$city)     { $err[self::FIELD['city']]     = 'Choose your city or municipality.'; }
        if (!$barangay) { $err[self::FIELD['barangay']] = 'Choose your barangay.'; }
        if ($full && $street === '') {
            $err[self::FIELD['street']] = 'Enter your house number and street.';
        }
        if (mb_strlen($street) > 160) {
            $err[self::FIELD['street']] = 'Keep the house number and street under 160 characters.';
        }
        if ($full && $zip === '') {
            $err[self::FIELD['zip']] = 'Enter the 4-digit ZIP code.';
        } elseif ($zip !== '' && !preg_match('/^\d{4}$/', $zip)) {
            $err[self::FIELD['zip']] = 'A Philippine ZIP code is 4 digits.';
        }
        if ($err) {
            return [null, $err];
        }

        /* One query walks the whole chain from the leaf up. Everything below
           checks what it returns against what was posted. */
        $row = Database::one(
            'SELECT b.code AS barangay_code, b.name AS barangay, b.sub_municipality,
                    c.code AS city_code, c.name AS city, c.province_code, c.region_code,
                    p.name AS province, p.region_code AS province_region,
                    r.name AS region
               FROM ph_barangays b
               JOIN ph_cities   c ON c.code = b.city_code
               JOIN ph_regions  r ON r.code = c.region_code
          LEFT JOIN ph_provinces p ON p.code = c.province_code
              WHERE b.code = ?',
            [$barangay]
        );

        if ($row === null) {
            return [null, [self::FIELD['barangay'] => 'That barangay is not in our list. Choose it again.']];
        }
        if ($row['city_code'] !== $city) {
            return [null, [self::FIELD['barangay'] => 'That barangay is not in the city you chose. Choose it again.']];
        }
        if ($row['region_code'] !== $region) {
            return [null, [self::FIELD['city'] => 'That city is not in the region you chose. Choose it again.']];
        }
        if ($row['province_code'] === null) {
            /* Province-less city: the picker put the CITY's code in the province
               slot, or nothing. Anything else is a province it does not belong to. */
            if ($province !== null && $province !== $row['city_code']) {
                return [null, [self::FIELD['province'] => 'That city is not part of a province. Choose it again.']];
            }
        } elseif ($province !== $row['province_code']) {
            return [null, [self::FIELD[$province === null ? 'province' : 'city'] => $province === null
                ? 'Choose your province.'
                : 'That city is not in the province you chose. Choose it again.']];
        }

        $a = [
            'region_code'      => $row['region_code'],
            'region'           => $row['region'],
            'province_code'    => $row['province_code'],
            'province'         => $row['province'],
            'city_code'        => $row['city_code'],
            'city'             => $row['city'],
            'barangay_code'    => $row['barangay_code'],
            'barangay'         => $row['barangay'],
            'sub_municipality' => $row['sub_municipality'],
            'street'           => $street === '' ? null : $street,
            'zip'              => $zip === '' ? null : $zip,
        ];
        $a['line'] = self::compose($a);
        return [$a, []];
    }

    /**
     * The single printable line: receipts, invoices, courier labels.
     *
     *   123 Rizal St, Poblacion, Dagupan City, Pangasinan 2400
     *   Blk 4 Lot 2, Barangay 105, Tondo I, City of Manila, National Capital Region (NCR) 1013
     *
     * The REGION appears only when there is no province — it is what gives a
     * courier the context a province otherwise would. Barangay names are used
     * as published: prefixing "Brgy." to one already called "Barangay 105"
     * prints "Brgy. Barangay 105".
     */
    public static function compose(array $a): string
    {
        $parts = array_filter([
            $a['street']           ?? null,
            $a['barangay']         ?? null,
            $a['sub_municipality'] ?? null,
            $a['city']             ?? null,
            ($a['province'] ?? null) ?: ($a['region'] ?? null),
        ], static fn($v) => $v !== null && $v !== '');
        $line = implode(', ', $parts);
        return !empty($a['zip']) ? $line . ' ' . $a['zip'] : $line;
    }

    /** Before the PSGC data is loaded: the one free-text line, as before. */
    private static function checkLegacyLine(array $in, bool|string $required): array
    {
        $line = trim(preg_replace('/\s+/u', ' ', (string) ($in['line'] ?? '')));
        if ($line === '') {
            return $required !== false
                ? [null, [self::FIELD['line'] => 'Enter your full address.']]
                : [null, []];
        }
        if (mb_strlen($line) > 300) {
            return [null, [self::FIELD['line'] => 'Keep the address under 300 characters.']];
        }
        return [[
            'region_code' => null, 'region' => null, 'province_code' => null, 'province' => null,
            'city_code' => null, 'city' => null, 'barangay_code' => null, 'barangay' => null,
            'sub_municipality' => null, 'street' => null, 'zip' => null,
            'line' => $line,
        ], []];
    }
}
