CREATE DATABASE IF NOT EXISTS elisha_bay_db;
USE elisha_bay_db;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS featured_products;
DROP TABLE IF EXISTS hero_slides;
DROP TABLE IF EXISTS faqs;
DROP TABLE IF EXISTS site_content;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS product_returns;
DROP TABLE IF EXISTS payment_accounts;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS inventory_adjustments;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS b2b_applications;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE categories (
    id VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT NULL,
    archived TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
    id VARCHAR(50) NOT NULL,
    category_id VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stock INT DEFAULT 0,
    rating DECIMAL(3, 2) DEFAULT 5.00,
    sold INT DEFAULT 0,
    is_best TINYINT(1) DEFAULT 0,
    tint VARCHAR(10) NULL,
    /* An application-root-relative path written by api/uploads/image.php:
       /uploads/products/<32 hex>.webp. Never a data URL.

       This was LONGTEXT holding base64, and the comment here claimed the
       browser downscaled it first. It did not — the product modal posted the
       untouched original, and three rows held 1.81MB between them, shipped in
       full on every public storefront request. Files live on disk now
       (decision I2); the column holds the path and nothing else. */
    image_url VARCHAR(255) NULL,
    archived TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) 
        REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE roles (
    id INT AUTO_INCREMENT NOT NULL,
    name VARCHAR(50) UNIQUE NOT NULL,
    slug VARCHAR(50) NULL,
    description TEXT NULL,
    /* Super Admin is is_system=1. hasPerm() short-circuits to true for it, so
       it deliberately has no role_permissions rows, and the Roles & Permissions
       screen must not offer it for editing or deletion. */
    is_system TINYINT(1) DEFAULT 0,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE permissions (
    id INT AUTO_INCREMENT NOT NULL,
    permission_key VARCHAR(100) UNIQUE NOT NULL,
    area VARCHAR(50) NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE role_permissions (
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    CONSTRAINT fk_role_perm_role FOREIGN KEY (role_id) 
        REFERENCES roles(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_role_perm_perm FOREIGN KEY (permission_id) 
        REFERENCES permissions(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE users (
    id VARCHAR(50) NOT NULL,
    role_id INT NULL, 
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    avatar VARCHAR(10) NULL,
    status ENUM('active', 'archived') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) 
        REFERENCES roles(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE INDEX idx_users_email ON users(email);

CREATE TABLE customers (
    id VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    /* Customer-side login. The landing page keeps a signed-in flag in
       localStorage["eb-auth"] and never stored credentials, so the seed rows
       leave these NULL; signup/login must fill them (hashed). */
    username VARCHAR(50) UNIQUE NULL,
    password VARCHAR(255) NULL,
    contact VARCHAR(20) NULL,
    status ENUM('active', 'retailer', 'archived') DEFAULT 'active',
    /* What `status` held before the account was archived, so a restore can put
       it back rather than guessing 'active' and silently demoting a retailer.
       Added by db/migrations/008-customer-archive-restore.sql; the reasoning,
       including why this is a companion column rather than a proper
       kind/archived split, is in that file's header. NULL when not archived. */
    status_before_archive ENUM('active', 'retailer') NULL,
    joined DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE b2b_applications (
    id INT AUTO_INCREMENT NOT NULL,
    app_id_code VARCHAR(30) UNIQUE NOT NULL,
    customer_id VARCHAR(50) NULL,
    business_name VARCHAR(150) NOT NULL,
    applicant_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    business_type VARCHAR(50) NOT NULL,
    bir_tin VARCHAR(30) NULL,
    business_address TEXT NOT NULL,
    /* become-partner.html collects account credentials with the application
       (#pf-username / #pf-password) — the partner account is created from
       these on approval. */
    username VARCHAR(50) NULL,
    password VARCHAR(255) NULL,
    requested_terms VARCHAR(50) NULL,
    monthly_volume VARCHAR(100) NULL,
    notes TEXT NULL,
    submitted_date DATE NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    assigned_tier ENUM('Bronze', 'Silver', 'Gold') NULL,
    rejection_reason TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_b2b_customer FOREIGN KEY (customer_id) 
        REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_b2b_app_code ON b2b_applications(app_id_code);
CREATE INDEX idx_b2b_status ON b2b_applications(status);

CREATE TABLE batches (
    id VARCHAR(50) NOT NULL,
    lot_code VARCHAR(50) UNIQUE NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    harvest_date DATE NOT NULL,
    production_date DATE NOT NULL,
    expiry_date DATE NOT NULL,
    total_qty INT NOT NULL,
    remaining_qty INT NOT NULL,
    quality_grade VARCHAR(100) NULL,
    lab_status ENUM('passed', 'pending', 'failed') DEFAULT 'pending',
    qa_inspector VARCHAR(150) NULL,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_batches_product FOREIGN KEY (product_id) 
        REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_batches_product ON batches(product_id);
CREATE INDEX idx_batches_lot_code ON batches(lot_code);
CREATE INDEX idx_batches_expiry ON batches(expiry_date);

CREATE TABLE inventory_adjustments (
    id INT AUTO_INCREMENT NOT NULL,
    date DATE NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    qty INT NOT NULL, 
    type ENUM('disposal', 'return') NOT NULL,
    reason TEXT NOT NULL,
    batch_code VARCHAR(50) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_adjustments_product FOREIGN KEY (product_id) 
        REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE orders (
    id VARCHAR(50) NOT NULL,
    customer_id VARCHAR(50) NULL,
    customer_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NULL,
    contact VARCHAR(20) NULL,
    address TEXT NULL,
    type ENUM('online', 'walk-in') NOT NULL,
    order_type ENUM('pickup', 'delivery') DEFAULT 'pickup',
    customer_type ENUM('regular', 'retailer') DEFAULT 'regular',
    method VARCHAR(50) NOT NULL,
    /* Order grand total. Derivable from order_items, but every list screen
       (Transactions, Sales Report, Receipts, Queue) sorts and filters on it,
       and returns must refund the amount actually charged even after a price
       change, so it is stored. */
    total DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    date DATE NOT NULL,
    datetime DATETIME NOT NULL,
    /* When the order became `delivered`. Drives the one-hour auto-complete the
       Scope promises, and is cleared if the order ever leaves that status.

       A column here rather than a lookup into order_status_history: that table
       is optional and every writer guards on hasTable(), so a rule that
       depended on it would silently stop running on a base install. */
    delivered_at DATETIME NULL,
    status ENUM('pending', 'on-hold', 'accepted', 'shipping', 'delivered', 'completed', 'cancelled') DEFAULT 'pending',
    notes TEXT NULL,
    pay_verified TINYINT(1) DEFAULT 0,
    proof_uploaded TINYINT(1) DEFAULT 0,
    proof_ref_num VARCHAR(100) NULL,
    /* The customer's uploaded payment reference image, as an application-root-
       relative path. Added by migration 003; before it there was no column
       anywhere that could hold one, because the checkout "upload" control was
       a div that set a boolean. NULL is a real answer — a cash-on-pickup order
       has no payment reference. */
    proof_image_path VARCHAR(255) NULL,
    proof_amount DECIMAL(10, 2) DEFAULT 0.00,
    cashier VARCHAR(50) NULL,
    batch_code_hint VARCHAR(50) NULL, 
    /* Courier tracking number, required when a delivery order moves to
       shipping. The Limitation says couriers are not integrated but that a
       tracking number is issued on dispatch as proof of shipment — there was
       no field for it anywhere, so the limitation promised something the
       system could not do. */
    tracking_number VARCHAR(60) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) 
        REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_orders_cashier FOREIGN KEY (cashier) 
        REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(date);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE order_items (
    id INT AUTO_INCREMENT NOT NULL,
    order_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    qty INT NOT NULL,
    price_at_purchase DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_items_order FOREIGN KEY (order_id) 
        REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) 
        REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_order_items_order ON order_items(order_id);


/* The customer's cart, held on the account rather than in the browser.

   Added by db/migrations/007-persistent-cart.sql and repeated here so a fresh
   install matches a migrated one. The full reasoning — why not localStorage,
   why no price column — is in that file's header.

   PRIMARY KEY (customer_id, product_id): one row per product per customer, so
   "add this again" is an ON DUPLICATE KEY UPDATE and a duplicated line cannot
   exist. Both foreign keys CASCADE: a deleted customer's cart records nothing,
   and a deleted product cannot be bought. */
CREATE TABLE cart_items (
    customer_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(50) NOT NULL,
    qty INT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (customer_id, product_id),
    /* The third copy of the same bound. The client caps at CART_MAX_QTY and
       api/shop/cart-save.php validates it; this one holds against a hand-written
       INSERT. */
    CONSTRAINT chk_cart_qty CHECK (qty > 0 AND qty <= 99),
    CONSTRAINT fk_cart_customer FOREIGN KEY (customer_id)
        REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_cart_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cart_product ON cart_items(product_id);

CREATE TABLE audit_logs (
    id INT AUTO_INCREMENT NOT NULL,
    ts DATETIME NOT NULL,
    actor VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_audit_ts ON audit_logs(ts);
CREATE INDEX idx_audit_type ON audit_logs(type);

CREATE TABLE site_content (
    key_name VARCHAR(50) NOT NULL,
    value_text TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (key_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE faqs (
    id INT AUTO_INCREMENT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Landing page hero carousel. site_content is one row per key, so the ordered
   slide list needs its own table. Titles mirror HERO_PANELS on the public page. */
CREATE TABLE hero_slides (
    id INT AUTO_INCREMENT NOT NULL,
    title VARCHAR(100) NOT NULL,
    /* Was image_data LONGTEXT. Renamed by migration 003 because a column named
       image_data holding a path is the exact kind of misnaming these defects
       came out of — and because nothing in the system ever wrote it, while
       content/get.php happily read it. */
    image_path VARCHAR(255) NULL,
    display_order INT DEFAULT 0,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Manual override for the Best Sellers carousel. Empty table = fall back to
   each product's own is_best flag, which is what SITE_CONTENT.featured = []
   means today. */
CREATE TABLE featured_products (
    product_id VARCHAR(50) NOT NULL,
    display_order INT DEFAULT 0,
    PRIMARY KEY (product_id),
    CONSTRAINT fk_featured_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Retailer credit accounts for the Payment Schemes screen (Cashier + Online
   Orders). Overdue is derived by comparing due_date to today, not stored. */
/* Short-lived codes emailed to a customer before an important account change
   takes effect (Scope: "the system sends a verification code to the registered
   email whenever the user attempts to change important account details").

   code_hash, never the code. For the minutes it lives, a verification code is a
   bearer credential — anyone holding it can complete the change — so a leaked
   database must not hand over live ones, for the same reason customers.password
   is a hash.

   `payload` carries the pending change as JSON: the customers row is not
   touched until the code is proven, so an abandoned verification leaves nothing
   behind. `attempts` lives on the row rather than in a session, because a
   lockout a client can reset by clearing a cookie is not a lockout. */
CREATE TABLE verification_codes (
    id VARCHAR(50) NOT NULL,
    customer_id VARCHAR(50) NOT NULL,
    purpose VARCHAR(40) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    payload TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_vcode_customer FOREIGN KEY (customer_id)
        REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_vcode_customer_purpose ON verification_codes(customer_id, purpose);
CREATE INDEX idx_vcode_expires ON verification_codes(expires_at);


CREATE TABLE payment_accounts (
    id VARCHAR(50) NOT NULL,
    customer_id VARCHAR(50) NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NULL,
    scheme VARCHAR(20) NOT NULL,
    balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    due_date DATE NOT NULL,
    paid TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_payacct_customer FOREIGN KEY (customer_id)
        REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_payacct_customer ON payment_accounts(customer_id);
CREATE INDEX idx_payacct_due ON payment_accounts(due_date);

/* Returns & refunds workflow. Named product_returns because RETURNS is a
   reserved word in MySQL. Status maps to the 7-step RETURN_STEPS pipeline:
   received > validated > eligible|ineligible > approved|rejected > processed. */
CREATE TABLE product_returns (
    id VARCHAR(50) NOT NULL,
    order_id VARCHAR(50) NULL,
    customer_id VARCHAR(50) NULL,
    customer_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NULL,
    phone VARCHAR(30) NULL,
    product_id VARCHAR(50) NOT NULL,
    qty INT NOT NULL,
    batch_code VARCHAR(50) NULL,
    purchase_date DATE NOT NULL,
    reason TEXT NOT NULL,
    status ENUM('received','validated','eligible','ineligible','approved','rejected','processed') DEFAULT 'received',
    received_date DATETIME NOT NULL,
    eligibility TINYINT(1) NULL,   /* NULL = not yet assessed */
    refund_amount DECIMAL(10, 2) DEFAULT 0.00,
    refund_method VARCHAR(50) NULL,
    notes TEXT NULL,
    rejected_reason TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_returns_order FOREIGN KEY (order_id)
        REFERENCES orders(id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_returns_customer FOREIGN KEY (customer_id)
        REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_returns_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_returns_order ON product_returns(order_id);
CREATE INDEX idx_returns_status ON product_returns(status);

/* Notification bell feed. Exactly one of order_id / return_id / product_id is
   set depending on type; audit-type rows carry none of them. */
CREATE TABLE notifications (
    id VARCHAR(50) NOT NULL,
    type ENUM('new-order','payment','hold','completed','return','inventory','audit') NOT NULL,
    order_id VARCHAR(50) NULL,
    return_id VARCHAR(50) NULL,
    product_id VARCHAR(50) NULL,
    message TEXT NOT NULL,
    created_at DATETIME NOT NULL,
    is_read TINYINT(1) DEFAULT 0,
    PRIMARY KEY (id),
    CONSTRAINT fk_notif_order FOREIGN KEY (order_id)
        REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_notif_return FOREIGN KEY (return_id)
        REFERENCES product_returns(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_notif_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notif_read ON notifications(is_read);
CREATE INDEX idx_notif_created ON notifications(created_at);

/* System-wide settings. Holds the Payment Schemes penalty rate (adminState
   .penaltyRate, 2% today) and the brand strings CONFIG currently hard-codes. */
CREATE TABLE settings (
    key_name VARCHAR(50) NOT NULL,
    value_text TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (key_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
