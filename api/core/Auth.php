<?php
declare(strict_types=1);

/** Server-side authentication: the browser only gets a session cookie, and the role is re-read from the database on every request. */
final class Auth
{
    private const SESSION_USER = 'eb_user_id';
    private const SESSION_TIME = 'eb_last_seen';
    /* Customers use a separate table and session key so a shopper's login can never pass a staff permission check. */
    private const SESSION_CUSTOMER = 'eb_customer_id';
    /* A short fingerprint of the password hash, saved at sign-in. When the password changes, every other session's
       fingerprint no longer matches the database and that session is signed out on its next request. */
    private const SESSION_PW_STAFF    = 'eb_pw_stamp';
    private const SESSION_PW_CUSTOMER = 'eb_cpw_stamp';

    /** Fingerprint of a password hash (never the hash itself) for the session. */
    private static function pwStamp(?string $hash): string
    {
        return substr(hash('sha256', (string) $hash), 0, 20);
    }

    /* One session per account: each sign-in issues a token kept in active_sessions (migration 026); a session whose token
       is no longer the account's latest was replaced by a newer sign-in elsewhere and is signed out. */
    private const SESSION_TOKEN_STAFF    = 'eb_sess_token';
    private const SESSION_TOKEN_CUSTOMER = 'eb_csess_token';
    private static ?bool $hasSessions = null;

    private static function sessionsReady(): bool
    {
        return self::$hasSessions ??= Database::hasTable('active_sessions');
    }

    /** Make this browser the account's only signed-in session (called at every sign-in). */
    private static function claimSession(string $type, string $id): void
    {
        $token = bin2hex(random_bytes(16));
        $_SESSION[$type === 'staff' ? self::SESSION_TOKEN_STAFF : self::SESSION_TOKEN_CUSTOMER] = $token;
        if (!self::sessionsReady()) { return; }
        Database::run(
            'INSERT INTO active_sessions (account_type, account_id, token) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE token = VALUES(token)',
            [$type, $id, $token]
        );
    }

    /** False when another sign-in of this account has replaced this session. Sessions from before the check adopt the slot if it is free. */
    private static function sessionIsCurrent(string $type, string $id): bool
    {
        if (!self::sessionsReady()) { return true; }
        $key  = $type === 'staff' ? self::SESSION_TOKEN_STAFF : self::SESSION_TOKEN_CUSTOMER;
        $mine = $_SESSION[$key] ?? null;
        $live = Database::scalar('SELECT token FROM active_sessions WHERE account_type = ? AND account_id = ?', [$type, $id]);
        if (!is_string($live) || $live === '') {
            if ($mine === null) { self::claimSession($type, $id); return true; }
            Database::run('INSERT IGNORE INTO active_sessions (account_type, account_id, token) VALUES (?, ?, ?)', [$type, $id, $mine]);
            return true;
        }
        return is_string($mine) && hash_equals($live, $mine);
    }

    /** Leave a short-lived note so the sign-in page can explain why this browser was signed out. */
    private static function noteSignedOutElsewhere(): void
    {
        if (headers_sent()) { return; }
        setcookie('eb_signed_out', 'elsewhere', [
            'expires'  => time() + 300,
            'path'     => Database::config()['app']['base_path'] ?? '/',
            'samesite' => 'Lax',
        ]);
    }

    /** After a password change, keep THIS session signed in by saving the new fingerprint; all other sessions drop out. */
    public static function refreshPasswordStamp(): void
    {
        if (isset($_SESSION[self::SESSION_USER])) {
            $h = Database::scalar('SELECT password FROM users WHERE id = ?', [$_SESSION[self::SESSION_USER]]);
            $_SESSION[self::SESSION_PW_STAFF] = self::pwStamp(is_string($h) ? $h : null);
        }
        if (isset($_SESSION[self::SESSION_CUSTOMER])) {
            $h = Database::scalar('SELECT password FROM customers WHERE id = ?', [$_SESSION[self::SESSION_CUSTOMER]]);
            $_SESSION[self::SESSION_PW_CUSTOMER] = self::pwStamp(is_string($h) ? $h : null);
        }
    }

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

