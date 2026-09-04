-- ---------------------------------------------------------------------------
-- 012 — login_attempts.context
--
-- WHY A CUSTOMER WAS LOCKED OUT AFTER TWO TRIES
-- ---------------------------------------------
-- The storefront sign-in form tries the STAFF endpoint first and falls through
-- to the customer one on a 401 — deliberate, so a staff member signing in from
-- the public site lands in the portal. The consequence nobody had costed: one
-- press of "Sign In" with a wrong password records TWO failures for the same
-- email and IP, one from each path.
--
-- With three free attempts shared between them, a customer reached a lockout on
-- their second press. The escalation was correct; the counter was being charged
-- twice for one mistake.
--
-- Splitting the bucket by context fixes it at the source. A customer's streak
-- counts customer attempts, a staff streak counts staff attempts, and the probe
-- that precedes every storefront sign-in stops spending the customer's budget.
--
-- IT ALSO STOPS A REAL CROSS-CONTEXT PROBLEM. Sharing one bucket meant a
-- customer typing their password wrongly four times also filled the STAFF
-- counter for that address. The next storefront sign-in then got a 429 from the
-- staff probe before the customer path ran at all — a customer locked out of
-- the shop by a portal counter for an account they do not have.
--
-- WHAT STILL SHARES A BUCKET, ON PURPOSE
-- --------------------------------------
-- Sign-in and the password-change re-authentication for the SAME audience.
-- api/shop/password.php's header says it shares sign-in's counter so a stolen
-- session cannot become an unlimited password oracle; that is still true, and
-- still what happens — both are 'customer'. The split here is between
-- audiences, not between forms.
--
-- Existing rows default to 'customer'. They are historical failures whose
-- origin is no longer knowable, and the customer bucket is the one where an
-- extra old row is harmless: it decays out of the 30-minute window on its own.
--
-- RE-RUNNABLE. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/012-lockout-context.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_012 //

CREATE PROCEDURE eb_migrate_012()
BEGIN
    DECLARE has_tbl INT DEFAULT 0;
    DECLARE has_col INT DEFAULT 0;
    DECLARE has_idx INT DEFAULT 0;

    /* login_attempts comes from db/schema-additions.sql, which is optional.
       Nothing to do if the throttle is not installed at all. */
    SELECT COUNT(*) INTO has_tbl
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_attempts';

    IF has_tbl = 1 THEN
        SELECT COUNT(*) INTO has_col
          FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'login_attempts' AND COLUMN_NAME = 'context';

        IF has_col = 0 THEN
            ALTER TABLE login_attempts
              ADD COLUMN context VARCHAR(16) NOT NULL DEFAULT 'customer'
                  COMMENT 'which audience: customer | staff'
                  AFTER ip_address;
        END IF;

        /* The lookup Lockout::secondsRemaining performs on every attempt:
           email + ip + context, newest first. Without context in the key the
           index stops covering the query the moment the column is used. */
        SELECT COUNT(*) INTO has_idx
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'login_attempts'
           AND INDEX_NAME = 'idx_attempts_key';

        IF has_idx = 0 THEN
            CREATE INDEX idx_attempts_key
                ON login_attempts (email, ip_address, context, attempted_at);
        END IF;
    END IF;
END //

DELIMITER ;

CALL eb_migrate_012();
DROP PROCEDURE eb_migrate_012;


/* -------------------------------------------------------------
   Verification

   SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_attempts'
    ORDER BY ORDINAL_POSITION;

   Expected: context VARCHAR(16) NOT NULL DEFAULT 'customer', and an index
   idx_attempts_key on (email, ip_address, context, attempted_at).
   ------------------------------------------------------------- */
