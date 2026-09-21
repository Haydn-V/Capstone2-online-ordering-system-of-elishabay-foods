-- ---------------------------------------------------------------------------
-- 015 — Philippine locations, and addresses built from them
--
-- WHAT WAS THERE
-- --------------
-- Every address in the system was one free-text box. Checkout, registration, the
-- retailer application and the profile page each asked for "house no., street,
-- barangay, city, province" in a single field and stored whatever came back:
--
--     orders.address              TEXT, free
--     b2b_applications.business_address   TEXT, free
--     customers.addr_street/city/province/zip/region   five free VARCHARs (005)
--
-- "Dagupan", "Dagupan City", "dagupan city pang." and "DAGUPAN" are four cities
-- to anything that has to group, count or route by one. Nothing downstream could
-- use the data for anything but printing it back.
--
-- And registration's address box wrote NOWHERE. api/shop/register.php documented
-- `address` in its body and never read it — every address typed at sign-up was
-- discarded. The picker is what finally gives it a destination.
--
-- WHAT THIS ADDS
-- --------------
-- Four reference tables from the PSGC — the Philippine Standard Geographic Code,
-- published by the Philippine Statistics Authority — keyed by the REAL PSGC
-- codes rather than invented ids:
--
--     ph_regions     code, name
--     ph_provinces   code, region_code, name
--     ph_cities      code, region_code, province_code (NULL — see below), name, type
--     ph_barangays   code, city_code, name, sub_municipality
--
-- Real codes because they are stable, and because it means a later PSGC release
-- can be loaded over this one without renumbering anything that points at it.
--
-- THE DATA IS NOT IN THIS FILE. It is db/seed-ph-locations.sql, generated from
-- the PSA publication by tools/psgc-convert.php. Kept apart so that ordinary
-- dumps of this project stay small enough to pass around, and so that a PSGC
-- refresh is a data reload rather than a schema change. docs/SETUP.md says how
-- to load it — including why phpMyAdmin will refuse it.
--
-- WHY THE DATABASE AND NOT A JAVASCRIPT FILE
-- ------------------------------------------
-- ~42,000 barangays is a few megabytes with indexes: small, as tables go, and
-- with an index on the parent code the lookup cost barely moves as it grows. The
-- customer never receives the table — choosing a city fetches that ONE city's
-- barangays, a few dozen names. The same list in a script would be downloaded
-- whole, by every visitor, on every page, whether they ever opened a form or not.
-- That is the entire reason this is a database job.
--
-- EVERY CHILD TABLE IS INDEXED ON ITS PARENT CODE
-- -----------------------------------------------
-- idx_barangay_city above all. It is the only thing that keeps "the barangays of
-- one city" an index range read instead of a scan of 42,000 rows. There are no
-- foreign keys between these four tables, deliberately: they are reloaded
-- wholesale from each PSGC release, and FKs would force a load order and turn a
-- refresh into a FOREIGN_KEY_CHECKS dance for no protection the converter does
-- not already give — it refuses to write a file whose parents do not resolve.
--
-- CITIES WITH NO PROVINCE
-- -----------------------
-- Metro Manila's sixteen cities and Pateros belong to no province, and neither
-- do highly urbanised and independent component cities elsewhere — Cebu City is
-- not part of Cebu Province, administratively. PSGC codes each of them at the
-- province level of its own hierarchy, so a city's "province" segment names no
-- province row at all.
--
-- Represented as `province_code NULL` with `region_code` always set, so every
-- city still has a parent. The CHOICE of how a customer reaches them is the
-- picker's (assets/js/public/address-picker.js): those cities are offered in the
-- Province list under their own names, beside the real provinces, which is where
-- PSGC puts them and where a person looks — "Cebu City" sits next to "Cebu", and
-- a Makati address never strands at a Province step with nothing to pick.
--
-- WHAT AN ADDRESS NOW STORES
-- --------------------------
-- Codes for the four levels, plus the house/street and ZIP the customer types,
-- because those are in no published list. On ORDERS the NAMES are stored beside
-- the codes, and `address` keeps the composed single line:
--
--   An order is a historical record. If a barangay is renamed or recoded in a
--   later PSGC release, last year's invoice must still print what the parcel was
--   actually shipped to. Names copied at the moment of sale are what makes that
--   true — the same reasoning as order_items.price_at_purchase.
--
--   `address` stays THE printable line. Receipts, invoices and courier labels
--   already print orders.address, and for a new order it is now composed from
--   the picker, so nothing downstream has to reassemble anything. Existing
--   orders keep the free text they were shipped to — they are not rewritten, and
--   there is no honest way to turn "9 Quezon St, Urdaneta City" into codes after
--   the fact.
--
-- RE-RUNNABLE. NO `USE elisha_bay_db;` — see the note in 003.
--
--     mysql -u root elisha_bay_db < db/migrations/015-ph-locations.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_015 //

