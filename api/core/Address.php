<?php
declare(strict_types=1);

/** Address resolves a Philippine address from PSGC codes for every endpoint: names always come from the ph_* tables, the region/province/city/barangay chain is checked, and a free-text line is accepted only while the location data is not loaded. */
final class Address
{
    /* How much of an address a form requires: true = everything (delivery, business), LOCATION = region to barangay (sign-up), false = optional but anything started must be finished (profile). */
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

    /** Is location data loaded? Cached per request. */
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

    /** Resolve a posted address or stop with field errors; when $required is false an empty address returns null but a partly filled one must be completed. */
    public static function resolve(?array $in, bool|string $required): ?array
    {
        [$address, $errors] = self::check($in, $required);
        if ($errors) {
            Response::validation('Please complete the address.', $errors);
        }
        return $address;
    }

    /** Like resolve() but returns [address, errors] instead of stopping, so callers can report all field errors together. */
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
        /* One message per field, in order, so the first error shown is the first thing to fix. */
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

        /* One query walks the chain up from the barangay, and the code below checks it against what was posted. */
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
            /* For a city with no province, the province slot must hold the city's own code or nothing. */
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

    /** Build the single printable address line for receipts, invoices and courier labels, showing the region only when there is no province. */
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
