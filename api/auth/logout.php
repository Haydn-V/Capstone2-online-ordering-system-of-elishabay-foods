<?php
declare(strict_types=1);

/**
 * POST /api/auth/logout.php
 *
 * Always succeeds, even with no active session — logging out of nothing is not
 * an error, and returning 401 here would make the client show a sign-in prompt
 * to somebody who is trying to leave.
 */

/* Exempt on purpose. The worst a forged logout achieves is signing someone
   out, and refusing a stale token here would strand a user who cannot leave. */
define('CSRF_EXEMPT', true);

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

Auth::logout();

Response::ok(['signed_out' => true]);
