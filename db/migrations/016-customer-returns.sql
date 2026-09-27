-- ---------------------------------------------------------------------------
-- 016 — Customer return & refund requests
--
-- WHAT WAS THERE
-- --------------
-- product_returns held ONE product per row and had no way in except seed data:
-- no customer screen could create one. Staff worked each row through the
-- 7-step pipeline (api/returns/advance.php).
--
-- WHAT THIS ADDS
-- --------------
--   orders.completed_at       when the order reached `completed`. The customer
--                             may request a return for 24 hours after this.
--                             delivered_at could not serve: it is cleared the
--                             moment an order leaves `delivered`.
--
--   product_returns           becomes the REQUEST (one row per request, which
--                             is what staff see and advance):
--     + proof_image           the customer's photo of the problem
--     + scope                 'whole' order or picked 'items'
--     product_id / qty / batch_code stay, holding the FIRST item and the TOTAL
--     units, so older queries that join products keep working.
--
--   product_return_items      the lines of a request: which product, how many,
--                             and the unit price the customer actually paid.
--                             Stock goes back per line when a refund is
--                             processed.
--
-- The PHP checks for product_return_items before using any of this, so the
-- code can be deployed before or after this file is run.
-- ---------------------------------------------------------------------------

ALTER TABLE orders
    ADD COLUMN completed_at DATETIME NULL AFTER delivered_at;

ALTER TABLE product_returns
    ADD COLUMN proof_image VARCHAR(255) NULL AFTER reason,
    ADD COLUMN scope ENUM('whole','items') NOT NULL DEFAULT 'items' AFTER proof_image;

CREATE TABLE IF NOT EXISTS product_return_items (
    id INT AUTO_INCREMENT NOT NULL,
    return_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    qty INT NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    batch_code VARCHAR(50) NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_rti_return FOREIGN KEY (return_id)
        REFERENCES product_returns(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_rti_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rti_return ON product_return_items(return_id);

-- Existing returns become one-item requests. The unit price is what that line
-- was sold at; failing that, the stored refund spread over the units.
INSERT INTO product_return_items (return_id, product_id, qty, unit_price, batch_code)
SELECT r.id, r.product_id, r.qty,
       COALESCE(
         (SELECT oi.price_at_purchase FROM order_items oi
           WHERE oi.order_id = r.order_id AND oi.product_id = r.product_id LIMIT 1),
         r.refund_amount / NULLIF(r.qty, 0),
         0),
       r.batch_code
  FROM product_returns r
 WHERE NOT EXISTS (SELECT 1 FROM product_return_items i WHERE i.return_id = r.id);

-- OPTIONAL: fill completed_at for orders already completed, from the status
-- history. Run only if the order_status_history table exists (it is optional —
-- see schema-additions.sql). Orders left NULL simply cannot be returned, which
-- for anything completed before today is the right answer anyway.
--
-- UPDATE orders o
--    SET o.completed_at = (SELECT MAX(h.changed_at) FROM order_status_history h
--                           WHERE h.order_id = o.id AND h.to_status = 'completed')
--  WHERE o.status = 'completed' AND o.completed_at IS NULL;