        /* Idle timeout is checked on the server so even a stolen session id expires. */
        $lifetime = (int) ($sec['session_lifetime'] ?? 7200);
        if (isset($_SESSION[self::SESSION_TIME]) && (time() - $_SESSION[self::SESSION_TIME]) > $lifetime) {
            self::logout();
        }
        $_SESSION[self::SESSION_TIME] = time();
    }

    /** Check staff credentials and start a session; an unknown email and a wrong password get separate messages (fields.email / fields.password), as the course requires, with the lockout still slowing guessing. */
    public static function attempt(string $email, string $password): array
    {
        /* Staff accounts use CTX_STAFF, which has a longer (30-minute) lockout ceiling than customers. */
        Lockout::enforce($email, Lockout::CTX_STAFF);

        $user = Database::one(
            'SELECT u.id, u.name, u.email, u.password, u.avatar, u.status,
                    u.role_id, r.name AS role, r.is_system
               FROM users u
               LEFT JOIN roles r ON r.id = u.role_id
              WHERE u.email = ?',
            [$email]
        );

        $ok = $user !== null && password_verify($password, $user['password']);

        /* Run password_verify on a dummy hash when the user does not exist, so timing does not reveal which emails exist. */
        if ($user === null) {
            password_verify($password, '$2y$10$usesomesillystringfteonwiuhefoiwehfoiwehfoiwehfoiweh');
        }

        if (!$ok) {
            /* Shows the lockout message instead if this failure crossed the limit (see Lockout::recordFailure). */
            Lockout::recordFailure($email, Lockout::CTX_STAFF);
            Response::error('UNAUTHENTICATED', ...self::badLogin($user === null, $email, Lockout::CTX_STAFF));
        }

        /* Archived accounts keep their history but cannot sign in. */
        if ($user['status'] === 'archived') {
            Lockout::record($email, false, Lockout::CTX_STAFF);
            Response::forbidden('This account has been archived. Contact an administrator.');
        }

        if ($user['role'] === null) {
            Lockout::record($email, false, Lockout::CTX_STAFF);
            Response::forbidden('This account has no role assigned. Contact an administrator.');
        }

        Lockout::record($email, true, Lockout::CTX_STAFF);

        /* Issue a new session id at sign-in to prevent session fixation. */
        session_regenerate_id(true);

        $_SESSION[self::SESSION_USER] = $user['id'];
        $_SESSION[self::SESSION_TIME] = time();
        $_SESSION[self::SESSION_PW_STAFF] = self::pwStamp($user['password']);
        self::claimSession('staff', (string) $user['id']);

        unset($user['password']);
        self::$user = $user;
        return $user;
    }

    /* Customer authentication: separate table and session key, no role or permissions, so it only satisfies requireCustomer(). */

    public static function attemptCustomer(string $email, string $password): array
    {
        /* Customer sign-in is now throttled too, since it is the public login form and previously allowed unlimited guesses. */
        Lockout::enforce($email, Lockout::CTX_CUSTOMER);

        $c = Database::one(
            'SELECT id, name, email, password, contact, status FROM customers WHERE email = ?',
            [$email]
        );

        $ok = $c !== null && $c['password'] !== null && password_verify($password, $c['password']);

        if ($c === null || $c['password'] === null) {
            /* Same dummy-hash timing guard and single message as staff, so customer emails cannot be discovered. */
            password_verify($password, '$2y$10$usesomesillystringfteonwiuhefoiwehfoiwehfoiwehfoiweh');
        }

        if (!$ok) {
            Lockout::recordFailure($email, Lockout::CTX_CUSTOMER);
            /* An unregistered email (or one with no password yet) and a wrong password get separate messages. */
            Response::error('UNAUTHENTICATED', ...self::badLogin($c === null || $c['password'] === null, $email, Lockout::CTX_CUSTOMER));
        }
        if ($c['status'] === 'archived') {
            Lockout::record($email, false, Lockout::CTX_CUSTOMER);
            Response::forbidden('This account is no longer active. Please contact us.');
        }

        /* Clear the failure streak after a successful sign-in. */
        Lockout::record($email, true, Lockout::CTX_CUSTOMER);

        session_regenerate_id(true);
        $_SESSION[self::SESSION_CUSTOMER] = $c['id'];
        $_SESSION[self::SESSION_TIME] = time();
        $_SESSION[self::SESSION_PW_CUSTOMER] = self::pwStamp($c['password']);
        self::claimSession('customer', (string) $c['id']);

        unset($c['password']);
        return self::$customer = $c;
    }

    /** Message, status and field for a failed sign-in: "not registered" on the email field, or "incorrect password" with tries left on the password field. */
    private static function badLogin(bool $unknownEmail, string $email, string $context): array
    {
        if ($unknownEmail) {
            $msg = 'This email is not registered yet. Check the spelling, or use Create Account to sign up.';
            return [$msg, 401, ['email' => $msg]];
        }
        $left = Lockout::attemptsLeft($email, $context);
        $msg  = 'Incorrect password. Check it and try again.'
            . ($left > 0
                ? sprintf(' %d attempt%s left before sign-in pauses for a few minutes.', $left, $left === 1 ? '' : 's')
                : '');
        return [$msg, 401, ['password' => $msg]];
    }

    /** Sign in a customer by id with no password check; ONLY for a sign-up just verified by emailed code (shop/register-verify.php). */
    public static function loginCustomer(string $id): array
    {
        $c = Database::one('SELECT id, name, email, contact, status, password FROM customers WHERE id = ?', [$id]);
        if ($c === null) {
            Response::error('SERVER', 'Your account could not be opened. Please sign in.', 500);
        }
        session_regenerate_id(true);
        $_SESSION[self::SESSION_CUSTOMER] = $c['id'];
        $_SESSION[self::SESSION_TIME] = time();
        $_SESSION[self::SESSION_PW_CUSTOMER] = self::pwStamp($c['password']);
        self::claimSession('customer', (string) $c['id']);
        unset($c['password']);
        return self::$customer = $c;
    }

    /** The signed-in customer or null, re-read every request like staff. */
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
            'SELECT id, name, email, contact, status, password FROM customers WHERE id = ?',
            [$id]
        );
        if ($c === null || $c['status'] === 'archived') {
            unset($_SESSION[self::SESSION_CUSTOMER], $_SESSION[self::SESSION_PW_CUSTOMER]);
            return null;
        }
        /* Password changed elsewhere since this session signed in: sign this session out. Sessions from before this check get stamped now. */
        $stamp = self::pwStamp($c['password']);
        if (!isset($_SESSION[self::SESSION_PW_CUSTOMER])) {
            $_SESSION[self::SESSION_PW_CUSTOMER] = $stamp;
        } elseif (!hash_equals($_SESSION[self::SESSION_PW_CUSTOMER], $stamp)) {
            unset($_SESSION[self::SESSION_CUSTOMER], $_SESSION[self::SESSION_PW_CUSTOMER]);
            return null;
        }
        /* Signed in again on another device or browser: only the newest session stays. */
        if (!self::sessionIsCurrent('customer', (string) $c['id'])) {
            unset($_SESSION[self::SESSION_CUSTOMER], $_SESSION[self::SESSION_PW_CUSTOMER], $_SESSION[self::SESSION_TOKEN_CUSTOMER]);
            self::noteSignedOutElsewhere();
            return null;
        }
        unset($c['password']);
        return self::$customer = $c;
    }

    /** @param string $message tells the visitor what signing in is for. */
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

    /** The signed-in staff user or null, re-read from the database so archiving or a role change applies on the next request. */
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
            'SELECT u.id, u.name, u.email, u.avatar, u.status, u.password,
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

        /* Password changed on another device since this session signed in: sign this session out. Sessions from before this check get stamped now. */
        $stamp = self::pwStamp($user['password']);
        if (!isset($_SESSION[self::SESSION_PW_STAFF])) {
            $_SESSION[self::SESSION_PW_STAFF] = $stamp;
        } elseif (!hash_equals($_SESSION[self::SESSION_PW_STAFF], $stamp)) {
            self::logout();
            return null;
        }
        /* Signed in again on another device or browser: only the newest session stays. */
        if (!self::sessionIsCurrent('staff', (string) $user['id'])) {
            self::logout();
            self::noteSignedOutElsewhere();
            return null;
        }
        unset($user['password']);

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

    /** Require one of the named roles or stop with 403; prefer Rbac::require() with a permission. */
    public static function requireRole(string ...$roles): array
    {
        $user = self::require();
        if (!in_array($user['role'], $roles, true)) {
            Response::forbidden('This action requires: ' . implode(' or ', $roles) . '.');
        }
        return $user;
    }

    /* Brute-force throttling needs the login_attempts table; without it throttling silently does not run, so apply that migration. */

    /* Passwords: the minimum length and the bcrypt hashing live only here, so the rule cannot drift between endpoints. */

    /** Minimum password length for every path. */
    public const PASSWORD_MIN = 8;

    /** The first password rule not met (8+ characters, upper and lower case, a number, a symbol), or null; mirrored by the checklist in site.js. */
    public static function passwordProblem(string $plain): ?string
    {
        $rules = [
            [mb_strlen($plain) >= self::PASSWORD_MIN,     'Use at least ' . self::PASSWORD_MIN . ' characters.'],
            [preg_match('/[A-Z]/', $plain) === 1,         'Add at least one uppercase letter (A–Z).'],
            [preg_match('/[a-z]/', $plain) === 1,         'Add at least one lowercase letter (a–z).'],
            [preg_match('/[0-9]/', $plain) === 1,         'Add at least one number (0–9).'],
            [preg_match('/[^A-Za-z0-9]/', $plain) === 1,  'Add at least one symbol, such as ! @ # $ or %.'],
        ];
        foreach ($rules as [$ok, $message]) {
            if (!$ok) { return $message; }
        }
        return null;
    }

    /** Validate and hash a password or stop with a field error on $field, so a plaintext password can never be stored by mistake. */
    public static function hashPassword(string $plain, string $field = 'password'): string
    {
        $problem = self::passwordProblem($plain);
        if ($problem !== null) {
            Response::validation('Check the highlighted fields.', [$field => $problem]);
        }
        /* Use PASSWORD_BCRYPT explicitly, because PASSWORD_DEFAULT can change between PHP versions. */
        return password_hash($plain, PASSWORD_BCRYPT);
    }

    /** Re-check the signed-in customer's current password before sensitive changes, throttled like sign-in so it cannot be used to guess passwords. */
    public static function reauthenticateCustomer(string $password): array
    {
        $customer = self::requireCustomer('Sign in to continue.');

        $email = (string) $customer['email'];
        Lockout::enforce($email, Lockout::CTX_CUSTOMER);

        $hash = Database::scalar('SELECT password FROM customers WHERE id = ?', [$customer['id']]);

        if (!is_string($hash) || $hash === '' || !password_verify($password, $hash)) {
            Lockout::record($email, false, Lockout::CTX_CUSTOMER);
            Response::validation('That is not your current password.', [
                'current_password' => 'Incorrect password.',
            ]);
        }

        Lockout::record($email, true, Lockout::CTX_CUSTOMER);
        return $customer;
    }

    /** Re-check the signed-in staff member's current password; the twin of reauthenticateCustomer() with the same throttling and error shape. */
    public static function reauthenticateStaff(string $password): array
    {
        $user = self::require();

        $email = (string) $user['email'];
        /* Uses CTX_STAFF like attempt(), since changing a privileged account's password deserves the stricter limit. */
        Lockout::enforce($email, Lockout::CTX_STAFF);

        $hash = Database::scalar('SELECT password FROM users WHERE id = ?', [$user['id']]);

        if (!is_string($hash) || $hash === '' || !password_verify($password, $hash)) {
            Lockout::record($email, false, Lockout::CTX_STAFF);
            Response::validation('That is not your current password.', [
                'current_password' => 'Incorrect password.',
            ]);
        }

        Lockout::record($email, true, Lockout::CTX_STAFF);
        return $user;
    }

}
