-- ---------------------------------------------------------------------------
-- 005 — a customer can have a saved delivery address
--
-- Decision I9 needs something to prefill FROM. There was nothing:
--
--     CREATE TABLE customers (
--       id, name, email, username, password, contact, status, joined, created_at
--     );
--
-- `contact` exists. Address does not — not a column, not a table. The only
-- address the system has ever stored is orders.address, one per order.
--
-- The storefront's own Profile > Delivery Address form
-- (public/profile/profile.html) has five inputs, a Save Address button, and a
-- submit handler that validates the street is non-empty, calls
-- showToast("Address saved!") and writes NOTHING. There is no endpoint behind
-- it. The same is true of the Personal Info and password forms on that page.
--
-- HOW MANY ADDRESSES
-- ------------------
-- ONE. Deliberately, and stated because the brief asks which of "no saved
-- address / partial address / multiple saved addresses" the schema supports.
--
-- An address book is a real feature with real questions attached — which is the
-- default, what happens to an order whose address is later deleted, how a
-- retailer's delivery sites differ from a household's. None of that has been
-- asked for. Five nullable columns on `customers` answer the question that WAS
-- asked ("prefill the customer's saved address") without inventing an
-- architecture, and a second table can be added later without changing what
-- these columns mean.
--
-- ALL NULLABLE, and partial is a legitimate state: someone may know their city
-- and not their ZIP. The checkout prefills whatever exists and leaves the rest
-- empty rather than refusing to prefill anything.
--
-- Field names match the form that already exists on the profile page, so the
-- mapping is one-to-one and there is no translation layer to get wrong.
--
-- RE-RUNNABLE. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/005-customer-profile.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_005 //

CREATE PROCEDURE eb_migrate_005()
BEGIN
    DECLARE has_col INT DEFAULT 0;

    SELECT COUNT(*) INTO has_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'addr_street';

    IF has_col = 0 THEN
        ALTER TABLE customers
          ADD COLUMN addr_street   VARCHAR(160) NULL COMMENT 'House no., street, barangay' AFTER contact,
          ADD COLUMN addr_city     VARCHAR(80)  NULL COMMENT 'City or municipality'        AFTER addr_street,
          ADD COLUMN addr_province VARCHAR(80)  NULL                                       AFTER addr_city,
          ADD COLUMN addr_zip      VARCHAR(10)  NULL                                       AFTER addr_province,
          ADD COLUMN addr_region   VARCHAR(80)  NULL                                       AFTER addr_zip;
    END IF;
END //

DELIMITER ;

CALL eb_migrate_005();
DROP PROCEDURE eb_migrate_005;


/* -------------------------------------------------------------
   Verification

   SELECT COLUMN_NAME, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
      AND COLUMN_NAME LIKE 'addr\\_%';

   Expected: five rows, all YES.
   ------------------------------------------------------------- */
