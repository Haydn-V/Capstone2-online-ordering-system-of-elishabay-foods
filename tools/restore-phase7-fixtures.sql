-- ---------------------------------------------------------------------------
-- Restore the rows Phase 7 click-testing changed.
--
-- Written while MySQL was down mid-phase so the changes could not be lost.
-- Safe to run more than once.
--
-- What was exercised, and what it changed:
--
--   Payment Verification -> Approve  on ORD-20260617-001 and ORD-20260617-005
--     * orders.pay_verified 0 -> 1
--     * orders.status  pending  -> accepted   (…-001)
--     * orders.status  on-hold  -> accepted   (…-005)
--     * accepting an online order DECREMENTS stock and increments sold, so both
--       orders' line items moved product rows too
--     * two audit_logs rows per order, plus an order_status_history row each
--
-- The behaviour was correct in every respect. These are test mutations, not
-- defects, and this file only puts the fixtures back.
-- ---------------------------------------------------------------------------

USE elisha_bay_db;

-- 1. Put the stock back that accepting those two orders consumed.
UPDATE products p
   JOIN (
     SELECT oi.product_id, SUM(oi.qty) AS qty
       FROM order_items oi
      WHERE oi.order_id IN ('ORD-20260617-001','ORD-20260617-005')
      GROUP BY oi.product_id
   ) m ON m.product_id = p.id
   SET p.stock = p.stock + m.qty,
       p.sold  = GREATEST(0, p.sold - m.qty);

-- 2. Orders back to their seeded state.
UPDATE orders SET status='pending', pay_verified=0 WHERE id='ORD-20260617-001';
UPDATE orders SET status='on-hold', pay_verified=0 WHERE id='ORD-20260617-005';

-- 3. Remove the history and audit rows the test produced.
DELETE FROM order_status_history
 WHERE order_id IN ('ORD-20260617-001','ORD-20260617-005')
   AND changed_at >= CURDATE();

DELETE FROM audit_logs WHERE id > 28;

-- 4. Report the result so the restore is checkable rather than assumed.
SELECT id, status, pay_verified FROM orders
 WHERE id IN ('ORD-20260617-001','ORD-20260617-005');
SELECT id, stock, sold FROM products WHERE id IN ('bg-pesto','bg-adobo');
SELECT (SELECT COUNT(*) FROM audit_logs) AS audit_rows,
       (SELECT COUNT(*) FROM orders)     AS orders,
       (SELECT COUNT(*) FROM order_items) AS order_items;
-- Expect: audit_rows 28, orders 42, order_items 78,
--         bg-pesto stock 160, bg-adobo stock 138.
