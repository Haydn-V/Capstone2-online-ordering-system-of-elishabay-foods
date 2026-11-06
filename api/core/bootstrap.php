<?php
declare(strict_types=1);

/** Every endpoint requires this file, which loads core classes, sets error handling so warnings never corrupt the JSON, and starts the session. */

require_once __DIR__ . '/Response.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/Validate.php';
/* Load before Auth.php, which uses Lockout::enforce(). */
require_once __DIR__ . '/Lockout.php';
require_once __DIR__ . '/Auth.php';
require_once __DIR__ . '/Rbac.php';
require_once __DIR__ . '/Csrf.php';
require_once __DIR__ . '/Revenue.php';
require_once __DIR__ . '/Payments.php';
/* Load before Stock.php, which raises Notify alerts. */
require_once __DIR__ . '/Notify.php';
require_once __DIR__ . '/Stock.php';
require_once __DIR__ . '/Mailer.php';
require_once __DIR__ . '/Orders.php';
require_once __DIR__ . '/Dates.php';
/* After Dates.php — Inventory::describe() resolves expiry against Dates::today(). */
require_once __DIR__ . '/Inventory.php';
/* Load after Payments.php, because Tax reads retailer status and both run in the same checkout transaction. */
require_once __DIR__ . '/Tax.php';
/* Estimated delivery fee (migration 021) — used by both checkouts. */
require_once __DIR__ . '/Shipping.php';
/* Load after Notify.php, because a low review rating raises a staff warning. */
require_once __DIR__ . '/Reviews.php';
/* Needs only Database; resolves PSGC codes into verified addresses for checkout, sign-up, profile and the retailer application. */
require_once __DIR__ . '/Address.php';
/* Customer return requests (migration 016) — window, lines, completion stamp. */
require_once __DIR__ . '/Returns.php';
/* The customer's own bell (migration 018). */
require_once __DIR__ . '/CustomerNotify.php';
require_once __DIR__ . '/CustomerName.php';
require_once __DIR__ . '/Signup.php';
require_once __DIR__ . '/PasswordReset.php';

$__cfg = Database::config();

date_default_timezone_set($__cfg['app']['timezone'] ?? 'Asia/Manila');

/* Never print errors into the response body; they go to the PHP error log instead. */
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

/* Buffer output so Response can discard anything that leaked out before it. */
ob_start();

/* Turn warnings and notices into exceptions so bad code fails loudly. */
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(static function (Throwable $e): void {
    error_log('[elishabay] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    /* Also save errors where a super admin can read them (api/system/errors.php), since hosting logs are not always reachable. */
    @file_put_contents(dirname(__DIR__) . '/logs/errors.log',
        date('Y-m-d H:i:s') . ' ' . ($_SERVER['SCRIPT_NAME'] ?? '') . ' | ' . $e->getMessage()
        . ' @ ' . basename($e->getFile()) . ':' . $e->getLine() . "
", FILE_APPEND | LOCK_EX);

    $debug = Database::config()['app']['debug'] ?? false;
    $msg = $debug
        ? $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine()
        : 'Something went wrong.';

    Response::serverError($msg);
});

/* Catch fatal errors separately so the client gets a JSON error instead of a blank response. */
register_shutdown_function(static function (): void {
    $err = error_get_last();
    if ($err !== null && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        error_log('[elishabay] FATAL ' . $err['message'] . ' @ ' . $err['file'] . ':' . $err['line']);
        @file_put_contents(dirname(__DIR__) . '/logs/errors.log',
            date('Y-m-d H:i:s') . ' ' . ($_SERVER['SCRIPT_NAME'] ?? '') . ' | FATAL ' . $err['message']
            . ' @ ' . basename($err['file']) . ':' . $err['line'] . "
", FILE_APPEND | LOCK_EX);
        if (!headers_sent()) {
            Response::serverError('Something went wrong.');
        }
    }
});

Auth::startSession();

/* CSRF is checked centrally for every non-GET request. */
Csrf::enforce();
