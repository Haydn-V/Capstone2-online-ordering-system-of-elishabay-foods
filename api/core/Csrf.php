<?php
declare(strict_types=1);

/**
 * CSRF protection for state-changing requests.
 *
 * WHY THIS EXISTS
 * ---------------
 * Authentication rides in a cookie, and browsers attach cookies to requests
 * they make on any page's behalf. So a form on evil.example that POSTs to
 * this API would arrive carrying the victim's session — authenticated, and
 * doing whatever the attacker wrote.
 *
 * SameSite=Lax on the session cookie already blocks the classic cross-site
 * form POST, which is real protection, but it is one browser setting away from
 * being the only thing standing there. A token the attacker's page cannot read
 * (same-origin policy stops it fetching one) is the actual defence.
 *
 * HOW IT WORKS
 * ------------
 * A random token is minted per session and handed to the client by
 * auth/login.php and auth/me.php. api.js sends it back in an X-CSRF-Token
 * header on every POST/PUT/DELETE. bootstrap.php checks it automatically, so
 * an endpoint cannot forget to.
 *
 * GET is exempt because it must be side-effect free — an endpoint that changes
 * state on GET is the bug, and no token would fix it.
 */
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

    /**
     * Enforce on any state-changing request. Called from bootstrap.php so it
     * applies by default rather than per endpoint.
     *
     * Skipped when nobody is signed in: there is no session to ride, so there
     * is nothing to forge. That is what lets login.php work — the credentials
     * are the proof there.
     */
    public static function enforce(): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return;
        }

        if (defined('CSRF_EXEMPT') && CSRF_EXEMPT === true) {
            return;
        }

        /* Covers customer sessions as well as staff. A signed-in shopper has a
           cookie a hostile page could ride just as easily. */
        if (!Auth::hasAnySession()) {
            return;
        }

        $sent = $_SERVER[self::HEADER] ?? '';
        $held = $_SESSION[self::KEY] ?? '';

        /* hash_equals, not ===, so a wrong token cannot be discovered one
           character at a time by measuring how long the comparison took. */
        if ($held === '' || $sent === '' || !hash_equals($held, $sent)) {
            /* 403, not 419. 419 is a Laravel convention, not a registered
               HTTP status — PHP does not recognise it and silently emits 500,
               which reads as "the server broke" rather than "refused". The
               distinct `CSRF` code is what the client branches on. */
            Response::error(
                'CSRF',
                'Your session token is missing or stale. Reload the page and try again.',
                403
            );
        }
    }
}
