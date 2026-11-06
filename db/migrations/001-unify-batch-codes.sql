/* =============================================================
   MIGRATION 001 — unify batch codes on the JBF-YYYY-Bnnn format

   THE PROBLEM
   -----------
   Three batch-code formats existed in the data against one lot_code
   column:

     batches.lot_code                 JBF-2026-B112   <- the real registry
     orders.batch_code_hint           BT-20260617-01
     product_returns.batch_code       BT-20260430-A
     inventory_adjustments.batch_code BT-20260501-B

   Measured before this ran: of 30 orders carrying a batch hint, ZERO
   matched a real lot. Of 6 returns carrying a code, ZERO matched. Every
   batch reference outside the batches table was a dangling pointer, so
   "which lot did this order ship from?" had no answer — the traceability
   screen worked only because nothing ever followed those links.

   THE APPROACH
   ------------
   Remap to a defensible real lot rather than invent one: for each row,
   pick a batch OF THE SAME PRODUCT that was produced on or before the
   relevant date and had not yet expired. Where no such batch exists, set
   NULL — an honest "we do not know which lot" beats a code that looks
   authoritative and points nowhere.

   Idempotent: rows already holding a real lot_code are left alone, so
   re-running changes nothing.

   Reversible: take a dump of the three columns first if you want to undo.
       SELECT id, batch_code_hint FROM orders;

   NO `USE elisha_bay_db;` — the same rule 003 onwards follow, and the
   reason is this file. It used to open with that line, which made it
   ignore the database named on the command line:

       mysql -u root eb_scratch < db/migrations/001-unify-batch-codes.sql

   silently ran against the LIVE database instead. Rehearsing the install
   in a scratch copy therefore translated nothing in the copy — 001 had
   done its work elsewhere — and 002 then failed on the untranslated seed
   codes with ERROR 1452, which read exactly like a bug in 001's logic.
   It was not: 001 ran fine, in the wrong place. (On live it was a no-op,
   because every guard below checks for a code that no longer resolves.)

   Run it against the database you mean:

       mysql -u root elisha_bay_db < db/migrations/001-unify-batch-codes.sql
   ============================================================= */

SET NAMES utf8mb4;

/* ---------------------------------------------------------------
   1. Orders — match against the products actually on the order.
   --------------------------------------------------------------- */
UPDATE orders o
   SET o.batch_code_hint = (
        SELECT b.lot_code
          FROM batches b
          JOIN order_items oi ON oi.product_id = b.product_id
         WHERE oi.order_id = o.id
           AND b.production_date <= o.date
           AND b.expiry_date     >= o.date
         ORDER BY b.production_date DESC
         LIMIT 1
   )
 WHERE o.batch_code_hint IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM batches b2 WHERE b2.lot_code = o.batch_code_hint);

/* ---------------------------------------------------------------
   2. Returns — match on the returned product and the purchase date.
   --------------------------------------------------------------- */
UPDATE product_returns r
   SET r.batch_code = (
        SELECT b.lot_code
          FROM batches b
         WHERE b.product_id = r.product_id
           AND b.production_date <= r.purchase_date
         ORDER BY b.production_date DESC
         LIMIT 1
   )
 WHERE r.batch_code IS NOT NULL
   AND r.batch_code <> ''
   AND NOT EXISTS (SELECT 1 FROM batches b2 WHERE b2.lot_code = r.batch_code);

/* ---------------------------------------------------------------
   3. Inventory adjustments — match on the adjusted product.

   These are historical disposal/return records; the batch is context
   rather than a live link, but a wrong code is still worse than none.
   --------------------------------------------------------------- */
UPDATE inventory_adjustments a
   SET a.batch_code = (
        SELECT b.lot_code
          FROM batches b
         WHERE b.product_id = a.product_id
           AND b.production_date <= a.date
         ORDER BY b.production_date DESC
         LIMIT 1
   )
 WHERE a.batch_code IS NOT NULL
   AND a.batch_code <> ''
   AND NOT EXISTS (SELECT 1 FROM batches b2 WHERE b2.lot_code = a.batch_code);

/* ---------------------------------------------------------------
   4. Anything still unmatched becomes NULL.

   A code in the old format that no batch can justify is not data — it is
   a guess that reads as a fact. Emptying it makes the gap visible.
   --------------------------------------------------------------- */
UPDATE orders o
   SET o.batch_code_hint = NULL
 WHERE o.batch_code_hint IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = o.batch_code_hint);

UPDATE product_returns r
   SET r.batch_code = NULL
 WHERE r.batch_code IS NOT NULL
   AND r.batch_code <> ''
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = r.batch_code);

UPDATE inventory_adjustments a
   SET a.batch_code = NULL
 WHERE a.batch_code IS NOT NULL
   AND a.batch_code <> ''
   AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = a.batch_code);

/* ---------------------------------------------------------------
   5. Report what is left.
   --------------------------------------------------------------- */
SELECT 'orders with a batch hint'        AS metric, COUNT(*) AS n FROM orders WHERE batch_code_hint IS NOT NULL
UNION ALL SELECT 'orders hints resolving to a real lot', COUNT(*) FROM orders o JOIN batches b ON b.lot_code = o.batch_code_hint
UNION ALL SELECT 'returns with a batch code',            COUNT(*) FROM product_returns WHERE batch_code IS NOT NULL
UNION ALL SELECT 'return codes resolving',               COUNT(*) FROM product_returns r JOIN batches b ON b.lot_code = r.batch_code
UNION ALL SELECT 'adjustments with a batch code',        COUNT(*) FROM inventory_adjustments WHERE batch_code IS NOT NULL
UNION ALL SELECT 'adjustment codes resolving',           COUNT(*) FROM inventory_adjustments a JOIN batches b ON b.lot_code = a.batch_code;

/* ---------------------------------------------------------------
   NOT DONE HERE: a foreign key on these columns — see 002.

   This note used to end with a sample ALTER TABLE for anyone who wanted
   the constraint. 002-batch-code-foreign-keys.sql now adds it, on all
   three columns, under the names fk_orders_batch_hint,
   fk_returns_batch_code and fk_adjustments_batch_code. The sample used a
   different name (fk_orders_batch), so running it as well would have put
   a SECOND, redundant key on orders.batch_code_hint. It is removed for
   that reason.

   Kept a separate migration because a data cleanup should not decide how
   strict the workflow is. 002 requires this file to have run first: the
   keys cannot be added while any old-format code survives.
   --------------------------------------------------------------- */
