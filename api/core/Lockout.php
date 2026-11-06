<?php
declare(strict_types=1);

/** Lockout is the single progressive sign-in throttle for all four password paths: 3 free failures, then 2, 4, 6... minutes (max 10 for customers, 30 for staff), reset on success or after 30 quiet minutes, keyed on email plus IP so nobody can lock out someone else. */
final class Lockout
{
    /** Storefront: cheap to get wrong, low value behind it. */
    public const CTX_CUSTOMER = 'customer';
    /** Portal: real privileges behind it, so a higher ceiling. */
    public const CTX_STAFF    = 'staff';

    /** Seconds the caller must still wait (0 = not locked); read-only, so it can be called any time. */
    public static function secondsRemaining(string $email, string $context = self::CTX_CUSTOMER): int
    {
        if (!self::available()) {
            return 0;
        }

        $cfg   = self::config();
        $ip    = self::ip();
        $decay = (int) $cfg['decay_seconds'];

        /* The streak is simply the failed rows still on record for this key, since a success deletes them and old ones age out. */
        $row = Database::one(
            'SELECT COUNT(*) AS n, UNIX_TIMESTAMP(MAX(attempted_at)) AS last_at
               FROM login_attempts
              WHERE email = ? AND ip_address = ? AND context = ? AND successful = 0
                AND attempted_at > (NOW() - INTERVAL ? SECOND)',
            [$email, $ip, $context, $decay]
        );

        $fails = (int) ($row['n'] ?? 0);
        if ($fails <= (int) $cfg['free_attempts']) {
            return 0;
        }

        $penalty = self::penaltyFor($fails, $context);
        /* The wait runs from the last failure, so each new failure restarts a longer wait. */
        $until   = (int) ($row['last_at'] ?? 0) + $penalty;
        $now     = self::nowFromDb();

        return $until > $now ? $until - $now : 0;
    }

    /** Refuse with 429 if this key is locked, before the password is even checked. */
    public static function enforce(string $email, string $context = self::CTX_CUSTOMER): void
    {
        self::sprayCheck();

        $wait = self::secondsRemaining($email, $context);
        if ($wait > 0) {
            /* Use a distinct lockout message with retryAfter so the sign-in form can show a countdown instead of "incorrect password". */
            Response::rateLimited(
                'Too many failed sign-in attempts. Try again in ' . self::humanWait($wait) . '.',
                $wait
            );
        }
    }

    /** Record one attempt; a success clears the streak for this key. */
    public static function record(string $email, bool $success, string $context = self::CTX_CUSTOMER): void
    {
        if (!self::available()) {
            return;
        }

        $ip = self::ip();

        Database::run(
            'INSERT INTO login_attempts (email, ip_address, context, successful) VALUES (?, ?, ?, ?)',
            [$email, $ip, $context, $success ? 1 : 0]
        );

        if ($success) {
            /* Clear only this email+IP key, so the real owner signing in elsewhere never resets an attacker's streak. */
            Database::run(
                'DELETE FROM login_attempts
                  WHERE email = ? AND ip_address = ? AND context = ? AND successful = 0',
                [$email, $ip, $context]
            );
        }
    }

    /** Record a failure and refuse immediately if that failure triggered the lock, so the user is told on that same attempt. */
    public static function recordFailure(string $email, string $context = self::CTX_CUSTOMER): void
    {
        self::record($email, false, $context);

        $wait = self::secondsRemaining($email, $context);
        if ($wait > 0) {
            Response::rateLimited(
                'Too many failed sign-in attempts. Try again in ' . self::humanWait($wait) . '.',
                $wait
            );
        }
    }

    /** Failed tries left before the next failure starts a wait (0 once a wait is in force), so the sign-in message can warn honestly. */
    public static function attemptsLeft(string $email, string $context = self::CTX_CUSTOMER): int
    {
        if (!self::available()) {
            return 0;
        }
        $fails = (int) Database::scalar(
            'SELECT COUNT(*) FROM login_attempts
              WHERE email = ? AND ip_address = ? AND context = ? AND successful = 0
                AND attempted_at > (NOW() - INTERVAL ? SECOND)',
            [$email, self::ip(), $context, (int) self::config()['decay_seconds']]
        );
        return max(0, (int) self::config()['free_attempts'] - $fails);
    }

    /** Wait time in seconds after $fails consecutive failures (public so tests can read the policy). */
    public static function penaltyFor(int $fails, string $context = self::CTX_CUSTOMER): int
    {
        $cfg  = self::config();
        $free = (int) $cfg['free_attempts'];
        if ($fails <= $free) {
            return 0;
        }
        $cap = (int) ($context === self::CTX_STAFF
            ? $cfg['max_lock_seconds_staff']
            : $cfg['max_lock_seconds']);

        return min(($fails - $free) * (int) $cfg['step_seconds'], $cap);
    }

    /** Block an IP that fails against too many different emails in the window, catching password spraying that per-account limits miss. */
    private static function sprayCheck(): void
    {
        $cfg = self::config();
        $max = (int) $cfg['ip_distinct_emails'];
        if ($max <= 0) {
            return;
        }

        $window = (int) $cfg['decay_seconds'];
        $n = (int) Database::scalar(
            'SELECT COUNT(DISTINCT email) FROM login_attempts
              WHERE ip_address = ? AND successful = 0
                AND attempted_at > (NOW() - INTERVAL ? SECOND)',
            [self::ip(), $window]
        );

        if ($n >= $max) {
            Response::rateLimited(
                'Too many failed sign-in attempts from this network. Try again later.',
                $window
            );
        }
    }

    /** "2 minutes", "90 seconds" — whichever a person can act on. */
    public static function humanWait(int $seconds): string
    {
        if ($seconds < 60) {
            return $seconds . ' second' . ($seconds === 1 ? '' : 's');
        }
        $mins = (int) ceil($seconds / 60);
        return $mins . ' minute' . ($mins === 1 ? '' : 's');
    }

    /** The lockout policy with built-in defaults, so an older config.php without these keys never disables the protection. */
    private static function config(): array
    {
        $sec = Database::config()['security'] ?? [];
        return [
            'free_attempts'          => $sec['lockout_free_attempts']     ?? 3,
            'step_seconds'           => $sec['lockout_step_seconds']      ?? 120,
            'max_lock_seconds'       => $sec['lockout_max_seconds']       ?? 600,
            'max_lock_seconds_staff' => $sec['lockout_max_seconds_staff'] ?? 1800,
            'decay_seconds'          => $sec['lockout_decay_seconds']     ?? 1800,
            'ip_distinct_emails'     => $sec['lockout_ip_distinct_emails'] ?? 12,
        ];
    }

    /** The caller's IP (fits IPv6), or a fixed placeholder when missing so every row has a usable key. */
    private static function ip(): string
    {
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        return $ip === '' ? 'cli' : substr($ip, 0, 45);
    }

    /** Current time from the database clock, so it matches the stored attempt timestamps regardless of PHP's timezone. */
    private static function nowFromDb(): int
    {
        return (int) Database::scalar('SELECT UNIX_TIMESTAMP()');
    }

    /** The table is created by db/schema-additions.sql; absence disables the control. */
    private static ?bool $available = null;

    private static function available(): bool
    {
        return self::$available ??= Database::hasTable('login_attempts');
    }
}
