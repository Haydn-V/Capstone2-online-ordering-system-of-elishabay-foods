-- ---------------------------------------------------------------------------
-- 003 — images become files on disk, columns become paths
--
-- Decisions I2 and I3. Before this migration the system stored images as
-- base64 data URLs inside LONGTEXT columns, and had no code anywhere that
-- wrote a file. api/uploads/image.php now writes to /uploads/{products,
-- content,references}/ and returns an application-root-relative path; these
-- columns hold that path and nothing else.
--
-- WHAT THAT COST WHILE IT LASTED, MEASURED
-- ----------------------------------------
-- Three of fifteen products carried an image. Those three rows held 1.81 MB of
-- base64 between them (414KB / 519KB / 918KB), and api/shop/products.php — a
-- public, unauthenticated endpoint the storefront calls on every page load —
-- returned 1,856,279 bytes. 98% of that payload was base64 that no renderer on
-- the storefront ever read, because the endpoint sends `image` and the card
-- read `img`. Paths make the same response about 4 KB.
--
-- ORDER OF OPERATIONS — READ THIS BEFORE RUNNING
-- ----------------------------------------------
-- This file does NOT convert the data. It cannot: decoding base64 to a .webp
-- on disk needs GD, and SQL has no way to write a file.
--
--     1. php tools/migrate-images.php --apply      (writes the files, rewrites
--                                                   the column values to paths)
--     2. this migration                            (narrows the column types)
--
-- Run in that order. Narrowing image_url to VARCHAR(255) while a row still
-- holds 918KB of base64 does not error under a lenient sql_mode — it TRUNCATES,
-- silently, and the image is gone with no way back. Under the STRICT_ALL_TABLES
-- this project now pins (D5) it errors instead, which is the point of pinning
-- it; but the guard below makes the failure explicit and readable either way
-- rather than depending on a server setting being right.
--
-- RE-RUNNABLE. Every step checks information_schema first and skips what is
-- already done. schema-additions.sql was not re-runnable and a second run
-- aborted at the first duplicate index, silently skipping everything below it
-- and leaving a database that looked installed and was missing a column. That
-- cost an hour in Phase 3. Not repeating it.
--
-- PRECONDITIONS (verified against the live database before writing this file):
--   * products:     15 rows, 3 with a data: URL, 12 NULL
--   * hero_slides:   5 rows, all NULL — no conversion needed, type change only
--   * orders:       no image column exists at all; one is added here
--
-- NO `USE elisha_bay_db;` HERE, DELIBERATELY.
-- Every other SQL file in this project hardcodes it, which means naming a
-- different database on the command line does nothing and the statements hit
-- the live one anyway. That trap recreated audit_logs on the production
-- database during Phase 3 and is written up in docs/SETUP.md. This file uses
-- DATABASE() throughout and operates on whatever the client selected:
--
--     mysql -u root elisha_bay_db < db/migrations/003-image-paths.sql
-- ---------------------------------------------------------------------------

DELIMITER //

DROP PROCEDURE IF EXISTS eb_migrate_003 //

