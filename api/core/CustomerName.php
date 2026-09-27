<?php
/**
 * Customer first / last name (migration 019).
 *
 * customers.name remains the single display name everything else reads; this
 * keeps it equal to "first last" and stores the two halves beside it. Gated on
 * the columns existing, so the code is safe on a database not yet migrated —
 * there the halves are only derived, never stored.
 */
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

    /**
     * Read first_name / last_name from a request body.
     * Returns null when the body carries neither (an old page posting `name`).
     * Adds messages to $errors under the keys first_name / last_name.
     */
    public static function fromInput(array $in, array &$errors): ?array
    {
        if (!array_key_exists('first_name', $in) && !array_key_exists('last_name', $in)) {
            return null;
        }
        $first = preg_replace('/\s+/u', ' ', trim((string) ($in['first_name'] ?? '')));
        $last  = preg_replace('/\s+/u', ' ', trim((string) ($in['last_name'] ?? '')));
        if ($first === '')              $errors['first_name'] = 'Your first name is required.';
        elseif (mb_strlen($first) > 60) $errors['first_name'] = 'Keep it under 60 characters.';
        if ($last === '')               $errors['last_name'] = 'Your last name is required.';
        elseif (mb_strlen($last) > 60)  $errors['last_name'] = 'Keep it under 60 characters.';
        return ['first' => $first, 'last' => $last, 'full' => trim($first . ' ' . $last)];
    }

    /** Store the halves (no-op before the migration). customers.name is the caller's. */
    public static function write(string $customerId, string $first, string $last): void
    {
        if (!self::ready()) return;
        Database::run(
            'UPDATE customers SET first_name = ?, last_name = ? WHERE id = ?',
            [$first, $last, $customerId]
        );
    }

    /** firstName / lastName for a customer: stored if saved, otherwise suggested. */
    public static function parts(string $customerId, string $fullName): array
    {
        if (self::ready()) {
            $r = Database::one('SELECT first_name, last_name FROM customers WHERE id = ?', [$customerId]);
            if ($r && trim((string) $r['first_name']) !== '' && trim((string) $r['last_name']) !== '') {
                return ['firstName' => $r['first_name'], 'lastName' => $r['last_name']];
            }
        }
        [$f, $l] = self::split($fullName);
        return ['firstName' => $f, 'lastName' => $l];
    }

    /**
     * Best guess for a name never saved in halves. Filipino surnames often
     * start with a particle ("De Lara", "dela Cruz", "Delos Santos",
     * "San Jose"), so the last name starts at the first particle after the
     * first word; otherwise it is the last word.
     */
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