CREATE PROCEDURE eb_migrate_015()
BEGIN
    DECLARE has_tbl INT DEFAULT 0;
    DECLARE has_col INT DEFAULT 0;

    /* ---- the four reference tables ---- */

    SELECT COUNT(*) INTO has_tbl FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ph_regions';
    IF has_tbl = 0 THEN
        CREATE TABLE ph_regions (
            code CHAR(10)     NOT NULL,
            name VARCHAR(120) NOT NULL,
            PRIMARY KEY (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;

    SELECT COUNT(*) INTO has_tbl FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ph_provinces';
    IF has_tbl = 0 THEN
        CREATE TABLE ph_provinces (
            code        CHAR(10)     NOT NULL,
            region_code CHAR(10)     NOT NULL,
            name        VARCHAR(120) NOT NULL,
            PRIMARY KEY (code),
            /* "the provinces of one region" */
            KEY idx_province_region (region_code, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;

    SELECT COUNT(*) INTO has_tbl FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ph_cities';
    IF has_tbl = 0 THEN
        CREATE TABLE ph_cities (
            code          CHAR(10)     NOT NULL,
            /* Always set, so a city with no province still has a parent. */
            region_code   CHAR(10)     NOT NULL,
            /* NULL for Metro Manila, and for highly urbanised and independent
               component cities — see CITIES WITH NO PROVINCE above. */
            province_code CHAR(10)     NULL,
            name          VARCHAR(120) NOT NULL,
            type          ENUM('City','Municipality') NOT NULL,
            PRIMARY KEY (code),
            /* "the cities of one province" */
            KEY idx_city_province (province_code, name),
            /* "the province-less cities of one region" — what the Province
               list adds beside the real provinces. */
            KEY idx_city_region (region_code, province_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;

    SELECT COUNT(*) INTO has_tbl FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ph_barangays';
    IF has_tbl = 0 THEN
        CREATE TABLE ph_barangays (
            code             CHAR(10)     NOT NULL,
            city_code        CHAR(10)     NOT NULL,
            name             VARCHAR(120) NOT NULL,
            /* The City of Manila is divided into sub-municipalities (Tondo,
               Sampaloc, Binondo…) and its ~900 barangays are numbered, not
               named. Its barangays hang off Manila itself; the district is kept
               so "Barangay 105" can be shown as "Barangay 105 · Tondo I", which
               is how a resident recognises it. NULL everywhere else. */
            sub_municipality VARCHAR(120) NULL,
            PRIMARY KEY (code),
            /* THE index. "the barangays of one city" is the only lookup this
               table ever serves, and without this it is a 42,000-row scan. */
            KEY idx_barangay_city (city_code, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;

    /* ---- customers: the saved address, as codes ----
       The five name columns from 005 stay and keep their meaning (region,
       province and city NAMES, the typed street, the ZIP); these add the codes
       they were chosen from, and the barangay, which 005 folded into the street
       line because it had nowhere else to go. */
    SELECT COUNT(*) INTO has_col FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
       AND COLUMN_NAME = 'addr_barangay_code';
    IF has_col = 0 THEN
        ALTER TABLE customers
          ADD COLUMN addr_barangay       VARCHAR(120) NULL AFTER addr_street,
          ADD COLUMN addr_region_code    CHAR(10)     NULL AFTER addr_region,
          ADD COLUMN addr_province_code  CHAR(10)     NULL AFTER addr_region_code,
          ADD COLUMN addr_city_code      CHAR(10)     NULL AFTER addr_province_code,
          ADD COLUMN addr_barangay_code  CHAR(10)     NULL AFTER addr_city_code;
        /* 005's comment on addr_street said "House no., street, barangay".
           The barangay has its own column now. */
        ALTER TABLE customers
          MODIFY addr_street VARCHAR(160) NULL COMMENT 'House no. and street, as typed';
    END IF;

    /* ---- orders: codes AND names, frozen at the sale ---- */
    SELECT COUNT(*) INTO has_col FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'ship_barangay_code';
    IF has_col = 0 THEN
        ALTER TABLE orders
          ADD COLUMN ship_street        VARCHAR(160) NULL COMMENT 'house no. and street, as typed' AFTER address,
          ADD COLUMN ship_barangay      VARCHAR(120) NULL AFTER ship_street,
          ADD COLUMN ship_city          VARCHAR(120) NULL AFTER ship_barangay,
          ADD COLUMN ship_province      VARCHAR(120) NULL AFTER ship_city,
          ADD COLUMN ship_region        VARCHAR(120) NULL AFTER ship_province,
          ADD COLUMN ship_zip           VARCHAR(10)  NULL AFTER ship_region,
          ADD COLUMN ship_region_code   CHAR(10)     NULL AFTER ship_zip,
          ADD COLUMN ship_province_code CHAR(10)     NULL AFTER ship_region_code,
          ADD COLUMN ship_city_code     CHAR(10)     NULL AFTER ship_province_code,
          ADD COLUMN ship_barangay_code CHAR(10)     NULL AFTER ship_city_code;
    END IF;

    /* ---- b2b_applications: the business address, same shape ----
       business_address stays the printable line, exactly as orders.address
       does. Existing applications keep their free text. */
    SELECT COUNT(*) INTO has_col FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_applications'
       AND COLUMN_NAME = 'biz_barangay_code';
    IF has_col = 0 THEN
        ALTER TABLE b2b_applications
          ADD COLUMN biz_street        VARCHAR(160) NULL AFTER business_address,
          ADD COLUMN biz_barangay      VARCHAR(120) NULL AFTER biz_street,
          ADD COLUMN biz_city          VARCHAR(120) NULL AFTER biz_barangay,
          ADD COLUMN biz_province      VARCHAR(120) NULL AFTER biz_city,
          ADD COLUMN biz_region        VARCHAR(120) NULL AFTER biz_province,
          ADD COLUMN biz_zip           VARCHAR(10)  NULL AFTER biz_region,
          ADD COLUMN biz_region_code   CHAR(10)     NULL AFTER biz_zip,
          ADD COLUMN biz_province_code CHAR(10)     NULL AFTER biz_region_code,
          ADD COLUMN biz_city_code     CHAR(10)     NULL AFTER biz_province_code,
          ADD COLUMN biz_barangay_code CHAR(10)     NULL AFTER biz_city_code;
    END IF;
END //

DELIMITER ;

CALL eb_migrate_015();
DROP PROCEDURE eb_migrate_015;


/* -------------------------------------------------------------
   Verification

   SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
     FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ph\\_%'
    GROUP BY TABLE_NAME, INDEX_NAME;

   Expected: a PRIMARY on each, plus idx_province_region, idx_city_province,
   idx_city_region and idx_barangay_city.

   After loading db/seed-ph-locations.sql:

   SELECT (SELECT COUNT(*) FROM ph_regions)   regions,
          (SELECT COUNT(*) FROM ph_provinces) provinces,
          (SELECT COUNT(*) FROM ph_cities)    cities,
          (SELECT COUNT(*) FROM ph_barangays) barangays;

   Expected, approximately: 17, 82, 1,600+, 42,000+.

   EXPLAIN SELECT code, name FROM ph_barangays WHERE city_code = '0000000000' ORDER BY name;
   Expected: key = idx_barangay_city, type = ref. Anything else is a scan.
   ------------------------------------------------------------- */
