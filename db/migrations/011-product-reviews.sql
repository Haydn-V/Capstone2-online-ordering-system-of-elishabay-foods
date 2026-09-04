-- ---------------------------------------------------------------------------
-- 011 — customer product reviews
--
-- `products.rating` already exists as DECIMAL(3,2) DEFAULT 5.00, is seeded with
-- invented values, and is read in four places: the shop cards, the product
-- detail, the `rating` sort option and the portal's Best Sellers table. Nothing
-- has ever written it from evidence. Every product currently advertises a score
-- it never earned — "4.9" beside a product nobody has rated.
--
-- This is the table that earns it.
--
-- ONLY A VERIFIED PURCHASE CAN PRODUCE A ROW
-- ------------------------------------------
-- `order_id` is NOT NULL and is a real foreign key, so a review cannot exist
-- without an order behind it. api/shop/review-save.php re-derives from the
-- database that the order belongs to the session's customer, is completed, and
-- contains that product — the client's claim that a purchase happened is never
-- taken. Without that, "how do you prevent fake ratings" has no answer, and
-- careful text moderation on top of an open door would be theatre.
--
-- ONE VOTE PER CUSTOMER PER PRODUCT
-- ---------------------------------
-- uq_review_customer_product is the whole rule. A customer who buys the same
-- product three times gets one vote on its average, not three, and a second
-- submission EDITS the first rather than stacking. `order_id` records the
-- purchase that first earned the right and is deliberately not updated on an
-- edit: it is provenance, not a pointer to the latest order.
--
-- WHY status IS AN ENUM AND hold_reason IS A STRING
-- -------------------------------------------------
-- Three states are the whole lifecycle and they are named in the interface, so
-- an ENUM says what an integer rank would not. `hold_reason` is a VARCHAR
-- rather than a second ENUM because 'keyword' is the only trigger today and the
-- next one is not yet known — an ENUM would need a migration to add a reason,
-- and a reason is a label, not a state machine.
--
-- MODERATION IS FOR ABUSE, NOT FOR DISAGREEMENT
-- ---------------------------------------------
-- `reject_reason` is TEXT and the endpoint requires it, because "rejected" with
-- no stated cause is indistinguishable from "we did not like the score". A low
-- rating is never a reason to reject: a 1-2 star review publishes immediately
-- and raises a Warning notification so staff hear about a real problem with a
-- real order quickly. Suppressing it would delay the business learning about a
-- genuine defect while making the product look better than it is.
--
-- THE KEYWORD LIST LIVES IN `settings`, NOT IN PHP
-- ------------------------------------------------
-- Same reason penalty_rate does: a hard-coded list cannot be changed without a
-- deploy, and the people who need to change it are not the people who deploy.
-- Seeded below under `review_flag_words`. Be accurate about what it is — a
-- keyword list, matched case-insensitively on word boundaries. It is not
-- content classification and nothing here should imply that it is.
--
-- RE-RUNNABLE. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/011-product-reviews.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_011 //

