<?php
declare(strict_types=1);

/** api/system/auto-complete.php runs the one-hour delivered-to-completed sweep from CLI (for a scheduler, no login needed) or over HTTP (needs audit.view); it is safe to run twice. */

require __DIR__ . '/../core/bootstrap.php';

$isCli = PHP_SAPI === 'cli';

if (!$isCli) {
    Response::requireMethod('GET');
    Rbac::require('audit.view');
}

/* Call autoCompleteDelivered() directly, skipping the page-load throttle, since a scheduler asked for it. */
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
