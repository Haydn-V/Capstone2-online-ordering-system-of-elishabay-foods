-- ---------------------------------------------------------------------------
-- 002 — batch-code integrity enforced by the database, not by validation code
--
-- D4. Three columns hold a batch lot code as free text:
--
--     orders.batch_code_hint
--     product_returns.batch_code
--     inventory_adjustments.batch_code
--
-- All three had values pointing at lot codes that did not exist. Migration 001
-- repaired the data by remapping what could be resolved and NULLing what could
-- not. That fixed the rows present at the time; it did nothing to stop the next
-- bad value.
--
-- Application validation has already failed at this once. A foreign key cannot
-- be forgotten, cannot be skipped by a script that writes directly, and cannot
-- be got wrong by the one endpoint nobody remembered to update.
--
-- ON DELETE RESTRICT rather than CASCADE or SET NULL, deliberately: these are
-- traceability records. If a batch is implicated in an order, a return or a
-- stock movement, deleting it should fail loudly and force someone to decide
-- what happens to that history — not silently take the history with it, and not
-- quietly cut the thread that connects a customer complaint to a lot.
--
-- ON UPDATE CASCADE is safe and useful here: correcting a typo in a lot code
-- should carry through to every record that cites it, which is precisely what
-- you want from a traceability key.
--
-- All three stay NULLABLE. A walk-in sale has no batch hint, and most stock
-- adjustments are not lot-specific; NULL is a real answer here, not missing data.
--
-- PRECONDITIONS
--   * batches.lot_code carries a UNIQUE index
--   * all four columns are varchar(50) utf8mb4_unicode_ci — FK requires a match
--   * 001 has run IN THIS DATABASE, so no old-format code survives
--
-- RE-RUNNABLE NOW, and it says what is wrong instead of failing cryptically
-- -----------------------------------------------------------------------
-- This was three bare ALTER TABLE statements. Two consequences:
--
--   A second run failed with "Duplicate key on write or update" (errno 121) on
--   the first constraint name, so this was the one migration that could not be
--   re-applied — every migration from 003 on can.
--
--   Run before 001 had translated the data, it failed with
--       ERROR 1452 (23000): Cannot add or update a child row
--   which names neither the column nor the cause. That exact error came up while
--   rehearsing a fresh install in a scratch database, and it read like a bug in
--   001's logic. It was not — 001 began with `USE elisha_bay_db;` and had run
--   against the live database instead of the scratch one (see its header). The
--   check below would have said so in one line.
--
-- Now each key is added only if it is not already there, and the ALTERs do not
-- start at all while any row still holds a code that resolves to no lot. A
-- stored procedure because MariaDB's ALTER TABLE has no ADD CONSTRAINT IF NOT
-- EXISTS for foreign keys, and SIGNAL needs one.
--
-- NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/002-batch-code-foreign-keys.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_002 //

CREATE PROCEDURE eb_migrate_002()
BEGIN
    DECLARE orphans INT DEFAULT 0;
    DECLARE has_fk  INT DEFAULT 0;
    DECLARE msg     VARCHAR(255);

    /* Refuse before touching anything. A partial run — one key added, two
       refused — would leave the schema in a state no document describes. */
    SELECT
        (SELECT COUNT(*) FROM orders o
          WHERE o.batch_code_hint IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = o.batch_code_hint))
      + (SELECT COUNT(*) FROM product_returns r
          WHERE r.batch_code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = r.batch_code))
      + (SELECT COUNT(*) FROM inventory_adjustments a
          WHERE a.batch_code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = a.batch_code))
      INTO orphans;

    IF orphans > 0 THEN
        SET msg = CONCAT(orphans, ' batch code(s) resolve to no lot in this database. ',
                         'Run 001-unify-batch-codes.sql against THIS database first, ',
                         'then this migration.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
    END IF;

    SELECT COUNT(*) INTO has_fk FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
       AND CONSTRAINT_NAME = 'fk_orders_batch_hint' AND CONSTRAINT_TYPE = 'FOREIGN KEY';
    IF has_fk = 0 THEN
        ALTER TABLE orders
          ADD CONSTRAINT fk_orders_batch_hint
          FOREIGN KEY (batch_code_hint) REFERENCES batches (lot_code)
          ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    SELECT COUNT(*) INTO has_fk FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'product_returns'
       AND CONSTRAINT_NAME = 'fk_returns_batch_code' AND CONSTRAINT_TYPE = 'FOREIGN KEY';
    IF has_fk = 0 THEN
        ALTER TABLE product_returns
          ADD CONSTRAINT fk_returns_batch_code
          FOREIGN KEY (batch_code) REFERENCES batches (lot_code)
          ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    SELECT COUNT(*) INTO has_fk FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_adjustments'
       AND CONSTRAINT_NAME = 'fk_adjustments_batch_code' AND CONSTRAINT_TYPE = 'FOREIGN KEY';
    IF has_fk = 0 THEN
        ALTER TABLE inventory_adjustments
          ADD CONSTRAINT fk_adjustments_batch_code
          FOREIGN KEY (batch_code) REFERENCES batches (lot_code)
          ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END //

DELIMITER ;

CALL eb_migrate_002();
DROP PROCEDURE eb_migrate_002;


/* -------------------------------------------------------------
   Verification

   SELECT TABLE_NAME, CONSTRAINT_NAME
     FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'batches'
      AND CONSTRAINT_NAME IN ('fk_orders_batch_hint', 'fk_returns_batch_code',
                              'fk_adjustments_batch_code');

   Expected: three rows.

   Orphan check — what the guard above counts, row by row:

   SELECT 'orders' src, batch_code_hint code FROM orders o
     WHERE o.batch_code_hint IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = o.batch_code_hint)
   UNION ALL
   SELECT 'returns', batch_code FROM product_returns r
     WHERE r.batch_code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = r.batch_code)
   UNION ALL
   SELECT 'adjustments', batch_code FROM inventory_adjustments a
     WHERE a.batch_code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = a.batch_code);
   ------------------------------------------------------------- */
