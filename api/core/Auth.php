<?php
declare(strict_types=1);

/**
 * Server-side authentication.
 *
 * Replaces the previous arrangement entirely: the browser used to hold a
 * STAFF_ACCOUNTS array with plaintext passwords and compare them in JS, which
 * meant every visitor was served every staff credential. Nothing here trusts
 * the client — the session cookie is the only thing the browser gets, and the
 * role is read back out of the database on every request.
 */
final class Auth
{
    private const SESSION_USER = 'eb_user_id';
    private const SESSION_TIME = 'eb_last_seen';
    /* Customers are a separate table and a separate session key on purpose.
       A shopper signing in must never land in the same slot that grants staff
       permissions — one key holding either kind of identity is exactly how a
       customer ends up passing an Rbac check. */
    private const SESSION_CUSTOMER = 'eb_customer_id';

    private static ?array $user = null;
    private static ?array $customer = null;

    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        $sec = Database::config()['security'];

        session_name($sec['session_name'] ?? 'eb_session');
        session_set_cookie_params([
            'lifetime' => 0,                                  // dies with the browser
            'path'     => Database::config()['app']['base_path'] ?? '/',
            'httponly' => $sec['cookie_httponly'] ?? true,    // JS cannot read it
            'samesite' => $sec['cookie_samesite'] ?? 'Lax',   // blocks cross-site sends
            'secure'   => $sec['cookie_secure'] ?? false,     // must be true under HTTPS
        ]);
        session_start();

