-- ---------------------------------------------------------------------------
-- 014 — VAT: exempt products, senior citizen / PWD sales, withholding tax
--
-- WHAT WAS THERE
-- --------------
-- Every sale was treated as 12% VAT-inclusive, and the Sales Invoice worked the
-- VAT out in the browser each time it was shown. That holds only while every
-- product is VATable, no buyer is a senior citizen or PWD, and no buyer withholds
-- tax. None of the three is guaranteed for a food business selling to retailers.
--
-- WHAT THIS ADDS
-- --------------
--   products.tax_type         VATable or VAT-exempt, set in VAT Maintenance.
--   order_items.tax_type      The product's tax type AT THE MOMENT OF SALE, copied
--                             like price_at_purchase — changing a product later
--                             must not rewrite invoices already issued.
--   orders.<breakdown>        The whole VAT breakdown, computed on the server by
--                             api/core/Tax.php at checkout and stored with the
--                             order. An invoice is a legal record: it prints what
--                             was decided at the sale, never a recalculation.
--   orders.sc_pwd_*           Senior citizen / PWD sale: type, ID number, name —
--                             the BIR requires the ID and name on the invoice.
--   orders.withholding_*      Tax a retailer withheld from its payment.
--   withholding_agents        Which retailers withhold, and at what rate.
--   credit_payments.source    + 'withholding': the withheld part of a Net sale is
--                             settled by the buyer remitting it to the BIR, so it
--                             is recorded as a verified payment on the account.
--   settings                  VAT rate and the SC/PWD rules, editable in VAT
--                             Maintenance rather than written into the code.
--   permissions               vat.manage — held by Super Admin only, and refused
--                             by the Roles & Permissions screen for any other role
--                             (Rbac::SYSTEM_ONLY).
--
-- HOW THE STORED FIGURES FIT TOGETHER
-- -----------------------------------
--   gross_total       Σ lines at shelf price (VATable shelf prices include VAT)
--   less_vat          the VAT contained in the VATable part of gross_total
--   net_of_vat        gross_total − less_vat
--   sc_pwd_discount   senior/PWD discount, on the amount net of VAT
--   vatable_sales     VATable sales after the discount, net of VAT
--   vat_amount        VAT charged on vatable_sales
--   vat_exempt_sales  VAT-exempt sales after the discount
--   total             vatable_sales + vat_amount + vat_exempt_sales  (charged)
--   withholding_tax   withheld by the buyer; amount due = total − withholding_tax
--
-- EXISTING ORDERS are backfilled as fully VATable at 12% with no discount and no
-- withholding — exactly what their invoices already printed.
--
-- RUN WITH INSTANT ALTER DISABLED. MariaDB 10.4's instant ALTER crashed mysqld on
-- migration 010 and corrupted a table:
--     SET GLOBAL innodb_instant_alter_column_allowed = 'never';
--     (run this file)
--     SET GLOBAL innodb_instant_alter_column_allowed = 'add_drop_reorder';
-- Idempotent: every change is guarded, so running it twice changes nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS tax_type ENUM('vatable','exempt') NOT NULL DEFAULT 'vatable' AFTER price;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS tax_type ENUM('vatable','exempt') NOT NULL DEFAULT 'vatable' AFTER price_at_purchase;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS gross_total      DECIMAL(10,2) NULL AFTER total,
    ADD COLUMN IF NOT EXISTS vat_rate         DECIMAL(5,2)  NULL AFTER gross_total,
    ADD COLUMN IF NOT EXISTS less_vat         DECIMAL(10,2) NULL AFTER vat_rate,
    ADD COLUMN IF NOT EXISTS net_of_vat       DECIMAL(10,2) NULL AFTER less_vat,
    ADD COLUMN IF NOT EXISTS sc_pwd_discount  DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER net_of_vat,
    ADD COLUMN IF NOT EXISTS vatable_sales    DECIMAL(10,2) NULL AFTER sc_pwd_discount,
    ADD COLUMN IF NOT EXISTS vat_amount       DECIMAL(10,2) NULL AFTER vatable_sales,
    ADD COLUMN IF NOT EXISTS vat_exempt_sales DECIMAL(10,2) NULL AFTER vat_amount,
    ADD COLUMN IF NOT EXISTS sc_pwd_type      ENUM('senior','pwd') NULL AFTER vat_exempt_sales,
    ADD COLUMN IF NOT EXISTS sc_pwd_id        VARCHAR(40)  NULL AFTER sc_pwd_type,
    ADD COLUMN IF NOT EXISTS sc_pwd_name      VARCHAR(100) NULL AFTER sc_pwd_id,
    ADD COLUMN IF NOT EXISTS withholding_rate DECIMAL(5,2) NULL AFTER sc_pwd_name,
    ADD COLUMN IF NOT EXISTS withholding_tax  DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER withholding_rate;

-- The weekly SC/PWD discount cap is counted per ID number.
CREATE INDEX IF NOT EXISTS idx_orders_sc_pwd_id ON orders (sc_pwd_id, date);

CREATE TABLE IF NOT EXISTS withholding_agents (
    customer_id VARCHAR(50)  NOT NULL,
    rate        DECIMAL(5,2) NOT NULL,
    updated_by  VARCHAR(50)  NULL,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (customer_id),
    CONSTRAINT fk_withholding_customer FOREIGN KEY (customer_id)
        REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE credit_payments
    MODIFY COLUMN source ENUM('customer','staff','legacy','withholding') NOT NULL DEFAULT 'customer';

-- Backfill: every existing order as it was printed — 12% VAT-inclusive, all VATable.
UPDATE orders
   SET gross_total      = total,
       vat_rate         = 12.00,
       vatable_sales    = ROUND(total / 1.12, 2),
       net_of_vat       = ROUND(total / 1.12, 2),
       less_vat         = total - ROUND(total / 1.12, 2),
       vat_amount       = total - ROUND(total / 1.12, 2),
       vat_exempt_sales = 0
 WHERE gross_total IS NULL;

-- Rules, editable in VAT Maintenance. Existing values are never overwritten.
--   sc_pwd_discount_rate  percent off, on the amount net of VAT
--   sc_pwd_vat_exempt     1 = the discounted sale is VAT-exempt (RA 9994 / RA 10754)
--                         0 = VAT is still charged on the discounted amount
--   sc_pwd_weekly_cap     peso limit on the discount per ID per week; 0 = no limit
INSERT INTO settings (key_name, value_text) VALUES
    ('vat_rate',                 '12'),
    ('sc_pwd_enabled',           '1'),
    ('sc_pwd_discount_rate',     '20'),
    ('sc_pwd_vat_exempt',        '1'),
    ('sc_pwd_weekly_cap',        '0'),
    ('withholding_default_rate', '1')
ON DUPLICATE KEY UPDATE key_name = key_name;

INSERT IGNORE INTO permissions (permission_key, area, label)
VALUES ('vat.manage', 'System', 'Manage VAT settings (Super Admin only)');

-- Belt and braces: vat.manage is never granted to a role. Rbac refuses it for
-- any role but Super Admin whatever this table says; this keeps the table honest.
DELETE rp FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
 WHERE p.permission_key = 'vat.manage';
