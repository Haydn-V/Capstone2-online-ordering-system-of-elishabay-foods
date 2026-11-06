-- ---------------------------------------------------------------------------
-- 008 — remember what a customer was before they were archived
--
-- customers.status is ENUM('active','retailer','archived'). Those are three
-- values in one column answering two different questions: WHAT KIND of
-- customer is this, and IS THE ACCOUNT OPEN. Archiving overwrites the answer
-- to the first with the answer to the second, and the first is then gone.
--
-- So a restore has nothing to restore TO. The obvious implementation —
--
--     UPDATE customers SET status = 'active' WHERE id = ?
--
-- is the one api/users/archive.php uses, and it is correct there because
-- `users` has only 'active' and 'archived'. Here it silently demotes a
-- retailer to an ordinary customer: they lose wholesale pricing and their
-- credit terms, and nothing in the interface says it happened. The next
-- person to notice is the retailer, at checkout, when Net 30 is not offered
-- any more.
--
-- WHY A COLUMN AND NOT AN INFERENCE
-- ---------------------------------
-- The status could be guessed: "does this customer have an approved row in
-- b2b_applications?" That is a guess, and it is wrong in both directions. A
-- retailer whose partnership was later ended still has the approved
-- application, so the guess promotes them back. A customer granted retailer
-- status through some future route that does not write an application would
-- not be restored at all. Recording the fact costs one nullable column and
-- cannot be wrong.
--
-- WHY NOT SPLIT THE COLUMN PROPERLY
-- ---------------------------------
-- The clean schema is `customers.kind` ENUM('regular','retailer') plus
-- `customers.archived` TINYINT — two questions, two columns. That is the right
-- shape and it is not what this migration does, because `status` is read by
-- name in nineteen places across the API, the portal engine and the
-- storefront, and every one of them would have to change together. A nullable
-- companion column fixes the defect without a migration that has to land
-- atomically with a rewrite. If the split is done later, this column is the
-- thing that tells it what each archived row used to be.
--
-- NULL means "not archived, or archived before this column existed". Restoring
-- a row with NULL falls back to 'active', which is the old behaviour and the
-- safest of the two guesses: it under-grants rather than over-grants.
--
-- RE-RUNNABLE. Guarded on information_schema like 003 through 007.
-- NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/008-customer-archive-restore.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_008 //

CREATE PROCEDURE eb_migrate_008()
BEGIN
    DECLARE has_col INT DEFAULT 0;

    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'status_before_archive';

    IF has_col = 0 THEN
        ALTER TABLE customers
          ADD COLUMN status_before_archive ENUM('active','retailer') NULL
            COMMENT 'What status was replaced when this account was archived. NULL when not archived. Restores read it; nothing else does.'
            AFTER status;

        /* Backfill for rows archived before this column existed. There is
           nothing to recover from — the value they held is gone — so they get
           NULL and a restore treats them as 'active'. Stated explicitly rather
           than left implicit: an archived retailer that predates this
           migration WILL come back as a regular customer, and the only fix is
           for staff to re-approve the partnership. */
        UPDATE customers SET status_before_archive = NULL WHERE status = 'archived';
    END IF;
END //

DELIMITER ;

CALL eb_migrate_008();
DROP PROCEDURE eb_migrate_008;


/* -------------------------------------------------------------
   Verification — run after applying

   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
      AND COLUMN_NAME = 'status_before_archive';

   Expected: one row — enum('active','retailer'), YES.

   SELECT status, status_before_archive, COUNT(*)
     FROM customers GROUP BY status, status_before_archive;

   Expected immediately after applying: no row has a non-NULL
   status_before_archive.
   ------------------------------------------------------------- */
