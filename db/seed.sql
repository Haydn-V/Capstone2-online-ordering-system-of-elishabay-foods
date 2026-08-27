/* =============================================================
   ELISHA BAY — SEED DATA
   Mirrors the JS seed arrays in StuffModule/AdminModule/admin.js
   and admin-inventory.js. Run AFTER database.txt (schema).
   System "today" for all relative dates: 2026-06-17
   ============================================================= */

/* IMPORTANT: run db/migrations/*.sql after this file.

   The seed reproduces the original JS arrays faithfully, including their
   defects — notably three incompatible batch-code formats, where no order or
   return code matches a real lot. Migration 001 resolves those to real lots.
   Seeding without running migrations re-introduces the dangling references. */

USE elisha_bay_db;

/* Peso signs and em-dashes are in the data, so the client connection has to
   be utf8mb4 or they import as mojibake. */
SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS = 0;

/* ---------- CATEGORIES (product varieties) ---------- */
INSERT INTO categories (id, name, description, archived) VALUES
  ('cat-db', 'Deboned Bangus', 'Flavor-marinated whole deboned milkfish fillets.', 0),
  ('cat-bg', 'Bottled Gourmet Bangus', 'Premium bangus & tuyo preserved in gourmet sauces.', 0);

/* ---------- PRODUCTS ---------- */
INSERT INTO products (id, category_id, name, description, price, stock, rating, sold, is_best, tint, image_url, archived) VALUES
  ('db-pesto', 'cat-db', 'Pesto Bangus', 'Deboned milkfish in fragrant basil pesto — herby, rich and ready to pan-sear.', 285, 142, 4.8, 1240, 1, '#3f8f4f', NULL, 0),
  ('db-garlic', 'cat-db', 'Garlic Bangus in Sukang Iloko', 'Classic garlicky bangus cured in tangy Ilocos sukang.', 265, 88, 4.7, 980, 0, '#caa24a', NULL, 0),
  ('db-hainan', 'cat-db', 'Hainanese Bangus', 'Ginger-scallion deboned bangus inspired by Hainanese chicken.', 295, 54, 4.6, 610, 0, '#d9b35b', NULL, 0),
  ('db-steak', 'cat-db', 'Asian Steak Bangus', 'Umami soy-glazed bangus with a steakhouse depth.', 299, 9, 4.9, 1410, 1, '#7a4b2b', NULL, 0),
  ('db-chili', 'cat-db', 'Chili Garlic Bangus', 'Bold chili-garlic kick for spice lovers.', 275, 120, 4.7, 870, 0, '#c43d2a', NULL, 0),
  ('db-masala', 'cat-db', 'Spicy Masala Bangus', 'Warm Indian-spiced masala marinade.', 289, 0, 4.5, 430, 0, '#b5621f', NULL, 0),
  ('bg-pesto', 'cat-bg', 'Bangus in Pesto Sauce', 'Flaked bangus bottled in olive-oil basil pesto.', 245, 160, 4.9, 2100, 1, '#3f8f4f', NULL, 0),
  ('bg-portu', 'cat-bg', 'Portuguese Style Bangus', 'Smoky paprika & tomato in Portuguese tradition.', 255, 74, 4.7, 760, 0, '#c43d2a', NULL, 0),
  ('bg-adobo', 'cat-bg', 'Pinoy Adobo Bangus', 'The Filipino classic — soy, vinegar, garlic, bay.', 235, 138, 4.8, 1680, 1, '#5a3a22', NULL, 0),
  ('bg-hawaii', 'cat-bg', 'Hawaiian Style Bangus', 'Sweet pineapple-glazed island flavor.', 249, 42, 4.5, 520, 0, '#e0a531', NULL, 0),
  ('bg-sundri', 'cat-bg', 'Bangus in Sun-dried Tomatoes', 'Mediterranean sun-dried tomato & herb oil.', 265, 6, 4.8, 690, 0, '#a8331f', NULL, 0),
  ('bg-tuyod', 'cat-bg', 'Tuyo Delizioso', 'Gourmet Spanish-style dried herring in oil.', 215, 155, 4.9, 1990, 1, '#c98a2e', NULL, 0),
  ('bg-tuyopes', 'cat-bg', 'Tuyo in Pesto Sauce', 'Smoky tuyo meets fresh basil pesto.', 225, 96, 4.6, 840, 0, '#4a9457', NULL, 0),
  ('bg-tomato', 'cat-bg', 'Bangus in Tomato Sauce', 'Comforting rich tomato sauce classic.', 209, 112, 4.4, 560, 0, '#cf3b22', NULL, 0),
  ('bg-bayo', 'cat-bg', 'Ba-yo (Bangus & Tuyo)', 'Two icons — bangus & tuyo — in one bottle.', 299, 33, 5, 1320, 1, '#b6702a', NULL, 0);

/* ---------- ROLES ---------- */
/* Super Admin is is_system=1: code grants it every permission unconditionally
   (hasPerm() in admin.js), so it owns no role_permissions rows. */
INSERT INTO roles (id, name, slug, description, is_system) VALUES
  (1, 'Super Admin', 'super-admin', 'Unrestricted access to every module, including roles & permissions.', 1),
  (2, 'Admin', 'admin', 'Full operational access across every module except managing roles & permissions.', 0),
  (3, 'Cashier', 'cashier', 'Walk-in POS sales, payment scheme monitoring, and transaction history.', 0),
  (4, 'Inventory Staff', 'inventory-staff', 'Manages Bangus products, batch/QA traceability, and stock levels.', 0),
  (5, 'Online Orders Staff', 'online-orders-staff', 'Accepts, verifies, and fulfills online orders; processes returns & refunds.', 0);

/* ---------- PERMISSIONS ---------- */
INSERT INTO permissions (id, permission_key, area, label) VALUES
  (1, 'users.manage', 'Maintenance', 'Manage customer & employee accounts'),
  (2, 'rbac.manage', 'System', 'Manage roles & permissions'),
  (3, 'b2b.review', 'Maintenance', 'Review B2B partner applications'),
  (4, 'landing.manage', 'Maintenance', 'Manage landing page content'),
  (5, 'products.manage', 'Maintenance', 'Manage products & varieties'),
  (6, 'inventory.report', 'Inventory', 'View inventory report'),
  (7, 'inventory.manage', 'Inventory', 'Restock, adjust & archive inventory'),
  (8, 'sales.report', 'Reports', 'View sales report'),
  (9, 'batches.manage', 'Reports', 'Manage batch tracking & QA'),
  (10, 'payments.manage', 'Finance', 'Manage payment schemes'),
  (11, 'transactions.view', 'Finance', 'View transaction history'),
  (12, 'audit.view', 'Finance', 'View audit log'),
  (13, 'pos.use', 'Point of Sale', 'Use point of sale (walk-in orders)'),
  (14, 'orders.view', 'Online Orders', 'View online orders'),
  (15, 'orders.accept', 'Online Orders', 'Accept/hold/reject orders, verify payments'),
  (16, 'orders.status', 'Online Orders', 'Update order status'),
  (17, 'orders.returns', 'Online Orders', 'Process returns & refunds');

