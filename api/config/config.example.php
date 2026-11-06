<?php
/** Configuration template: copy to config.php (which is gitignored) and never put a real password in this file. */

return [

    /* Database */
    'db' => [
        'host'     => 'localhost',
        'port'     => 3306,
        'name'     => 'elisha_bay_db',
        /* Use a dedicated MySQL account with only SELECT/INSERT/UPDATE/DELETE on elisha_bay_db (never root), since the app never needs to create or drop tables. */
        'user'     => 'elishabay_app',
        'pass'     => '',            // set this to the password used above
        'charset'  => 'utf8mb4',

        /* Force strict SQL mode per connection so bad data raises an error instead of being silently saved. */
        'sql_mode' => 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION',
    ],

    /* Application */
    'app' => [
        /* Base URL path the project is served from (with trailing slash), used for redirects and cookie paths. */
        'base_path' => '/elishabay/',

        /* Must be false on any public server, because true sends error details (paths, SQL) back to the browser. */
        'debug'     => true,

        'timezone'  => 'Asia/Manila',
    ],

    /* Outbound email: 'log' saves each message to storage/mail/*.eml without sending (for testing), 'smtp' really sends (for Gmail use smtp.gmail.com:587, tls and an App Password). */
    'mail' => [
        'transport'  => 'log',
        'host'       => '',
        'port'       => 587,
        'encryption' => 'tls',        // 'tls' (587), 'ssl' (465), or '' (none)
        'username'   => '',
        'password'   => '',
        'from_email' => 'no-reply@elishabay.ph',
        'from_name'  => 'Elisha Bay',
        'timeout'    => 15,
    ],

    /* Security */
    'security' => [
        /* Session cookie settings: 'secure' must be true once the site runs on HTTPS. */
        'session_name'     => 'eb_session',
        'cookie_httponly'  => true,
        'cookie_samesite'  => 'Lax',
        /* Must be true on HTTPS, otherwise the session cookie travels unencrypted and can be stolen. */
        'cookie_secure'    => false,

        /* Idle timeout in seconds before a session is treated as expired. */
        'session_lifetime' => 7200,

        /* Failed sign-in lockout settings (rules in api/core/Lockout.php), keyed on email plus IP so nobody can lock a customer out just by knowing their email. */

        /* Free attempts before any delay, to allow for typos. */
        'lockout_free_attempts'      => 3,
        /* Each failure past the free ones adds this much: 2, 4, 6, 8, 10 min. */
        'lockout_step_seconds'       => 120,
        /* Maximum lockout for the storefront, kept short because a locked-out shopper is usually the victim. */
        'lockout_max_seconds'        => 600,
        /* Maximum lockout for the portal, longer because staff accounts are more powerful. */
        'lockout_max_seconds_staff'  => 1800,
        /* No attempts for this long and the streak resets on its own. */
        'lockout_decay_seconds'      => 1800,
        /* How many different emails one IP may fail against before that IP is blocked (catches password spraying; 0 disables). */
        'lockout_ip_distinct_emails' => 12,
    ],
];
