-- ---------------------------------------------------------------------------
-- 006 — the schema the written Scope already promised
--
-- The capstone's Scope and Limitations describes six behaviours the code does
-- not have. Four of them cannot exist without columns that were never added.
-- This migration adds only the storage; the endpoints and screens come with it.
--
-- WHAT EACH CHANGE IS FOR
-- -----------------------
--
-- 1. orders.delivered_at
--    "The system updates a delivered order to completed one hour after
--    delivery." Nothing recorded WHEN an order became delivered, so the hour
--    could not be measured from anything.
--
--    Deliberately a column on `orders` rather than a lookup into
--    order_status_history. That table is optional — every write to it in this
--    codebase is wrapped in Database::hasTable('order_status_history') — and a
--    rule that silently stops running on an install without it is worse than no
--    rule. The sweep must work on the base schema.
--
-- 2. orders.tracking_number
--    The stated Limitation says the system does not integrate with courier
--    APIs, but that "tracking numbers will be issued upon dispatch and will
--    serve as proof of shipment". There was no field anywhere in the schema or
--    the interface, so the limitation promised something the system could not
--    do at all.
--
--    VARCHAR(60): couriers here issue codes well under that (LBC 12-14, J&T 12,
--    Ninja Van 15), and the headroom costs nothing.
--
-- 3. verification_codes
--    "The system sends a verification code to the registered email whenever the
--    user attempts to change important account details."
--
--    code_hash, not code. A verification code is a bearer credential for the
--    minutes it lives: anyone holding it can complete the change. A leaked
--    database must not hand over live account-change tokens, for exactly the
--    reason customers.password is a bcrypt hash and not a password.
--
--    `payload` holds the pending change as JSON rather than applying it and
--    rolling back on failure. The customers row is untouched until the code is
--    proven, so an abandoned verification leaves nothing behind.
--
--    `attempts` is on the row, not in a session: a lockout that a client can
--    reset by clearing a cookie is not a lockout.
--
-- 4. order_status_history
--    Created here IF it does not exist. Its definition already lives in
--    db/schema-additions.sql, which is documented as optional, so every writer
--    guards on hasTable(). Several of the new endpoints write to it. Creating it
--    here does not remove those guards — an install that skipped this migration
--    must still work — it just means a migrated install always has it.
--
-- RE-RUNNABLE. Every step checks information_schema first, like 003, 004 and
-- 005. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/006-scope-completion.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_006 //

CREATE PROCEDURE eb_migrate_006()
BEGIN
    DECLARE has_col   INT DEFAULT 0;
    DECLARE has_table INT DEFAULT 0;

    /* ---- 1. orders.delivered_at ------------------------------------- */
    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'delivered_at';

    IF has_col = 0 THEN
        ALTER TABLE orders
          ADD COLUMN delivered_at DATETIME NULL
            COMMENT 'When the order became delivered. Drives the one-hour auto-complete; cleared if it ever leaves delivered.'
            AFTER datetime;
    END IF;

    /* ---- 2. orders.tracking_number ----------------------------------- */
    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'tracking_number';

    IF has_col = 0 THEN
        ALTER TABLE orders
          ADD COLUMN tracking_number VARCHAR(60) NULL
            COMMENT 'Courier tracking number, required when a delivery order ships. Proof of dispatch; the courier is not integrated.'
            AFTER batch_code_hint;
    END IF;

    /* ---- 3. verification_codes --------------------------------------- */
    SELECT COUNT(*) INTO has_table
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_codes';

    IF has_table = 0 THEN
        CREATE TABLE verification_codes (
            id          VARCHAR(50)  NOT NULL,
            customer_id VARCHAR(50)  NOT NULL,
            purpose     VARCHAR(40)  NOT NULL,
            code_hash   VARCHAR(255) NOT NULL,
            payload     TEXT         NOT NULL,
            attempts    INT          NOT NULL DEFAULT 0,
            expires_at  DATETIME     NOT NULL,
            consumed_at DATETIME     NULL,
            created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            CONSTRAINT fk_vcode_customer FOREIGN KEY (customer_id)
                REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

        CREATE INDEX idx_vcode_customer_purpose
            ON verification_codes(customer_id, purpose);
        CREATE INDEX idx_vcode_expires ON verification_codes(expires_at);
    END IF;

    /* ---- 4. order_status_history -------------------------------------
       Definition copied from db/schema-additions.sql. Kept identical on
       purpose: two definitions of one table is how an install ends up with a
       column that only exists on some machines. */
    SELECT COUNT(*) INTO has_table
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_status_history';

    IF has_table = 0 THEN
        CREATE TABLE order_status_history (
            id          INT AUTO_INCREMENT NOT NULL,
            order_id    VARCHAR(50) NOT NULL,
            from_status VARCHAR(20) NULL,
            to_status   VARCHAR(20) NOT NULL,
            changed_by  VARCHAR(50) NULL,
            note        TEXT NULL,
            changed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            CONSTRAINT fk_osh_order FOREIGN KEY (order_id)
                REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT fk_osh_user FOREIGN KEY (changed_by)
                REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

        CREATE INDEX idx_osh_order ON order_status_history(order_id);
        CREATE INDEX idx_osh_changed ON order_status_history(changed_at);
    END IF;

    /* ---- 5. the auto-complete throttle -------------------------------
       Orders::autoCompleteDelivered() is called from two list endpoints and
       must not run its UPDATE on every page load. The last-run marker lives in
       `settings` rather than a file: the application's database user has no
       filesystem grants and should not need any, and a marker in a file is one
       more thing that can be out of step with the data it describes.

       Seeded in the past so the first call after this migration does real work
       rather than waiting five minutes. */
    INSERT INTO settings (key_name, value_text)
    VALUES ('autocomplete_last_run', '1970-01-01 00:00:00')
    ON DUPLICATE KEY UPDATE key_name = key_name;
END //

DELIMITER ;

CALL eb_migrate_006();
DROP PROCEDURE eb_migrate_006;


/* -------------------------------------------------------------
   Verification — run after applying

   SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND (   (TABLE_NAME = 'orders' AND COLUMN_NAME IN ('delivered_at','tracking_number'))
           OR  TABLE_NAME = 'verification_codes')
    ORDER BY TABLE_NAME, ORDINAL_POSITION;

   Expected: orders.delivered_at (datetime, YES), orders.tracking_number
   (varchar 60, YES), and nine verification_codes columns.

   SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('verification_codes','order_status_history');

   Expected: 2.

   SELECT value_text FROM settings WHERE key_name = 'autocomplete_last_run';

   Expected: one row.
   ------------------------------------------------------------- */
