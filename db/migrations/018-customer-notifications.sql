-- ---------------------------------------------------------------------------
-- 018 — Notifications for customers
--
-- The `notifications` table is the STAFF bell: it has no customer and every
-- member of staff sees every row. Customers need their own feed, scoped to
-- them, telling them when something happened to THEIR order, payment or
-- return — so they do not have to keep reopening My Orders to find out.
--
-- Written by api/core/CustomerNotify.php from:
--   api/orders/status.php          order accepted / shipped / delivered / ...
--   api/orders/verify-payment.php  payment verified / not verified
--   api/returns/advance.php        return reviewed / approved / refunded / ...
-- Read by api/shop/notifications.php (the bell in the storefront header).
--
-- The PHP checks for this table before using it, so the code can be deployed
-- before or after this file is run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_notifications (
    id INT AUTO_INCREMENT NOT NULL,
    customer_id VARCHAR(50) NOT NULL,
    type ENUM('order','payment','return') NOT NULL,
    title VARCHAR(120) NOT NULL,
    message VARCHAR(500) NOT NULL,
    link VARCHAR(255) NULL,          /* page inside public/, e.g. profile/my-orders.html */
    order_id VARCHAR(50) NULL,
    return_id VARCHAR(50) NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_cn_customer FOREIGN KEY (customer_id)
        REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_cn_customer ON customer_notifications(customer_id, is_read, created_at);
