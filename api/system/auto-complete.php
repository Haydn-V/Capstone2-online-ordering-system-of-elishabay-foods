<?php
declare(strict_types=1);

/**
 * api/system/auto-complete.php — run the one-hour delivered→completed sweep.
 *
 *   CLI:   php api/system/auto-complete.php
 *   HTTP:  GET /api/system/auto-complete.php     (requires audit.view)
 *
 * WHY BOTH
 * --------
 * The rule already runs opportunistically: Orders::sweepIfDue() is called by
 * api/orders/list.php and api/shop/my-orders.php, so on a machine nobody has
 * configured, an order still completes the next time anyone looks at an order
 * list. That is enough to be correct and not enough to be punctual — on a quiet
 * evening an order can sit an extra twelve hours because nothing was loaded.
 *
 * This is the same function behind a door a scheduler can knock on, so a real
 * deployment gets completion within a minute of the hour elapsing. Both routes
 * call ONE implementation; there is no second copy of the rule to drift.
 *
 * WHY THE CLI PATH IS UNAUTHENTICATED
 * -----------------------------------
 * A scheduled task has no session and no browser to hold a cookie. It is
 * reached only by something already executing on the server, which by then has
 * the database credentials in api/config/config.php anyway — a login would add
 * a stored password without adding a barrier.
 *
 * The HTTP path is a different matter: it is reachable by anyone who can make a
 * request, so it requires a signed-in user with `audit.view`. That permission
 * rather than an orders one because this is an operational maintenance action,
 * and audit.view is already the marker for "may see how the system is behaving
 * to itself".
 *
 * The sweep is idempotent — it only ever moves orders that have genuinely been
 * delivered for an hour — so an accidental double run does nothing.
 */

require __DIR__ . '/../core/bootstrap.php';

$isCli = PHP_SAPI === 'cli';

if (!$isCli) {
    Response::requireMethod('GET');
    Rbac::require('audit.view');
}

/* autoCompleteDelivered(), not sweepIfDue(): the five-minute throttle exists to
   stop a page load doing this work repeatedly. A scheduler asking for it has
   asked for it, and silently skipping the run because a page load happened four
   minutes ago would make the schedule unreliable for no benefit. */
$moved = Orders::autoCompleteDelivered();

if ($isCli) {
    printf("auto-complete: %d order(s) completed%s\n",
        $moved, $moved === 0 ? ' (nothing was due)' : '');
    exit(0);
}

Response::ok([
    'completed' => $moved,
    'ranAt'     => date('Y-m-d H:i:s'),
]);
