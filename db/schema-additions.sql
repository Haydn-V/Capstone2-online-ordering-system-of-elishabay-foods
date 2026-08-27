/* =============================================================
   ELISHA BAY — PROPOSED SCHEMA ADDITIONS

   *** NOT APPLIED. *** schema.sql + seed.sql are complete and imported
   without these. Every block below is a gap found during the Phase 0
   audit where a screen shows information the database cannot currently
   store. Each is justified individually — apply the ones you want, skip
   the rest. Nothing here is invented for its own sake.

   Run after schema.sql and seed.sql:
       mysql -u root elisha_bay_db < db/schema-additions.sql
   ============================================================= */

USE elisha_bay_db;

/* -------------------------------------------------------------
   RE-RUNNABLE.

   This file must survive being applied twice. It did not: CREATE TABLE was
   guarded with IF NOT EXISTS but the CREATE INDEX and ALTER TABLE statements
   after it were not, so a second run aborted at line 51 with

       ERROR 1061 Duplicate key name 'idx_osh_order'

   and every statement BELOW that point silently never ran — including the
   ALTER that adds audit_logs.actor_user_id. The result is a database that
   looks installed and is missing a column, which then fails at runtime with
   "Unknown column 'a.actor_user_id'". That happened for real during Phase 3.

   MariaDB accepts IF NOT EXISTS on CREATE INDEX and ADD COLUMN, so both are
   guarded now. ADD CONSTRAINT has no such form; a duplicate-constraint error
   on re-run is possible and is called out at that statement.
   ------------------------------------------------------------- */


SET NAMES utf8mb4;


/* -------------------------------------------------------------
   1. order_status_history                          [RECOMMENDED]
   -------------------------------------------------------------
   WHY: STATUS_TRANSITIONS in engine.js governs a seven-state order
   workflow (pending → accepted → shipping → delivered → completed,
   plus on-hold and cancelled), and the Order Status screen shows a
   stepper of where an order has been. Today `orders.status` holds
   only the CURRENT state — the history behind that stepper is
   invented at render time and nothing records WHO moved an order or
   WHEN.

   This also matters for accountability: "who cancelled this paid
   order?" is currently unanswerable.

   Phase 5's orders module writes one row here per transition; the
   stepper then reads real history instead of inferring it.
   ------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS order_status_history (
    id INT AUTO_INCREMENT NOT NULL,
    order_id VARCHAR(50) NOT NULL,
    from_status VARCHAR(20) NULL,          /* NULL on the row that creates the order */
    to_status VARCHAR(20) NOT NULL,
    changed_by VARCHAR(50) NULL,           /* users.id; NULL if the system did it */
    note TEXT NULL,                        /* the hold/cancel reason the UI already collects */
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_osh_order FOREIGN KEY (order_id)
        REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_osh_user FOREIGN KEY (changed_by)
        REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_osh_changed ON order_status_history(changed_at);


/* -------------------------------------------------------------
   2. audit_logs.actor_user_id                      [RECOMMENDED]
   -------------------------------------------------------------
   WHY: audit_logs.actor is a display name ('Maria Santos'). Rename
   that employee and every one of their audit entries silently
   detaches from them; two employees who share a name are
   indistinguishable forever.

   The name column stays — an audit trail should preserve what was
   true at the time, and the user row may later be archived — but a
   real foreign key is added alongside it so the log can be filtered
   by account.

   ON DELETE SET NULL rather than CASCADE: deleting a user must never
   delete the record of what they did.
   ------------------------------------------------------------- */
ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS actor_user_id VARCHAR(50) NULL AFTER actor;

/* ADD CONSTRAINT has no IF NOT EXISTS form, and a duplicate constraint name is
   a hard error that aborts every statement below it — which is exactly how this
   file previously left the database half-installed. Added only when absent. */
SET @fk_exists := (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'audit_logs'
       AND CONSTRAINT_NAME = 'fk_audit_actor'
);
SET @sql := IF(@fk_exists = 0,
    'ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_actor
        FOREIGN KEY (actor_user_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE INDEX IF NOT EXISTS idx_audit_actor_user ON audit_logs(actor_user_id);

/* Backfill by matching the existing name strings. Safe to re-run. */
UPDATE audit_logs a
   JOIN users u ON u.name = a.actor
   SET a.actor_user_id = u.id
 WHERE a.actor_user_id IS NULL;


/* -------------------------------------------------------------
   3. login_attempts                                [RECOMMENDED]
   -------------------------------------------------------------
   WHY: Phase 3 puts a real login endpoint on the network. Without a
   record of failed attempts there is no lockout and no rate limit,
   and six known demo accounts with human-memorable passwords sit
   behind it. This is the cheapest possible brute-force defence.

   Store the attempted email rather than a user id: attempts against
   addresses that do not exist are exactly what you want to see.

   Prune periodically — this table only needs a recent window.
   ------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS login_attempts (
    id INT AUTO_INCREMENT NOT NULL,
    email VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,       /* 45 chars fits IPv6 */
    successful TINYINT(1) NOT NULL DEFAULT 0,
    attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_attempts_email ON login_attempts(email, attempted_at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip_address, attempted_at);


/* -------------------------------------------------------------
   4. sessions                                        [NOT NEEDED]
   -------------------------------------------------------------
   Deliberately NOT included.

   PHP's built-in session handler writes to disk and is entirely
   adequate here. A sessions table only earns its place if you need
   to list active sessions, force "log out everywhere", or run
   several web servers behind a load balancer — none of which applies
   to a single XAMPP box.

   If that changes, the table is `session_id VARCHAR(128) PRIMARY KEY,
   user_id, payload, ip_address, user_agent, last_activity` wired up
   through session_set_save_handler(). Adding it now would be
   complexity with no reader.
   ------------------------------------------------------------- */
