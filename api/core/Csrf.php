<?php
declare(strict_types=1);

/** CSRF protection: each session gets a random token that api.js sends back in an X-CSRF-Token header on every POST/PUT/DELETE, and bootstrap.php checks it automatically so a hostile site cannot act with the user's cookie. */
final class Csrf
{
    private const KEY = 'eb_csrf';
    private const HEADER = 'HTTP_X_CSRF_TOKEN';

    /** The current session's token, minted on first use. */
    public static function token(): string
    {
        if (empty($_SESSION[self::KEY])) {
            $_SESSION[self::KEY] = bin2hex(random_bytes(32));
        }
        return $_SESSION[self::KEY];
    }

    /** Discard the token — called on logout, alongside the session itself. */
    public static function clear(): void
    {
        unset($_SESSION[self::KEY]);
    }

    /** Check the token on every state-changing request (called from bootstrap.php), skipping only when nobody is signed in because there is no session to forge. */
    public static function enforce(): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return;
        }

        if (defined('CSRF_EXEMPT') && CSRF_EXEMPT === true) {
            return;
        }

        /* Applies to customer sessions as well as staff. */
        if (!Auth::hasAnySession()) {
            return;
        }

        $sent = $_SERVER[self::HEADER] ?? '';
        $held = $_SESSION[self::KEY] ?? '';

        /* hash_equals instead of === so the token cannot be guessed by timing the comparison. */
        if ($held === '' || $sent === '' || !hash_equals($held, $sent)) {
            /* Return 403 (not 419, which PHP turns into a 500) with code CSRF so the client knows why it was refused. */
            Response::error(
                'CSRF',
                'Your session token is missing or stale. Reload the page and try again.',
                403
            );
        }
    }
}