CREATE PROCEDURE eb_migrate_003()
BEGIN
    DECLARE unconverted    INT DEFAULT 0;
    DECLARE has_image_data INT DEFAULT 0;
    DECLARE has_image_path INT DEFAULT 0;
    DECLARE has_proof_col  INT DEFAULT 0;
    DECLARE products_type  VARCHAR(64) DEFAULT '';

    /* ---- 0. Refuse to run if step 1 has not been done ----------------
       A migration that silently destroys the data it was meant to preserve is
       worse than one that will not start. */
    SELECT COUNT(*) INTO unconverted
      FROM products
     WHERE image_url IS NOT NULL
       AND image_url NOT LIKE '/uploads/%'
       AND image_url NOT LIKE 'http%';

    IF unconverted > 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'Run "php tools/migrate-images.php --apply" first: products.image_url still holds non-path values that this migration would truncate.';
    END IF;

    /* ---- 1. products.image_url — LONGTEXT -> VARCHAR(255) ------------
       The column name stays. `image_url` describes a path accurately, and
       renaming it would touch six files across three endpoints for no
       behavioural gain.

       255 is generous: the longest value this system can produce is
       /uploads/products/ + 32 hex + .webp = 55 characters. The headroom is for
       an external CDN URL later, which imageUrl() already passes through. */
    SELECT DATA_TYPE INTO products_type
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'products' AND COLUMN_NAME = 'image_url';

    IF products_type <> 'varchar' THEN
        ALTER TABLE products
          MODIFY COLUMN image_url VARCHAR(255) NULL
          COMMENT 'Application-root-relative path, e.g. /uploads/products/ab12.webp. Never a data URL.';
    END IF;

    /* ---- 2. hero_slides.image_data -> image_path ---------------------
       This one IS renamed, because `image_data` holding a path is precisely
       the class of lie that produced these defects: a column whose name says
       one thing while the writer and the reader assume another. Only
       api/content/get.php, db/schema.sql and db/seed.sql refer to it.

       The column was NULL in all five rows and unfillable — no code path
       anywhere wrote it, while content/get.php happily read it. That asymmetry
       is defect 3.3 in a single line. */
    SELECT COUNT(*) INTO has_image_data
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'hero_slides' AND COLUMN_NAME = 'image_data';

    SELECT COUNT(*) INTO has_image_path
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'hero_slides' AND COLUMN_NAME = 'image_path';

    IF has_image_data = 1 AND has_image_path = 0 THEN
        SELECT COUNT(*) INTO unconverted
          FROM hero_slides
         WHERE image_data IS NOT NULL
           AND image_data NOT LIKE '/uploads/%'
           AND image_data NOT LIKE 'http%';

        IF unconverted > 0 THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Run "php tools/migrate-images.php --apply" first: hero_slides.image_data still holds non-path values.';
        END IF;

        ALTER TABLE hero_slides
          CHANGE COLUMN image_data image_path VARCHAR(255) NULL
          COMMENT 'Application-root-relative path, e.g. /uploads/content/ab12.webp.';
    END IF;

    /* ---- 3. orders.proof_image_path — new ----------------------------
       There was no column anywhere that could hold a customer's payment
       reference image. The checkout "upload" was a div that set a boolean, so
       nothing ever needed one.

       Note what is NOT changed here: proof_uploaded stays, and both checkout
       endpoints currently set it from `$refNum !== null ? 1 : 0` — from whether
       a reference NUMBER was typed, not from whether a file exists. Payment
       Verification renders "Proof Uploaded" on that basis today. Correcting it
       belongs to defect 3.4 in the application layer; it is called out here so
       the next reader of this schema does not take proof_uploaded at face
       value.

       NULLABLE, and NULL is a real answer: a cash-on-pickup order has no
       payment reference and never will. */
    SELECT COUNT(*) INTO has_proof_col
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'proof_image_path';

    IF has_proof_col = 0 THEN
        ALTER TABLE orders
          ADD COLUMN proof_image_path VARCHAR(255) NULL
            COMMENT 'Application-root-relative path to the customer-uploaded payment reference image.'
            AFTER proof_ref_num;
    END IF;
END //

DELIMITER ;

CALL eb_migrate_003();
DROP PROCEDURE eb_migrate_003;


/* -------------------------------------------------------------
   Verification — run after applying
   -------------------------------------------------------------

   SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND (   (TABLE_NAME = 'products'     AND COLUMN_NAME = 'image_url')
           OR (TABLE_NAME = 'hero_slides'  AND COLUMN_NAME = 'image_path')
           OR (TABLE_NAME = 'orders'       AND COLUMN_NAME = 'proof_image_path'));

   Expected: three rows, all varchar(255).

   SELECT COUNT(*) FROM products WHERE image_url LIKE 'data:%';

   Expected: 0.
   ------------------------------------------------------------- */