/* ---------- ROLE → PERMISSION GRANTS ---------- */
INSERT INTO role_permissions (role_id, permission_id) VALUES
  /* Admin (role_id 2) — users.manage, b2b.review, landing.manage, products.manage, inventory.report, inventory.manage, sales.report, batches.manage, payments.manage, transactions.view, audit.view, pos.use, orders.view, orders.accept, orders.status, orders.returns */
  (2, 1),
  (2, 3),
  (2, 4),
  (2, 5),
  (2, 6),
  (2, 7),
  (2, 8),
  (2, 9),
  (2, 10),
  (2, 11),
  (2, 12),
  (2, 13),
  (2, 14),
  (2, 15),
  (2, 16),
  (2, 17),
  /* Cashier (role_id 3) — pos.use, transactions.view, sales.report, payments.manage */
  (3, 13),
  (3, 11),
  (3, 8),
  (3, 10),
  /* Inventory Staff (role_id 4) — inventory.report, inventory.manage, batches.manage, audit.view */
  (4, 6),
  (4, 7),
  (4, 9),
  (4, 12),
  /* Online Orders Staff (role_id 5) — orders.view, orders.accept, orders.status, orders.returns, transactions.view, payments.manage */
  (5, 14),
  (5, 15),
  (5, 16),
  (5, 17),
  (5, 11),
  (5, 10);

/* ---------- EMPLOYEE ACCOUNTS ---------- */
/* Passwords are bcrypt hashes from PHP's password_hash($p, PASSWORD_BCRYPT).
   Verify with password_verify() — never by comparing strings.

   The plaintext behind these hashes is the same demo credential set the old JS
   array used, so the documented test logins still work. They are listed in
   docs/SETUP.md rather than here.

   Each hash carries its own salt, so re-running password_hash() on the same
   password produces a different string. That is correct — do not "fix" it by
   reusing one hash across accounts.

   NOTE: until Phase 5 removes the client-side STAFF_ACCOUNTS array from
   assets/js/portal/engine.js, those same passwords are still shipped to every
   browser in plaintext. Hashing here does not close that hole by itself. */
INSERT INTO users (id, role_id, name, email, password, avatar, status) VALUES
  ('emp-01', 1, 'Maria Santos',     'admin@elishabay.ph',     '$2y$10$Xc..Kn7iuDoEqHmzbPrA2e.QFFY/h.QoR.DUFBarBhgGn5kgt7caS', 'MS', 'active'),
  ('emp-02', 4, 'Jose Reyes',       'inventory@elishabay.ph', '$2y$10$7vuqWwGSOde7C2yCW1Ao6.t4GUN0imgoRSGCOwHg20oe3uYAvdSSW', 'JR', 'active'),
  ('emp-03', 3, 'Ana Cruz',         'cashier@elishabay.ph',   '$2y$10$FWYQuYvBt/2XAYmSvd1/.OUal.NuEpCAoVVSJo6xXBxITZvUHT8dS', 'AC', 'active'),
  ('emp-04', 5, 'Luis Bautista',    'orders@elishabay.ph',    '$2y$10$CppmRcbKqP3p3syxwu8Re.6LxICqcasyp/zKv7NY7A5GvbH0sgW3C', 'LB', 'active'),
  ('emp-05', 1, 'Rosa Dela Torre',  'admin2@elishabay.ph',    '$2y$10$dCEgECNuB0A4GQkWIO7OReeWnVtbUtBRib5kD1ADBrRxK.AyJrNfy', 'RD', 'archived'),
  ('emp-06', 2, 'Carlo Villanueva', 'subadmin@elishabay.ph',  '$2y$10$SqpfbgvDtj4f.NRIGxDdvuD/sxmctCDxUX9jdqUdshURkW9Ot9uMm', 'CV', 'active');

/* ---------- CUSTOMERS ---------- */
/* username/password are NULL: the landing page demo auth (eb-auth) never
   persisted credentials. Populate on real signup. */
INSERT INTO customers (id, name, email, username, password, contact, status, joined) VALUES
  ('cus-01', 'Patricia Lim', 'plim@gmail.com', NULL, NULL, '+63 917 111 0001', 'active', '2025-03-10'),
  ('cus-02', 'Roberto Tan', 'roberto.tan@yahoo.com', NULL, NULL, '+63 918 222 0002', 'retailer', '2025-01-22'),
  ('cus-03', 'Elena Soriano', 'elena.s@outlook.com', NULL, NULL, '+63 919 333 0003', 'active', '2025-04-05'),
  ('cus-04', 'Danilo Mercado', 'dmercado@gmail.com', NULL, NULL, '+63 920 444 0004', 'retailer', '2024-11-18'),
  ('cus-05', 'Cynthia Flores', 'cynflores@gmail.com', NULL, NULL, '+63 921 555 0005', 'active', '2025-05-14'),
  ('cus-06', 'Samuel Aguilar', 'saguilar@yahoo.com', NULL, NULL, '+63 922 666 0006', 'archived', '2024-09-30'),
  ('cus-07', 'Marilyn Gonzales', 'mgonzales@gmail.com', NULL, NULL, '+63 923 777 0007', 'active', '2025-06-01'),
  ('cus-08', 'Fernando Castro', 'fcastro@gmail.com', NULL, NULL, '+63 924 888 0008', 'retailer', '2024-12-07'),
  ('cus-09', 'Loreta Pascual', 'lpascual@outlook.com', NULL, NULL, '+63 925 999 0009', 'active', '2025-02-28'),
  ('cus-10', 'Artemio Valdez', 'artval@gmail.com', NULL, NULL, '+63 926 000 0010', 'active', '2026-01-15');

/* ---------- B2B PARTNER APPLICATIONS ---------- */
/* bir_tin, business_address and monthly_volume are invented demo values.
   The JS B2B_APPLICATIONS array never carried them, but become-partner.html
   marks all three required (#pf-tin, #pf-address, #pf-volume) and
   business_address is NOT NULL — so seeding them as NULL silently wrote empty
   strings under MySQL's default non-strict mode. Filling them keeps the
   constraint honest; the addresses match the region each application's notes
   already describe.

   username/password stay NULL: the partner account is created on approval,
   not at application time. */
