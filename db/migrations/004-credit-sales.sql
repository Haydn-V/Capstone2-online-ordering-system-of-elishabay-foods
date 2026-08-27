-- ---------------------------------------------------------------------------
-- 004 — a credit sale can be traced back to the sale
--
-- Decision I8. `payment_accounts` holds retailer receivables (Net 30/60/90) and
-- had no link to the order that created them, because nothing created them:
-- every row in the table was seeded, and the only write anywhere in the
-- codebase was `UPDATE payment_accounts SET paid = ?` in payments/settle.php.
-- A balance could be marked settled and could never be raised.
--
-- WHY THAT MATTERED
-- -----------------
-- The POS offers Net 30 / Net 60 / Net 90 the moment a cashier selects
-- "Retailer" (assets/js/portal/pos.js, buildPayMethodGrid). api/pos/checkout.php
-- accepted only cash, gcash and bank, so pressing Place Order returned
--
--     422  pay_method: Payment method must be one of: cash, gcash, bank.
--
-- and placeOrder()'s error handler had no branch for `pay_method`, so nothing
-- was shown at all. The cashier saw the button do nothing. No order row, no
-- receivable, nothing in Payment History — which is the defect as reported.
--
-- WHAT THIS ADDS
-- --------------
-- One nullable column, so a receivable names the sale it came from.
--
-- NULLABLE because the four seeded rows predate any order and because the FK is
-- ON DELETE SET NULL: deleting an order should not silently take the record of
-- money still owed with it. Losing the link is recoverable; losing the debt is
-- not.
--
-- RE-RUNNABLE, same as 003, and for the same reason.
--
-- NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/004-credit-sales.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_004 //

CREATE PROCEDURE eb_migrate_004()
BEGIN
    DECLARE has_col INT DEFAULT 0;
    DECLARE has_fk  INT DEFAULT 0;

    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payment_accounts' AND COLUMN_NAME = 'order_id';

    IF has_col = 0 THEN
        ALTER TABLE payment_accounts
          ADD COLUMN order_id VARCHAR(50) NULL
            COMMENT 'The sale that opened this receivable. NULL for seeded rows and for any account whose order was deleted.'
            AFTER customer_id;
    END IF;

    SELECT COUNT(*) INTO has_fk
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payment_accounts'
       AND CONSTRAINT_NAME = 'fk_payacct_order';

    IF has_fk = 0 THEN
        ALTER TABLE payment_accounts
          ADD CONSTRAINT fk_payacct_order
          FOREIGN KEY (order_id) REFERENCES orders (id)
          ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END //

DELIMITER ;

CALL eb_migrate_004();
DROP PROCEDURE eb_migrate_004;


/* -------------------------------------------------------------
   Verification

   SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_accounts'
      AND COLUMN_NAME = 'order_id';

   Expected: one row, YES.
   ------------------------------------------------------------- */
