<?php
declare(strict_types=1);

/** POST /api/auth/logout.php always succeeds, since logging out with no session is not an error worth a sign-in prompt. */

/* CSRF-exempt on purpose: a forged logout only signs someone out, and refusing a stale token would trap a user who wants to leave. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

Auth::logout();

Response::ok(['signed_out' => true]);