INSERT INTO b2b_applications (app_id_code, customer_id, business_name, applicant_name, email, phone, business_type, bir_tin, business_address, username, password, requested_terms, monthly_volume, notes, submitted_date, status, assigned_tier, rejection_reason) VALUES
  ('APP-2026-008', 'cus-04', 'Mercado Wet Market Supply', 'Danilo Mercado', 'dmercado@gmail.com', '+63 920 444 0004', 'Distributor', '281-455-901-000', 'Stall 14, Dagupan City Public Market, Dagupan City, Pangasinan', NULL, NULL, 'Net 60', '300-600 units', 'Existing wet-market stall operator expanding to bulk distribution.', '2026-06-14', 'pending', NULL, NULL),
  ('APP-2026-007', 'cus-03', 'Soriano Grocers', 'Elena Soriano', 'elena.s@outlook.com', '+63 919 333 0003', 'Supermarket', '144-702-338-000', '72 P. Burgos St, Batangas City, Batangas', NULL, NULL, 'Net 90', '600-1000 units', '3-branch grocery chain in Batangas requesting bulk frozen allocation.', '2026-06-12', 'pending', NULL, NULL),
  ('APP-2026-006', 'cus-09', 'Pascual Sari-Sari Hub', 'Loreta Pascual', 'lpascual@outlook.com', '+63 925 999 0009', 'Sari-Sari Store', '509-118-274-000', '18 Maginhawa St, Diliman, Quezon City', NULL, NULL, 'Net 30', '100-300 units', 'Small chain of 4 sari-sari stores in Quezon City.', '2026-06-10', 'pending', NULL, NULL),
  ('APP-2026-005', 'cus-02', 'Tan Wholesale Foods', 'Roberto Tan', 'roberto.tan@yahoo.com', '+63 918 222 0002', 'Distributor', '233-901-556-000', 'Unit 5, Bonuan Gueset Commercial Row, Dagupan City, Pangasinan', NULL, NULL, 'Net 30', '1000+ units', 'Long-standing partner, consistently high volume orders.', '2026-05-20', 'approved', 'Gold', NULL),
  ('APP-2026-004', 'cus-08', 'Castro Restaurant Group', 'Fernando Castro', 'fcastro@gmail.com', '+63 924 888 0008', 'Restaurant', '870-224-113-000', '3F Sunset Plaza, Perez Blvd, Dagupan City, Pangasinan', NULL, NULL, 'Net 90', '600-1000 units', '5-branch restaurant chain, verified DTI and BIR permits.', '2026-05-02', 'approved', 'Silver', NULL),
  ('APP-2026-003', 'cus-06', 'Aguilar Trading Co.', 'Samuel Aguilar', 'saguilar@yahoo.com', '+63 922 666 0006', 'Distributor', '415-663-092-000', '112 Rizal Ave Ext, San Carlos City, Pangasinan', NULL, NULL, 'Net 60', '300-600 units', 'Follow up requested twice, no response after 30 days.', '2026-04-18', 'rejected', NULL, 'Unable to verify business permit documents on file.'),
  ('APP-2026-002', 'cus-10', 'Valdez Family Mart', 'Artemio Valdez', 'artval@gmail.com', '+63 926 000 0010', 'Sari-Sari Store', '726-330-847-000', '9 Aguinaldo Highway, Imus, Cavite', NULL, NULL, 'Net 30', 'under 100 units', 'First-time applicant, single storefront in Cavite.', '2026-06-16', 'pending', NULL, NULL),
  ('APP-2026-001', 'cus-05', 'Flores Catering Services', 'Cynthia Flores', 'cynflores@gmail.com', '+63 921 555 0005', 'Restaurant', '398-571-260-000', '27 Mabini St, Urdaneta City, Pangasinan', NULL, NULL, 'Net 30', '100-300 units', 'Event caterer, moderate recurring bulk orders.', '2026-03-11', 'approved', 'Bronze', NULL);

/* ---------- BATCH TRACKING / QA ---------- */
INSERT INTO batches (id, lot_code, product_id, harvest_date, production_date, expiry_date, total_qty, remaining_qty, quality_grade, lab_status, qa_inspector, notes) VALUES
  ('bat-201', 'JBF-2026-B112', 'db-pesto', '2026-06-13', '2026-06-14', '2027-06-13', 300, 245, 'Grade A Export Quality', 'passed', 'Rosa Dela Torre (QA Inspector)', 'Standard cold-chain handling maintained throughout processing.'),
  ('bat-200', 'JBF-2026-B111', 'bg-pesto', '2026-06-11', '2026-06-12', '2027-12-03', 400, 392, 'Grade A Export Quality', 'passed', 'Rosa Dela Torre (QA Inspector)', 'Vacuum seal integrity verified at 100% across sampled jars.'),
  ('bat-199', 'JBF-2026-B110', 'db-steak', '2026-06-10', '2026-06-11', '2027-06-10', 150, 9, 'Grade A Export Quality', 'passed', 'Rosa Dela Torre (QA Inspector)', 'Soy glaze viscosity and umami profile within spec.'),
  ('bat-198', 'JBF-2026-B109', 'bg-sundri', '2026-06-08', '2026-06-09', '2027-11-30', 200, 6, 'Grade B Standard Quality', 'pending', NULL, 'Awaiting microbiological swab results from third-party lab.'),
  ('bat-197', 'JBF-2026-B108', 'db-masala', '2026-06-06', '2026-06-07', '2027-06-06', 250, 0, 'Grade C Local Market', 'failed', 'Jose Reyes (QA Inspector)', 'Elevated bacterial count on swab test — batch pulled from sale.'),
  ('bat-196', 'JBF-2026-B107', 'bg-hawaii', '2026-06-04', '2026-06-05', '2027-11-26', 180, 42, 'Grade A Export Quality', 'passed', 'Rosa Dela Torre (QA Inspector)', 'Pineapple glaze brix level confirmed within target range.'),
  ('bat-195', 'JBF-2026-B106', 'bg-tuyod', '2026-06-02', '2026-06-03', '2027-11-24', 350, 155, 'Grade A Export Quality', 'passed', 'Rosa Dela Torre (QA Inspector)', 'Dried herring moisture content verified pre-bottling.'),
  ('bat-194', 'JBF-2026-B105', 'db-garlic', '2026-05-30', '2026-05-31', '2027-05-30', 220, 88, 'Grade B Standard Quality', 'pending', NULL, 'Sukang Iloko acidity retest scheduled this week.'),
  ('bat-193', 'JBF-2026-B104', 'db-chili', '2026-05-27', '2026-05-28', '2027-05-27', 260, 120, 'Grade A Export Quality', 'passed', 'Jose Reyes (QA Inspector)', 'Chili-garlic marinade Scoville level within labeled range.'),
  ('bat-192', 'JBF-2026-B103', 'bg-adobo', '2026-05-23', '2026-05-24', '2027-11-14', 300, 138, 'Grade A Export Quality', 'passed', 'Jose Reyes (QA Inspector)', 'Soy-vinegar ratio confirmed against master recipe.'),
  ('bat-191', 'JBF-2026-B102', 'db-hainan', '2026-05-19', '2026-05-20', '2027-05-19', 150, 54, 'Grade A Export Quality', 'passed', 'Rosa Dela Torre (QA Inspector)', 'Ginger-scallion aromatics verified by sensory panel.'),
  ('bat-190', 'JBF-2026-B101', 'bg-bayo', '2026-05-14', '2026-05-15', '2027-11-05', 120, 33, 'Grade A Export Quality', 'passed', 'Jose Reyes (QA Inspector)', 'Dual-product bottle seal and fill weight passed spot check.');

