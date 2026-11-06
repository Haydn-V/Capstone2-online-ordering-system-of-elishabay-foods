<?php
declare(strict_types=1);

/** GET /api/system/errors.php (Super Admin only) shows the last 30 server errors from api/logs/errors.log, which the web cannot read directly. */
require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::requireRole('Super Admin');

$file  = dirname(__DIR__) . '/logs/errors.log';
$lines = is_file($file) ? file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
Response::ok(['errors' => array_reverse(array_slice($lines ?: [], -30))]);
