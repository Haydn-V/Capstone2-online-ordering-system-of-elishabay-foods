-- ---------------------------------------------------------------------------
-- 013 — payments toward a Net account, one row each
--
-- WHAT WAS THERE
-- --------------
-- `payment_accounts` is the receivables table: one row per credit sale, with
-- the amount billed (`balance`) and a yes/no `paid` flag. Staff could press
-- "Mark Paid" and nothing else. A retailer paying a Net 60 balance in three
-- instalments had nowhere to record the first two, no way to send a proof,
-- and no history to look back on — and the Sales Report counted the whole
-- order as revenue on the day it was placed, whether or not a peso had come
-- in.
--
-- WHAT THIS ADDS
-- --------------
-- One table. Each row is one payment: who paid, how much, how, the reference
-- and screenshot, and whether staff have verified it.
--
--   payment_accounts.balance  stays the amount BILLED. It is never decremented.
--   paid so far               = SUM(amount) of VERIFIED rows here
--   remaining                 = billed + penalty − paid so far
--   payment_accounts.paid     becomes derived: set by the server when verified
--                             payments cover what is owed (Payments::refreshAccount),
--                             never by hand
--
-- Deriving "paid so far" from rows rather than storing a running total means
-- the number on screen can always be explained line by line — which is the
-- whole point of the feature.
--
-- `paid_date` IS THE REVENUE DATE
-- -------------------------------
-- The day the money was paid, as the retailer's own records would show it —
-- not the day staff got round to verifying it. A payment counts as revenue
-- only once verified, and then on this date.
--
-- `source`
--   customer  sent from the retailer's Payment Schemes page, starts `pending`
--   staff     recorded at the counter by a cashier or admin, starts `verified`
--   legacy    the backfill below. Counted as PAID but never as revenue.
--
-- ON DELETE RESTRICT on the account: a payment is money received. Deleting the
-- receivable must not quietly take the record of that money with it.
--
-- WHY THE BACKFILL, AND WHY IT IS NOT REVENUE
-- -------------------------------------------
-- Accounts already marked paid before this existed have no payment rows, so
-- "paid so far" would read ₱0 and the account would reopen. Each gets one
-- `legacy` row for its full balance. The date that money actually arrived was
-- never recorded, so these rows are excluded from revenue: inventing a date
-- would put real money into a month it may not belong to. Same principle as
-- migration 009 — a record that quietly invents history is worse than one
-- with an honest gap.
--
-- SAFE ON XAMPP's MariaDB 10.4
-- ----------------------------
-- CREATE TABLE and INSERT only. No ALTER, so none of the instant-ALTER code
-- path that crashed mysqld during migration 010 on 2026-09-11.
--
-- RE-RUNNABLE. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/013-credit-payments.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_payments (
    id               INT AUTO_INCREMENT NOT NULL,
    account_id       VARCHAR(50)  NOT NULL,
    customer_id      VARCHAR(50)  NULL,
    amount           DECIMAL(10,2) NOT NULL,
    /* NULL only on legacy rows, where how the money arrived was never recorded. */
    method           ENUM('gcash','bank','cash') NULL,
    ref_num          VARCHAR(100) NULL,
    proof_image_path VARCHAR(255) NULL,
    status           ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
    source           ENUM('customer','staff','legacy')     NOT NULL DEFAULT 'customer',
    paid_date        DATE NOT NULL COMMENT 'the day the money was paid — the revenue date',
    note             VARCHAR(500) NULL,
    reject_reason    VARCHAR(500) NULL COMMENT 'required when status = rejected; shown to the retailer',
    submitted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by       VARCHAR(50) NULL,
    decided_at       DATETIME NULL,
    PRIMARY KEY (id),
    /* An account's payments, by state — the paid / pending sums on every read. */
    KEY idx_cp_account_status (account_id, status),
    /* The staff review queue, oldest first. */
    KEY idx_cp_status_submitted (status, submitted_at),
    /* Revenue by date range. */
    KEY idx_cp_status_paid_date (status, paid_date),
    CONSTRAINT fk_cp_account  FOREIGN KEY (account_id)  REFERENCES payment_accounts (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_cp_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_cp_decider  FOREIGN KEY (decided_by)  REFERENCES users (id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One legacy row per account already marked paid that has no payment rows.
-- Guarded by NOT EXISTS, so a second run inserts nothing.
--
-- DATED NO LATER THAN THE DUE DATE. The old system treated `paid = 1` as
-- settled in full, penalty and all. Dating the row on the day the account was
-- created — which for the seeded accounts is the day the demo data was
-- imported, weeks after their due dates — made the new penalty rule (charged on
-- what was unpaid ON the due date) bill a late penalty the old system never
-- asked for, and reopened two settled accounts as overdue.
INSERT INTO credit_payments
       (account_id, customer_id, amount, method, status, source, paid_date, note, submitted_at)
SELECT pa.id, pa.customer_id, pa.balance, NULL, 'verified', 'legacy',
       LEAST(DATE(pa.created_at), pa.due_date),
       'Settled before payment tracking existed. When the money arrived was never recorded, so this is not counted as revenue.',
       pa.created_at
  FROM payment_accounts pa
 WHERE pa.paid = 1
   AND NOT EXISTS (SELECT 1 FROM credit_payments cp WHERE cp.account_id = pa.id);

-- Repairs an install that ran the first version of this file, which dated
-- legacy rows by created_at alone. A no-op everywhere else.
UPDATE credit_payments cp
  JOIN payment_accounts pa ON pa.id = cp.account_id
   SET cp.paid_date = LEAST(cp.paid_date, pa.due_date)
 WHERE cp.source = 'legacy' AND cp.paid_date > pa.due_date;


/* -------------------------------------------------------------
   Verification

   SELECT pa.id, pa.scheme, pa.balance, pa.paid,
          COALESCE(SUM(CASE WHEN cp.status = 'verified' THEN cp.amount END), 0) AS paid_so_far
     FROM payment_accounts pa
     LEFT JOIN credit_payments cp ON cp.account_id = pa.id
    GROUP BY pa.id;

   Expected: every account with paid = 1 shows paid_so_far = balance;
   every account with paid = 0 shows 0.
   ------------------------------------------------------------- */
