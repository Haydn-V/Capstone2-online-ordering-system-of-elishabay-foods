<?php
declare(strict_types=1);

/**
 * Lockout — the progressive sign-in throttle, in one place.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Four paths refuse a bad password: staff sign-in, customer sign-in, the
 * customer password change (shop/password.php) and the staff password change
 * (users/me-password.php). The last two share sign-in's counter *deliberately* —
 * password.php's header says so — because a stolen session must not become an
 * unlimited password oracle. Four call sites for one policy is exactly how
 * `products.sold` came to disagree with itself before Stock was extracted.
 *
 * WHAT REPLACED THE OLD POLICY
 * ----------------------------
 * It was: 5 failures inside 15 minutes, then a flat 15-minute refusal. Two
 * problems. A real customer who mistypes twice and then genuinely forgets is
 * locked out of their own account for a quarter of an hour, which is a long
 * time to be told nothing useful. And the counter was keyed on the EMAIL ALONE,
 * so anyone who knew a customer's address could lock them out of it on purpose
 * by failing five times — a denial-of-service built on purpose. See KEYING.
 *
 * THE POLICY NOW
 * --------------
 *   Failures 1-3   free. Typos happen, and charging for them buys nothing:
 *                  an attacker is not deterred by three attempts, only a real
 *                  person is inconvenienced.
 *   Failure 4      locked 2 minutes.
 *   Each further   +2 minutes: 4, 6, 8, 10 …
 *   Cap            10 minutes for customers, 30 for staff. See THE STAFF CAP.
 *   Success        clears the streak completely.
 *   Quiet period   30 minutes with no attempt at all resets the streak, so
 *                  somebody who failed twice this morning does not arrive this
 *                  evening one attempt from a lock.
 *
 * The lock is not a stored flag. It is derived: the streak length gives a
 * penalty, and the penalty runs from the moment of the LAST failure. Nothing
 * has to be scheduled, nothing has to be cleaned up, and a row that ages out of
 * the decay window stops counting on its own.
 *
 * KEYING: EMAIL **AND** IP, NEVER EMAIL ALONE
 * -------------------------------------------
 * Keying on the email alone means the throttle can be aimed at a victim: fail
 * four times against someone's address and they are locked out of their own
 * account, from their own machine, having done nothing. That is a
 * denial-of-service the system would be performing on its own users' behalf.
 *
 * Keyed on (email, IP), an attacker locks out only themselves. The cost is that
 * a distributed attacker gets a fresh budget per source address — which is why
 * there is a second, looser limit on the IP alone (see sprayCheck): one machine
 * failing against many different accounts is the pattern per-key limits cannot
 * see, and it is the one that actually indicates an attack rather than a
 * forgotten password.
 *
 * THE STAFF CAP IS HIGHER, DELIBERATELY
 * -------------------------------------
 * This change is a WEAKENING of a security control: ten minutes is less than
 * fifteen, and the first three attempts now cost nothing. For a storefront that
 * is a good trade — the realistic harm is a customer locked out of their own
 * order history, and the passwords guard a shopping cart. It is a worse trade
 * for the staff portal, where an account carries stock adjustments, refunds,
 * price changes and, for Super Admin, the permission table itself. So staff
 * keep the same free attempts (a cashier mistypes too) but escalate to a
 * 30-minute ceiling rather than 10.
 */
final class Lockout
{
    /** Storefront: cheap to get wrong, low value behind it. */
    public const CTX_CUSTOMER = 'customer';
    /** Portal: real privileges behind it, so a higher ceiling. */
    public const CTX_STAFF    = 'staff';

    /**
     * How long the caller must wait, in seconds. 0 means not locked.
     *
     * Reads only — it never writes, so a caller can ask before doing work and
     * ask again afterwards without inflating anything.
     */
    public static function secondsRemaining(string $email, string $context = self::CTX_CUSTOMER): int
    {
        if (!self::available()) {
            return 0;
        }

        $cfg   = self::config();
        $ip    = self::ip();
        $decay = (int) $cfg['decay_seconds'];

        /* The streak IS the surviving failed rows for this key: record() deletes
           them on success, so anything still here is consecutive by
           construction. The decay window does the forgetting. */
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
        /* Measured from the LAST failure, not the first. Each new failure
           restarts a longer wait, which is what makes it escalate. */
        $until   = (int) ($row['last_at'] ?? 0) + $penalty;
        $now     = self::nowFromDb();

        return $until > $now ? $until - $now : 0;
    }

