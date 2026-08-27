<?php
declare(strict_types=1);

/**
 * GET /api/system/dates.php
 *
 * What "today" is, and what each named range means, resolved in Asia/Manila.
 *
 * Any signed-in staff member. It exposes no business data — only the calendar —
 * and every portal screen needs it, so gating it on a permission would break
 * the dashboard for roles that legitimately see one.
 *
 * WHY THIS EXISTS
 * ---------------
 * D1: the client formats dates, it never computes them. It used to compute
 * range boundaries in JavaScript, in parallel with PHP doing the same, and the
 * two disagreed — the server's week began on Monday and the browser's on
 * Sunday, so "This Week" meant one thing in the Sales Report headline and
 * another in the table below it.
 *
 * The browser now asks this endpoint once at start-up and uses what it is told.
 *
 * `mysqlAgrees` reports whether PHP's date and MySQL's CURDATE() are the same
 * day. They should be — MariaDB runs on SYSTEM time and this machine is UTC+8 —
 * but "should be" is how a whole class of date bug gets in. If it is ever
 * false, endpoints that mix CURDATE() with a PHP date are straddling a day
 * boundary and the number on screen depends on which one answered.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$drift = Dates::assertAgreesWithMysql();

Response::ok([
    'today'    => Dates::today(),
    'timezone' => Dates::TZ,
    'ranges'   => Dates::ranges(),
    /* Stated rather than assumed, so a mismatch is visible in the payload
       instead of showing up as an off-by-one in a report months later. */
    'mysqlAgrees' => $drift === null,
    'drift'       => $drift,
]);
