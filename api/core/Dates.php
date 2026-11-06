<?php
declare(strict_types=1);

/** All date logic in one place, in Asia/Manila time, so PHP, MySQL and the browser never disagree about "today" or what a week is (the client asks api/system/dates.php instead of computing). */
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

    /** The date n days before today (negative n moves forward). */
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

    /** Named date ranges for reports and the dashboard, with weeks starting on Monday (change it here to change it everywhere). */
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

    /** The period of the same length just before [$from, $to], used for comparison figures. */
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

    /** Returns PHP's and MySQL's "today" when they disagree (null when they match), since a mismatch breaks date logic for part of each day. */
    public static function assertAgreesWithMysql(): ?array
    {
        $mysql = (string) Database::scalar('SELECT CURDATE()');
        $php   = self::today();
        return $mysql === $php ? null : ['php' => $php, 'mysql' => $mysql];
    }
}