    /**
     * Refuse with a 429 if this key is locked. Called before the password is
     * checked, so a locked-out caller cannot keep testing passwords.
     */
    public static function enforce(string $email, string $context = self::CTX_CUSTOMER): void
    {
        self::sprayCheck();

        $wait = self::secondsRemaining($email, $context);
        if ($wait > 0) {
            /* A DISTINCT MESSAGE, AND A NUMBER IN IT.

               The old one said "Email or password is incorrect" for this case
               too, which is why a lockout was indistinguishable from a typo and
               sent people back to retype a password that was already right.
               `retryAfter` lets the sign-in modal count down instead of leaving
               somebody guessing — see the handler in site.js. */
            Response::rateLimited(
                'Too many failed sign-in attempts. Try again in ' . self::humanWait($wait) . '.',
                $wait
            );
        }
    }

    /**
     * Record one attempt. A success wipes the streak for this key.
     */
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
            /* Scoped to this key, not to the email. Clearing every failure for
               the address would let a successful sign-in from one machine wipe
               an attacker's streak on another — handing them a free reset by
               waiting for the real owner to sign in. */
            Database::run(
                'DELETE FROM login_attempts
                  WHERE email = ? AND ip_address = ? AND context = ? AND successful = 0',
                [$email, $ip, $context]
            );
        }
    }

    /**
     * Record a failed attempt, then refuse if THAT failure created the lock.
     *
     * WHY THIS IS NOT JUST record(false).
     *
     * enforce() runs before the password is checked, so it can only see the
     * failures that came earlier. With three free attempts, the fourth wrong
     * password passes enforce() (three on record), fails, and is stored — and
     * the caller is told "incorrect", even though they are now locked. They
     * only discover it on the fifth attempt. That is a lock that announces
     * itself one attempt late, to somebody who has already been told to go and
     * retype the password.
     *
     * Checking again after recording makes the attempt that crosses the line
     * the one that says so.
     */
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

    /**
     * The wait after `$fails` consecutive failures, in seconds.
     *
     * Public because it is the policy, and a test that cannot read the policy
     * can only assert the numbers it was told to expect.
     */
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

    /**
     * ONE MACHINE, MANY ACCOUNTS — the pattern a per-key limit cannot see.
     *
     * (email, IP) keying is what stops the throttle being aimed at a victim,
     * but it also hands someone spraying one password across a thousand
     * addresses a fresh budget for every one of them. This is the backstop:
     * too many DISTINCT emails failing from a single address in the window and
     * that address is refused outright.
     *
     * The threshold is deliberately far above anything a household or an office
     * behind one NAT would reach by forgetting passwords — this is not a second
     * lockout, it is an "attack in progress" signal.
     */
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

    /**
     * The policy, with defaults.
     *
     * Defaults live here rather than only in config.php so an install whose
     * config predates this file still gets the policy instead of a set of
     * zeroes — which would read as "never lock" and silently remove the
     * control entirely.
     */
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

    /**
     * The caller's address, as the column stores it.
     *
     * VARCHAR(45) fits IPv6, which is what localhost actually sends (`::1`).
     * A missing REMOTE_ADDR becomes a literal rather than an empty string, so
     * every row has a usable key and CLI callers all share one bucket instead
     * of colliding with a real address.
     */
    private static function ip(): string
    {
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        return $ip === '' ? 'cli' : substr($ip, 0, 45);
    }

    /**
     * Now, according to the DATABASE.
     *
     * The failure timestamps come from MySQL's clock (`attempted_at` defaults
     * to CURRENT_TIMESTAMP). Comparing them against PHP's `time()` would drift
     * whenever the two disagree about the timezone — and on XAMPP they often
     * do, because PHP reads php.ini's date.timezone and MySQL does not. A few
     * hours of drift either way turns every lock permanent or every lock into
     * nothing.
     */
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
