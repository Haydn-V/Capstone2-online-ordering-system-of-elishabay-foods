<?php
/** Customer first/last name (migration 019): customers.name stays the display name, with the two halves stored beside it only when those columns exist. */
final class CustomerName
{
    private static ?bool $ready = null;

    public static function ready(): bool
    {
        return self::$ready ??= (bool) Database::scalar(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            ['customers', 'last_name']
        );
    }

    /** Read first_name/last_name from the request (null if neither is sent) and add any errors to $errors. */
    public static function fromInput(array $in, array &$errors): ?array
    {
        if (!array_key_exists('first_name', $in) && !array_key_exists('last_name', $in)) {
            return null;
        }
        $first = self::proper((string) ($in['first_name'] ?? ''));
        $last  = self::proper((string) ($in['last_name'] ?? ''));
        if ($first === '')              $errors['first_name'] = 'Your first name is required.';
        elseif (mb_strlen($first) > 60) $errors['first_name'] = 'Keep it under 60 characters.';
        elseif (!self::valid($first))   $errors['first_name'] = 'Use letters only (spaces, hyphens, apostrophes and periods are fine).';
        if ($last === '')               $errors['last_name'] = 'Your last name is required.';
        elseif (mb_strlen($last) > 60)  $errors['last_name'] = 'Keep it under 60 characters.';
        elseif (!self::valid($last))    $errors['last_name'] = 'Use letters only (spaces, hyphens, apostrophes and periods are fine).';
        /* Middle name is optional; only its initial appears in the name shown everywhere. */
        $middle = self::proper((string) ($in['middle_name'] ?? ''));
        if ($middle !== '' && mb_strlen($middle) > 60) $errors['middle_name'] = 'Keep it under 60 characters.';
        elseif ($middle !== '' && !self::valid($middle)) $errors['middle_name'] = 'Use letters only (spaces, hyphens, apostrophes and periods are fine).';
        return ['first' => $first, 'middle' => $middle, 'last' => $last, 'full' => self::display($first, $middle, $last)];
    }

    /** A name written properly: each word starts with a capital ("juan dela cruz" -> "Juan Dela Cruz", also after a
        hyphen or apostrophe: "mary-ann", "o'neil"). A word typed in mixed case (McArthur, DeGuzman) is kept as typed
        apart from its first letter; suffixes stay as written (Jr., Sr., II, III, IV). Mirrors properName() in site.js. */
    public static function proper(string $name): string
    {
        $name = preg_replace('/\s+/u', ' ', trim($name));
        $words = explode(' ', $name);
        foreach ($words as $i => &$w) {
            if ($w === '') continue;
            if ($i > 0 && preg_match('/^(ii|iii|iv|vi|vii|viii|ix)$/iu', $w)) { $w = mb_strtoupper($w); continue; }
            $lower = mb_strtolower($w);
            if ($w !== $lower && $w !== mb_strtoupper($w)) {
                /* Mixed case on purpose: only make sure it starts with a capital. */
                $w = mb_strtoupper(mb_substr($w, 0, 1)) . mb_substr($w, 1);
                continue;
            }
            $w = preg_replace_callback("/(^|[-'’])(\p{L})/u",
                static fn(array $m): string => $m[1] . mb_strtoupper($m[2]), $lower);
        }
        return implode(' ', $words);
    }

    /** The name shown everywhere (customers.name): first name, middle initial, last name.
        "Juan", "Dizon", "Dela Cruz" -> "Juan D. Dela Cruz"; no middle name -> "Juan Dela Cruz". */
    public static function display(string $first, string $middle, string $last): string
    {
        $initial = $middle !== '' ? mb_strtoupper(mb_substr($middle, 0, 1)) . '.' : '';
        return trim(preg_replace('/\s+/u', ' ', "$first $initial $last"));
    }

    /** Letters, spaces, hyphens, apostrophes and periods only (no digits or symbols). */
    public static function valid(string $name): bool
    {
        return (bool) preg_match("/^[\p{L}][\p{L}\p{M} .'’-]*$/u", $name);
    }

    /** Save the two halves (does nothing before the migration); the caller saves customers.name. */
    public static function write(string $customerId, string $first, string $last, ?string $middle = null): void
    {
        if (!self::ready()) return;
        Database::run(
            'UPDATE customers SET first_name = ?, last_name = ? WHERE id = ?',
            [$first, $last, $customerId]
        );
        /* The full middle name (migration 039); only its initial is shown. */
        if ($middle !== null && self::middleReady()) {
            Database::run('UPDATE customers SET middle_name = ? WHERE id = ?', [$middle === '' ? null : $middle, $customerId]);
        }
    }

    public static function middleReady(): bool
    {
        static $ready = null;
        return $ready ??= self::ready() && Database::hasColumn('customers', 'middle_name');
    }

    /** firstName / lastName for a customer: stored if saved, otherwise suggested. */
    public static function parts(string $customerId, string $fullName): array
    {
        if (self::ready()) {
            $r = Database::one('SELECT first_name, last_name' . (self::middleReady() ? ', middle_name' : '') . ' FROM customers WHERE id = ?', [$customerId]);
            if ($r && trim((string) $r['first_name']) !== '' && trim((string) $r['last_name']) !== '') {
                return ['firstName' => $r['first_name'], 'middleName' => $r['middle_name'] ?? '', 'lastName' => $r['last_name']];
            }
        }
        [$f, $l] = self::split($fullName);
        return ['firstName' => $f, 'middleName' => '', 'lastName' => $l];
    }

    /** Guess first/last from a full name, treating Filipino surname particles (De, dela, Delos, San) as the start of the last name. */
    public static function split(string $full): array
    {
        $w = preg_split('/\s+/u', trim($full), -1, PREG_SPLIT_NO_EMPTY);
        if (count($w) < 2) return [$full, ''];
        $particles = ['de', 'del', 'dela', 'delos', 'de los', 'della', 'di', 'da', 'dos', 'san', 'santa', 'sta.', 'sto.', 'santo', 'van', 'von', 'la', 'le', 'mac', 'mc'];
        for ($i = 1; $i < count($w) - 1; $i++) {
            if (in_array(mb_strtolower($w[$i]), $particles, true)) {
                return [implode(' ', array_slice($w, 0, $i)), implode(' ', array_slice($w, $i))];
            }
        }
        return [implode(' ', array_slice($w, 0, -1)), end($w)];
    }
}
