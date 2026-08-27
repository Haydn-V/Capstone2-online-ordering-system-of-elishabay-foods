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
-- All three stay NULLABLE. A walk-in sale has no batch hint, and most stock
-- adjustments are not lot-specific; NULL is a real answer here, not missing data.
--
-- PRECONDITIONS (verified before writing this file):
--   * batches.lot_code carries a UNIQUE index
--   * all four columns are varchar(50) utf8mb4_unicode_ci — FK requires a match
--   * orphan count is 0 in all three columns
--
-- If this migration fails with errno 150, run the orphan check at the bottom
-- first; something wrote a bad value after 001.
-- ---------------------------------------------------------------------------

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_batch_hint
  FOREIGN KEY (batch_code_hint) REFERENCES batches (lot_code)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE product_returns
  ADD CONSTRAINT fk_returns_batch_code
  FOREIGN KEY (batch_code) REFERENCES batches (lot_code)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE inventory_adjustments
  ADD CONSTRAINT fk_adjustments_batch_code
  FOREIGN KEY (batch_code) REFERENCES batches (lot_code)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ON UPDATE CASCADE is safe and useful here: correcting a typo in a lot code
-- should carry through to every record that cites it, which is precisely what
-- you want from a traceability key.

-- ---------------------------------------------------------------------------
-- Orphan check — run this first if the ALTERs fail.
--
--   SELECT 'orders' src, batch_code_hint code FROM orders o
--     WHERE o.batch_code_hint IS NOT NULL
--       AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = o.batch_code_hint)
--   UNION ALL
--   SELECT 'returns', batch_code FROM product_returns r
--     WHERE r.batch_code IS NOT NULL
--       AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = r.batch_code)
--   UNION ALL
--   SELECT 'adjustments', batch_code FROM inventory_adjustments a
--     WHERE a.batch_code IS NOT NULL
--       AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.lot_code = a.batch_code);
-- ---------------------------------------------------------------------------