/* ---------- INVENTORY ADJUSTMENTS ---------- */
INSERT INTO inventory_adjustments (date, product_id, qty, type, reason, batch_code) VALUES
  ('2026-06-08', 'bg-sundri', -12, 'disposal', 'Expired batch BT-20260501-B', 'BT-20260501-B'),
  ('2026-05-28', 'db-masala', -8, 'disposal', 'Damaged packaging upon delivery', 'BT-20260301-A'),
  ('2026-05-15', 'bg-hawaii', 3, 'return', 'Customer returned unopened units', 'BT-20260125-A'),
  ('2026-05-10', 'db-steak', -5, 'disposal', 'Defective seal on lids', 'BT-20260501-A'),
  ('2026-04-20', 'bg-portu', -3, 'disposal', 'Minor mold detected on jar rim', 'BT-20260415-A'),
  ('2026-04-05', 'bg-adobo', 6, 'return', 'Walk-in returned — wrong order', 'BT-20260425-A');

/* ---------- ORDERS ---------- */
/* 30 historical rows (POS walk-in + online) then 12 live online orders.
   method holds the canonical key (cash/gcash/bank/net30...), not the display
   label — payMethodLabel() in admin.js renders it.

   FIVE ROWS HAVE proof_amount > total ON PURPOSE.

     ORD-20260612-001  1277.00 / claimed 1290.00
     ORD-20260615-001  1305.00 / claimed 1375.00
     ORD-20260616-001  1870.00 / claimed 1915.00
     ORD-20260616-002  1438.00 / claimed 1440.00
     ORD-20260617-002   897.00 / claimed  919.00

   Payment Verification compares proof_amount against the order total and
   renders "✗ MISMATCH" when they differ (assets/js/portal/orders.js). Without
   rows that actually differ, that branch would never render and nobody would
   see the indicator working.

   Written down because an integrity sweep flags "proof_amount > total" as an
   anomaly, and it looks exactly like corrupt data until someone knows why it
   is there. Confirmed intentional by the owner, 23 Aug 2026. Do not "fix"
   these figures. */