        /* Idle timeout. Checked here rather than relying on the cookie so that
           a stolen session id also expires. */
        $lifetime = (int) ($sec['session_lifetime'] ?? 7200);
        if (isset($_SESSION[self::SESSION_TIME]) && (time() - $_SESSION[self::SESSION_TIME]) > $lifetime) {
            self::logout();
        }
        $_SESSION[self::SESSION_TIME] = time();
    }

    /**
     * Verify credentials and start a session.
     *
     * Returns the user row on success. On failure it throws the standard
     * error response — deliberately the same message whether the email is
     * unknown or the password is wrong, so the endpoint cannot be used to
     * enumerate which staff addresses exist.
     */
    public static function attempt(string $email, string $password): array
    {
        self::throttle($email);

        $user = Database::one(
            'SELECT u.id, u.name, u.email, u.password, u.avatar, u.status,
                    u.role_id, r.name AS role, r.is_system
               FROM users u
               LEFT JOIN roles r ON r.id = u.role_id
              WHERE u.email = ?',
            [$email]
        );

        $ok = $user !== null && password_verify($password, $user['password']);

        /* password_verify on a dummy hash when the user does not exist, so a
           missing account and a wrong password take a similar amount of time.
           Skipping it would make user enumeration possible by stopwatch. */
        if ($user === null) {
            password_verify($password, '$2y$10$usesomesillystringfteonwiuhefoiwehfoiwehfoiwehfoiweh');
        }

        if (!$ok) {
            self::record($email, false);
            Response::error('UNAUTHENTICATED', 'Email or password is incorrect.', 401);
        }

        /* An archived account keeps its row and its history but must not be
           able to sign in. The old client-side check did this too; it is
           repeated here because that check no longer counts for anything. */
        if ($user['status'] === 'archived') {
            self::record($email, false);
            Response::forbidden('This account has been archived. Contact an administrator.');
        }

        if ($user['role'] === null) {
            self::record($email, false);
            Response::forbidden('This account has no role assigned. Contact an administrator.');
        }

        self::record($email, true);

        /* New session id on privilege change — stops session fixation, where
           an attacker plants a known session id before the victim logs in. */
        session_regenerate_id(true);

        $_SESSION[self::SESSION_USER] = $user['id'];
        $_SESSION[self::SESSION_TIME] = time();

        unset($user['password']);
        self::$user = $user;
        return $user;
    }

    /* ------------------------------------------------------------------
       Customer authentication.

       Deliberately separate from staff sign-in: different table, different
       session key, no role and no permissions. A customer session satisfies
       requireCustomer() and nothing else — Rbac::require() and Auth::require()
       both still refuse it.
       ------------------------------------------------------------------ */

    public static function attemptCustomer(string $email, string $password): array
    {
        $c = Database::one(
            'SELECT id, name, email, password, contact, status FROM customers WHERE email = ?',
            [$email]
        );

        $ok = $c !== null && $c['password'] !== null && password_verify($password, $c['password']);

        if ($c === null || $c['password'] === null) {
            /* Same dummy-hash timing guard as the staff path, and the same
               single message, so this cannot be used to discover which email
               addresses have accounts. */
            password_verify($password, '$2y$10$usesomesillystringfteonwiuhefoiwehfoiwehfoiwehfoiweh');
        }

        if (!$ok) {
            Response::error('UNAUTHENTICATED', 'Email or password is incorrect.', 401);
        }
        if ($c['status'] === 'archived') {
            Response::forbidden('This account is no longer active. Please contact us.');
        }

        session_regenerate_id(true);
        $_SESSION[self::SESSION_CUSTOMER] = $c['id'];
        $_SESSION[self::SESSION_TIME] = time();

        unset($c['password']);
        return self::$customer = $c;
    }

    /** The signed-in customer, or null. Re-read each request, like staff. */
    public static function customer(): ?array
    {
        if (self::$customer !== null) {
            return self::$customer;
        }
        $id = $_SESSION[self::SESSION_CUSTOMER] ?? null;
        if ($id === null) {
            return null;
        }
        $c = Database::one(
            'SELECT id, name, email, contact, status FROM customers WHERE id = ?',
            [$id]
        );
        if ($c === null || $c['status'] === 'archived') {
            unset($_SESSION[self::SESSION_CUSTOMER]);
            return null;
        }
        return self::$customer = $c;
    }

    /**
     * @param string $message shown to the visitor. Defaults to something
     *        generic, but a caller should say what the sign-in is FOR —
     *        "Sign in to view this" during checkout told the shopper nothing
     *        about why their order had not gone through.
     */
    public static function requireCustomer(string $message = 'Sign in to continue.'): array
    {
        $c = self::customer();
        if ($c === null) {
            Response::unauthenticated($message);
        }
        return $c;
    }

    /** True when anybody at all is signed in — used by the CSRF guard. */
    public static function hasAnySession(): bool
    {
        return !empty($_SESSION[self::SESSION_USER]) || !empty($_SESSION[self::SESSION_CUSTOMER]);
    }

    public static function logout(): void
    {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires'  => time() - 42000,
                'path'     => $p['path'],
                'httponly' => $p['httponly'],
                'samesite' => $p['samesite'],
                'secure'   => $p['secure'],
            ]);
        }
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_destroy();
        }
        self::$user = null;
        self::$customer = null;
    }

    /**
     * The signed-in user, or null.
     *
     * Re-read from the database rather than cached in the session, so that
     * archiving an account or changing its role takes effect on the very next
     * request instead of whenever they happen to log out.
     */
    public static function user(): ?array
    {
        if (self::$user !== null) {
            return self::$user;
        }
        $id = $_SESSION[self::SESSION_USER] ?? null;
        if ($id === null) {
            return null;
        }

        $user = Database::one(
            'SELECT u.id, u.name, u.email, u.avatar, u.status,
                    u.role_id, r.name AS role, r.is_system
               FROM users u
               LEFT JOIN roles r ON r.id = u.role_id
              WHERE u.id = ?',
            [$id]
        );

        if ($user === null || $user['status'] === 'archived' || $user['role'] === null) {
            self::logout();
            return null;
        }

        return self::$user = $user;
    }

    /** Require any signed-in user, or stop with 401. */
    public static function require(): array
    {
        $user = self::user();
        if ($user === null) {
            Response::unauthenticated();
        }
        return $user;
    }

    /**
     * Require one of the named roles, or stop with 403.
     *
     * Prefer Rbac::require() with a permission — roles are coarse, and the
     * permission table is what the Roles screen actually edits.
     */
    public static function requireRole(string ...$roles): array
    {
        $user = self::require();
        if (!in_array($user['role'], $roles, true)) {
            Response::forbidden('This action requires: ' . implode(' or ', $roles) . '.');
        }
        return $user;
    }

    /* ------------------------------------------------------------------
       Brute-force throttling.

       Depends on the login_attempts table from db/schema-additions.sql,
       which is optional and may not be applied. Rather than crash when it
       is absent, throttling simply does not engage — but that is a real
       reduction in protection, so it is worth applying that file.
       ------------------------------------------------------------------ */

    private static ?bool $attemptsTable = null;

    private static function attemptsAvailable(): bool
    {
        return self::$attemptsTable ??= Database::hasTable('login_attempts');
    }

    /* ------------------------------------------------------------------
       Passwords — one rule, one hash, one place.

       The minimum length and the bcrypt call were written out FOUR times:
       twice in users/save.php (create and update), once in shop/register.php,
       and a fifth was about to be added by shop/password.php. Four copies of a
       security rule is four places to weaken it and three places to forget when
       it changes.
       ------------------------------------------------------------------ */

    /** Minimum length. Change it here and every path changes with it. */
    public const PASSWORD_MIN = 8;

    /**
     * Validate and hash, or refuse.
     *
     * Refuses with a field error rather than returning false, because every
     * caller did exactly that and an ignored return value is how a plaintext
     * password reaches a column.
     *
     * `$field` names the input so the message lands on the right box — the
     * password-change form has three of them.
     */
    public static function hashPassword(string $plain, string $field = 'password'): string
    {
        if (mb_strlen($plain) < self::PASSWORD_MIN) {
            Response::validation('Check the highlighted fields.', [
                $field => 'Use at least ' . self::PASSWORD_MIN . ' characters.',
            ]);
        }
        /* PASSWORD_BCRYPT explicitly, not PASSWORD_DEFAULT: DEFAULT changes
           between PHP versions, and a hash written by one server that another
           cannot verify locks people out of their accounts. */
        return password_hash($plain, PASSWORD_BCRYPT);
    }

    /**
     * Re-verify the CURRENT password of the already-signed-in customer.
     *
     * For operations that need proof the person at the keyboard is the account
     * holder, not just someone holding a session cookie — changing a password
     * being the one that matters.
     *
     * Throttled on the same counter as sign-in, so this cannot be used as an
     * unlimited password oracle against a stolen session. `throttle()` and
     * `record()` stay private; this is the door they are reached through.
     */
    public static function reauthenticateCustomer(string $password): array
    {
        $customer = self::requireCustomer('Sign in to continue.');

        $email = (string) $customer['email'];
        self::throttle($email);

        $hash = Database::scalar('SELECT password FROM customers WHERE id = ?', [$customer['id']]);

        if (!is_string($hash) || $hash === '' || !password_verify($password, $hash)) {
            self::record($email, false);
            Response::validation('That is not your current password.', [
                'current_password' => 'Incorrect password.',
            ]);
        }

        self::record($email, true);
        return $customer;
    }

    private static function throttle(string $email): void
    {
        if (!self::attemptsAvailable()) {
            return;
        }

        $sec     = Database::config()['security'];
        $max     = (int) ($sec['max_login_attempts'] ?? 5);
        $window  = (int) ($sec['lockout_seconds'] ?? 900);

        $failures = (int) Database::scalar(
            'SELECT COUNT(*) FROM login_attempts
              WHERE email = ? AND successful = 0
                AND attempted_at > (NOW() - INTERVAL ? SECOND)',
            [$email, $window]
        );

        if ($failures >= $max) {
            Response::rateLimited(
                'Too many failed sign-in attempts. Try again in ' . ceil($window / 60) . ' minutes.'
            );
        }
    }

    private static function record(string $email, bool $success): void
    {
        if (!self::attemptsAvailable()) {
            return;
        }
        Database::run(
            'INSERT INTO login_attempts (email, ip_address, successful) VALUES (?, ?, ?)',
            [$email, $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0', $success ? 1 : 0]
        );

        /* A successful sign-in clears the counter, so one fat-fingered
           password does not keep counting against you all afternoon. */
        if ($success) {
            Database::run('DELETE FROM login_attempts WHERE email = ? AND successful = 0', [$email]);
        }
    }
}
