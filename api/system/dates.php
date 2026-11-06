<?php
declare(strict_types=1);

/** GET /api/system/dates.php (any signed-in staff) tells the browser what today and each named range are in Manila time, plus whether PHP and MySQL agree on the date. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$drift = Dates::assertAgreesWithMysql();

Response::ok([
    'today'    => Dates::today(),
    'timezone' => Dates::TZ,
    'ranges'   => Dates::ranges(),
    /* Report the PHP/MySQL date match so a mismatch is visible. */
    'mysqlAgrees' => $drift === null,
    'drift'       => $drift,
]);
