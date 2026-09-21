<?php
declare(strict_types=1);

/**
 * One JSON envelope for every endpoint, success or failure.
 *
 *   { "ok": true,  "data": ..., "meta": { "page": 1, "total": 120 } }
 *   { "ok": false, "error": { "code": "VALIDATION", "message": "...", "fields": {} } }
 *
 * Callers can therefore branch on `ok` alone and never have to guess at the
 * shape of a failure. api.js on the front end unwraps exactly this.
 */
final class Response
{
    /** Emit a success envelope and stop. */
    public static function ok($data = null, ?array $meta = null, int $status = 200): never
    {
        $body = ['ok' => true, 'data' => $data];
        if ($meta !== null) {
            $body['meta'] = $meta;
        }
        self::send($body, $status);
    }

    /** Emit a created-resource envelope and stop. */
    public static function created($data = null): never
    {
        self::ok($data, null, 201);
    }

    /**
     * Emit a failure envelope and stop.
     *
     * @param string $code    machine-readable: VALIDATION, UNAUTHENTICATED,
     *                        FORBIDDEN, NOT_FOUND, CONFLICT, RATE_LIMITED, SERVER
     * @param array  $fields  field name => message, for form rendering
     */
    /**
     * @param array $fields form-input errors, rendered against a form by the client
     * @param array $meta   anything else the client needs to act on the refusal
     *                      (a retry delay, say) — kept OUT of `fields` so it is
     *                      never mistaken for an input name
     */
    public static function error(
        string $code,
        string $message,
        int $status = 400,
        array $fields = [],
        array $meta = []
    ): never {
        self::send([
            'ok'    => false,
            'error' => array_merge($meta, [
                'code'    => $code,
                'message' => $message,
                'fields'  => (object) $fields,
            ]),
        ], $status);
    }

    /* ---- shorthands for the statuses the API actually returns ---- */

    public static function validation(string $message, array $fields = []): never
    {
        self::error('VALIDATION', $message, 422, $fields);
    }

    public static function badRequest(string $message): never
    {
        self::error('BAD_REQUEST', $message, 400);
    }

    public static function unauthenticated(string $message = 'Sign in to continue.'): never
    {
        self::error('UNAUTHENTICATED', $message, 401);
    }

    public static function forbidden(string $message = 'You do not have access to this.'): never
    {
        self::error('FORBIDDEN', $message, 403);
    }

    public static function notFound(string $message = 'Not found.'): never
    {
        self::error('NOT_FOUND', $message, 404);
    }

    public static function conflict(string $message): never
    {
        self::error('CONFLICT', $message, 409);
    }

    /**
     * @param int $retryAfter seconds the caller must wait, 0 when unknown.
     *
     * NOT PASSED AS A `fields` ENTRY. `fields` means "these form inputs are
     * wrong" and the client renders it straight onto a form — a `retryAfter`
     * key in there would have the sign-in modal hunting for an input by that
     * name. It goes beside `fields` in the envelope instead, and out as a real
     * `Retry-After` header, which is what the status code already promises.
     */
    public static function rateLimited(string $message, int $retryAfter = 0): never
    {
        if ($retryAfter > 0) {
            header('Retry-After: ' . $retryAfter);
        }
        self::error('RATE_LIMITED', $message, 429, [], ['retryAfter' => $retryAfter]);
    }

    public static function serverError(string $message = 'Something went wrong.'): never
    {
        self::error('SERVER', $message, 500);
    }

    /**
     * Reject anything but the expected HTTP verb.
     *
     * @param string|string[] $allowed
     */
    public static function requireMethod(string|array $allowed): void
    {
        $allowed = (array) $allowed;
        $method  = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (!in_array($method, $allowed, true)) {
            header('Allow: ' . implode(', ', $allowed));
            self::error('METHOD_NOT_ALLOWED', "This endpoint expects " . implode(' or ', $allowed) . '.', 405);
        }
    }

    /**
     * Decode a JSON request body.
     *
     * Falls back to form-encoded input so an endpoint keeps working if a
     * caller posts a plain <form>. Returns [] rather than null so callers can
     * index it without null checks.
     */
    public static function input(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                return $decoded;
            }
            /* A body that is present but not valid JSON is a caller bug worth
               naming, rather than silently treating as empty. */
            if (json_last_error() !== JSON_ERROR_NONE && !empty($_POST) === false) {
                self::badRequest('Request body is not valid JSON.');
            }
        }
        return $_POST ?: [];
    }

    /** Set by cacheFor(); null means the default, no-store. */
    private static ?int $cacheSeconds = null;

    /**
     * Let THIS response be cached by the browser for `$seconds`.
     *
     * Everything else stays `no-store`, and that default is right: nearly every
     * response here is somebody's cart, orders or session. The exception is
     * public reference data that changes every few years — the PSGC location
     * lists — where re-fetching the same province's cities on every page is
     * pure waste. Opt-in per response, never a global switch, so an endpoint
     * that returns personal data cannot end up cached by forgetting something.
     *
     * Applied to successful responses only; an error is never cached.
     */
    public static function cacheFor(int $seconds): void
    {
        self::$cacheSeconds = max(0, $seconds);
    }

    private static function send(array $body, int $status): never
    {
        /* Discard anything already buffered. A stray warning printed before
           this point would otherwise sit in front of the JSON and make the
           whole response unparseable to the client. */
        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header($status < 400 && self::$cacheSeconds
            ? 'Cache-Control: public, max-age=' . self::$cacheSeconds
            : 'Cache-Control: no-store');

        echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
