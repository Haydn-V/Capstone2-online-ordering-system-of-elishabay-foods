-- ---------------------------------------------------------------------------
-- 009 — a lot for every product that holds stock
--
-- WHY THIS EXISTS
-- ---------------
-- api/inventory/adjust.php now REQUIRES a lot code on disposal and return, and
-- the form picks it from the selected product's own batches. Three active
-- products held real stock with no batch row at all:
--
--     bg-portu     Portuguese Style Bangus     74 units
--     bg-tomato    Bangus in Tomato Sauce     112 units
--     bg-tuyopes   Tuyo in Pesto Sauce         96 units
--
-- Without this, those three become impossible to adjust: the picker would have
-- nothing to offer and the disposal of genuinely damaged stock would be blocked
-- by a traceability rule that has no data to trace.
--
-- WHY A LOT RATHER THAN DELETING THE PRODUCTS
-- -------------------------------------------
-- Removing and re-adding them was considered. Between them they carry twelve
-- order lines, a return record and a featured-list entry; the foreign keys on
-- order_items and product_returns would either refuse the delete or take real
-- sales history with it, and the replacements would start with no rating and a
-- lifetime `sold` of zero. Opening a lot reaches the same end state — every
-- product has a lot code — and loses nothing.
--
-- WHAT THESE ROWS CLAIM
-- ---------------------
-- The note on each says plainly that the lot was opened to account for stock
-- that predates batch tracking. These are NOT original production runs and must
-- not read as though they were: the harvest and production dates are the day
-- the lot was opened, not a manufacturing record anyone observed. A QA
-- traceability table whose rows quietly invent provenance is worse than one
-- with an honest gap in it.
--
-- Shelf life is 364 days, matching every other lot in this database.
--
-- IDEMPOTENT
-- ----------
-- Each insert is guarded by NOT EXISTS on the product, so a second run inserts
-- nothing. Re-runnable like schema-additions.sql and 001.
-- ---------------------------------------------------------------------------

USE elisha_bay_db;

-- Lot codes continue the existing sequence; JBF-2026-B112 was the highest.
INSERT INTO batches
    (id, lot_code, product_id, harvest_date, production_date, expiry_date,
     total_qty, remaining_qty, quality_grade, lab_status, qa_inspector, notes)
SELECT
    'bat-213', 'JBF-2026-B113', p.id,
    CURDATE(), CURDATE(), CURDATE() + INTERVAL 364 DAY,
    p.stock, p.stock,
    'Grade A Export Quality', 'passed', 'Jose Reyes (QA Inspector)',
    'Opened to account for stock on hand that predates batch tracking. Dates are the date this lot was opened, not an observed production run.'
  FROM products p
 WHERE p.id = 'bg-portu'
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.product_id = p.id);

INSERT INTO batches
    (id, lot_code, product_id, harvest_date, production_date, expiry_date,
     total_qty, remaining_qty, quality_grade, lab_status, qa_inspector, notes)
SELECT
    'bat-214', 'JBF-2026-B114', p.id,
    CURDATE(), CURDATE(), CURDATE() + INTERVAL 364 DAY,
    p.stock, p.stock,
    'Grade A Export Quality', 'passed', 'Jose Reyes (QA Inspector)',
    'Opened to account for stock on hand that predates batch tracking. Dates are the date this lot was opened, not an observed production run.'
  FROM products p
 WHERE p.id = 'bg-tomato'
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.product_id = p.id);

INSERT INTO batches
    (id, lot_code, product_id, harvest_date, production_date, expiry_date,
     total_qty, remaining_qty, quality_grade, lab_status, qa_inspector, notes)
SELECT
    'bat-215', 'JBF-2026-B115', p.id,
    CURDATE(), CURDATE(), CURDATE() + INTERVAL 364 DAY,
    p.stock, p.stock,
    'Grade A Export Quality', 'passed', 'Jose Reyes (QA Inspector)',
    'Opened to account for stock on hand that predates batch tracking. Dates are the date this lot was opened, not an observed production run.'
  FROM products p
 WHERE p.id = 'bg-tuyopes'
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.product_id = p.id);

-- Should report 0. Any product left here cannot be adjusted through the form.
SELECT COUNT(*) AS products_still_without_a_lot
  FROM products p
 WHERE p.archived = 0
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.product_id = p.id);