INSERT INTO orders (id, customer_id, customer_name, email, contact, address, type, order_type, customer_type, method, total, date, datetime, status, notes, pay_verified, proof_uploaded, proof_ref_num, proof_amount, cashier, batch_code_hint) VALUES
  ('EB-1A2B3C-101', 'cus-01', 'Patricia Lim', NULL, '+63 917 111 0001', NULL, 'online', 'pickup', 'regular', 'gcash', 725, '2026-06-17', '2026-06-17 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260617-01'),
  ('EB-2B3C4D-102', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 584, '2026-06-17', '2026-06-17 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260617-02'),
  ('EB-3C4D5E-103', 'cus-02', 'Roberto Tan', NULL, '+63 918 222 0002', NULL, 'online', 'pickup', 'regular', 'bank', 1972, '2026-06-16', '2026-06-16 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260616-01'),
  ('EB-4D5E6F-104', 'cus-03', 'Elena Soriano', NULL, '+63 919 333 0003', NULL, 'online', 'pickup', 'regular', 'gcash', 530, '2026-06-16', '2026-06-16 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260616-02'),
  ('EB-5E6F7G-105', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 852, '2026-06-15', '2026-06-15 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260615-01'),
  ('EB-6F7G8H-106', 'cus-04', 'Danilo Mercado', NULL, '+63 920 444 0004', NULL, 'online', 'pickup', 'regular', 'bank', 4950, '2026-06-15', '2026-06-15 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260615-02'),
  ('EB-7G8H9I-107', 'cus-05', 'Cynthia Flores', NULL, '+63 921 555 0005', NULL, 'online', 'pickup', 'regular', 'gcash', 845, '2026-06-14', '2026-06-14 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260614-01'),
  ('EB-8H9I0J-108', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 470, '2026-06-14', '2026-06-14 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260614-02'),
  ('EB-9I0J1K-109', 'cus-07', 'Marilyn Gonzales', NULL, '+63 923 777 0007', NULL, 'online', 'pickup', 'regular', 'gcash', 500, '2026-06-13', '2026-06-13 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260613-01'),
  ('EB-0J1K2L-110', 'cus-08', 'Fernando Castro', NULL, '+63 924 888 0008', NULL, 'online', 'pickup', 'regular', 'bank', 2814, '2026-06-13', '2026-06-13 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260613-02'),
  ('EB-1K2L3M-111', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 540, '2026-06-12', '2026-06-12 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260612-01'),
  ('EB-2L3M4N-112', 'cus-09', 'Loreta Pascual', NULL, '+63 925 999 0009', NULL, 'online', 'pickup', 'regular', 'gcash', 530, '2026-06-12', '2026-06-12 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260612-02'),
  ('EB-3M4N5O-113', 'cus-10', 'Artemio Valdez', NULL, '+63 926 000 0010', NULL, 'online', 'pickup', 'regular', 'gcash', 484, '2026-06-11', '2026-06-11 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260611-01'),
  ('EB-4N5O6P-114', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 868, '2026-06-11', '2026-06-11 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260611-02'),
  ('EB-5O6P7Q-115', 'cus-01', 'Patricia Lim', NULL, '+63 917 111 0001', NULL, 'online', 'pickup', 'regular', 'gcash', 735, '2026-06-07', '2026-06-07 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260607-01'),
  ('EB-6P7Q8R-116', 'cus-02', 'Roberto Tan', NULL, '+63 918 222 0002', NULL, 'online', 'pickup', 'regular', 'bank', 3682, '2026-06-05', '2026-06-05 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260605-01'),
  ('EB-7Q8R9S-117', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 299, '2026-06-03', '2026-06-03 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260603-01'),
  ('EB-8R9S0T-118', 'cus-03', 'Elena Soriano', NULL, '+63 919 333 0003', NULL, 'online', 'pickup', 'regular', 'gcash', 865, '2026-06-01', '2026-06-01 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260601-01'),
  ('EB-9S0T1U-119', 'cus-04', 'Danilo Mercado', NULL, '+63 920 444 0004', NULL, 'online', 'pickup', 'regular', 'bank', 5212, '2026-05-30', '2026-05-30 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260530-01'),
  ('EB-0T1U2V-120', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 434, '2026-05-28', '2026-05-28 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260528-01'),
  ('EB-1U2V3W-121', 'cus-07', 'Marilyn Gonzales', NULL, '+63 923 777 0007', NULL, 'online', 'pickup', 'regular', 'gcash', 1355, '2026-05-26', '2026-05-26 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260526-01'),
  ('EB-2V3W4X-122', 'cus-08', 'Fernando Castro', NULL, '+63 924 888 0008', NULL, 'online', 'pickup', 'regular', 'bank', 2510, '2026-05-23', '2026-05-23 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260523-01'),
  ('EB-3W4X5Y-123', 'cus-09', 'Loreta Pascual', NULL, '+63 925 999 0009', NULL, 'online', 'pickup', 'regular', 'gcash', 779, '2026-05-18', '2026-05-18 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260518-01'),
  ('EB-4X5Y6Z-124', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 574, '2026-05-13', '2026-05-13 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260513-01'),
  ('EB-5Y6Z7A-125', 'cus-01', 'Patricia Lim', NULL, '+63 917 111 0001', NULL, 'online', 'pickup', 'regular', 'gcash', 1458, '2026-05-08', '2026-05-08 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260508-01'),
  ('EB-6Z7A8B-126', 'cus-02', 'Roberto Tan', NULL, '+63 918 222 0002', NULL, 'online', 'pickup', 'regular', 'bank', 4330, '2026-04-23', '2026-04-23 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260423-01'),
  ('EB-7A8B9C-127', 'cus-04', 'Danilo Mercado', NULL, '+63 920 444 0004', NULL, 'online', 'pickup', 'regular', 'bank', 7065, '2026-03-29', '2026-03-29 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260329-01'),
  ('EB-8B9C0D-128', NULL, 'Walk-in', NULL, '—', NULL, 'walk-in', 'pickup', 'regular', 'cash', 1128, '2026-03-09', '2026-03-09 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260309-01'),
  ('EB-9C0D1E-129', 'cus-08', 'Fernando Castro', NULL, '+63 924 888 0008', NULL, 'online', 'pickup', 'regular', 'bank', 3834, '2026-02-07', '2026-02-07 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20260208-01'),
  ('EB-0D1E2F-130', 'cus-03', 'Elena Soriano', NULL, '+63 919 333 0003', NULL, 'online', 'pickup', 'regular', 'gcash', 1060, '2025-11-29', '2025-11-29 00:00:00', 'completed', NULL, 1, 0, NULL, 0, NULL, 'BT-20251231-01'),
  ('ORD-20260617-001', NULL, 'Maria Gonzales', 'mgonzales@email.ph', '09171234567', '45 Santos St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1205, '2026-06-17', '2026-06-17 08:30:00', 'pending', NULL, 0, 1, 'GC-20260617-A001', 1205, NULL, NULL),
  ('ORD-20260617-002', NULL, 'Roberto Lim', 'rlim@email.ph', '09209876543', '23 Rizal Ave, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'bank', 897, '2026-06-17', '2026-06-17 09:15:00', 'pending', NULL, 0, 1, 'BT-EBI-20260617-002', 919, NULL, NULL),
  ('ORD-20260617-003', NULL, 'Cecilia Ramos', 'cramos@email.ph', '09123456789', '78 Fernandez St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1630, '2026-06-17', '2026-06-17 10:00:00', 'pending', NULL, 0, 0, NULL, 0, NULL, NULL),
  ('ORD-20260617-004', NULL, 'Patrick Villanueva', 'pvillanueva@email.ph', '09171223344', '21 Dakila St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1410, '2026-06-17', '2026-06-17 11:45:00', 'pending', NULL, 0, 1, 'GC-20260617-E004', 1410, NULL, NULL),
  ('ORD-20260617-005', NULL, 'Danilo Flores', 'dflores@email.ph', '09209998877', '88 Quezon Blvd, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'bank', 2260, '2026-06-17', '2026-06-17 07:45:00', 'on-hold', 'Payment amount mismatch — expected ₱2,390, received ₱2,000', 0, 1, 'BT-EBI-20260617-005', 2000, NULL, NULL),
  ('ORD-20260616-001', NULL, 'Aldrin Cruz', 'acruz@email.ph', '09181234567', '15 Burgos Ave, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1870, '2026-06-16', '2026-06-16 14:20:00', 'accepted', NULL, 1, 1, 'GC-20260616-B001', 1915, NULL, NULL),
  ('ORD-20260616-002', NULL, 'Rowena Santos', 'rsantos@email.ph', '09361234567', '32 Luna St, San Carlos City, Pangasinan', 'online', 'delivery', 'regular', 'bank', 1438, '2026-06-16', '2026-06-16 09:00:00', 'shipping', 'JRS Express #JRS20260616A', 1, 1, 'BT-EBI-20260616-002', 1440, NULL, NULL),
  ('ORD-20260615-001', NULL, 'Noel Aquino', 'naquino@email.ph', '09191234567', '7 Arellano St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1305, '2026-06-15', '2026-06-15 11:30:00', 'delivered', NULL, 1, 1, 'GC-20260615-C001', 1375, NULL, NULL),
  ('ORD-20260614-001', NULL, 'Evangeline Reyes', 'ereyes@email.ph', '09171112233', '55 Perez St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1583, '2026-06-14', '2026-06-14 16:45:00', 'completed', NULL, 1, 1, 'GC-20260614-D001', 1155, NULL, NULL),
  ('ORD-20260614-002', NULL, 'Marco Dela Cruz', 'mdelacruz@email.ph', '09276543210', '14 Mabini St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'bank', 1726, '2026-06-14', '2026-06-14 10:20:00', 'completed', NULL, 1, 1, 'BT-EBI-20260614-002', 1680, NULL, NULL),
  ('ORD-20260613-001', NULL, 'Tessie Bautista', 'tbautista@email.ph', '09181112233', '12 Mabini St, Dagupan City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 598, '2026-06-13', '2026-06-13 13:00:00', 'cancelled', 'No payment submitted within 24 hours', 0, 0, NULL, 0, NULL, NULL),
  ('ORD-20260612-001', NULL, 'Lorna Mendez', 'lmendez@email.ph', '09201122334', '9 Quezon St, Urdaneta City, Pangasinan', 'online', 'delivery', 'regular', 'gcash', 1277, '2026-06-12', '2026-06-12 09:45:00', 'completed', NULL, 1, 1, 'GC-20260612-F001', 1290, NULL, NULL);

/* ---------- ORDER LINE ITEMS ---------- */
INSERT INTO order_items (order_id, product_id, qty, price_at_purchase) VALUES
  ('EB-1A2B3C-101', 'bg-pesto', 2, 245),
  ('EB-1A2B3C-101', 'bg-adobo', 1, 235),
  ('EB-2B3C4D-102', 'db-steak', 1, 299),
  ('EB-2B3C4D-102', 'db-pesto', 1, 285),
  ('EB-3C4D5E-103', 'bg-tuyod', 5, 215),
  ('EB-3C4D5E-103', 'bg-bayo', 3, 299),
  ('EB-4D5E6F-104', 'db-garlic', 2, 265),
  ('EB-5E6F7G-105', 'bg-tomato', 3, 209),
  ('EB-5E6F7G-105', 'bg-tuyopes', 1, 225),
  ('EB-6F7G8H-106', 'bg-bayo', 10, 299),
  ('EB-6F7G8H-106', 'bg-pesto', 8, 245),
  ('EB-7G8H9I-107', 'db-chili', 2, 275),
  ('EB-7G8H9I-107', 'db-hainan', 1, 295),
  ('EB-8H9I0J-108', 'bg-adobo', 2, 235),
  ('EB-9I0J1K-109', 'bg-tuyod', 1, 215),
  ('EB-9I0J1K-109', 'db-pesto', 1, 285),
  ('EB-0J1K2L-110', 'bg-bayo', 6, 299),
  ('EB-0J1K2L-110', 'bg-portu', 4, 255),
  ('EB-1K2L3M-111', 'db-garlic', 1, 265),
  ('EB-1K2L3M-111', 'db-chili', 1, 275),
  ('EB-2L3M4N-112', 'bg-sundri', 2, 265),
  ('EB-3M4N5O-113', 'bg-adobo', 1, 235),
  ('EB-3M4N5O-113', 'bg-hawaii', 1, 249),
  ('EB-4N5O6P-114', 'bg-tomato', 2, 209),
  ('EB-4N5O6P-114', 'bg-tuyopes', 2, 225),
  ('EB-5O6P7Q-115', 'bg-pesto', 3, 245),
  ('EB-6P7Q8R-116', 'bg-bayo', 8, 299),
  ('EB-6P7Q8R-116', 'bg-tuyod', 6, 215),
  ('EB-7Q8R9S-117', 'db-steak', 1, 299),
  ('EB-8R9S0T-118', 'db-pesto', 2, 285),
  ('EB-8R9S0T-118', 'db-hainan', 1, 295),
  ('EB-9S0T1U-119', 'bg-adobo', 12, 235),
  ('EB-9S0T1U-119', 'bg-bayo', 8, 299),
  ('EB-0T1U2V-120', 'bg-tuyopes', 1, 225),
  ('EB-0T1U2V-120', 'bg-tomato', 1, 209),
  ('EB-1U2V3W-121', 'db-chili', 3, 275),
  ('EB-1U2V3W-121', 'db-garlic', 2, 265),
  ('EB-2V3W4X-122', 'bg-portu', 6, 255),
  ('EB-2V3W4X-122', 'bg-pesto', 4, 245),
  ('EB-3W4X5Y-123', 'bg-sundri', 2, 265),
  ('EB-3W4X5Y-123', 'bg-hawaii', 1, 249),
  ('EB-4X5Y6Z-124', 'db-pesto', 1, 285),
  ('EB-4X5Y6Z-124', 'db-masala', 1, 289),
  ('EB-5Y6Z7A-125', 'bg-tuyod', 4, 215),
  ('EB-5Y6Z7A-125', 'bg-bayo', 2, 299),
  ('EB-6Z7A8B-126', 'bg-pesto', 10, 245),
  ('EB-6Z7A8B-126', 'bg-adobo', 8, 235),
  ('EB-7A8B9C-127', 'bg-bayo', 15, 299),
  ('EB-7A8B9C-127', 'bg-tuyod', 12, 215),
  ('EB-8B9C0D-128', 'db-steak', 2, 299),
  ('EB-8B9C0D-128', 'db-garlic', 2, 265),
  ('EB-9C0D1E-129', 'bg-portu', 8, 255),
  ('EB-9C0D1E-129', 'bg-bayo', 6, 299),
  ('EB-0D1E2F-130', 'db-pesto', 2, 285),
  ('EB-0D1E2F-130', 'bg-pesto', 2, 245),
  ('ORD-20260617-001', 'bg-pesto', 3, 245),
  ('ORD-20260617-001', 'bg-adobo', 2, 235),
  ('ORD-20260617-002', 'db-steak', 2, 299),
  ('ORD-20260617-002', 'bg-bayo', 1, 299),
  ('ORD-20260617-003', 'bg-sundri', 4, 265),
  ('ORD-20260617-003', 'db-pesto', 2, 285),
  ('ORD-20260617-004', 'bg-adobo', 6, 235),
  ('ORD-20260617-005', 'db-chili', 5, 275),
  ('ORD-20260617-005', 'db-hainan', 3, 295),
  ('ORD-20260616-001', 'bg-pesto', 5, 245),
  ('ORD-20260616-001', 'bg-tuyod', 3, 215),
  ('ORD-20260616-002', 'bg-adobo', 4, 235),
  ('ORD-20260616-002', 'bg-hawaii', 2, 249),
  ('ORD-20260615-001', 'db-garlic', 3, 265),
  ('ORD-20260615-001', 'bg-portu', 2, 255),
  ('ORD-20260614-001', 'bg-pesto', 2, 245),
  ('ORD-20260614-001', 'bg-tuyopes', 3, 225),
  ('ORD-20260614-001', 'bg-tomato', 2, 209),
  ('ORD-20260614-002', 'db-masala', 4, 289),
  ('ORD-20260614-002', 'db-pesto', 2, 285),
  ('ORD-20260613-001', 'bg-bayo', 2, 299),
  ('ORD-20260612-001', 'bg-hawaii', 3, 249),
  ('ORD-20260612-001', 'bg-sundri', 2, 265);

/* ---------- RETURNS & REFUNDS ---------- */
INSERT INTO product_returns (id, order_id, customer_id, customer_name, email, phone, product_id, qty, batch_code, purchase_date, reason, status, received_date, eligibility, refund_amount, refund_method, notes, rejected_reason) VALUES
  ('RET-20260617-001', 'ORD-20260614-001', NULL, 'Evangeline Reyes', 'ereyes@email.ph', '09171112233', 'bg-pesto', 1, 'BT-20260430-A', '2026-06-14', 'Product has unusual odor, possibly spoiled upon opening', 'received', '2026-06-17 08:00:00', NULL, 245, NULL, NULL, NULL),
  ('RET-20260617-002', 'ORD-20260614-002', NULL, 'Marco Dela Cruz', 'mdelacruz@email.ph', '09276543210', 'db-masala', 1, 'BT-20260501-B', '2026-06-14', 'Lid was damaged / dented when received — possible contamination concern', 'validated', '2026-06-16 15:30:00', NULL, 275, NULL, 'Order ID confirmed, product batch verified', NULL),
  ('RET-20260616-001', 'ORD-20260612-001', NULL, 'Lorna Mendez', 'lmendez@email.ph', '09201122334', 'bg-hawaii', 2, 'BT-20260420-C', '2026-06-12', 'Color appears off — darker than expected. Tasted sour.', 'eligible', '2026-06-15 10:00:00', 1, 500, NULL, 'Batch BT-20260420-C confirmed as affected lot', NULL),
  ('RET-20260615-001', 'ORD-20260614-001', NULL, 'Evangeline Reyes', 'ereyes@email.ph', '09171112233', 'bg-tomato', 1, 'BT-20260415-D', '2026-06-14', 'Seal was already broken upon delivery', 'approved', '2026-06-14 18:00:00', 1, 220, NULL, 'Approved: manufacturing defect — broken seal', NULL),
  ('RET-20260614-001', 'ORD-20260612-001', NULL, 'Lorna Mendez', 'lmendez@email.ph', '09201122334', 'bg-sundri', 1, 'BT-20260410-E', '2026-06-12', 'Received wrong flavor — ordered Sundried got Adobo', 'rejected', '2026-06-13 14:00:00', 0, 0, NULL, NULL, 'Batch code matches original order. No wrong-flavor variance on record for this batch.'),
  ('RET-20260613-001', 'ORD-20260614-002', NULL, 'Marco Dela Cruz', 'mdelacruz@email.ph', '09276543210', 'db-pesto', 1, 'BT-20260405-F', '2026-06-14', 'Foreign object found inside jar — small plastic fragment', 'processed', '2026-06-12 09:00:00', 1, 290, 'gcash', 'Refund ₱290 sent via GCash 09276543210', NULL);

/* ---------- NOTIFICATIONS ---------- */
INSERT INTO notifications (id, type, order_id, return_id, product_id, message, created_at, is_read) VALUES
  ('n01', 'new-order', 'ORD-20260617-004', NULL, NULL, 'New online order from Patrick Villanueva — ₱1,410', '2026-06-17 11:45:00', 0),
  ('n02', 'new-order', 'ORD-20260617-003', NULL, NULL, 'New online order from Cecilia Ramos — awaiting payment proof', '2026-06-17 10:00:00', 0),
  ('n03', 'payment', 'ORD-20260617-002', NULL, NULL, 'Payment proof uploaded — Roberto Lim (BT-EBI-20260617-002)', '2026-06-17 09:15:00', 0),
  ('n04', 'new-order', 'ORD-20260617-001', NULL, NULL, 'New online order from Maria Gonzales — ₱1,205', '2026-06-17 08:30:00', 0),
  ('n05', 'return', NULL, 'RET-20260617-001', NULL, 'Return request received from Evangeline Reyes — Pesto Bangus', '2026-06-17 08:00:00', 0),
  ('n06', 'hold', 'ORD-20260617-005', NULL, NULL, 'Order ORD-20260617-005 placed on hold — payment mismatch', '2026-06-17 07:45:00', 1),
  ('n07', 'return', NULL, 'RET-20260617-002', NULL, 'Return request from Marco Dela Cruz requires validation', '2026-06-16 15:30:00', 1),
  ('n08', 'completed', 'ORD-20260614-001', NULL, NULL, 'Order ORD-20260614-001 marked Completed — Evangeline Reyes', '2026-06-14 18:00:00', 1),
  ('n09', 'inventory', NULL, NULL, 'db-masala', 'Spicy Masala Bangus is out of stock — 0 units remaining', '2026-06-17 06:30:00', 0),
  ('n10', 'inventory', NULL, NULL, 'db-steak', 'Asian Steak Bangus critically low — only 9 units left', '2026-06-16 09:00:00', 1),
  ('n11', 'audit', NULL, NULL, NULL, 'New employee account created: Rosa Dela Torre (Super Admin)', '2026-06-13 10:15:00', 1);

/* ---------- PAYMENT SCHEMES (retailer credit accounts) ---------- */
INSERT INTO payment_accounts (id, customer_id, name, email, scheme, balance, due_date, paid) VALUES
  ('pay-01', 'cus-02', 'Roberto Tan', 'roberto.tan@yahoo.com', 'Net 30', 4250, '2026-07-01', 0),
  ('pay-02', 'cus-04', 'Danilo Mercado', 'dmercado@gmail.com', 'Net 60', 12800, '2026-06-05', 0),
  ('pay-03', 'cus-08', 'Fernando Castro', 'fcastro@gmail.com', 'Net 90', 7650, '2026-08-15', 0),
  ('pay-04', 'cus-02', 'Roberto Tan', 'roberto.tan@yahoo.com', 'Net 30', 3100, '2026-05-10', 1);

/* ---------- AUDIT LOG ---------- */
INSERT INTO audit_logs (ts, actor, type, description) VALUES
  ('2026-06-17 09:14:00', 'Maria Santos', 'order', 'Processed online order EB-1A2B3C-101 for Patricia Lim.'),
  ('2026-06-17 10:32:00', 'Jose Reyes', 'restock', 'Restocked Bangus in Pesto Sauce (+50 units, Batch BT-20260617-A).'),
  ('2026-06-16 11:05:00', 'Maria Santos', 'user', 'Upgraded customer Marilyn Gonzales to Retailer status.'),
  ('2026-06-16 14:22:00', 'Ana Cruz', 'order', 'Processed walk-in sale for 3 items. TX: EB-5E6F7G-105.'),
  ('2026-06-15 09:00:00', 'Jose Reyes', 'restock', 'Restocked Asian Steak Bangus (+30 units, Batch BT-20260615-A).'),
  ('2026-06-15 15:48:00', 'Maria Santos', 'product', 'Archived product ''Spicy Masala Bangus'' (id: db-masala). Reason: low demand.'),
  ('2026-06-14 08:30:00', 'Luis Bautista', 'order', 'Processed online order EB-7G8H9I-107 for Cynthia Flores.'),
  ('2026-06-13 10:15:00', 'Maria Santos', 'user', 'Added new employee account: Rosa Dela Torre (Super Admin).'),
  ('2026-06-12 13:00:00', 'Jose Reyes', 'restock', 'Restocked Tuyo Delizioso (+80 units, Batch BT-20260612-A).'),
  ('2026-06-11 09:45:00', 'Maria Santos', 'user', 'Archived employee account: Rosa Dela Torre. Reason: contract ended.'),
  ('2026-06-10 14:30:00', 'Ana Cruz', 'order', 'Processed walk-in sale TX: EB-4N5O6P-114.'),
  ('2026-06-09 11:20:00', 'Maria Santos', 'product', 'Updated price of Pesto Bangus from ₱265 to ₱285.'),
  ('2026-06-08 10:00:00', 'Jose Reyes', 'restock', 'Disposed 12 units of Bangus in Sun-dried Tomatoes (expired, Batch BT-20260501-B).'),
  ('2026-06-07 09:15:00', 'Luis Bautista', 'order', 'Processed online order EB-5O6P7Q-115 for Patricia Lim.'),
  ('2026-06-05 13:40:00', 'Maria Santos', 'system', 'Updated landing page — About Us text and Contact info revised.'),
  ('2026-06-03 10:30:00', 'Maria Santos', 'product', 'Added new product: Bangus in Tomato Sauce (id: bg-tomato).'),
  ('2026-05-28 09:00:00', 'Jose Reyes', 'restock', 'Restocked Ba-yo (Bangus & Tuyo) (+100 units, Batch BT-20260528-A).'),
  ('2026-05-20 14:15:00', 'Maria Santos', 'user', 'Upgraded customer Roberto Tan to Retailer. Assigned Net 30 payment scheme.'),
  ('2026-06-17 07:45:00', 'Luis Bautista', 'order', 'Order ORD-20260617-005 placed On Hold — Payment mismatch.'),
  ('2026-06-16 14:22:00', 'Luis Bautista', 'order', 'Order ORD-20260616-001 Accepted.'),
  ('2026-06-16 11:00:00', 'Luis Bautista', 'order', 'Order ORD-20260616-002 moved to Shipping — JRS Express #JRS20260616A.'),
  ('2026-06-15 13:00:00', 'Luis Bautista', 'order', 'Order ORD-20260615-001 marked Delivered.'),
  ('2026-06-14 18:00:00', 'Luis Bautista', 'order', 'Order ORD-20260614-001 Completed.'),
  ('2026-05-15 14:00:00', 'Jose Reyes', 'product', 'Return · Hawaiian Style Bangus +3 units · Batch BT-20260125-A · Reason: Customer returned unopened.'),
  ('2026-05-10 11:00:00', 'Jose Reyes', 'product', 'Disposal · Asian Steak Bangus -5 units · Batch BT-20260501-A · Reason: Defective seal.'),
  ('2026-04-20 10:30:00', 'Jose Reyes', 'product', 'Disposal · Portuguese Style Bangus -3 units · Batch BT-20260415-A · Reason: Minor mold on rim.'),
  ('2026-04-05 15:00:00', 'Jose Reyes', 'product', 'Return · Pinoy Adobo Bangus +6 units · Batch BT-20260425-A · Reason: Wrong order.'),
  ('2026-05-28 09:30:00', 'Jose Reyes', 'product', 'Disposal · Spicy Masala Bangus -8 units · Batch BT-20260301-A · Reason: Damaged packaging.');

/* ---------- LANDING PAGE CONTENT ---------- */
INSERT INTO site_content (key_name, value_text) VALUES
  ('about', 'Elisha Bay is a family-owned artisan food brand rooted in Dagupan City — the Bangus Capital of the Philippines. Every product starts with fresh, locally-sourced milkfish, hand-deboned or bottled in small batches.'),
  ('vision', 'To bring Dagupan''s gourmet bangus to every Filipino table — and put Pangasinan''s handcrafted bottled fish on the world map.'),
  ('mission', 'To craft honest, high-quality fish products using local catch and traditional methods, while supporting Dagupan''s fishing families and delighting every customer, one jar at a time.'),
  ('contact_address', '148 Brgy. Mangin, Dagupan City, Pangasinan'),
  ('contact_phone', '+63 917 000 0000'),
  ('contact_email', 'hello@jurisbayfoods.ph'),
  ('contact_facebook', 'facebook.com/ElishaBayPH');

INSERT INTO faqs (question, answer, display_order) VALUES
  ('How long do the bottled products last?', 'Unopened, our bottled gourmet bangus and tuyo keep for up to 6 months at room temperature away from direct sunlight. Refrigerate after opening and consume within 5 days.', 1),
  ('How do I pay for my order?', 'We accept Cash (on pickup), GCash and Bank Transfer. For GCash and Bank Transfer, enter your reference number at checkout so we can verify your payment.', 2),
  ('Do you deliver nationwide?', 'Yes. Orders are shipped nationwide via LBC courier. Delivery fees and transit time depend on your location — computed at checkout.', 3),
  ('Can I cancel my order?', 'Orders can be cancelled while they are still pending and have not been prepared or shipped. Contact us right away and we will sort it out.', 4),
  ('I run a store — can I resell your products?', 'Absolutely! We welcome resellers and retail partners. Message us on Facebook or email us for wholesale pricing and terms.', 5),
  ('What are your business hours?', 'Monday to Saturday, 8:00 AM – 5:00 PM at 148 Brgy. Mangin, Dagupan City, Pangasinan.', 6);

/* Hero carousel slides. image_path is NULL until an admin uploads one through
   the Landing Page module; api/uploads/image.php writes the file and
   api/content/save.php stores the path here. */
INSERT INTO hero_slides (title, image_path, display_order) VALUES
  ('Pesto Bangus', NULL, 1),
  ('Adobo Bangus', NULL, 2),
  ('Asian Steak', NULL, 3),
  ('Tuyo Delizioso', NULL, 4),
  ('Ba-yo Signature', NULL, 5);

/* featured_products is intentionally empty: SITE_CONTENT.featured = [],
   which makes the landing page fall back to each product's is_best flag. */

/* ---------- SYSTEM SETTINGS ---------- */
INSERT INTO settings (key_name, value_text) VALUES
  ('penalty_rate', '2'),
  ('currency', '₱'),
  ('brand', 'Elisha Bay'),
  ('company', 'Juris Bay Foods, Inc.');

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- Fixed test fixtures (D16).
--
-- tools/verify-api.py used to register a customer with a timestamped email on
-- every run, so the customers table grew by one row per execution and the
-- register path could never be exercised from a known starting state. These two
-- rows are seeded once and reused; the suite resets their state in setup and
-- never creates or drops an account.
--
--   cus-t01  password is Test@Cust1  -- sign-in, session and checkout tests
--   cus-t02  password NULL           -- the "registering claims an existing
--                                       record" path; teardown sets it back
--
-- They are ordinary customer rows and appear in staff screens like any other.
-- Remove them only if you also remove the tests that depend on them.
-- ---------------------------------------------------------------------------
INSERT INTO customers (id, name, email, password, contact, status, joined) VALUES
  ('cus-t01', 'Test Shopper',  'test.shopper@elishabay.ph',  '$2y$10$Ifp09DtbhlYyOWyOzma5ReusH/8v.hsZBfAjZOKhPh2/04vCBqCxO', '+63 900 000 0001', 'active', '2026-01-01'),
  ('cus-t02', 'Test Claimant', 'test.claimant@elishabay.ph', NULL, '+63 900 000 0002', 'active', '2026-01-01')
ON DUPLICATE KEY UPDATE
  password = VALUES(password), status = VALUES(status);
