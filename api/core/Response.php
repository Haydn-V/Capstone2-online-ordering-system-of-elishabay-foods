<?php
declare(strict_types=1);

/** One JSON envelope for every endpoint ({ok, data, meta} or {ok:false, error:{code, message, fields}}) so callers only branch on ok. */
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

    /** Send a failure envelope and stop; $code is machine-readable and $fields maps form fields to messages. */
    /** @param $fields form-input errors; @param $meta other details the client needs (like a retry delay), kept separate from fields. */
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

    /** Rate-limited: put retryAfter beside fields (not in it) and send a real Retry-After header. */
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

    /** Reject any HTTP method other than the allowed ones. */
    public static function requireMethod(string|array $allowed): void
    {
        $allowed = (array) $allowed;
        $method  = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (!in_array($method, $allowed, true)) {
            header('Allow: ' . implode(', ', $allowed));
            self::error('METHOD_NOT_ALLOWED', "This endpoint expects " . implode(' or ', $allowed) . '.', 405);
        }
    }

    /** Decode the JSON body (falling back to form data), returning [] instead of null. */
    public static function input(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                return $decoded;
            }
            /* A body that is present but not valid JSON is reported as an error, not treated as empty. */
            if (json_last_error() !== JSON_ERROR_NONE && !empty($_POST) === false) {
                self::badRequest('Request body is not valid JSON.');
            }
        }
        return $_POST ?: [];
    }

    /** Set by cacheFor(); null means the default, no-store. */
    private static ?int $cacheSeconds = null;

    /** Allow this one response to be cached for $seconds (used for public location lists only); everything else stays no-store and errors are never cached. */
    public static function cacheFor(int $seconds): void
    {
        self::$cacheSeconds = max(0, $seconds);
    }

    private static function send(array $body, int $status): never
    {
        /* Discard anything already buffered so stray output cannot break the JSON. */
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