CREATE PROCEDURE eb_migrate_011()
BEGIN
    DECLARE has_tbl  INT DEFAULT 0;
    DECLARE has_col  INT DEFAULT 0;
    DECLARE has_perm INT DEFAULT 0;
    DECLARE has_set  INT DEFAULT 0;
    DECLARE perm_id  INT DEFAULT 0;

    SELECT COUNT(*) INTO has_tbl
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_reviews';

    IF has_tbl = 0 THEN
        CREATE TABLE product_reviews (
            id            INT AUTO_INCREMENT NOT NULL,
            product_id    VARCHAR(50) NOT NULL,
            customer_id   VARCHAR(50) NOT NULL,
            /* The purchase that earned the right to review. Kept as the
               EARLIEST qualifying order across edits — provenance, not a
               pointer at the most recent one. */
            order_id      VARCHAR(50) NOT NULL,
            /* 1..5. Range enforced in PHP rather than by a CHECK constraint,
               because MariaDB 10.4 honours CHECK but older MySQL silently
               ignores it, and a rule that is enforced on one engine and not
               another is worse than one enforced in a single known place. */
            rating        TINYINT NOT NULL,
            comment       TEXT NULL,
            status        ENUM('published','pending','rejected') NOT NULL DEFAULT 'published',
            hold_reason   VARCHAR(80) NULL COMMENT 'why it was held: keyword today',
            reject_reason TEXT NULL COMMENT 'required when status = rejected',
            moderated_by  VARCHAR(50) NULL,
            moderated_at  DATETIME NULL,
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            /* ONE VOTE PER CUSTOMER PER PRODUCT. The upsert in
               review-save.php targets this key, so a second submission edits
               rather than duplicating. */
            UNIQUE KEY uq_review_customer_product (customer_id, product_id),
            /* The product page reads published rows for one product. */
            KEY idx_review_product_status (product_id, status),
            /* The staff queue reads pending rows oldest-first. */
            KEY idx_review_status_created (status, created_at),
            CONSTRAINT fk_review_product FOREIGN KEY (product_id)
                REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT fk_review_customer FOREIGN KEY (customer_id)
                REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE,
            /* RESTRICT, not CASCADE: an order is the evidence a review is
               allowed to exist. Deleting one must not silently take the review
               with it, and must not leave the review unprovenanced either. */
            CONSTRAINT fk_review_order FOREIGN KEY (order_id)
                REFERENCES orders(id) ON UPDATE CASCADE,
            /* The moderator may leave the company; the decision stays. */
            CONSTRAINT fk_review_moderator FOREIGN KEY (moderated_by)
                REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;

    /* ---- products.review_count ----
       Without it a product with NO reviews still renders whatever is in
       `rating` — which is how every seeded product came to advertise a 4.9 it
       never earned. The count is what lets the cards, the detail, the carousel
       and the portal tables say "No ratings yet" instead of inventing a score,
       and that honesty is the point of the feature.

       BOTH COLUMNS ARE BACKFILLED FROM product_reviews, not set to a flat zero.
       On a fresh install that IS zero for every product, which is the point: the
       seeded 4.9s go, because a rating nobody gave is not data worth preserving
       and leaving it would mean the column disagrees with the reviews it is
       meant to summarise from the moment this runs. Deriving it rather than
       assuming it also means this stays correct if the column is ever dropped
       and the migration re-run against a database that already has reviews —
       the same formula as Reviews::recompute(), which owns it from then on. */
    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'products' AND COLUMN_NAME = 'review_count';

    IF has_col = 0 THEN
        ALTER TABLE products
          ADD COLUMN review_count INT NOT NULL DEFAULT 0
              COMMENT 'published reviews behind products.rating'
              AFTER rating;

        UPDATE products p
           SET p.review_count = (
                   SELECT COUNT(*) FROM product_reviews r
                    WHERE r.product_id = p.id AND r.status = 'published'
               ),
               p.rating = COALESCE((
                   SELECT ROUND(AVG(r.rating), 2) FROM product_reviews r
                    WHERE r.product_id = p.id AND r.status = 'published'
               ), 0.00);
    END IF;

    /* ---- products.rating DEFAULT 5.00 -> 0.00 ----
       The old default is where the invented scores came from. Nothing inserts
       a product without an explicit rating today (products/save.php passes 0),
       so this changes no behaviour on its own — it removes the trap, and stops
       the live column disagreeing with db/schema.sql, which now declares 0.00.

       Guarded on the current default so a re-run does no table work. */
    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'products' AND COLUMN_NAME = 'rating'
       AND COLUMN_DEFAULT = '5.00';

    IF has_col = 1 THEN
        ALTER TABLE products MODIFY rating DECIMAL(3,2) NOT NULL DEFAULT 0.00;
    END IF;

    /* ---- notifications.type += 'review' ----
       A low rating raises a Warning so staff hear about a real problem with a
       real order quickly (review-save.php). That needs a type of its own: the
       level follows from the type in Notify::BY_TYPE and callers cannot
       override it, so reusing 'hold' or 'return' to smuggle a review through
       would file it under the wrong thing in all three notification screens.

       ENUM extension is append-only here — every existing value is repeated in
       the same order, so no stored row changes meaning. */
    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type'
       AND COLUMN_TYPE NOT LIKE '%review%';

    IF has_col = 1 THEN
        ALTER TABLE notifications MODIFY type
            ENUM('new-order','payment','hold','completed','return','inventory',
                 'audit','review') NOT NULL;
    END IF;

    /* ---- the permission the staff queue is gated on ---- */
    SELECT COUNT(*) INTO has_perm
      FROM permissions WHERE permission_key = 'reviews.moderate';

    IF has_perm = 0 THEN
        INSERT INTO permissions (permission_key, area, label)
        VALUES ('reviews.moderate', 'Maintenance',
                'Moderate customer product reviews');
    END IF;

    SELECT id INTO perm_id FROM permissions WHERE permission_key = 'reviews.moderate';

    /* Granted to the roles that already hold the neighbouring content duties.
       Super Admin owns every permission implicitly (is_system) and takes no
       role_permissions rows — see Rbac::forRole(). Inventory Staff, Cashier and
       Online Orders Staff are deliberately NOT granted it: moderating public
       content is a maintenance duty, not an operational one.

       INSERT ... SELECT with NOT EXISTS rather than INSERT IGNORE, so re-running
       adds nothing and masks nothing. */
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, perm_id
      FROM roles r
     WHERE r.name IN ('Admin')
       AND NOT EXISTS (
             SELECT 1 FROM role_permissions rp
              WHERE rp.role_id = r.id AND rp.permission_id = perm_id
           );

    /* ---- the keyword list ---- */
    SELECT COUNT(*) INTO has_set
      FROM settings WHERE key_name = 'review_flag_words';

    IF has_set = 0 THEN
        /* A comma-separated list, matched case-insensitively on WORD
           BOUNDARIES by Reviews::flagged() — so a short flagged word cannot
           trip on a longer innocent one ("ass" must not flag "class").
           Deliberately short and editable: this is a starting point for the
           business to tune from the settings table, not a claim to
           completeness. */
        INSERT INTO settings (key_name, value_text)
        VALUES ('review_flag_words',
                'scam,fraud,fake,poison,disgusting,idiot,stupid,damn,hell,crap,shit,fuck,bastard,bitch');
    END IF;
END //

DELIMITER ;

CALL eb_migrate_011();
DROP PROCEDURE eb_migrate_011;


/* -------------------------------------------------------------
   Verification

   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_reviews'
    ORDER BY ORDINAL_POSITION;

   SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols,
          NON_UNIQUE
     FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_reviews'
    GROUP BY INDEX_NAME;

   Expected: uq_review_customer_product UNIQUE on (customer_id, product_id),
   idx_review_product_status on (product_id, status), and
   idx_review_status_created on (status, created_at).

   SELECT permission_key FROM permissions WHERE permission_key = 'reviews.moderate';
   SELECT value_text FROM settings WHERE key_name = 'review_flag_words';
   ------------------------------------------------------------- */
