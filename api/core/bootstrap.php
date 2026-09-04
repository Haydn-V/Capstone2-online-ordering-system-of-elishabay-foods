<?php
declare(strict_types=1);

/**
 * Every endpoint starts with:  require __DIR__ . '/../core/bootstrap.php';
 *
 * Loads the core classes, configures error handling so a PHP warning can never
 * corrupt a JSON body, and starts the session.
 */

require_once __DIR__ . '/Response.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/Validate.php';
/* Before Auth.php — Auth's four password paths all refuse through
   Lockout::enforce(), which owns the progressive throttle policy. */
require_once __DIR__ . '/Lockout.php';
require_once __DIR__ . '/Auth.php';
require_once __DIR__ . '/Rbac.php';
require_once __DIR__ . '/Csrf.php';
require_once __DIR__ . '/Revenue.php';
require_once __DIR__ . '/Payments.php';
/* Before Stock.php — Stock::sell() raises a Notify when a sale takes a product
   across into the critical or out-of-stock band. */
require_once __DIR__ . '/Notify.php';
require_once __DIR__ . '/Stock.php';
require_once __DIR__ . '/Mailer.php';
require_once __DIR__ . '/Orders.php';
require_once __DIR__ . '/Dates.php';
/* After Dates.php — Inventory::describe() resolves expiry against Dates::today(). */
require_once __DIR__ . '/Inventory.php';
/* After Notify.php — review-save.php raises a Warning when a customer leaves a
   low rating, and Reviews owns the constant that decides what "low" means. */
require_once __DIR__ . '/Reviews.php';

$__cfg = Database::config();

date_default_timezone_set($__cfg['app']['timezone'] ?? 'Asia/Manila');

/* Never print diagnostics into the response body — a single notice echoed
   ahead of the JSON makes the whole payload unparseable to the client. They go
   to the PHP error log instead, and surface in the envelope only via the
   handlers below. */
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

/* Buffer output so Response can discard anything that leaked out before it. */
ob_start();

/* A warning or notice becomes an exception, so sloppy code fails loudly in
   development instead of returning half-correct data. */
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(static function (Throwable $e): void {
    error_log('[elishabay] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());

    $debug = Database::config()['app']['debug'] ?? false;
    $msg = $debug
        ? $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine()
        : 'Something went wrong.';

    Response::serverError($msg);
});

/* Fatals bypass the exception handler, so they get their own net. Without
   this, a fatal returns a blank 200 body and the client sees "invalid JSON"
   rather than the actual problem. */
register_shutdown_function(static function (): void {
    $err = error_get_last();
    if ($err !== null && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        error_log('[elishabay] FATAL ' . $err['message'] . ' @ ' . $err['file'] . ':' . $err['line']);
        if (!headers_sent()) {
            Response::serverError('Something went wrong.');
        }
    }
});

Auth::startSession();

/* Applied centrally so an endpoint cannot forget it. GET is exempt; an
   endpoint that changes state on GET is itself the bug. */
Csrf::enforce();
