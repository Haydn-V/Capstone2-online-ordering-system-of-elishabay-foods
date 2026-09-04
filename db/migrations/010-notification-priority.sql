-- ---------------------------------------------------------------------------
-- 010 — notifications carry an urgency level
--
-- Every notification was equal. list.php returned them newest-first, the bell
-- showed a plain count, and an expired batch still counted as sellable sorted
-- underneath an order somebody had already completed. There was no way to tell
-- "three things happened" from "something is on fire".
--
--     CREATE TABLE notifications (
--       id, type, order_id, return_id, product_id, message, created_at, is_read
--     );
--
-- `type` says WHAT happened. It does not say how much it matters: a `return`
-- can be a refund request that needs looking at today, and an `inventory` row
-- can be a product that has hit zero and is losing sales right now. Those are
-- different levels of the same table.
--
-- WHY A COLUMN AND NOT A CASE STATEMENT IN JAVASCRIPT
-- --------------------------------------------------
-- Three screens read these rows — the topbar bell, the dashboard's System
-- Notifications panel, and the Notifications module — and each is drawn by a
-- different function. A type→level rule expressed in one screen's script is a
-- rule the other two do not have, and REMEDIATION.md is largely a catalogue of
-- exactly that failure in this codebase (the stock-movement rules written four
-- different ways in five files; the sidebar highlight rule that existed in
-- three places and was wrong in two).
--
-- Stored, the level is decided once, at the moment the event happens, by
-- api/core/Notify.php. Every reader sorts and labels from the same value, and
-- an ORDER BY can use it — which a JavaScript rule cannot, because the ordering
-- has to survive paging.
--
-- WHY AN ENUM AND NOT AN INTEGER RANK
-- -----------------------------------
-- Three named levels that appear verbatim in the interface ("Critical",
-- "Warning", "Info"). An integer would need a lookup on every read to say what
-- 1 means, and would invite a fourth level to be squeezed between two others
-- rather than argued about. Ordering is handled by FIELD() in the query, which
-- keeps the display order in the same place as the rest of the sort.
--
-- THE MAPPING BELOW IS NOT CONFIRMED WITH THE ADVISER. It is the group's
-- reading of which events sit where, and it is written down here so that
-- changing it is a decision with a diff rather than a silent edit:
--
--   critical  a product at critical stock or out of stock; a batch already
--             expired but still counted as sellable; a retailer payment past
--             its due date
--   warning   a batch expiring within 30 days; an order on hold; a new online
--             order or a payment awaiting verification; a return request
--   info      an order completed; audit entries; an application submitted
--
-- The backfill below applies it to the rows already on record, so a system
-- migrated today has the same ordering as one seeded fresh.
--
-- `inventory` backfills to critical because the only two seeded inventory rows
-- are an out-of-stock product and a critically low one — which is what the type
-- has always been used for. Rows raised from here on get their level from
-- Notify::priorityFor() at insert time and never rely on this default.
--
-- RE-RUNNABLE. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/010-notification-priority.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_010 //

CREATE PROCEDURE eb_migrate_010()
BEGIN
    DECLARE has_col INT DEFAULT 0;
    DECLARE has_idx INT DEFAULT 0;

    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'priority';

    IF has_col = 0 THEN
        ALTER TABLE notifications
          ADD COLUMN priority ENUM('critical','warning','info') NOT NULL DEFAULT 'info'
              COMMENT 'Urgency level — set by api/core/Notify.php at insert time'
              AFTER type;

        /* Backfill from `type`, using the table in this file's header. Only run
           inside the IF, so re-running the migration cannot overwrite a level
           an operator has since corrected by hand. */
        UPDATE notifications SET priority = CASE type
            WHEN 'inventory' THEN 'critical'
            WHEN 'new-order' THEN 'warning'
            WHEN 'payment'   THEN 'warning'
            WHEN 'hold'      THEN 'warning'
            WHEN 'return'    THEN 'warning'
            WHEN 'completed' THEN 'info'
            WHEN 'audit'     THEN 'info'
            ELSE 'info'
        END;
    END IF;

    /* The unread-per-level counts the bell needs are a GROUP BY over exactly
       these two columns, run on every page load of every portal. */
    SELECT COUNT(*) INTO has_idx
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'notifications' AND INDEX_NAME = 'idx_notif_priority';

    IF has_idx = 0 THEN
        CREATE INDEX idx_notif_priority ON notifications(is_read, priority);
    END IF;
END //

DELIMITER ;

CALL eb_migrate_010();
DROP PROCEDURE eb_migrate_010;


/* -------------------------------------------------------------
   Verification

   SELECT type, priority, COUNT(*) AS rows_
     FROM notifications
    GROUP BY type, priority
    ORDER BY FIELD(priority,'critical','warning','info'), type;

   Expected against db/seed.sql: inventory=critical (2),
   new-order=warning (8), payment=warning (1), hold=warning (1),
   return=warning (2), completed=info (1), audit=info (2).
   No row may have a NULL priority — the column is NOT NULL.
   ------------------------------------------------------------- */
