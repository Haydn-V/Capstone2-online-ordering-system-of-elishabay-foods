-- ---------------------------------------------------------------------------
-- 017 — Where the refund goes, and proof that it went
--
-- Refunds are GCash or bank transfer only (no cash). The customer says where
-- to send the money when they file the request; staff attach the transfer
-- receipt when they process it, and the customer can see that receipt on
-- their Returns & Refunds tab.
--
--   refund_pref            'gcash' | 'bank' — chosen by the customer
--   refund_account_name    name on the account
--   refund_account_number  GCash number or bank account number (or NULL when
--                          they gave a QR code instead)
--   refund_bank_name       which bank (bank transfer only)
--   refund_qr              the customer's GCash / bank QR image, if given
--   refund_receipt         the staff's screenshot of the completed transfer
--
-- Needs 016 first. The PHP checks for refund_receipt before using any of this.
-- ---------------------------------------------------------------------------

ALTER TABLE product_returns
    ADD COLUMN refund_pref ENUM('gcash','bank') NULL AFTER scope,
    ADD COLUMN refund_account_name VARCHAR(100) NULL AFTER refund_pref,
    ADD COLUMN refund_account_number VARCHAR(50) NULL AFTER refund_account_name,
    ADD COLUMN refund_bank_name VARCHAR(100) NULL AFTER refund_account_number,
    ADD COLUMN refund_qr VARCHAR(255) NULL AFTER refund_bank_name,
    ADD COLUMN refund_receipt VARCHAR(255) NULL AFTER refund_method;
