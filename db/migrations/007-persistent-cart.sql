-- ---------------------------------------------------------------------------
-- 007 — the cart belongs to the account, not to the tab
--
-- state.cart in assets/js/public/site.js was a bare array:
--
--     const state = { theme, cart: [], auth, filter };
--
-- Nothing persisted it. Reload the page and it was empty; sign out and back in
-- and it was empty; open the shop on a phone after adding on a laptop and it
-- was empty. updateCartBadge() rendering 0 was not a badge bug — there really
-- was nothing in the cart, every time.
--
-- WHY NOT localStorage
-- --------------------
-- Because this project has already been burned by trusting the browser. The
-- comment above _savedAuth in site.js records what happened last time: the
-- signed-in flag was restored from localStorage["eb-auth"], and since
-- localStorage is editable from the console, typing the right JSON was a
-- login. That flag is now deliberately NOT restored, and the page starts
-- signed out until the server says otherwise.
--
-- A cart in localStorage is a smaller version of the same mistake. It is
-- per-browser, so it does not survive the device change that is most of the
-- reason to want it; it is per-origin rather than per-account, so two people
-- sharing a machine share a cart; and it is client-authored data that the
-- checkout would then have to distrust anyway.
--
-- The manuscript describes the cart as part of the customer's account. This
-- table is that sentence.
--
-- SHAPE
-- -----
-- PRIMARY KEY (customer_id, product_id) — one row per product per customer,
-- which makes "add this product again" an ON DUPLICATE KEY UPDATE rather than
-- a select-then-branch, and makes a duplicated line impossible rather than
-- merely unlikely. No surrogate id: nothing needs to name a cart line.
--
-- Both foreign keys CASCADE on delete. A deleted customer's cart is not a
-- record of anything, and a deleted product cannot be bought — carrying either
-- one as an orphan would only mean every reader has to handle it.
--
-- qty is INT with a CHECK, not TINYINT. The client caps at CART_MAX_QTY (99)
-- and api/shop/cart-save.php validates the same bound; the CHECK is the third
-- copy, and the only one that holds if somebody writes to the table by hand.
--
-- NO PRICE COLUMN, deliberately. A cart is a list of intentions, not a quote.
-- Pricing a line when it is added means a price that silently goes stale in a
-- cart somebody leaves open for a week, and two places that decide what a
-- product costs. api/shop/checkout.php already prices every line from
-- `products` at the moment the order is placed, for exactly this reason, and
-- api/shop/cart.php joins for the current price on the way out.
--
-- updated_at is here so a future housekeeping sweep can age abandoned carts
-- out. Nothing reads it today; that is a five-line cron when somebody asks for
-- it, and adding the column later would mean backfilling.
--
-- RE-RUNNABLE. Guarded on information_schema like 003 through 006.
-- NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/007-persistent-cart.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_007 //

CREATE PROCEDURE eb_migrate_007()
BEGIN
    DECLARE has_table INT DEFAULT 0;

    SELECT COUNT(*) INTO has_table
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_items';

    IF has_table = 0 THEN
        CREATE TABLE cart_items (
            customer_id VARCHAR(50) NOT NULL,
            product_id  VARCHAR(50) NOT NULL,
            qty         INT         NOT NULL,
            updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (customer_id, product_id),
            CONSTRAINT chk_cart_qty CHECK (qty > 0 AND qty <= 99),
            CONSTRAINT fk_cart_customer FOREIGN KEY (customer_id)
                REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT fk_cart_product FOREIGN KEY (product_id)
                REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

        /* The primary key already covers (customer_id, …); this one serves the
           other direction — "is this product in anybody's cart", which is what
           a product archival check would ask. */
        CREATE INDEX idx_cart_product ON cart_items(product_id);
    END IF;
END //

DELIMITER ;

CALL eb_migrate_007();
DROP PROCEDURE eb_migrate_007;


/* -------------------------------------------------------------
   Verification — run after applying

   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_items'
    ORDER BY ORDINAL_POSITION;

   Expected: four rows — customer_id (varchar(50), NO, PRI),
   product_id (varchar(50), NO, PRI), qty (int, NO), updated_at (timestamp, NO).

   SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME
     FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_items'
      AND REFERENCED_TABLE_NAME IS NOT NULL;

   Expected: fk_cart_customer -> customers, fk_cart_product -> products.
   ------------------------------------------------------------- */
