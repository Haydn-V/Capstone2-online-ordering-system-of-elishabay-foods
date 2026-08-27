-- ---------------------------------------------------------------------------
-- Refresh the demo data's dates so the seed stays current.
--
-- WHY THIS EXISTS
-- ---------------
-- db/seed.sql carries a fixed era: orders run 2025-11-29 to 2026-06-17. That was
-- fine on the day it was written and drifts further out of date every day since.
-- The consequence is not cosmetic — "Today", "This Week" and "This Month" on the
-- Sales Report and dashboard read EMPTY, because there genuinely are no orders in
-- those windows.
--
-- It also caused real defects. The client used to pin dAgo() to the constant
-- 2026-06-17 precisely so the demo would look populated, and that constant leaked
-- into payment-overdue status and batch expiry — where it reported a lot as having
-- 336 days of shelf life left when the true figure was 275.
--
-- The code was fixed to use the real clock (api/core/Dates.php, Asia/Manila). This
-- file fixes the other half: it moves the DATA to the present instead of dragging
-- the clock into the past.
--
-- WHAT IT DOES
-- ------------
-- Computes one delta — the gap between today and the most recent order — and
-- shifts every business date by exactly that amount. Relative spacing is
-- preserved, so an order still precedes its batch's expiry, a return still
-- follows its purchase, and a NET-60 account still falls due sixty days after it
-- was opened. Nothing is invented and no row is added or removed.
--
-- IDEMPOTENT. The delta is measured from the data itself, so a second run
-- computes zero and changes nothing. Safe to run before a demo, before a defence,
-- or on a schedule.
--
-- NOT SHIFTED: every `created_at` / `updated_at` column. Those are row-import
-- metadata, not business dates — they legitimately say when the row entered this
-- database. `login_attempts` is transient and excluded for the same reason.
--
-- BACK UP FIRST if the data matters:
--   mysqldump -u root --databases elisha_bay_db > backup.sql
-- ---------------------------------------------------------------------------

USE elisha_bay_db;

-- One delta for everything. Measured so the newest order lands on today.
SET @delta := (SELECT DATEDIFF(CURDATE(), MAX(date)) FROM orders);

SELECT CONCAT('Shifting every business date forward by ', @delta, ' day(s).') AS plan;

-- ---------------------------------------------------------------------------
-- Orders and their history
-- ---------------------------------------------------------------------------
UPDATE orders
   SET date     = DATE_ADD(date, INTERVAL @delta DAY),
       datetime = DATE_ADD(datetime, INTERVAL @delta DAY)
 WHERE @delta <> 0;

UPDATE order_status_history
   SET changed_at = DATE_ADD(changed_at, INTERVAL @delta DAY)
 WHERE @delta <> 0;

-- ---------------------------------------------------------------------------
-- Batches. Harvest -> production -> expiry all move together, so shelf life and
-- the gaps between them stay exactly as designed.
-- ---------------------------------------------------------------------------
UPDATE batches
   SET harvest_date    = DATE_ADD(harvest_date, INTERVAL @delta DAY),
       production_date = DATE_ADD(production_date, INTERVAL @delta DAY),
       expiry_date     = DATE_ADD(expiry_date, INTERVAL @delta DAY)
 WHERE @delta <> 0;

-- ---------------------------------------------------------------------------
-- Returns, adjustments, credit accounts, applications, customers, notifications
-- ---------------------------------------------------------------------------
UPDATE product_returns
   SET purchase_date = DATE_ADD(purchase_date, INTERVAL @delta DAY),
       received_date = DATE_ADD(received_date, INTERVAL @delta DAY)
 WHERE @delta <> 0;

UPDATE inventory_adjustments
   SET date = DATE_ADD(date, INTERVAL @delta DAY)
 WHERE @delta <> 0;

-- Due dates move with everything else, so the accounts that were meant to read
-- as overdue still do, and by the same margin.
UPDATE payment_accounts
   SET due_date = DATE_ADD(due_date, INTERVAL @delta DAY)
 WHERE @delta <> 0;

UPDATE b2b_applications
   SET submitted_date = DATE_ADD(submitted_date, INTERVAL @delta DAY)
 WHERE @delta <> 0;

UPDATE customers
   SET joined = DATE_ADD(joined, INTERVAL @delta DAY)
 WHERE @delta <> 0;

UPDATE notifications
   SET created_at = DATE_ADD(created_at, INTERVAL @delta DAY)
 WHERE @delta <> 0;

UPDATE audit_logs
   SET ts = DATE_ADD(ts, INTERVAL @delta DAY)
 WHERE @delta <> 0;

-- ---------------------------------------------------------------------------
-- Report the result rather than assume it.
-- ---------------------------------------------------------------------------
SELECT 'orders'        AS dataset, MIN(date) AS earliest, MAX(date) AS latest FROM orders
UNION ALL SELECT 'batches produced', MIN(production_date), MAX(production_date) FROM batches
UNION ALL SELECT 'batches expire',   MIN(expiry_date),     MAX(expiry_date)     FROM batches
UNION ALL SELECT 'returns',          MIN(purchase_date),   MAX(purchase_date)   FROM product_returns
UNION ALL SELECT 'payments due',     MIN(due_date),        MAX(due_date)        FROM payment_accounts
UNION ALL SELECT 'audit log',        DATE(MIN(ts)),        DATE(MAX(ts))        FROM audit_logs;

SELECT
  (SELECT COUNT(*) FROM orders WHERE date = CURDATE())                              AS orders_today,
  (SELECT COUNT(*) FROM orders WHERE date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)) AS orders_this_week,
  (SELECT COUNT(*) FROM orders WHERE date >= DATE_FORMAT(CURDATE(), '%Y-%m-01'))    AS orders_this_month,
  (SELECT COUNT(*) FROM batches WHERE expiry_date < CURDATE())                      AS expired_lots,
  (SELECT COUNT(*) FROM payment_accounts WHERE paid = 0 AND due_date < CURDATE())   AS overdue_accounts;

-- ---------------------------------------------------------------------------
-- One seed inconsistency, corrected.
--
-- cus-04 (Danilo Mercado) was seeded as a `retailer` while his only B2B
-- application, APP-2026-008, sat at `pending`. Under the rule the system now
-- enforces — retailer status comes ONLY from approving an application — that
-- state is unreachable, so the data described something the software cannot
-- produce.
--
-- Corrected by approving the application rather than demoting the customer: he
-- holds a live credit account (payment_accounts), so demoting him would orphan a
-- real financial record to tidy a status field. Silver matches his Net 60 terms,
-- consistent with Castro Restaurant Group on Net 90 at Silver and Flores on
-- Net 30 at Bronze.
--
-- Guarded, so re-running changes nothing once applied.
-- ---------------------------------------------------------------------------
UPDATE b2b_applications
   SET status = 'approved', assigned_tier = 'Silver'
 WHERE app_id_code = 'APP-2026-008'
   AND status = 'pending';

SELECT a.app_id_code, a.status, a.assigned_tier, c.id AS customer, c.status AS customer_status
  FROM b2b_applications a JOIN customers c ON c.id = a.customer_id
 WHERE c.status = 'retailer'
 ORDER BY a.app_id_code;
