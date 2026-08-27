<?php
declare(strict_types=1);

/**
 * Every date the system reasons about, resolved in one place.
 *
 * D1. Asia/Manila throughout, no UTC conversion anywhere in the stack. The
 * Philippines has one timezone and no DST, so conversion buys nothing and has
 * already cost this project a class of bugs.
 *
 * WHY THE CLIENT NO LONGER COMPUTES RANGES
 * ----------------------------------------
 * It computed them in parallel and got a different answer. Measured:
 *
 *     PHP   strtotime('monday this week')  ->  2026-08-17  (Monday)
 *     JS    d.setDate(d.getDate()-d.getDay())  ->  2026-08-16  (Sunday)
 *
 * so "This Week" on the Sales Report meant one thing in the headline figure and
 * another in the table beneath it. Neither was wrong in isolation; having two
 * was.
 *
 * There was a second, quieter failure. JavaScript parses `new Date("2026-06-17")`
 * as UTC and `new Date("2026-06-17T00:00:00")` as local, while `toISOString()`
 * always formats UTC. Mixing them made `addDays("2026-06-17", 30)` return 16
 * July rather than the 17th, so every NET-30 due date was a day early. Both
 * functions are banned in application code — `tools/verify-structure.py`
 * enforces it.
 *
 * The client now asks api/system/dates.php what a named range means and
 * formats what it is given. It does not compute.
 *
 * MYSQL AGREES BY CONFIGURATION, NOT BY LUCK
 * ------------------------------------------
 * MariaDB runs on SYSTEM time, and this machine is UTC+8, so CURDATE() matches
 * PHP's date() under Asia/Manila. Verified, not assumed. If the two ever
 * disagree, endpoints mixing CURDATE() with PHP dates will straddle a day
 * boundary for part of every day — Dates::assertAgreesWithMysql() exists to
 * catch that.
 */
final class Dates
{
    public const TZ = 'Asia/Manila';

    /** Today, as the business reckons it. */
    public static function today(): string
    {
        return self::now()->format('Y-m-d');
    }

    public static function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('now', new DateTimeZone(self::TZ));
    }

    /** n days before today. Negative n moves forward. */
    public static function daysAgo(int $n): string
    {
        return self::now()->modify(($n >= 0 ? '-' : '+') . abs($n) . ' days')->format('Y-m-d');
    }

    /** Add days to a YYYY-MM-DD string and get one back. */
    public static function addDays(string $ymd, int $n): string
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $ymd, new DateTimeZone(self::TZ));
        if ($d === false) {
            throw new InvalidArgumentException("Not a date: $ymd");
        }
        return $d->modify(($n >= 0 ? '+' : '-') . abs($n) . ' days')->format('Y-m-d');
    }

    /**
     * The named ranges the reports and dashboard offer.
     *
     * The week starts MONDAY. That is the ISO convention and the one the server
     * already used; the client's Sunday start was the odd one out. If the
     * business wants Sunday, change it here — in one place — and both ends
     * follow.
     *
     * @return array<string, array{from:?string, to:?string}>
     */
    public static function ranges(): array
    {
        $now   = self::now();
        $today = $now->format('Y-m-d');

        $monday    = $now->modify('monday this week')->format('Y-m-d');
        $lastMonSt = $now->modify('monday last week')->format('Y-m-d');
        $lastMonEn = $now->modify('sunday last week')->format('Y-m-d');

        $monthStart     = $now->format('Y-m-01');
        $lastMonthStart = $now->modify('first day of last month')->format('Y-m-d');
        $lastMonthEnd   = $now->modify('last day of last month')->format('Y-m-d');

        $lastYear = (int) $now->format('Y') - 1;

        return [
            'today'     => ['from' => $today,          'to' => $today],
            'yesterday' => ['from' => self::daysAgo(1),'to' => self::daysAgo(1)],
            'week'      => ['from' => $monday,         'to' => $today],
            'lastweek'  => ['from' => $lastMonSt,      'to' => $lastMonEn],
            'month'     => ['from' => $monthStart,     'to' => $today],
            'lastmonth' => ['from' => $lastMonthStart, 'to' => $lastMonthEnd],
            'year'      => ['from' => $now->format('Y-01-01'), 'to' => $today],
            'lastyear'  => ['from' => "$lastYear-01-01", 'to' => "$lastYear-12-31"],
            'all'       => ['from' => null,            'to' => null],
        ];
    }

    /** One named range, or null if the name is not one we offer. */
    public static function range(string $name): ?array
    {
        return self::ranges()[$name] ?? null;
    }

    /**
     * The period immediately before [$from,$to], of the same length — what a
     * comparison figure is measured against.
     */
    public static function previous(string $from, string $to): array
    {
        $s = new DateTimeImmutable($from, new DateTimeZone(self::TZ));
        $e = new DateTimeImmutable($to, new DateTimeZone(self::TZ));
        $days = (int) $s->diff($e)->days + 1;
        $prevEnd   = $s->modify('-1 day');
        $prevStart = $prevEnd->modify('-' . ($days - 1) . ' days');
        return ['from' => $prevStart->format('Y-m-d'), 'to' => $prevEnd->format('Y-m-d')];
    }

    /** True when a string is a real YYYY-MM-DD date (rejects 2026-02-30). */
    public static function isValid(string $ymd): bool
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $ymd, new DateTimeZone(self::TZ));
        return $d !== false && $d->format('Y-m-d') === $ymd;
    }

    /**
     * PHP's idea of today and MySQL's must match, or any endpoint mixing
     * CURDATE() with a PHP date straddles a day boundary for part of each day.
     * Returns the two values when they disagree, null when they agree.
     */
    public static function assertAgreesWithMysql(): ?array
    {
        $mysql = (string) Database::scalar('SELECT CURDATE()');
        $php   = self::today();
        return $mysql === $php ? null : ['php' => $php, 'mysql' => $mysql];
    }
}
