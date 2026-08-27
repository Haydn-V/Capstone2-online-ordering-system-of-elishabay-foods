<?php
/**
 * Elisha Bay — configuration template.
 *
 * Copy this file to config.php and edit the values there:
 *     copy api\config\config.example.php api\config\config.php
 *
 * config.php is gitignored; this template is the one that gets committed.
 * Never put a real password in this file.
 */

return [

    /* ---------------------------------------------------------
       Database
       --------------------------------------------------------- */
    'db' => [
        'host'     => 'localhost',
        'port'     => 3306,
        'name'     => 'elisha_bay_db',
        /* A SCOPED ACCOUNT, NOT root.
           ----------------------------
           This template used to say `root` with an empty password, and every
           install copied it. The application then ran every query as the MySQL
           superuser: a single injection or file-read had every schema behind
           it, plus FILE and SUPER.

           Create the account once, per install:

               CREATE USER 'elishabay_app'@'localhost' IDENTIFIED BY '<a long random password>';
               GRANT SELECT, INSERT, UPDATE, DELETE ON elisha_bay_db.* TO 'elishabay_app'@'localhost';
               FLUSH PRIVILEGES;

           No DDL is granted on purpose. The application never issues CREATE,
           ALTER or DROP — db/schema.sql and db/migrations/* are run by hand,
           and they should need a deliberate act and a different credential.
           `sql_mode` below is SET SESSION, which needs no privilege.

           Verify the account is actually constrained rather than assuming it:
           a DROP, a CREATE and a `SELECT ... FROM mysql.user` should all come
           back "command denied". */
        'user'     => 'elishabay_app',
        'pass'     => '',            // set this to the password used above
        'charset'  => 'utf8mb4',

        /* Pinned per connection, deliberately. XAMPP ships MySQL without
           STRICT_TRANS_TABLES, which downgrades real errors to warnings: the
           first seed import silently wrote '' into a NOT NULL column instead
           of failing. Setting it here means the app never depends on how the
           server happens to be configured. */
        'sql_mode' => 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION',
    ],

    /* ---------------------------------------------------------
       Application
       --------------------------------------------------------- */
    'app' => [
        /* Where the project is served from. Used to build redirects and
           cookie paths. Include the trailing slash. */
        'base_path' => '/elishabay/',

        /* MUST be false anywhere other than a local machine. When true, the
           text of an unhandled exception — file paths, SQL fragments, table
           names — is returned to the caller instead of only going to the
           error log. That is a gift to anyone probing the API.

           Left true here because this is a XAMPP development install and a
           silent 500 is genuinely hard to debug. api/config/config.php is
           gitignored, so this value does not travel; the deployment checklist
           in docs/SETUP.md lists it first. */
        'debug'     => true,

        'timezone'  => 'Asia/Manila',
    ],

    /* ---------------------------------------------------------
       Outbound email
       ---------------------------------------------------------
       Used to tell a B2B applicant their partner application was approved or
       rejected. api/core/Mailer.php speaks SMTP directly — this project has no
       Composer, and PHP's mail() shells out to a sendmail XAMPP ships
       unconfigured, whose failure mode is to return true having delivered
       nothing.

       transport:
         'log'  — writes the complete message to storage/mail/*.eml and reports
                  success. NOT a stub: an approval must not fail because nobody
                  has entered credentials, and the whole flow stays testable.
                  Every send is recorded and the staff screen says the email was
                  logged rather than sent, so it never pretends.
         'smtp' — real delivery. Fill in host, port, encryption and credentials.

       For Gmail: host smtp.gmail.com, port 587, encryption 'tls', and an App
       Password — not the account password, which Google refuses for SMTP.
       --------------------------------------------------------- */
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

    /* ---------------------------------------------------------
       Security
       --------------------------------------------------------- */
    'security' => [
        /* Session cookie. 'secure' must become true once the site is served
           over HTTPS; it is false here only because XAMPP serves plain HTTP
           on localhost. */
        'session_name'     => 'eb_session',
        'cookie_httponly'  => true,
        'cookie_samesite'  => 'Lax',
        /* MUST become true under HTTPS. While false, the session cookie is
           sent over plain HTTP and can be read by anything on the network
           path — which is the whole session, including a Super Admin's.

           It is false here only because XAMPP serves http://localhost. This is
           the single most important line to change before this is reachable
           from anywhere but this machine. */
        'cookie_secure'    => false,

        /* Idle timeout in seconds before a session is treated as expired. */
        'session_lifetime' => 7200,

        /* Failed logins allowed from one email/IP inside the window before
           the account is temporarily refused. Requires the login_attempts
           table from db/schema-additions.sql. */
        'max_login_attempts' => 5,
        'lockout_seconds'    => 900,
    ],
];
