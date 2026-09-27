"use strict";

/* ============================================================
   CONFIG — mirrors the public site's brand config
   ============================================================ */
const CONFIG = {
  brand: "Elisha Bay", company: "Juris Bay Foods, Inc.", currency: "₱",
  address: "148 Brgy. Mangin, Dagupan City, Pangasinan",
  phone: "+63 900 000 0000", email: "hello@elishabay.ph",
  facebook: "facebook.com/ElishaBayPH",
};

/* ============================================================
   PROJECT ROOT — derived, never hardcoded
   ------------------------------------------------------------
   Every portal entry is portal/<role>/index.html, but this file is
   also the engine for the landing-page preview iframe and the logout
   redirect, both of which need a path back out to public/. Deriving
   it from this script's own URL keeps those working no matter what
   folder the project is served from — the previous absolute paths
   (/V4Home/HomePage/index.html) 404'd anywhere but the web root.
   ============================================================ */
const PORTAL_BASE_PATH = (() => {
  const src = (document.currentScript && document.currentScript.src) || "";
  const i = src.indexOf("assets/js/portal/");
  return i >= 0 ? src.slice(0, i) : "/";
})();

/* ============================================================
   CATALOGUE — loaded from the database
   ------------------------------------------------------------
   These were `const` arrays that every screen read directly. They
   are now `let`, filled by loadCatalog() from api/products/list.php
   and api/categories/list.php before the first render.

   Declared with their old seed contents still in place on purpose:
   ~40 render functions across four files reference PRODUCTS
   synchronously, and an empty array during the moment before the
   fetch resolves would render four screens blank. The seed is
   overwritten wholesale by the first successful load, so what you
   see after login is the database — the literals below are only
   scaffolding for the first few hundred milliseconds.

   Phase 5 removes them entirely as each module gains its own
   loading state.
   ============================================================ */
/* Filled from api/categories/list.php by loadCatalog(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let CATEGORIES_DATA = [];

/* Filled from api/products/list.php by loadCatalog(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let PRODUCTS = [];

/* ============================================================
   STAFF ACCOUNTS (login source of truth)
   ============================================================ */
/* PASSWORDS DELIBERATELY REMOVED.

   This array used to carry a plaintext password per account, and this file is
   served to every visitor — so every staff credential in the system was one
   "view source" away. Authentication now happens in api/auth/login.php against
   bcrypt hashes in MySQL; nothing in the browser ever sees a password.

   What remains is display data for the User Management screen, still hardcoded
   because that screen has not been wired to the API yet. Phase 5 replaces this
   with GET api/users/list.php and deletes the array. Do not re-add a password
   field to it. */
/* Filled from api/users/list.php by loadAdminData(). Empty until then.
   Also removed a staff roster (names, emails, roles) that engine.js served
   to anyone who opened a portal page, signed in or not.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let STAFF_ACCOUNTS = [];

/* ============================================================
   RBAC — permissions catalog + role→permission grants
   ============================================================ */
const PERMISSIONS = {
  "users.manage":     { area:"Maintenance",    label:"Manage customer & employee accounts" },
  "rbac.manage":       { area:"System",         label:"Manage roles & permissions" },
  /* SUPER ADMIN ONLY — systemOnly. Mirrors Rbac::SYSTEM_ONLY on the server: the
     matrix shows it locked for every other role, and roles/save.php refuses it
     if it is sent anyway. */
  "vat.manage":        { area:"System",         label:"Manage VAT settings", systemOnly:true },
  "b2b.review":         { area:"Maintenance",    label:"Review B2B partner applications" },
  "landing.manage":      { area:"Maintenance",    label:"Manage landing page content" },
  "products.manage":      { area:"Maintenance",    label:"Manage products & varieties" },
  "inventory.report":       { area:"Inventory",      label:"View inventory report" },
  "inventory.manage":         { area:"Inventory",      label:"Restock, adjust & archive inventory" },
  "sales.report":               { area:"Reports",        label:"View sales report" },
  "batches.manage":               { area:"Reports",        label:"Manage batch tracking & QA" },
  "payments.manage":                 { area:"Finance",        label:"Manage payment schemes" },
  "transactions.view":                 { area:"Finance",        label:"View transaction history" },
  "audit.view":                          { area:"Finance",        label:"View audit log" },
  "pos.use":                               { area:"Point of Sale",  label:"Use point of sale (walk-in orders)" },
  "orders.view":                             { area:"Online Orders",  label:"View online orders" },
  "orders.accept":                             { area:"Online Orders",  label:"Accept/hold/reject orders, verify payments" },
  "orders.status":                               { area:"Online Orders",  label:"Update order status" },
  "orders.returns":                                { area:"Online Orders",  label:"Process returns & refunds" },
  /* Was missing here while the database had it (migration 011), so it drew no
     switch yet counted in "Total Permissions" — Admin showed 13 with 12 on. */
  "reviews.moderate": { area:"Maintenance",    label:"Moderate customer product reviews" },
};

/* Roles editable from the Roles & Permissions screen. "Super Admin" is
   not listed here — it always has every permission, unconditionally. */
const ROLE_PERMISSIONS = {
  "Admin":               Object.keys(PERMISSIONS).filter(k => k !== "rbac.manage" && !PERMISSIONS[k].systemOnly),
  "Cashier":             ["pos.use","transactions.view","sales.report","payments.manage"],
  "Inventory Staff":     ["inventory.report","inventory.manage","batches.manage","audit.view"],
  "Online Orders Staff": ["orders.view","orders.accept","orders.status","orders.returns","transactions.view","payments.manage"],
};

/* Display metadata (slug badge + blurb) for the Roles & Permissions cards.
   Custom roles created via "Create New Role" get an entry pushed here too. */
/* Factory permissions of the built-in roles — the same grants db/seed.sql
   writes. The matrix's "Default" button restores these (then Save Matrix
   persists them). Custom roles have no default and show no button. */
const ROLE_DEFAULTS = {
  "Admin": ["users.manage","b2b.review","landing.manage","products.manage","inventory.report","inventory.manage",
            "sales.report","batches.manage","payments.manage","transactions.view","audit.view","pos.use",
            "orders.view","orders.accept","orders.status","orders.returns","reviews.moderate"],
  "Cashier": ["pos.use","transactions.view","sales.report","payments.manage"],
  "Inventory Staff": ["inventory.report","inventory.manage","batches.manage","audit.view"],
  "Online Orders Staff": ["orders.view","orders.accept","orders.status","orders.returns","transactions.view","payments.manage"],
};

const ROLE_META = {
  "Admin":               { slug:"admin",                 desc:"Full operational access across every module except managing roles & permissions." },
  "Cashier":             { slug:"cashier",              desc:"Walk-in POS sales, payment scheme monitoring, and transaction history." },
  "Inventory Staff":     { slug:"inventory-staff",       desc:"Manages Bangus products, batch/QA traceability, and stock levels." },
  "Online Orders Staff": { slug:"online-orders-staff",   desc:"Accepts, verifies, and fulfills online orders; processes returns & refunds." },
};

/* Consults the grants the server sent with the session, which come from the
   role_permissions table — so an edit made on the Roles & Permissions screen
   takes effect for real rather than only in this file's copy.

   ROLE_PERMISSIONS below is still the source for the Roles matrix UI until
   Phase 5 wires that screen to the API; it is no longer what decides access.
   The fallback exists only for the moment between page load and the session
   resolving, where no permission should be granted anyway. */
function hasPerm(key){
  const user = adminState.currentUser;
  if(!user) return false;
  if(window.EbSession && EbSession.isSignedIn()) return EbSession.can(key);
  return false;
}

/* mod key -> required permission (mods not listed here are always visible, e.g. dashboard) */
const MOD_PERM = {
  users:"users.manage", b2b:"b2b.review", landing:"landing.manage", products:"products.manage",
  inventory:"inventory.report", "inventory-manage":"inventory.manage", expiry:"inventory.manage",
  sales:"sales.report", batches:"batches.manage",
  payments:"payments.manage", transactions:"transactions.view", audit:"audit.view",
  pos:"pos.use", "pos-payment":"pos.use",
  ordersqueue:"orders.accept", paymentverify:"orders.accept", orderstatus:"orders.status",
  "online-txns":"orders.view", orderhistory:"transactions.view", receipts:"orders.view", returns:"orders.returns",
  roles:"rbac.manage",
  reviews:"reviews.moderate",
  vat:"vat.manage",
};

/* Hide every [data-perm] element the current user lacks, then collapse
   any nav-group left with no visible items. Run once right after login. */
/* Delegates to assets/js/core/rbac.js. Worth repeating where it is easy to
   forget: this hides things, it does not protect them. Rbac::require() in PHP
   is the control, on every endpoint. */
function applyRBAC(){ return EbRbac.apply(); }

/* ============================================================
   SEED DATA — customers
   ============================================================ */
/* Filled from api/customers/list.php by loadAdminData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let CUSTOMERS = [];

/* ============================================================
   DATES
   ------------------------------------------------------------
   Two rules, and every date string in the portal goes through them.

   1. THE CLOCK IS THE CLOCK. dAgo() used to read
      `new Date("2026-06-17")` — a constant, chosen when the seed data was
      written so the dashboard would have something to show. Once the system
      was wired to a database that stopped being a convenience and became a
      lie: "Today" on the Sales Report meant 17 June 2026 no matter what day
      it was, and a receipt's NET-30 due date was counted from a date in the
      past. The seed orders run to 17 June 2026 and are deliberately left
      alone, so Today / This Week / This Month will read empty until fresh
      orders arrive. An empty report that is correct beats a populated one
      that is not.

   2. LOCAL, NOT UTC. `toISOString()` formats in UTC. In UTC+8 that is a day
      behind local for the first eight hours of every day, and the previous
      code mixed the two conventions: `new Date("2026-06-17")` parses a
      date-only string as UTC, while `new Date("2026-06-17T00:00:00")` parses
      as LOCAL, so addDays("2026-06-17", 30) returned 16 July rather than the
      17th. ymd() below reads the local calendar fields directly, and
      parseYmd() parses a date-only string back as local midnight, so a round
      trip is lossless and matches MySQL's CURDATE() on the same machine.
   ============================================================ */

/** A Date as local YYYY-MM-DD. Never toISOString() — that is UTC. */
function ymd(d){
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/** "YYYY-MM-DD" as local midnight — the inverse of ymd(). */
function parseYmd(str){
  const [y, m, d] = String(str).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Today, or n days before it.

    Prefers the SERVER's date (Asia/Manila) over the browser's clock, which the
    user can change and which may sit in another timezone entirely. Falls back
    to the local clock only before system/dates.php has answered. */
function dAgo(n){
  const base = SERVER_DATES?.today;
  if(base) return n === 0 ? base : addDays(base, -n);
  const d = new Date(); d.setDate(d.getDate() - n); return ymd(d);
}

function addDays(str, n){ const d = parseYmd(str); d.setDate(d.getDate() + n); return ymd(d); }

/* ============================================================
   BATCH TRACKING & QA TRACEABILITY
   ============================================================ */
const QUALITY_GRADES = ["Grade A Export Quality","Grade B Standard Quality","Grade C Local Market"];
const LAB_STATUSES = {
  passed:  "Passed (Commercial Sterility Certified)",
  pending: "Pending Lab Results",
  failed:  "Failed (Contamination Detected)",
};

/* Filled from api/batches/list.php by loadCatalog(). Seed rows below are
   scaffolding for the moment before that resolves — see the CATALOGUE note. */
/* Filled from api/batches/list.php by loadInventoryData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let BATCHES = [];

/* Canonical order/transaction ledger — POS walk-in sales (type:"walk-in") and
   online orders (type:"online") in one array. Filled from api/orders/list.php
   by loadOrders(). Empty until then.

   This used to be assembled at parse time from two seed literals, ORDERS_SEED
   (30 historical rows) and ONLINE_ORDERS_SEED (5 live ones), merged by a .map()
   that filled in workflow defaults and normalised `method` to `payMethod`.
   All of it is gone:

   - The rows were mock data. loadOrders() overwrote them on every load, so they
     changed no outcome — but a failed load left every order screen showing
     invented orders that looked real.
   - The payMethod normalisation is redundant. orders/list.php emits `payMethod`
     directly (list.php:195), so nothing needs renaming on arrival.
   - ONLINE_ORDERS_SEED.map() called payMethodLabel() at PARSE time, which is
     what made the temporal-dead-zone crash possible when that helper was later
     rewritten as a const arrow. With the seed gone, no function is called
     before the module finishes loading. */
let ORDERS = [];

/* ============================================================
   ONLINE ORDERS — status workflow + returns + notifications
   ============================================================ */
const STATUS_TRANSITIONS = {
  "pending":   ["accepted","on-hold","cancelled"],
  "accepted":  ["shipping","on-hold","cancelled"],
  "shipping":  ["delivered","on-hold"],
  "delivered": ["completed","on-hold"],
  "on-hold":   ["accepted","cancelled"],
  "completed": [],
  "cancelled": [],
};
const STATUS_LABEL = {
  pending:"Pending", accepted:"Accepted", shipping:"Shipping",
  delivered:"Delivered", completed:"Completed",
  "on-hold":"On Hold", cancelled:"Cancelled",
};

const RETURN_STEPS = [
  "Receive Request","Validate Customer & Order","Eligibility Verification",
  "Rejected Requests","Approval Process","Return Processing","Transaction Recording",
];
const RETURN_STATUS_STEP = {
  received:1, validated:2, eligible:3, ineligible:4, approved:5, rejected:4, processed:7,
};

/* Filled from api/returns/list.php by loadOpsData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let RETURNS = [];

/* Filled from api/notifications/list.php by loadOpsData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let NOTIFICATIONS = [];

/* ============================================================
   SEED DATA — payment accounts (retailers)
   ============================================================ */
/* Filled from api/payments/list.php by loadOpsData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let PAYMENT_ACCOUNTS = [];

/* ============================================================
   B2B RETAIL PARTNER APPLICATIONS
   ============================================================ */
const PARTNER_TIERS = ["Bronze","Silver","Gold"];

/* Filled from api/b2b/list.php by loadOpsData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let B2B_APPLICATIONS = [];

/* ============================================================
   SEED DATA — site content (Landing Page Maintenance)
   ============================================================ */
const SITE_CONTENT = {
  /* Seeded from what the public page actually shows today. Before the
     content bridge existed this module held a completely different set of
     FAQs and About/Vision/Mission copy that no visitor ever saw, so the
     live text is treated as the source of truth. The admin's own
     business-hours question was worth keeping and is appended as #6.

     NOTE — contact details conflicted between the two: the live page
     shows +63 917 000 0000 / hello@jurisbayfoods.ph while this module
     had +63 900 000 0000 / hello@elishabay.ph. Different email DOMAINS,
     so one is simply wrong. The live values are used here; confirm which
     is correct and edit in the module. */
  about: "Elisha Bay is a family-owned artisan food brand rooted in Dagupan City — the Bangus Capital of the Philippines. Every product starts with fresh, locally-sourced milkfish, hand-deboned or bottled in small batches.",
  vision: "To bring Dagupan's gourmet bangus to every Filipino table — and put Pangasinan's handcrafted bottled fish on the world map.",
  mission: "To craft honest, high-quality fish products using local catch and traditional methods, while supporting Dagupan's fishing families and delighting every customer, one jar at a time.",
  faqs: [
    { q:"How long do the bottled products last?", a:"Unopened, our bottled gourmet bangus and tuyo keep for up to 6 months at room temperature away from direct sunlight. Refrigerate after opening and consume within 5 days." },
    { q:"How do I pay for my order?", a:"We accept Cash (on pickup), GCash and Bank Transfer. For GCash and Bank Transfer, enter your reference number at checkout so we can verify your payment." },
    { q:"Do you deliver nationwide?", a:"Yes. Orders are shipped nationwide via LBC courier. Delivery fees and transit time depend on your location — computed at checkout." },
    { q:"Can I cancel my order?", a:"Orders can be cancelled while they are still pending and have not been prepared or shipped. Contact us right away and we will sort it out." },
    { q:"I run a store — can I resell your products?", a:"Absolutely! We welcome resellers and retail partners. Message us on Facebook or email us for wholesale pricing and terms." },
    { q:"What are your business hours?", a:"Monday to Saturday, 8:00 AM – 5:00 PM at 148 Brgy. Mangin, Dagupan City, Pangasinan." },
  ],
  contact: {
    address: "148 Brgy. Mangin, Dagupan City, Pangasinan",
    phone: "+63 917 000 0000",
    facebook: "facebook.com/ElishaBayPH",
    email: "hello@jurisbayfoods.ph",
  },
  /* GCash / bank accounts customers pay into. Filled from content/get.php. */
  payment: {
    gcash: { name: "", number: "", qr: "" },
    bank:  { bank: "", name: "", number: "", qr: "" },
  },

  /* Hero slide photos. Titles match HERO_PANELS on the public page. */
  hero: [
    { title:"Pesto Bangus",    img:"" },
    { title:"Adobo Bangus",    img:"" },
    { title:"Asian Steak",     img:"" },
    { title:"Tuyo Delizioso",  img:"" },
    { title:"Ba-yo Signature", img:"" },
  ],

  /* Product ids shown in the landing page's Best Sellers carousel.
     Empty = fall back to each product's own `best` flag. Persisted to
     featured_products by content/save.php. */
  featured: [],

  /* `productImages: {}` used to be here — a productId -> image map with no
     table, no endpoint and no reader. Removed with the duplicate uploader that
     filled it. A product's photo lives on the product. */
};

/* ============================================================
   SEED DATA — audit log
   ============================================================ */
/* Filled from api/audit/list.php by loadAdminData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let AUDIT_LOG = [];

/* ============================================================
   APP STATE
   ============================================================ */
const adminState = {
  theme:         document.documentElement.getAttribute("data-theme") || "light",
  currentUser:   null,
  currentModule: "dashboard",
  penaltyRate:   2,
  userTabActive: "customers",
  productsTabActive: "catalog",
  salesRange:    "today",
  batchSort:     { col:"lotCode", dir:"desc" },
  batchPage:     1,
  batchPageSize: 10,
  b2bSort:       { col:"appId", dir:"desc" },
  b2bPage:       1,
  b2bPageSize:   10,
  /* Pagers for tables that previously relied on a fixed-height scroll
     cap (.table-wrap.scrollable / .viewport-bound) to stay usable.
     Shape matches what pagination.js (Paginate) expects. */
  custPager:     { page: 1, pageSize: 10 },
  empPager:      { page: 1, pageSize: 10 },
  varietyPager:  { page: 1, pageSize: 10 },
  invReportPager:{ page: 1, pageSize: 10 },
  salesPager:    { page: 1, pageSize: 10 },
  payPager:      { page: 1, pageSize: 10 },
  txPager:       { page: 1, pageSize: 10 },
  auditPager:    { page: 1, pageSize: 10 },
  cart:          [],
  catFilter:     "All",
  onlineTxnFilter: "all",
  paySort:     { col:"name", dir:"asc" },
  queueFilter: "pending",
  pvFilter: "all",
  queuePager: { page: 1, pageSize: 10 },
  pvPager:    { page: 1, pageSize: 10 },
  returnTab:     "all",
  invTab:        "overview",
  notifFilter:   "all",
  /* Urgency, so this screen opens in the same order the bell and the
     dashboard panel are fixed at. It was "newest", which is what made the
     Notifications module the one place an expired batch could sit below a
     completed order. */
  notifSort:     "urgency",
  /* Pagers for admin-orders.js / admin-inventory.js tables. */
  onlineTxnPager:  { page: 1, pageSize: 10 },
  orderStatusPager:{ page: 1, pageSize: 10 },
  ordHistoryPager: { page: 1, pageSize: 10 },
  receiptsPager:   { page: 1, pageSize: 10 },
  stockOvwPager:   { page: 1, pageSize: 10 },
  adjLogPager:     { page: 1, pageSize: 10 },
  archivePager:    { page: 1, pageSize: 10 },
  expiryPager:     { page: 1, pageSize: 10 },
  /* buildStockOverview() rebuilds its whole tbody on every keystroke now
     (to make room for pagination), so its search/filter values have to
     live here instead of being read off DOM inputs that get wiped by
     the rebuild. */
  invOverviewQuery: "",
  invOverviewLevel: "all",
  /* Which trailing sales window the stock bands are measured over on the
     Inventory Report and Stock Overview: "default" | "week" | "yesterday"
     | "month". See STOCK_WINDOWS. */
  stockWindow:   "default",
  /* What the restock form's suggested quantity is measured over:
     "week" | "yesterday". See RESTOCK_BASES in inventory.js. */
  restockBasis:  "week",
};

/* ============================================================
   HELPERS
   ============================================================ */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
/* Formatting lives in assets/js/core/format.js — one implementation shared
   with the public site, which had drifted its own slightly different copies.
   These names stay as thin aliases because ~200 call sites across engine.js,
   pos.js, orders.js and inventory.js use them, and renaming all of them is
   churn without benefit. */
/* Function declarations, not const arrows, deliberately: several of these are
   called at parse time by the seed-array .map() blocks near the top of this
   file. A const is in the temporal dead zone until its line executes, so an
   arrow here throws "Cannot access X before initialization" and takes the
   whole script — and therefore the entire portal — down with it. Declarations
   hoist, so they are safe to call from anywhere. */
function peso(n)         { return EbFormat.peso(n); }
function escHtml(s)      { return EbFormat.escHtml(s); }
function fmtDate(s)      { return EbFormat.fmtDate(s); }
function fmtDateTime(s)  { return EbFormat.fmtDateTime(s); }
function stockInfo(n)    { return EbFormat.stockInfo(n); }
function movementType(n) { return EbFormat.movementType(n); }

/* ============================================================
   THE SALES WINDOW THE STOCK BANDS ARE MEASURED OVER
   ============================================================
   Critical / Low / Safe and Fast / Slow / Non-Moving are not counts, they are
   RATES — units sold per day over a trailing window — so the window is half of
   what they mean. See api/core/Inventory.php.

   It was a single stored setting, ninety days, for every screen at once. Ninety
   days is the right lens on a slow mover and the wrong one the morning after a
   bulk order empties a shelf: one big day inside ninety barely moves the rate,
   and the band still reads Safe. A week answers "what is moving now"; yesterday
   answers "what went out yesterday", noise and all.

   SESSION-SCOPED, NOT STORED. This is a lens someone looks through, not a
   business rule — two people can hold different ones at the same time, and
   neither changes the other's screen or the stored default. It resets on
   reload, which is the right default for a view nobody agreed to.

   Deliberately NOT applied to PRODUCTS (loadCatalog), which every other screen
   reads: the dashboard's Critical Stock card and the POS would silently change
   meaning from a control on another screen. The two screens that offer the
   toggle fetch their own rows and say in words what they measured. */
const STOCK_WINDOWS = [
  ["default",   "Default window"],
  ["week",      "Last 7 days"],
  ["yesterday", "Yesterday"],
  ["month",     "Last 30 days"],
];

/* null for the stored default — the endpoint treats a missing param and the
   string "default" alike, and sending nothing keeps the URL honest. */
function stockWindowParam(){
  return adminState.stockWindow === "default" ? null : adminState.stockWindow;
}

/* The OPTIONS only, never the <select>. The element and its id belong to the
   screen that mounts it, spelled out there as a literal — a JS-built id is
   invisible to the structure check that catches a querySelector aimed at an
   element nobody renders, which is exactly the typo this project's checker
   exists to catch. The Inventory Report's copy is static markup in
   portal/views/inventory.html; keep the two option lists in step. */
function stockWindowOptions(){
  return STOCK_WINDOWS.map(([v, label]) =>
    `<option value="${v}"${adminState.stockWindow === v ? " selected" : ""}>Measured: ${escHtml(label)}</option>`
  ).join("");
}

/* The caption is written from the RESPONSE, not from what was asked for: an
   unknown window is refused by the endpoint, and a request that fell back to
   the stored default must not be captioned "Yesterday". */
function paintStockWindowNote(sel, meta){
  const el = $(sel);
  if(!el) return;
  const label = (meta && meta.windowLabel) || "";
  el.textContent = label
    ? `Stock levels and movement measured over ${label}, from completed orders.`
    : "";
}

/* THE RATING, SAID HONESTLY. One function, because every portal screen that
   prints `rating` has to make the same decision and none of them should make
   it differently.

   products.rating is derived from PUBLISHED reviews by Reviews::recompute()
   and is 0.00 when there are none. Printing that gives "0.0★", which reads as
   a product people rated badly rather than one nobody has rated — the exact
   misreading this feature exists to remove, just pointing the other way from
   the seeded 4.9s it replaced.

   Takes the whole product rather than (rating, count) so a caller physically
   cannot pass one without the other. api/products/list.php sends reviewCount
   beside rating for the same reason. */
function ratingText(p){
  const n = Number(p && p.reviewCount) || 0;
  if(n <= 0) return "No ratings yet";
  return `${Number(p.rating).toFixed(1)}★ (${n})`;
}

/* The one image resolver (decision I6). No screen in this file builds an image
   src by hand any more — a stored path is application-root-relative, and
   resolving it against whatever page is asking is exactly how the staff
   screens found images the storefront could not. */
function imageUrl(rec)   { return EbFormat.imageUrl(rec); }

function getProduct(id){ return PRODUCTS.find(p=>p.id===id); }

function payMethodLabel(m){ return EbFormat.payMethodLabel(m); }

/* Every payment method badge sitewide was flat badge-info blue —
   couldn't tell GCash from Cash from Bank Transfer at a glance. */
function methodBadgeClass(method){
  return {
    GCash:         "badge-info",
    Cash:          "badge-ok",
    "Bank Transfer":"badge-purple",
    /* The Net schemes had no entry, so they fell through to badge-muted —
       the SAME badge an unrecognised value gets. A sale on terms is not an
       unknown method, and the two must not look alike: muted grey is what the
       screen shows when it cannot name something. */
    "Net 30":      "badge-warn",
    "Net 60":      "badge-warn",
    "Net 90":      "badge-warn",
  }[method] || "badge-muted";
}

/* CART PRICING ONLY.

   Multiplies each line by the product's CURRENT price, which is correct for a
   cart being priced right now and wrong for everything else. Using it on a past
   order means editing a price silently rewrites history: raise the price of one
   product and last quarter's revenue goes up.

   For anything already sold, use orderTotal(). D3. */
function txTotal(items){
  return items.reduce((s,it) => {
    const p = PRODUCTS.find(x=>x.id===it.id);
    return s + (p ? p.price * it.qty : 0);
  }, 0);
}

/* What an order was actually charged. Reads orders.total, which the server
   wrote at the time from price_at_purchase.

   Falls back to recomputing only when `total` is genuinely absent, and says so
   — a silent fallback here would reintroduce the bug it exists to prevent. */
function orderTotal(o){
  if(!o) return 0;
  if(typeof o.total === "number") return o.total;
  const n = Number(o.total);
  if(Number.isFinite(n) && o.total !== null && o.total !== "") return n;
  console.warn("[money] order has no stored total, recomputing from current prices:", o.id);
  return txTotal(o.items || []);
}

/* Which orders count as revenue — mirrors Revenue::STATUSES in
   api/core/Revenue.php. The server is authoritative; this exists so the
   dashboard's own arithmetic agrees with it instead of inventing a third rule.
   If one changes, change both. */
const REVENUE_STATUSES = ["completed"];
/* Net 30/60/90 orders are not revenue in themselves — their verified payments
   are, on the day each was paid (api/core/Revenue.php). Revenue in a range is
   sumRevenue(orders in range) + receivedBetween(from, to). */
const CREDIT_PAY_METHODS = ["net30", "net60", "net90"];
function isCreditOrder(o){ return !!o && CREDIT_PAY_METHODS.includes(o.payMethod); }
function isRevenue(o){ return !!o && REVENUE_STATUSES.includes(o.status) && !isCreditOrder(o); }
/* A SALE, for counting orders: paid-at-the-time orders that completed, and Net
   orders once they committed stock — the same rule reports/sales.php counts. */
function isSaleOrder(o){
  return isRevenue(o) || (isCreditOrder(o) && ["accepted","shipping","delivered","completed"].includes(o.status));
}
/* Verified, non-legacy payments toward Net accounts, from api/payments/received.php. */
let CREDIT_RECEIPTS = [];
function receivedBetween(from, to){
  return CREDIT_RECEIPTS
    .filter(r => (!from || r.paidDate >= from) && (!to || r.paidDate <= to))
    .reduce((s, r) => s + r.amount, 0);
}
function sumRevenue(list){ return list.filter(isRevenue).reduce((s,o)=>s+orderTotal(o),0); }

function txItemsSummary(items){
  return items.map(it => {
    const p = PRODUCTS.find(x=>x.id===it.id);
    return p ? `${p.name} ×${it.qty}` : it.id;
  }).join(", ");
}

/* Overdue is decided by the SERVER, against its own CURDATE().

   This used to read `new Date(acct.dueDate) < new Date("2026-06-17")` — a
   frozen constant, so an account's overdue status was fixed relative to 17 June
   2026 for ever. Every account due after that date read as current no matter
   how long it went unpaid, and every account due before it read as overdue even
   once settled terms changed.

   api/payments/list.php already returns daysPastDue, computed with
   DATEDIFF(CURDATE(), due_date), and the penalty is calculated from it
   server-side. Recomputing it here was a second opinion nobody needed. */
function isOverdue(acct){
  if(!acct || acct.paid) return false;
  if(typeof acct.daysPastDue === "number") return acct.daysPastDue > 0;
  /* Pre-load fallback only. Uses the server's today, never the browser's. */
  const today = SERVER_DATES?.today;
  return today ? String(acct.dueDate) < today : false;
}

/* LOCAL-ONLY audit entry — shows the action in the on-screen log immediately.

   It does NOT persist. Every endpoint writes its own audit row inside the same
   transaction as the change, which is the record that counts: if the browser
   were responsible for logging, the one action worth hiding is the one that
   would never get logged.

   This remains only for the few screens whose writes do not yet go through an
   endpoint. Each of those is a gap, not a design; when the last one is wired,
   delete this function rather than leaving it as a tempting shortcut.

   The timestamp used to be `new Date("2026-06-17")` — a frozen date, so every
   locally-added entry claimed to have happened in June regardless of when it
   actually did. */
/* Raises the UI notification for an action. Does NOT write to AUDIT_LOG.

   It used to unshift a row carrying id "local-<timestamp>" and localOnly:true.
   That row never reached the database, vanished on reload, and was invisible to
   every other user — and the endpoints already write a proper audit row inside
   the same transaction as the action, so it was a second, fake copy of an event
   that was already recorded correctly (D13, D14).

   The returned object is deliberately transient. Nothing inserts it into
   AUDIT_LOG; the genuine row appears there on the next load, with the server's
   own timestamp and actor. */
function addAuditEntry(type, desc){
  const now = new Date();
  return {
    id: "transient-" + Date.now(),
    ts: ymd(now) + " " +
        now.toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit",hour12:false}),
    actor: adminState.currentUser ? adminState.currentUser.name : "System",
    type, desc,
  };
}

function initials(name){ return EbFormat.initials(name); }

/* ============================================================
   TOAST
   ============================================================ */
/* Toast and modal live in assets/js/core/ui.js. Kept as aliases for the same
   reason as the format helpers — the call sites number in the hundreds. */
function toast(msg, type="ok"){ return EbUI.toast(msg, type); }

/* ============================================================
   MODAL
   ============================================================ */
function openModal(opts){ return EbUI.openModal(opts); }
function closeModal(){ return EbUI.closeModal(); }

/* ============================================================
   IMAGE LIGHTBOX
   ------------------------------------------------------------
   The first one in this project. Written as a general overlay
   taking (src, alt, opener) rather than as something the product
   modal owns, because "show me that image bigger" is not a
   product-maintenance idea — the payment proof, the hero slides
   and the batch photos are all the same request.

   It is HERE and not in core/ui.js only because its styles are in
   portal.css. Moving the function without moving .eb-lightbox
   would hand a public page an unstyled full-screen div; promote
   both together when a storefront screen needs it.

   Owns its own markup, built once on first use and reused, so no
   page has to carry a container for an overlay it may never open.
   ============================================================ */
let lightboxOpener = null;      /* what to give focus back to on close */

function lightboxEl(){
  let el = $("#eb-lightbox");
  if(el) return el;

  /* Built from a markup string rather than assigned with el.id = "…", so the
     id is DECLARED where verify-structure.py's dangling-selector check can see
     it. That check reads id="…" out of the portal scripts; an id set through
     the property would make every $("#eb-lightbox") here look dangling, which
     is the same noise that would hide a real typo.

     aria-modal + a label, because while this is open it is the dialog — the
     product modal underneath is inert to the keyboard by the trap below. */
  const host = document.createElement("div");
  host.innerHTML = `
    <div id="eb-lightbox" class="eb-lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
      <button type="button" class="eb-lightbox-close" aria-label="Close image preview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <img alt=""/>
    </div>`;
  el = host.firstElementChild;
  document.body.appendChild(el);

  el.querySelector(".eb-lightbox-close").addEventListener("click", closeLightbox);
  /* Scrim only. A click on the image itself must not close what it opened. */
  el.addEventListener("click", e => { if(e.target === el) closeLightbox(); });

  /* CAPTURE, and it stops propagation.
     ---------------------------------------------------------------------
     initModal() listens for Escape on document in the bubble phase and closes
     the product modal. Both listeners are on document, so without capture one
     Escape would close the lightbox AND the modal underneath it, losing the
     administrator's unsaved edits. Capture runs first; stopping propagation
     there means the modal's listener never sees the key. */
  document.addEventListener("keydown", e => {
    if(!el.classList.contains("open")) return;

    if(e.key === "Escape"){
      e.stopPropagation();
      closeLightbox();
      return;
    }
    /* Focus trap. Only the close button is focusable in here, so Tab and
       Shift+Tab both mean "stay". Without this, Tab walks into the form
       behind the scrim, which is still there and still editable. */
    if(e.key === "Tab"){
      e.preventDefault();
      el.querySelector(".eb-lightbox-close").focus();
    }
  }, true);

  return el;
}

function openLightbox(src, alt, opener){
  if(!src) return;
  const el  = lightboxEl();
  const img = el.querySelector("img");
  img.src = src;
  img.alt = alt || "";
  lightboxOpener = opener || document.activeElement;
  el.classList.add("open");
  el.querySelector(".eb-lightbox-close").focus();
}

function closeLightbox(){
  const el = $("#eb-lightbox");
  if(!el) return;
  el.classList.remove("open");
  /* Dropped so a large image is not held decoded behind an invisible overlay,
     and so reopening cannot flash the previous one. */
  el.querySelector("img").removeAttribute("src");
  /* Back where it came from — the image, which is a control now. Leaving focus
     on a hidden button strands the keyboard at the top of the document. */
  if(lightboxOpener && document.contains(lightboxOpener)) lightboxOpener.focus();
  lightboxOpener = null;
}

/* ============================================================
   SPARKLINE CHART (SVG line)
   ============================================================ */
function drawSparkline(svgEl, data, { labels=[], color="var(--gold)", fillColor="", lineWidth=2, smooth=false }={}){
  if(!svgEl || !data.length) return;
  const W = svgEl.clientWidth || 600;
  const H = svgEl.clientHeight || 140;
  const PAD = { t:12, r:20, b:labels.length?28:12, l:52 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const max = Math.max(...data, 1);
  const xStep = cW / Math.max(data.length-1, 1);
  const yScale = v => PAD.t + cH - (v/max)*cH;
  const xScale = i => PAD.l + i*xStep;
  const coordPts = data.map((v,i) => [xScale(i), yScale(v)]);

  /* smooth bezier path */
  function bezierPath(pts){
    if(pts.length < 2) return `M${pts[0][0]},${pts[0][1]}`;
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for(let i=1; i<pts.length; i++){
      const pp = pts[Math.max(i-2,0)];
      const p0 = pts[i-1];
      const p1 = pts[i];
      const p2 = pts[Math.min(i+1,pts.length-1)];
      const cp1x = p0[0]+(p1[0]-pp[0])/5;
      const cp1y = p0[1]+(p1[1]-pp[1])/5;
      const cp2x = p1[0]-(p2[0]-p0[0])/5;
      const cp2y = p1[1]-(p2[1]-p0[1])/5;
      d+=` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
    }
    return d;
  }

  const isArea = smooth || !!fillColor;
  /* Visible stroke: a bezier `d` in area mode, polyline `points` otherwise. */
  const linePath = isArea
    ? bezierPath(coordPts)
    : coordPts.map(p=>p.join(",")).join(" ");
  /* The gradient fill is always a <path>, so its `d` needs real path syntax in
     both modes — polyline `points` format carries no moveto command. */
  const areaTopD = isArea
    ? linePath
    : coordPts.map((p,i)=> `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const bottom = PAD.t+cH;
  const areaD = `${areaTopD} L${coordPts[coordPts.length-1][0].toFixed(1)},${bottom.toFixed(1)} L${coordPts[0][0].toFixed(1)},${bottom.toFixed(1)} Z`;

  /* y-axis ticks */
  const ticks = [0, Math.round(max/2), max];
  const yTicksHtml = ticks.map(v=>`
    <line x1="${PAD.l-6}" y1="${yScale(v).toFixed(1)}" x2="${W-PAD.r}" y2="${yScale(v).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <text x="${PAD.l-10}" y="${yScale(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="var(--text-muted)">₱${v>=1000?Math.round(v/1000)+"k":v}</text>
  `).join("");

  /* x-axis labels */
  const xLabelsHtml = labels.map((l,i)=>`
    <text x="${xScale(i).toFixed(1)}" y="${H-4}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${escHtml(l)}</text>
  `).join("");

  /* dots — only for non-area mode */
  const dotsHtml = !isArea ? data.map((v,i)=>`
    <circle cx="${coordPts[i][0].toFixed(1)}" cy="${coordPts[i][1].toFixed(1)}" r="3.5" fill="${color}" stroke="var(--surface)" stroke-width="2">
      <title>${labels[i]||"Day "+(i+1)}: ₱${v.toLocaleString("en-PH")}</title>
    </circle>
  `).join("") : "";

  svgEl.innerHTML = `
    <defs>
      <linearGradient id="sg-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="${isArea?0.45:0.22}"/>
        <stop offset="80%" stop-color="${color}" stop-opacity="${isArea?0.08:0}"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${yTicksHtml}
    <path d="${areaD}" fill="url(#sg-fill)"/>
    ${isArea
      ? `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="${lineWidth+0.5}" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<polyline points="${linePath}" fill="none" stroke="${color}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`}
    ${dotsHtml}
    ${xLabelsHtml}
  `;
}

function drawBarChart(svgEl, data, { labels=[], color="var(--gold)" }={}){
  if(!svgEl || !data.length) return;
  const W = svgEl.clientWidth || 600;
  const H = svgEl.clientHeight || 140;
  const PAD = { t:12, r:20, b:labels.length?28:12, l:52 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const max = Math.max(...data, 1);
  const yScale = v => PAD.t + cH - (v/max)*cH;
  const n = data.length;
  const slotW = cW / n;
  const barW = Math.max(slotW * 0.55, 6);
  const xCenter = i => PAD.l + i*slotW + slotW/2;

  const ticks = [0, Math.round(max/2), max];
  const yTicksHtml = ticks.map(v=>`
    <line x1="${PAD.l-6}" y1="${yScale(v).toFixed(1)}" x2="${W-PAD.r}" y2="${yScale(v).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <text x="${PAD.l-10}" y="${yScale(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="var(--text-muted)">₱${v>=1000?Math.round(v/1000)+"k":v}</text>
  `).join("");

  const xLabelsHtml = labels.map((l,i)=>`
    <text x="${xCenter(i).toFixed(1)}" y="${H-4}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${escHtml(l)}</text>
  `).join("");

  const barsHtml = data.map((v,i)=>{
    const x = xCenter(i) - barW/2;
    const y = v===0 ? PAD.t+cH : yScale(v);
    const bH = PAD.t+cH - y;
    const r = Math.min(4, barW/2, Math.max(bH,0.1)/2);
    const gradId = `bcg${i}`;
    return `
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.25"/>
      </linearGradient></defs>
      <path d="M${(x).toFixed(1)},${(y+r).toFixed(1)}
               Q${x.toFixed(1)},${y.toFixed(1)} ${(x+r).toFixed(1)},${y.toFixed(1)}
               L${(x+barW-r).toFixed(1)},${y.toFixed(1)}
               Q${(x+barW).toFixed(1)},${y.toFixed(1)} ${(x+barW).toFixed(1)},${(y+r).toFixed(1)}
               L${(x+barW).toFixed(1)},${(PAD.t+cH).toFixed(1)}
               L${x.toFixed(1)},${(PAD.t+cH).toFixed(1)} Z"
            fill="url(#${gradId})">
        <title>${labels[i]||"Day "+(i+1)}: ₱${v.toLocaleString("en-PH")}</title>
      </path>`;
  }).join("");

  svgEl.innerHTML = `${yTicksHtml}${barsHtml}${xLabelsHtml}`;
}

/* ============================================================
   CHART RESIZE
   Charts render to fixed pixel geometry measured from the SVG's
   own width, so they go stale whenever that width changes —
   collapsing the sidebar, or resizing the window. Each render
   registers its redraw function here and one shared observer
   replays it on the next frame after a size change.
   ============================================================ */
let _chartResizeObserver = null;
function observeChart(svgEl, redraw){
  if(!svgEl || typeof ResizeObserver === "undefined") return;
  svgEl.__redraw = redraw;
  if(!_chartResizeObserver){
    let timer = 0;
    _chartResizeObserver = new ResizeObserver(entries=>{
      /* Debounced on a timer rather than rAF — rAF callbacks don't run in
         a backgrounded/non-compositing tab, which would leave the chart
         stale at its old width. */
      clearTimeout(timer);
      const targets = entries.map(e=>e.target);
      timer = setTimeout(()=>{
        targets.forEach(t=>{ if(typeof t.__redraw === "function") t.__redraw(); });
      }, 60);
    });
  }
  _chartResizeObserver.observe(svgEl);
}

/* Redraw every registered chart at its current width. */
function redrawCharts(){
  ["#sparkline-sales", "#sparkline-sales-report"].forEach(sel=>{
    const el = $(sel);
    if(el && typeof el.__redraw === "function") el.__redraw();
  });
}

/* Window resizes change the content width too. */
let _winResizeTimer = 0;
window.addEventListener("resize", ()=>{
  clearTimeout(_winResizeTimer);
  _winResizeTimer = setTimeout(redrawCharts, 120);
});

/* ============================================================
   THEME TOGGLE
   ============================================================ */
/* #theme-btn opens the Light / Dark / System menu (assets/js/theme.js), which
   sets data-theme. Charts are drawn with theme colours, so they redraw. */
function initTheme(){
  window.addEventListener("eb-theme-change", e => {
    adminState.theme = e.detail.theme;
    if(typeof redrawCharts === "function") redrawCharts();
  });
}

/* ============================================================
   SESSION — server-backed
   ------------------------------------------------------------
   Was: read sessionStorage["eb-staff"] and trust whatever role
   string it held. Anyone could set that key by hand and walk into
   any portal, and the credentials it came from were shipped to
   every browser in a plaintext array.

   Now: ask api/auth/me.php. The PHP session cookie is httponly, so
   this is the only way the page can learn who is signed in, and the
   role is re-read from the database on every page load.
   ============================================================ */

/* ============================================================
   CATALOGUE LOADING
   ------------------------------------------------------------
   Replaces the PRODUCTS and CATEGORIES_DATA seed arrays with real
   rows. Called once after sign-in, before the first render.

   Mutates in place via length/push rather than reassigning, so that
   any code holding a reference to the original array — and there is
   plenty across pos.js, orders.js and inventory.js — sees the new
   data instead of quietly keeping the seed.
   ============================================================ */
async function loadCatalog(){
  try {
    /* Dates first, and awaited before anything renders: every screen with a
       range filter asks getDateRange() what "this week" means, and until
       system/dates.php has answered there is no authoritative answer. Fetched
       alongside the catalogue rather than before it — they are independent —
       but nothing is drawn until all three land.

       limit=200 covers the whole catalogue in one request; the real fix for
       larger catalogues is per-module server-side paging in Phase 5. */
    const [products, categories] = await Promise.all([
      EbApi.get("products/list.php",   { limit: 200, status: "all" }),
      EbApi.get("categories/list.php", { status: "all" }),
      loadServerDates(),
    ]);

    PRODUCTS.length = 0;
    products.data.forEach(p => PRODUCTS.push(p));

    CATEGORIES_DATA.length = 0;
    categories.data.forEach(c => CATEGORIES_DATA.push(c));

    /* Batches and the adjustment log are permission-gated server-side, and a
       Cashier holds neither inventory.report nor batches.manage. Asking anyway
       would earn a 403 and pop an error toast at every Cashier login for data
       that role's screens never show — so only fetch what this role may read. */
    if (EbRbac.canAny("inventory.report", "batches.manage", "inventory.manage")) {
      await loadInventoryData();
    }
    await loadOrders();
    await loadAdminData();
    await loadOpsData();

    /* The notification feed is part database rows and part alerts derived
       from the records just loaded. Its derived half is cached on first read,
       and the first read happens at sign-in — before any of this. Clearing it
       here is what makes a Cashier's overdue-payment alerts and an Inventory
       user's expiry alerts appear at all. */
    if(typeof refreshDerivedNotifications === "function") refreshDerivedNotifications();

    return true;
  } catch(err){
    /* Loud, not silent. A screen showing seed data while the operator
       believes it is live is worse than a visible failure. */
    console.error("[catalog]", err);
    toast("Could not load the product catalogue: " + err.message, "err");
    return false;
  }
}

/* Admin tables: employees, customers, audit log, and the role matrix.
   Each is permission-gated separately, because the roles that can see one
   frequently cannot see another — an Inventory Staff member holds audit.view
   but not users.manage. */
/* Operational data: returns, notifications, payment accounts, B2B
   applications and landing-page content. Each is gated by its own permission,
   so a role only fetches what its screens actually show. */
async function loadOpsData(){
  const jobs = [];

  /* The bell is in the shared shell, so every role loads notifications. */
  jobs.push(EbApi.get("notifications/list.php", { limit: 100 }).then(r => {
    NOTIFICATIONS.length = 0;
    r.data.forEach(n => NOTIFICATIONS.push(n));
    adminState.unreadNotifs = r.meta ? r.meta.unread : 0;
    /* Per-level unread counts, so the bell can say "something is on fire"
       separately from "three things happened" without recounting rows. */
    adminState.unreadByPriority = (r.meta && r.meta.unreadByPriority) || null;
    /* The type→level table comes FROM the server, from the same helper that
       stamps the stored rows. The portal derives some notifications in the
       browser (expiring batches, failed QA lots, retailer payment schemes)
       which have no row to carry a level; taking the table rather than
       keeping a copy is what stops those from drifting out of step with the
       ones the database orders. orders.js holds the same table as a hard
       fallback for the window before this resolves. */
    if(r.meta && r.meta.priorityMap && typeof NOTIF_PRIORITY_MAP !== "undefined"){
      NOTIF_PRIORITY_MAP = r.meta.priorityMap;
    }
  }));

  if(EbRbac.can("orders.returns")){
    jobs.push(EbApi.get("returns/list.php", { limit: 200 }).then(r => {
      RETURNS.length = 0;
      r.data.forEach(x => RETURNS.push(x));
    }));
  }

  /* Net-account payments, for every revenue figure computed in this browser
     (dashboard, Sales Report estimate and chart) — see receivedBetween(). */
  if(EbRbac.canAny("sales.report", "payments.manage")){
    jobs.push(EbApi.get("payments/received.php").then(r => { CREDIT_RECEIPTS = r.data || []; }));
  }

  if(EbRbac.can("payments.manage")){
    jobs.push(EbApi.get("payments/list.php").then(r => {
      PAYMENT_ACCOUNTS.length = 0;
      r.data.forEach(x => PAYMENT_ACCOUNTS.push(x));
      /* The penalty rate is a stored setting now, not a number typed into the
         screen and lost on reload. */
      if(r.meta && r.meta.penaltyRate != null) adminState.penaltyRate = r.meta.penaltyRate;
      /* The rest of the meta, kept for the dashboard's Payment Schemes badge.
         Counted over EVERY account by payments/list.php rather than the page it
         returns, so "3 to review" means three in the whole book — a badge built
         from PAYMENT_ACCOUNTS would only ever count the first ten. */
      adminState.payMeta = r.meta || null;
    }));
  }

  if(EbRbac.can("b2b.review")){
    jobs.push(EbApi.get("b2b/list.php", { limit: 200 }).then(r => {
      B2B_APPLICATIONS.length = 0;
      r.data.forEach(x => B2B_APPLICATIONS.push(x));
    }));
  }

  if(EbRbac.can("landing.manage")){
    jobs.push(EbApi.get("content/get.php").then(r => {
      SITE_CONTENT.about   = r.data.about;
      SITE_CONTENT.vision  = r.data.vision;
      SITE_CONTENT.mission = r.data.mission;
      SITE_CONTENT.contact = r.data.contact;
      if(r.data.payment) SITE_CONTENT.payment = r.data.payment;
      SITE_CONTENT.faqs    = r.data.faqs;
      if(Array.isArray(r.data.hero) && r.data.hero.length) SITE_CONTENT.hero = r.data.hero;
      SITE_CONTENT.featured = r.data.featured || [];
    }));
  }

  try {
    await Promise.all(jobs);
    return true;
  } catch(err){
    console.error("[ops]", err);
    toast("Could not load operational data: " + err.message, "err");
    return false;
  }
}

async function loadAdminData(){
  const jobs = [];

  if(EbRbac.can("users.manage")){
    jobs.push(
      EbApi.get("users/list.php", { limit: 200, status: "all" }).then(r => {
        STAFF_ACCOUNTS.length = 0;
        r.data.forEach(u => STAFF_ACCOUNTS.push({
          id: u.id, name: u.name, email: u.email, avatar: u.avatar,
          status: u.status, role: u.role, roleId: u.role_id,
        }));
      }),
      EbApi.get("customers/list.php", { limit: 200 }).then(r => {
        CUSTOMERS.length = 0;
        r.data.forEach(c => CUSTOMERS.push(c));
      })
    );
  }

  if(EbRbac.can("audit.view")){
    jobs.push(EbApi.get("audit/list.php", { limit: 200 }).then(r => {
      AUDIT_LOG.length = 0;
      r.data.forEach(a => AUDIT_LOG.push({
        id: a.id, ts: a.ts, actor: a.actor, type: a.type, desc: a.desc,
        actorArchived: a.actorArchived,
      }));
    }));
  }

  if(EbRbac.can("rbac.manage")){
    jobs.push(EbApi.get("roles/list.php").then(r => {
      /* Rebuild the two structures the Roles screen renders from, so the
         matrix reflects role_permissions rather than the old constants. */
      /* The server's permission list is the authority: add any key this file
         does not know yet, so a permission added by a migration always gets a
         switch instead of being counted invisibly. */
      (r.data.permissions || []).forEach(p => {
        if(!PERMISSIONS[p.key]) PERMISSIONS[p.key] = { area: p.area, label: p.label, systemOnly: !!p.systemOnly };
      });
      Object.keys(ROLE_PERMISSIONS).forEach(k => delete ROLE_PERMISSIONS[k]);
      r.data.roles.forEach(role => {
        if(!role.isSystem) ROLE_PERMISSIONS[role.name] = role.permissions;
        ROLE_META[role.name] = { slug: role.slug, desc: role.desc || "" };
      });
      adminState.roleList = r.data.roles;
    }));
  }

  try {
    await Promise.all(jobs);
    return true;
  } catch(err){
    console.error("[admin]", err);
    toast("Could not load administration data: " + err.message, "err");
    return false;
  }
}

/* Orders. Separate loader so an order action can refresh just this, and so a
   role without orders access never asks for it.

   limit=500 pulls the whole ledger in one request, which is honest at this
   size (42 rows) and wrong at ten thousand. The real fix is per-screen
   server-side paging via EbPaginate — the Queue and History screens each want
   their own filtered page rather than a shared client-side array. Deferred
   deliberately, and noted so it is not mistaken for finished. */
async function loadOrders(){
  if(!EbRbac.canAny("orders.view", "transactions.view", "orders.accept", "orders.status")) return false;
  try {
    const { data } = await EbApi.get("orders/list.php", { limit: 500, sort: "newest" });
    ORDERS.length = 0;
    data.forEach(o => ORDERS.push(o));
    return true;
  } catch(err){
    console.error("[orders]", err);
    toast("Could not load orders: " + err.message, "err");
    return false;
  }
}

/* Batches + adjustment log. Separate from loadCatalog() so the inventory
   screens can refresh just this after a stock movement, without re-fetching
   the whole product catalogue. */
async function loadInventoryData(){
  try {
    const jobs = [EbApi.get("batches/list.php", { limit: 200, sort: "expiry" })];
    if (EbRbac.canAny("inventory.report", "inventory.manage")) {
      jobs.push(EbApi.get("inventory/adjustments.php", { limit: 200 }));
    }
    const [batches, adjustments] = await Promise.all(jobs);

    BATCHES.length = 0;
    batches.data.forEach(b => BATCHES.push(b));

    /* The server reports its own date with the batch list. Recording it means
       every "days left" figure in the UI is measured from the same clock that
       computed daysToExpiry, instead of the browser's timezone or a hardcoded
       constant. */
    if (batches.meta && batches.meta.today) adminState.serverToday = batches.meta.today;

    /* The lot code the next restock would be given. Prefilled into the restock
       and replenish forms so the operator sees what is about to be created
       instead of inventing one — and can still override it. Refreshed here,
       which runs after every stock movement, so the suggestion never lags the
       lots actually on record. */
    if (batches.meta && batches.meta.nextLotCode) adminState.nextLotCode = batches.meta.nextLotCode;

    if (adjustments) {
      ADJUSTMENTS.length = 0;
      adjustments.data.forEach(a => ADJUSTMENTS.push(a));
    }
    return true;
  } catch(err){
    console.error("[inventory]", err);
    toast("Could not load inventory data: " + err.message, "err");
    return false;
  }
}

/* Paint the signed-in identity into the shell. Shared by the session check
   and the login handler, which previously duplicated every line of it. */
function applySignedInUser(user){
  adminState.currentUser = user;

  const avatar = user.avatar || initials(user.name);
  $("#admin-app").classList.remove("hide");
  $("#sidebar-name").textContent      = user.name;
  $("#sidebar-role").textContent      = user.role;
  /* The header identity line. It used to read "Signed in as Super Admin" from a
     <small> inside the SIDEBAR brand — a role with no person attached, in a
     panel that collapses to an icon rail. Name and role now, in the topbar,
     written from the same `user` the dropdown below is written from. */
  $("#topbar-user-name").textContent  = user.name;
  $("#topbar-role-label").textContent = user.role;
  $("#sidebar-avatar").textContent    = avatar;
  $("#topbar-avatar").textContent     = avatar;
  /* The chip's accessible name. Its three text nodes are aria-hidden — a
     screen reader would otherwise read the name, the role and the avatar
     initials as three loose strings with nothing saying any of it opens a
     menu — so the whole sentence is written here, from the same `user` the
     visible text comes from. */
  const chip = $("#topbar-user-btn");
  if(chip){
    chip.setAttribute("aria-label", `User menu — ${user.name}, ${user.role}`);
    chip.title = `${user.name} · ${user.role}`;
  }
  $("#ud-name").textContent           = user.name;
  $("#ud-role").textContent           = user.role;

  applyRBAC();
  if(typeof initNotifBadge === "function") initNotifBadge();
}

/* The role this entry point accepts, declared on #portal-root. */
function portalRole(){
  const root = document.getElementById("portal-root");
  return (root && root.dataset.portalRole) || "";
}

/* True if a valid session was found and the app was revealed.
   Async now — callers must await it. */
async function checkSessionAuth(){
  try {
    const user = await EbSession.bootstrap();
    if(!user) return false;

    /* Valid credentials, wrong door: send them out to the landing page
       rather than showing a mostly-empty sidebar. The server enforces the
       same rule on login, so this is convenience, not the control. */
    const expected = portalRole();
    if(expected && user.role !== expected){
      window.location.href = PORTAL_BASE_PATH + "public/index.html";
      return false;
    }

    applySignedInUser(user);
    await loadCatalog();      /* real rows before anything renders */
    renderDashboard();
    return true;
  } catch(err){
    console.error("[session]", err);
    return false;
  }
}

/* ============================================================
   SIGN-IN
   ------------------------------------------------------------
   Staff sign in on the landing page only. The portal used to carry
   its own sign-in card as well — left over from testing — which
   flashed on screen while the session check ran. Now: signed in →
   the portal opens; not signed in → back to the landing page.
   ============================================================ */
const LANDING_URL = PORTAL_BASE_PATH + "public/index.html";

async function initLogin(){
  const ok = await checkSessionAuth();
  if(!ok) window.location.replace(LANDING_URL);
}

/* ============================================================
   SIDEBAR / NAVIGATION
   ============================================================ */

/* Modules that REMEMBER which tab you were on.
   ------------------------------------------------------------
   Each of these resolves its own default inside its render function, which is
   why the sidebar used to disagree with the screen: clicking the parent row
   calls navigate(mod, undefined), the render then opened the remembered tab —
   Restock, say — and the highlighter had been handed `undefined`, so it lit the
   parent and no sub-item at all. The panel and the sidebar disagreed from the
   first click.

   Resolving it HERE means one value drives the highlight and the render. Adding
   a module with a remembered tab means adding a line here; leaving it out only
   costs the memory, not the highlight. */
const TAB_MEMORY = {
  users:              () => adminState.userTabActive     || "customers",
  products:           () => adminState.productsTabActive || "catalog",
  "inventory-manage": () => adminState.invTab            || "overview",
};

/**
 * THE ONE SIDEBAR HIGHLIGHT RULE.
 *
 * This existed in three places and was wrong in two of them. navigate() had the
 * correct version; the Users and Products tab handlers each re-implemented it
 * inline and both dropped the parent line, so clicking a tab inside those
 * screens silently un-highlighted "User Management" / "Products". Inventory
 * Management had no copy at all, which is the reported bug: its pill row
 * switched the panel and left the sidebar pointing at whatever was clicked
 * last.
 *
 * Idempotent, so calling it from both navigate() and a render is safe — that
 * redundancy is deliberate: a render that owns its highlight cannot drift out
 * of sync with the panel it just drew.
 */
function syncNavHighlight(mod, tab){
  $$(".nav-item").forEach(btn => btn.classList.remove("active"));

  $$(".nav-item").forEach(btn => {
    if(btn.dataset.mod !== mod) return;
    /* The parent row (or a plain module) — no data-tab of its own. In icon-only
       sidebar mode this is the ONLY indicator there is, because .nav-item.sub
       is display:none there, so it must stay in the rule. */
    if(!btn.dataset.tab) btn.classList.add("active");
    /* The matching sub-item. */
    if(btn.dataset.tab === tab) btn.classList.add("active");
  });

  /* A highlight nobody can see is not a highlight.
     Two things hide nav items: `.nav-parent.collapsed + .nav-sub-list` and
     `.nav-group.collapsed .nav-item`. Arriving from a dashboard shortcut into a
     group the operator had collapsed would otherwise light a row inside a
     closed drawer. Both are reopened; the icon-only sidebar is NOT touched —
     that is a deliberate global state, and a navigation event has no business
     overriding it. */
  $$(".nav-item.active").forEach(btn => {
    btn.closest(".nav-group")?.classList.remove("collapsed");
    const parent = btn.closest(".nav-sub-list")?.previousElementSibling;
    if(parent?.classList.contains("nav-parent")) parent.classList.remove("collapsed");
  });
}

/* Passed as navigate()'s intent by the topbar Refresh: re-render in place
   WITHOUT enterModule(), so the screen's search, filters and page survive. */
const NAV_REFRESH = "__refresh";
function navigate(mod, tab, intent){
  /* deactivate all panels and nav items */
  /* permission guard — bounce to dashboard if this mod isn't granted
     (matters once permissions can change at runtime via Roles & Permissions) */
  if(MOD_PERM[mod] && !hasPerm(MOD_PERM[mod])){
    toast("You don't have access to that section.", "err");
    if(mod !== "dashboard") return navigate("dashboard");
  }

  $$(".mod-panel").forEach(p  => p.classList.remove("active"));

  adminState.currentModule = mod;
  const panel = $(`#mod-${mod}`);
  if(panel) panel.classList.add("active");

  /* ONE value drives both the highlight and the render. Passing `tab` to the
     highlighter and letting the render resolve its own default is what made the
     two disagree — see TAB_MEMORY above. */
  const activeTab = tab || TAB_MEMORY[mod]?.() || undefined;

  syncNavHighlight(mod, activeTab);

  /* Arriving resets the destination's filters, then applies whatever this
     particular navigation asked for. Both happen BEFORE the render, because
     the render is what reads them. */
  const isRefresh = intent === NAV_REFRESH;
  if(!isRefresh) enterModule(mod, intent);

  /* render the module */
  const renders = {
    dashboard:    renderDashboard,
    users:        ()=> renderUsers(activeTab),
    landing:      renderLanding,
    products:     ()=> renderProducts(activeTab),
    b2b:          renderB2B,
    inventory:    renderInventory,
    "inventory-manage": ()=> renderInventoryManage(activeTab),
    expiry:       renderExpiry,
    sales:        ()=> renderSales(adminState.salesRange),
    batches:      renderBatches,
    payments:     renderPayments,
    transactions: renderTransactions,
    audit:        renderAudit,
    roles:        renderRoles,
    pos:          renderPos,
    "pos-payment":   renderPayment,
    notifications: renderNotifications,
    profile:      renderProfile,
    "online-txns":    renderOnlineTxns,
    ordersqueue:   renderQueue,
    paymentverify: renderPaymentVerify,
    orderstatus:   renderOrderStatus,
    orderhistory:  renderHistory,
    receipts:      renderReceipts,
    returns:       renderReturns,
    /* loadReviews(), not renderReviews(): this screen holds no seed data and
       its rows are filtered SERVER-side by the active tab, so arriving at it
       has to fetch. Rendering first would flash the previous tab's rows. */
    reviews:       loadReviews,
    /* Fetches its own data on arrival — assets/js/portal/vat.js. */
    vat:           renderVat,
  };
  /* THE INTENT LIVES FOR ONE RENDER. Set immediately before, cleared in the
     finally immediately after, so a render that reads navIntent() sees it and
     nothing later can. The finally matters: a render that throws must not
     leave the intent standing for the next navigation to pick up. */
  NAV_INTENT = isRefresh ? null : (intent || null);
  try {
    if(renders[mod]) renders[mod]();
  } finally {
    NAV_INTENT = null;
  }

  /* mobile: close sidebar */
  if(window.innerWidth <= 900){
    $("#sidebar").classList.remove("open");
    $("#sidebar-overlay").classList.remove("show");
  }
  /* scroll to top */
  $("#main-content").scrollTo(0,0);
}

/* A SHORTCUT'S FILTER IS A ONE-SHOT INTENT, NOT STATE.

   THE BUG THIS REPLACES. The first version wrote the filter into adminState —
   `adminState.invOverviewLevel = "crit"` — and nothing ever cleared it. The
   Critical Stock card worked, and then Stock Overview stayed filtered to
   critical for the rest of the session: reached from the sidebar, from the tab
   pills, from anywhere, it showed a short list with no explanation. A value in
   adminState is durable by definition, and "open this screen showing critical
   items THIS TIME" is not a durable fact about the screen.

   HOW THE INTENT TRAVELS NOW. As a third argument to navigate(), parked in
   NAV_INTENT for exactly the duration of one render and cleared in a `finally`
   the moment that render returns. It cannot outlive the navigation that
   carried it, so there is no stored value for the next feature to find and
   reuse — which is how this bug would otherwise come back.

   AND ARRIVING WITHOUT AN INTENT RESETS. Consuming the intent is only half of
   it: a screen whose filter is still set from last time is the same bug by
   another route. Every entry below declares a `reset` that returns its screen
   to its default filters, and enterModule() runs it on every arrival before
   `apply` gets a look in. Re-renders WITHIN a screen — a filter change, a save
   — do not go through here and keep what the operator set. */
let NAV_INTENT = null;

/* Read one field of the current navigation's intent. Returns undefined when
   the screen was reached by any route that carried none. */
function navIntent(key){
  return NAV_INTENT ? NAV_INTENT[key] : undefined;
}

/* Per-destination: what "default" means, and what an intent may override.

   The knowledge of where each screen keeps its filter lives HERE, once, beside
   the convention that uses it — not scattered across the click handlers. A
   screen that grows a new filter control changes one entry. */
const NAV_ENTRY = {
  "inventory-manage": {
    reset(){
      adminState.invOverviewLevel = "all";
      adminState.invOverviewQuery = "";
      adminState.stockOvwPager.page = 1;
    },
    apply(intent){
      if(!intent.level) return;
      adminState.invTab = "overview";
      adminState.invOverviewLevel = intent.level;
    },
  },
  inventory: {
    /* The Inventory Report's select is static markup that renderInventory()
       reads at query time, so the value lives on the element and the reset has
       to write the element too. */
    reset(){
      const el = $("#filter-inventory");
      if(el && el.value !== "all"){
        el.value = "all";
        if(window.EbSelect) EbSelect.sync(el);
      }
      adminState.invReportPager.page = 1;
    },
    apply(intent){
      if(!intent.level) return;
      const el = $("#filter-inventory");
      if(el) el.value = intent.level;
      /* EbSelect draws the trigger label from the native select. A bare
         `.value =` fires no change event, so without this the box would read
         "All Levels" over a list filtered to Critical — the filter applied and
         the control denying it, the exact confusion the shortcut exists to
         avoid. */
      if(window.EbSelect) EbSelect.sync(el);
    },
  },
  sales: {
    /* The report opens on its own default range unless told otherwise. */
    reset(){ adminState.salesRange = "today"; },
    apply(intent){ if(intent.range) adminState.salesRange = intent.range; },
  },
  users: {
    reset(){
      const el = $("#filter-customers");
      if(el && el.value !== "all"){
        el.value = "all";
        if(window.EbSelect) EbSelect.sync(el);
      }
      if(adminState.custPager) adminState.custPager.page = 1;
    },
    apply(intent){
      if(!intent.status) return;
      const el = $("#filter-customers");
      if(el) el.value = intent.status;
      if(window.EbSelect) EbSelect.sync(el);
    },
  },
};

/* Run on every arrival at a module, from navigate() and from nowhere else. */
function enterModule(mod, intent){
  const entry = NAV_ENTRY[mod];
  if(!entry) return;
  entry.reset();
  if(intent) entry.apply(intent);
}

/* Cross-links inside a panel — "View All" on the dashboard, "Back" on the POS
   payment screen, the dashboard's Critical Stock card. These were
   `onclick="navigate('sales')"` in the markup, which the brief rules out and
   which only worked because navigate() happened to be a global; the moment
   engine.js becomes a module they break silently, with no reference for a
   linter or a grep to find.

   Takes a root and is idempotent, because not every [data-goto] exists at
   startup: renderDashboard() rebuilds its stat cards on every visit to the
   dashboard, so it re-wires its own subtree and the flag stops a card that
   survived a render from collecting a second listener. */
function wireGoto(root = document){
  $$("[data-goto]", root).forEach(btn=>{
    if(btn.dataset.gotoWired) return;
    btn.dataset.gotoWired = "1";
    btn.addEventListener("click", ()=>{
      /* The markup declares the intent; navigate() carries it for one render.
         data-filter-level / -range / -status map onto the keys NAV_ENTRY reads,
         so adding a filtered shortcut is an attribute, not a code change. */
      const intent = {};
      if(btn.dataset.filterLevel)  intent.level  = btn.dataset.filterLevel;
      if(btn.dataset.filterRange)  intent.range  = btn.dataset.filterRange;
      if(btn.dataset.filterStatus) intent.status = btn.dataset.filterStatus;
      navigate(btn.dataset.goto, btn.dataset.tab,
               Object.keys(intent).length ? intent : undefined);
    });
  });
}

function initSidebar(){
  $$(".nav-item").forEach(btn=>{
    btn.title = btn.textContent.trim();
    /* .nav-parent is a .nav-item too and carries BOTH behaviours — navigate and
       open/close its drawer. Bound once, below, rather than twice here: the two
       handlers now have to agree about the collapsed state, and two listeners
       racing in registration order cannot. */
    if(btn.classList.contains("nav-parent")) return;
    btn.addEventListener("click", ()=> navigate(btn.dataset.mod, btn.dataset.tab));
  });
  $$(".dash-shortcut-btn[data-mod]").forEach(btn=>{
    btn.addEventListener("click", ()=> navigate(btn.dataset.mod, btn.dataset.tab));
  });

  /* Filter inputs that reset paging and re-render their screen.

     These were eight inline handlers in the markup, each a small program:
         oninput="adminState.ordHistoryPager.page=1;renderHistory()"
     The brief rules out inline handlers, and they carried two further problems.
     They depended on `adminState` and every render function being globals, so
     they break silently the moment engine.js becomes a module — with no
     reference a grep or a linter can find. And forgetting the `page=1` reset
     (three of the eight nearly did) leaves you on page 4 of a filtered set that
     now has one page, looking at an empty table.

     The markup now carries data-refilters="<screen>" and the pairing lives
     here, in one place, checked once at startup. */
  const FILTER_SCREENS = {
    onlineTxns:  { pager: "onlineTxnPager",    render: () => renderOnlineTxns() },
    history:     { pager: "ordHistoryPager",   render: () => renderHistory() },
    orderStatus: { pager: "orderStatusPager",  render: () => renderOrderStatus() },
    receipts:    { pager: "receiptsPager",     render: () => renderReceipts() },
    returns:     { pager: null,                render: () => renderReturns() },
  };

  $$("[data-refilters]").forEach(el=>{
    const key = el.dataset.refilters;
    const screen = FILTER_SCREENS[key];
    if(!screen){
      /* Loud rather than silent: a typo in the attribute used to mean the
         filter simply did nothing, which reads as "search is broken". */
      console.error("[filters] unknown data-refilters value:", key, el);
      return;
    }
    const evt = el.tagName === "SELECT" || el.type === "date" ? "change" : "input";
    el.addEventListener(evt, ()=>{
      if(screen.pager && adminState[screen.pager]) adminState[screen.pager].page = 1;
      screen.render();
    });
  });

  wireGoto();

  const hamburger = $("#topbar-hamburger");
  const sidebar   = $("#sidebar");
  const overlay   = $("#sidebar-overlay");

  hamburger.addEventListener("click", ()=>{
    if (window.innerWidth <= 860) {
      const open = sidebar.classList.toggle("open");
      overlay.classList.toggle("show", open);
    } else {
      $("#admin-app").classList.toggle("sidebar-collapsed");
      /* Collapsing changes the content width, so any chart drawn to fixed
         pixel geometry has to be redrawn. Done explicitly here rather than
         relying solely on the ResizeObserver, whose callbacks need a
         rendering frame the browser may not produce. */
      redrawCharts();
    }
  });
  overlay.addEventListener("click", ()=>{
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
  });

  $("#sidebar-logout").addEventListener("click", logout);

  $$(".nav-group-label").forEach(label => {
    label.addEventListener("click", () => {
      label.closest(".nav-group").classList.toggle("collapsed");
    });
  });

  /* The parent row carried TWO listeners — navigate (as a .nav-item) and a bare
     `classList.toggle("collapsed")` — which only worked while nothing else
     touched `collapsed`. Now that syncNavHighlight() expands a drawer holding
     the newly active item, and navigate() lights this module's remembered
     sub-item, the toggle ran afterwards and inverted the wrong state: a
     collapsed parent was expanded by the highlighter and instantly re-collapsed,
     so its drawer could never be opened from its own row at all.

     Split by WHERE the click lands, in one handler:

       the chevron  → collapse/expand only, no navigation. That is what a
                      chevron means, and it is the only gesture whose sole
                      purpose is the drawer.
       anywhere else → navigate, and leave the drawer OPEN.

     The row no longer toggles closed, deliberately. It navigates to the
     module's remembered tab, so closing the drawer on that same click would
     hide the sub-item it had just highlighted — the exact fault Task 4 is
     about, re-introduced by the row that caused it. Collapsing is still
     available on the chevron, and on the group label for the whole section. */
  $$(".nav-parent").forEach(btn => {
    btn.addEventListener("click", e => {
      if(e.target.closest(".nav-chevron")){
        btn.classList.toggle("collapsed");
        return;
      }
      navigate(btn.dataset.mod, btn.dataset.tab);
    });
  });
}

function initUserDropdown() {
  const userWrap = $("#topbar-user");
  const trigger  = $("#topbar-user-btn");

  /* aria-expanded has to move with the class or the menu is open for sighted
     users and closed for everybody else. One setter so the two cannot part. */
  const setOpen = open => {
    userWrap.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  trigger.addEventListener("click", e => {
    e.stopPropagation();
    setOpen(!userWrap.classList.contains("open"));
  });

  document.addEventListener("click", () => setOpen(false));

  /* Escape closes and RETURNS FOCUS to the trigger. Neither existed: the menu
     could only be dismissed by clicking elsewhere, and a keyboard user who
     opened it had no way back out — focus stayed wherever it was while the
     panel silently vanished under a click they had no reason to make. */
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !userWrap.classList.contains("open")) return;
    setOpen(false);
    trigger.focus();
  });

  $("#ud-profile")?.addEventListener("click", () => {
    setOpen(false);
    navigate("profile");
  });
  $("#ud-logout").addEventListener("click", logout);
}

function logout(){
  openModal({
    title: "Sign Out",
    body: "<p>Sign out of the Admin Dashboard?</p>",
    confirmLabel: "Sign Out",
    confirmClass: "btn-red",
    onConfirm: async ()=>{
      closeModal();
      adminState.currentUser = null;
      /* Destroy the server session too. Clearing local state alone would
         leave the session cookie valid — the next visit to any portal URL
         would silently sign straight back in. */
      try { await EbSession.logout(); } catch(_){}
      window.location.href = PORTAL_BASE_PATH + "public/index.html";
    }
  });
}

/* ============================================================
   MODULE: DASHBOARD
   ============================================================ */

/* THE DASHBOARD TILES ARE CONTROLS, NOT READOUTS.

   An administrator who reads "3 critical" wants the three products; one who
   reads a revenue figure wants the report behind it. Every tile now opens the
   screen its number came from, and two of them arrive with a filter already
   applied.

   ONE BUILDER, FOUR TILES. Critical Stock was written first and the other
   three were about to be copies of it — which is how four rules that agree
   today stop agreeing later. The routing, the permission rule, the markup and
   the aria labelling live here once; each tile below supplies only what
   differs.

   WHERE IT GOES DEPENDS ON WHAT THE ROLE HOLDS. navigate()'s permission guard
   would bounce a Cashier straight back to the dashboard with an error toast,
   so a tile whose destination they cannot open is rendered as a PLAIN DIV —
   visible, still telling them the number, simply not clickable. Offering a
   control that is guaranteed to fail is worse than offering none.

   `data-perm` is ALSO stamped on the button, even though the conditional
   render above already handles it. It is not redundant belt-and-braces: it
   declares the requirement where a reader of the markup will look for it, and
   it keeps the control correct if applyRBAC() re-runs after a live permission
   change without a dashboard re-render.

   A FILTERED TILE CARRIES A ONE-SHOT INTENT, never durable state — see
   NAV_ENTRY. Today's Sales sets the report range for that arrival only, and
   the retailer sub-line filters Customer Accounts the same way; open either
   screen by any other route afterwards and it is back to its default.

   TWO BUTTONS, NOT A BUTTON INSIDE A BUTTON. The face and the sub-line are
   separate targets going to different places, and nesting one interactive
   element inside another is invalid and unreachable by keyboard. They are
   siblings inside the card, so both tab-stop and both announce their own
   destination. */
function statCard(o){
  const style = `style="--accent-color:${o.accent};--accent-bg:${o.accentBg}"`;
  const face  = `<div class="stat-icon">${o.icon}</div>
      <div class="stat-label">${o.label}</div>
      <div class="stat-value">${o.value}</div>`;
  const delta = o.delta || "";

  /* Turn an intent object into the data-filter-* attributes wireGoto reads. */
  const attrs = link => {
    if(!link) return "";
    let a = `data-goto="${link.mod}"`;
    if(link.tab)  a += ` data-tab="${link.tab}"`;
    if(link.perm) a += ` data-perm="${link.perm}"`;
    const it = link.intent || {};
    if(it.level)  a += ` data-filter-level="${it.level}"`;
    if(it.range)  a += ` data-filter-range="${it.range}"`;
    if(it.status) a += ` data-filter-status="${it.status}"`;
    return a;
  };

  const faceLink = o.link && hasPerm(o.link.perm) ? o.link : null;
  const subLink  = o.subLink && hasPerm(o.subLink.perm) ? o.subLink : null;

  const faceHtml = faceLink
    ? `<button type="button" class="stat-card-face" ${attrs(faceLink)}
              aria-label="${escHtml(faceLink.aria)}">${face}</button>`
    : face;

  const subHtml = o.sub === undefined ? "" : (subLink
    ? `<button type="button" class="stat-sub stat-sub-link" ${attrs(subLink)}
              aria-label="${escHtml(subLink.aria)}">${o.sub}</button>`
    : `<div class="stat-sub">${o.sub}</div>`);

  const linked = (faceLink || subLink) ? " stat-card-linked" : "";
  return `<div class="stat-card${linked}" ${style}>${faceHtml}${subHtml}${delta}</div>`;
}

/* WHO GETS THE INVENTORY DASHBOARD.

   THE RULE:  (inventory.report OR inventory.manage)  AND NOT sales.report

   By permission, never by role name. Roles are editable from Roles &
   Permissions — they can be renamed, have permissions taken away, and be
   created from scratch — so `role === "Inventory Staff"` would be a dashboard
   that breaks the first time somebody makes a second stock role or renames the
   one that exists. The same objection applies to a hardcoded list of role
   names, which is the same thing spelled longer.

   Read it as: this person's job is stock, and revenue is not their screen. The
   management dashboard leads with Total Revenue, Today's Sales and Recent
   Transactions, all of which sit behind sales.report — someone without it gets
   a page whose headline figures are either hidden or un-openable.

   The NOT is what keeps Super Admin, Admin and anyone else who holds both from
   losing the revenue view: holding sales.report means the money IS their
   screen, whatever else they also hold. */
function isInventoryDashboard(){
  return (hasPerm("inventory.report") || hasPerm("inventory.manage")) && !hasPerm("sales.report");
}

/* The notification types that are an inventory matter. Keyed to the type, not
   to the permission: visibleNotifications() has already dropped anything this
   user may not see, but "may see" is a wider set than "is their job" —
   Inventory Staff holds audit.view, and an audit entry is not a stock alert.
   Same vocabulary as NOTIF_PERM in orders.js. */
const INVENTORY_NOTIF_TYPES = ["inventory", "expiry", "batch-qa"];

function renderDashboard(){
  /* Which of the two dashboards this is. Decided once, here, and every panel
     below follows it — so there is one answer on the page rather than four
     independent ones that can disagree. */
  const invView = isInventoryDashboard();
  const showPanel = (sel, on) => { const el = $(sel); if(el) el.classList.toggle("hide", !on); };
  showPanel("#dash-sales-panel",  !invView);
  showPanel("#dash-recent-panel", !invView);
  showPanel("#dash-rank-panel",    invView);
  /* The grid needs to know too. Hiding the sales panel takes the left column's
     height with it, and the two list heights in portal.css are tuned to the
     column heights of the version that HAS it — see .notif-list there. */
  $(".dash-grid")?.classList.toggle("dash-grid--inventory", invView);
  const stockTitle = $("#dash-stock-title");
  if(stockTitle) stockTitle.textContent = invView ? "Stock Overview" : "Stock Levels";

  /* ── welcome banner ── */
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const user = adminState.currentUser;
  const firstName = user ? user.name.split(" ")[0] : "Admin";
  const greetEl = $("#dash-greeting");
  if(greetEl) greetEl.textContent = `${greeting}, ${firstName}`;
  const dateEl = $("#dash-date");
  if(dateEl) dateEl.textContent = now.toLocaleDateString("en-PH",{weekday:"long",year:"numeric",month:"long",day:"numeric"});

  /* ── Payment Schemes shortcut ──
     The badge says why to go, not that the button exists. Payments waiting to
     be checked outrank overdue accounts: one is work sitting in a queue, the
     other is already known and chased. Empty when there is neither, and the
     CSS hides an empty badge rather than showing a reassuring blank pill. */
  const payBadge = $("#dash-pay-badge");
  if(payBadge){
    const m       = adminState.payMeta;
    const review  = m ? +m.reviewCount  || 0 : 0;
    const overdue = m ? +m.overdueCount || 0 : 0;
    payBadge.textContent = review  ? `${review} to review`
                         : overdue ? `${overdue} overdue`
                         : "";
    payBadge.classList.toggle("is-alert", review > 0 || overdue > 0);
  }

  /* ── deltas ── */
  const todayStr       = dAgo(0);
  const thisMonthStart = todayStr.slice(0,7)+"-01";
  const lmEnd          = addDays(thisMonthStart, -1);
  const lmStart        = lmEnd.slice(0,7)+"-01";

  const totalSales     = sumRevenue(ORDERS) + receivedBetween(null, null);
  const todayTx        = ORDERS.filter(tx=>tx.date===todayStr);
  const todaySales     = sumRevenue(todayTx) + receivedBetween(todayStr, todayStr);
  const yesterdaySales = sumRevenue(ORDERS.filter(tx=>tx.date===dAgo(1))) + receivedBetween(dAgo(1), dAgo(1));
  const thisMonthRev   = sumRevenue(ORDERS.filter(tx=>tx.date>=thisMonthStart&&tx.date<=todayStr)) + receivedBetween(thisMonthStart, todayStr);
  const lastMonthRev   = sumRevenue(ORDERS.filter(tx=>tx.date>=lmStart&&tx.date<=lmEnd)) + receivedBetween(lmStart, lmEnd);
  /* THE SERVER'S BAND, NOT A PIECE COUNT.

     This card is labelled "Critical Stock" and its button opens the Inventory
     Report filtered to Critical — but it counted `stock <= 10`, the fixed floor
     the measured model replaced. The two answers disagreed by design: a fast
     seller with 400 jars and nine days of cover is Critical on the report and
     was invisible here, while a product with eight jars and three years of
     cover was counted here and is Safe there. A card that disagrees with the
     screen it links to is worse than no card.

     PRODUCTS is loaded on the stored default window (see STOCK_WINDOWS), so
     this matches the Inventory Report whenever its own toggle is on Default. */
  const bandOf         = p => (p.inventory && p.inventory.level) || stockInfo(p).level;
  const liveProducts   = PRODUCTS.filter(p=>!p.archived);
  const lowStock       = liveProducts.filter(p=>bandOf(p)==="crit").length;
  const outStock       = liveProducts.filter(p=>bandOf(p)==="out").length;
  const activeCustomers= CUSTOMERS.filter(c=>c.status!=="archived").length;
  const retailers      = CUSTOMERS.filter(c=>c.status==="retailer").length;

  function deltaBadge(curr, prev, label="vs prev", lowerBetter=false){
    if(!prev) return "";
    const pct = Math.round(((curr-prev)/prev)*100);
    const good = lowerBetter ? pct<=0 : pct>=0;
    const cls  = pct===0?"flat":good?"up":"down";
    const arrow= pct>0?"↑":pct<0?"↓":"→";
    return `<div class="stat-delta ${cls}">${arrow} ${Math.abs(pct)}% ${label}</div>`;
  }

  /* Critical Stock routes by permission: Stock Overview can actually restock,
     the Inventory Report can only show. Neither held means no control at all. */
  const stockDest = hasPerm("inventory.manage")
    ? { mod: "inventory-manage", tab: "overview", perm: "inventory.manage" }
    : hasPerm("inventory.report")
      ? { mod: "inventory", tab: null, perm: "inventory.report" }
      : null;

  /* ── the inventory reader's four tiles ──────────────────────────────
     Critical Stock and Out of Stock are the same shortcuts the management
     dashboard carries: the same destination, chosen by the same permission,
     and the same ONE-SHOT intent — NAV_ENTRY resets the destination's filter on
     every arrival and applies the intent for that render only, so opening the
     Inventory Report from anywhere else afterwards finds it unfiltered. That is
     what stops a tile leaving its filter behind.

     Total Products and Total Stock on Hand are not filters, so they go to the
     same screen unfiltered rather than inventing a band for themselves. */
  if(invView){
    const warnStock  = liveProducts.filter(p=>bandOf(p)==="warn").length;
    const archived   = PRODUCTS.length - liveProducts.length;
    const totalStock = liveProducts.reduce((n,p)=> n + (+p.stock || 0), 0);

    $("#dash-stats").innerHTML = [
      statCard({
        accent: "var(--crit)", accentBg: "rgba(234,88,12,.1)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        label: "Critical Stock", value: lowStock,
        sub: `${warnStock} more at warning level`,
        link: stockDest && { ...stockDest, intent: { level: "crit" },
                aria: `Critical Stock: ${lowStock}. Show the products at critical stock level.` },
        subLink: stockDest && { ...stockDest, intent: { level: "warn" },
                aria: `${warnStock} more at warning level. Show the products at warning stock level.` },
      }),

      statCard({
        accent: "var(--info)", accentBg: "rgba(59,130,246,.1)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
        label: "Total Products", value: liveProducts.length,
        /* The archived line is a fact about the catalogue, not a shortcut: the
           Archive tab is its own screen with its own permission, and a tile
           that filtered to it would be offering a filter this screen has no
           state for. */
        sub: archived ? `${archived} archived` : "none archived",
        link: stockDest && { ...stockDest,
                aria: `Total Products: ${liveProducts.length}. Open the stock list.` },
      }),

      statCard({
        accent: "var(--ok-ink)", accentBg: "rgba(24,169,87,.12)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
        label: "Total Stock on Hand", value: totalStock.toLocaleString(),
        sub: `across ${liveProducts.length} product${liveProducts.length === 1 ? "" : "s"}`,
        link: stockDest && { ...stockDest,
                aria: `Total Stock on Hand: ${totalStock} units. Open the stock list.` },
      }),

      statCard({
        accent: "var(--out-ink)", accentBg: "rgba(220,38,38,.10)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
        label: "Out of Stock", value: outStock,
        sub: outStock ? "nothing on the shelf for these" : "every product has stock",
        link: stockDest && { ...stockDest, intent: { level: "out" },
                aria: `Out of Stock: ${outStock}. Show the products that are out of stock.` },
      }),
    ].join("");

    wireGoto($("#dash-stats"));
  } else {

    $("#dash-stats").innerHTML = [
      statCard({
        accent: "var(--gold-ink)", accentBg: "var(--gold-dim)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg>`,
        label: "Total Revenue", value: peso(totalSales),
        sub: `${ORDERS.length} total transactions`,
        delta: deltaBadge(thisMonthRev, lastMonthRev, "vs last month"),
        link: { mod: "sales", perm: "sales.report",
                aria: `Total Revenue: ${peso(totalSales)}. Open the Sales Report.` },
      }),

      statCard({
        accent: "var(--ok-ink)", accentBg: "rgba(24,169,87,.12)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
        label: "Today's Sales", value: peso(todaySales),
        sub: `<span class="stat-trend up">\u2191 ${todayTx.length} orders</span>`,
        delta: deltaBadge(todaySales, yesterdaySales, "vs yesterday"),
        /* The range is a one-shot: the report opens on Today this time and
           returns to its own default on any later visit. */
        link: { mod: "sales", perm: "sales.report", intent: { range: "today" },
                aria: `Today's Sales: ${peso(todaySales)}. Open the Sales Report for today.` },
      }),

      statCard({
        accent: "var(--crit)", accentBg: "rgba(234,88,12,.1)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        label: "Critical Stock", value: lowStock,
        sub: `${outStock} product(s) out of stock`,
        link: stockDest && { ...stockDest, intent: { level: "crit" },
                aria: `Critical Stock: ${lowStock}. Show the products at critical stock level.` },
        subLink: stockDest && { ...stockDest, intent: { level: "out" },
                aria: `${outStock} product(s) out of stock. Show the products that are out of stock.` },
      }),

      statCard({
        accent: "var(--info)", accentBg: "rgba(59,130,246,.1)",
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
        label: "Customers", value: activeCustomers,
        sub: `${retailers} retailer(s)`,
        link: { mod: "users", tab: "customers", perm: "users.manage",
                aria: `Customers: ${activeCustomers}. Open Customer Accounts.` },
        /* The sub-line names retailers specifically, so it filters to them —
           again as a one-shot, so the tab is unfiltered by any other route. */
        subLink: { mod: "users", tab: "customers", perm: "users.manage",
                intent: { status: "retailer" },
                aria: `${retailers} retailer(s). Show retailer accounts.` },
      }),
    ].join("");

    /* The cards are rebuilt on every visit, so their listeners are too. */
    wireGoto($("#dash-stats"));
  }

  /* sparkline — daily sales for past 7 days.
     Skipped entirely on the inventory dashboard: its panel is hidden, the
     figures are revenue, and drawing into a hidden SVG is work done to be
     looked at by nobody. */
  if(!invView){
    const days = [];
    const labels = [];
    for(let i=6;i>=0;i--){
      const d = dAgo(i);
      const total = sumRevenue(ORDERS.filter(tx=>tx.date===d)) + receivedBetween(d, d);
      days.push(total);
      labels.push(new Date(d+"T00:00:00").toLocaleDateString("en-PH",{weekday:"short"}));
    }
    const weekTotal = days.reduce((a,b)=>a+b,0);
    const weekEl = $("#dash-week-total");
    if(weekEl) weekEl.textContent = peso(weekTotal);

    if(!adminState.chartType) adminState.chartType = "line";

    const redrawDashChart = () => {
      const svgEl = $("#sparkline-sales");
      const type = adminState.chartType;
      if(type === "bar")   drawBarChart(svgEl, days, { labels, color:"var(--gold)" });
      else if(type==="area") drawSparkline(svgEl, days, { labels, color:"var(--gold)", smooth:true, lineWidth:2 });
      else                 drawSparkline(svgEl, days, { labels, color:"var(--gold)" });
    };

    requestAnimationFrame(redrawDashChart);
    observeChart($("#sparkline-sales"), redrawDashChart);

    /* wire chart toggle */
    $$("[data-chart]").forEach(btn=>{
      btn.classList.toggle("active", btn.dataset.chart === adminState.chartType);
      btn.onclick = ()=>{
        adminState.chartType = btn.dataset.chart;
        $$("[data-chart]").forEach(b=> b.classList.toggle("active", b.dataset.chart===adminState.chartType));
        requestAnimationFrame(redrawDashChart);
      };
    });
  }

  /* stock bars */
  const stockEl = $("#dash-stock-bars");
  const products = PRODUCTS.filter(p=>!p.archived);
  const maxStk   = Math.max(...products.map(p=>p.stock), 1);
  stockEl.innerHTML = products.map((p,i)=>{
    const si = stockInfo(p);
    const gradients = {
      ok:   "linear-gradient(90deg,#15803d,#22c55e)",
      warn: "linear-gradient(90deg,#a16207,#eab308)",
      crit: "linear-gradient(90deg,#b91c1c,#ef4444)",
      out:  "linear-gradient(90deg,#7f1d1d,#ef4444)"
    };
    /* Inline styles beat any stylesheet rule, so these have to be accessible
       at source. Each is the original hue darkened to clear 4.5:1 on cream. */
    const valColors = { ok:"#16803d", warn:"#8c6b05", crit:"#cb3a3a", out:"#cb3a3a" };
    const badge = si.level==="out"  ? `<span class="stock-badge out">Out</span>`
                : si.level==="crit" ? `<span class="stock-badge low">Low</span>`
                : si.level==="warn" ? `<span class="stock-badge warn">Warn</span>`
                : "";
    const pct = Math.max((p.stock/maxStk)*100, 2);
    return `<div class="stock-row">
      <span class="stock-row-rank">${i+1}</span>
      <span class="stock-row-name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
      <div class="stock-bar-wrap"><div class="stock-bar-fill" style="width:${pct}%;background:${gradients[si.level]}"></div></div>
      <div class="stock-row-right">
        <span class="stock-row-val" style="color:${valColors[si.level]}">${p.stock}</span>
        ${badge}
      </div>
    </div>`;
  }).join("");

  /* ── System Notifications ──────────────────────────────────────────
     THIS PANEL USED TO INVENT ITS OWN FEED.

     It rebuilt a list here from PRODUCTS and PAYMENT_ACCOUNTS with its own
     stock thresholds (`stock <= 10`, hardcoded), its own colour vocabulary
     (dot: "red" / "crit" / "gold" / "ok"), its own ordering, and two rows
     that were simply invented — "Monthly sales report ready for review"
     and "All employee accounts verified" were printed unconditionally and
     were true of nothing. It shared not one line with the bell above it or
     the Notifications module, so the same event could appear in three
     places with three different wordings and three different urgencies, or
     in one and not the others. REMEDIATION.md is largely a catalogue of
     this exact failure elsewhere in the codebase.

     It now reads the same rows, through the same permission scope, in the
     same order, with the same level labels as the bell and the module. */
  /* ON THE INVENTORY DASHBOARD, INVENTORY MATTERS ONLY.

     visibleNotifications() has already dropped everything this user has no
     permission to see, and that is not the same filter. Inventory Staff holds
     audit.view, so the audit feed reached this panel — a list headed "System
     Notifications" on a stock screen, carrying entries about who changed a
     price. The bell and the Notifications module keep the whole permitted feed;
     it is only this panel, on this dashboard, that narrows.

     THE COUNT NARROWS WITH IT. A badge counting rows the list does not show is
     the same defect as a badge counting rows nobody can act on. */
  const dashFeed = (typeof visibleNotifications === "function")
    ? visibleNotifications().filter(n => !invView || INVENTORY_NOTIF_TYPES.includes(n.type))
    : [];

  const dashNotifs = (typeof sortByUrgency === "function")
    ? sortByUrgency(dashFeed).slice(0, 8)
    : dashFeed.slice(0, 8);

  const dashUnread = dashFeed.filter(n=>!n.read).length;

  /* The unread count, not the total. The badge is red; a red badge reading
     "17" beside a list that is entirely handled history is an alarm about
     nothing. */
  const countEl = $("#dash-notif-count");
  if(countEl) countEl.textContent = dashUnread;

  const dashEl = $("#dash-notifs");
  if(dashEl){
    dashEl.innerHTML = dashNotifs.map(n=>{
      const level = notifPriority(n);
      return `<div class="notif-item level-${level} ${n.read ? "" : "unread"}">
      <div class="notif-text">
        <p>${escHtml(n.msg)}</p>
        <small>${notifLevelChip(n)}<span>${escHtml(fmtDateTime(n.time))}</span></small>
      </div>
    </div>`;
    }).join("") || `<div class="alert-empty"><strong>Nothing waiting</strong>You're all caught up.</div>`;
  }

  /* The topbar badge is NOT set here any more. initNotifBadge() in orders.js
     owns it, counts the same rows this panel shows, and knows how many of
     them are critical. This function used to write it too, from a different
     list, so the badge said one thing on the dashboard and another on every
     other screen. */
  if(typeof initNotifBadge === "function") initNotifBadge();

  /* Product Rankings replace Recent Transactions on the inventory dashboard. */
  if(invView){
    renderDashRankings();
    return;
  }

  /* recent transactions */
  const recentTx = [...ORDERS].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  const recentEl = $("#dash-recent-tx");
  if(recentEl) recentEl.innerHTML = recentTx.map(tx=>{
    const ttl = orderTotal(tx);
    return `<tr>
      <td class="mono">${escHtml(tx.id)}</td>
      <td>${escHtml(tx.customer)}</td>
      <td style="font-size:.8rem;color:var(--text-muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(txItemsSummary(tx.items))}</td>
      <td><strong>${peso(ttl)}</strong></td>
      <td><span class="badge ${methodBadgeClass(tx.method)}">${escHtml(tx.method)}</span></td>
      <td class="muted">${fmtDate(tx.date)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">No transactions yet.</td></tr>`;
}

/* PRODUCT RANKINGS — what sold most this week, beside what is left of it.

   ASKED OF THE SERVER, not summed from ORDERS. The browser holds the orders it
   has been given, which is every order at forty rows and a page of them the
   moment the list is paged — the same trap the Sales Report was pulled out of.
   api/reports/top-products.php aggregates in SQL, ranks by units through
   Revenue::productTotals (the method the Sales Report's Best Sellers uses, so
   the two cannot disagree about what sold), and resolves "this week" with
   Dates::range — Monday to today, which is what the Sales Report's week button
   means too.

   THE STOCK COLUMN IS THE MEASURED BAND, not a raw count. "142 units" answers
   nothing on its own: a fast seller with 142 and four days of cover is
   Critical, and the whole point of putting units sold next to stock is to see
   that. Same bands, same labels, same badges as the Inventory Report. */
function renderDashRankings(){
  const body = $("#dash-rankings");
  const note = $("#dash-rank-note");
  if(!body) return;

  const wholeRow = html =>
    `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">${html}</td></tr>`;

  body.innerHTML = wholeRow("Loading…");

  EbApi.get("reports/top-products.php", { range: "week", limit: 5 })
    .then(({ data, meta }) => {
      const r = meta && meta.range;
      if(note){
        note.textContent = r && r.from
          ? `by units sold · ${fmtDate(r.from)} – ${fmtDate(r.to)}`
          : "by units sold this week";
      }
      if(!data || !data.length){
        /* A period with nothing in it is a fact. An empty table with headers
           reads as a broken query — the same reason the Sales Report's own
           empty state says so in words. */
        body.innerHTML = wholeRow("Nothing has sold yet this week.");
        return;
      }
      body.innerHTML = data.map((p, i) => {
        const st = stockInfo({ inventory: { level: p.stockLevel, levelReason: null, daysCover: p.daysCover },
                               stock: p.stock });
        const why = p.daysCover === null || p.daysCover === undefined
          ? "" : ` title="About ${p.daysCover} day(s) of cover at the current rate."`;
        return `<tr>
          <td class="num-cell muted">${i + 1}</td>
          <td><strong>${escHtml(p.name)}</strong></td>
          <td class="num-cell">${(+p.units || 0).toLocaleString()}</td>
          <td class="num-cell">${(+p.stock || 0).toLocaleString()}</td>
          <td><span class="badge ${st.cls}"${why}>${escHtml(st.label)}</span></td>
        </tr>`;
      }).join("");
    })
    .catch(err => {
      if(note) note.textContent = "";
      body.innerHTML = wholeRow("Could not load the rankings: " + escHtml(err.message));
    });
}

/* ============================================================
   MODULE: USER MANAGEMENT
   ============================================================ */
function renderUsers(tab){
  const activeTab = tab || adminState.userTabActive;
  adminState.userTabActive = activeTab;

  /* In the render, not in the tab click handler, so the sidebar follows however
     this screen was reached — pill, sidebar, or a programmatic re-render after
     a save. The handler used to carry its own copy of the highlight rule which
     dropped the parent row, so switching to Employee Accounts from the pills
     un-highlighted "User Management". */
  syncNavHighlight("users", activeTab);

  /* Switch tab */
  $$("[data-user-tab]").forEach(btn=>{
    const isActive = btn.dataset.userTab === activeTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  $$(".tab-panel", $("#mod-users")).forEach(p=>{
    p.classList.toggle("active", p.id === `tab-${activeTab}`);
  });
  /* The filter set for this tab. It used to live INSIDE the panel, so switching
     panels switched it for free; it now sits in the merged toolbar row beside
     the tabs (see .view-toolbar in portal.css) and has to be told. Driven off
     the same activeTab as the panel above, on purpose — two sources for "which
     tab is open" is how a screen ends up showing one tab's table under the
     other tab's filters. */
  $$(".tab-filters", $("#mod-users")).forEach(f=>{
    f.classList.toggle("active", f.dataset.tabFilters === activeTab);
  });

  /* header action button */
  $("#users-header-actions").innerHTML = activeTab === "customers"
    ? `<button class="btn btn-gold" id="add-customer-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Add Customer</button>`
    : ``;

  if(activeTab === "customers") renderCustomers();
  else renderEmployees();

  /* tab click handlers.

     onclick, not addEventListener: this function re-runs on every tab switch,
     so addEventListener stacked another handler on the same button each time
     and one click ended up firing N renders. Assignment replaces. (Same shape
     inventory.js already uses for its pill row.)

     The highlight is no longer done here — renderUsers() owns it, above. */
  $$("[data-user-tab]").forEach(btn=>{
    btn.onclick = ()=> renderUsers(btn.dataset.userTab);
  });
  const addCust = $("#add-customer-btn");
  if(addCust) addCust.addEventListener("click", ()=> openAddCustomerModal());
  const addEmp = $("#add-employee-btn");
  if(addEmp) addEmp.addEventListener("click", ()=> openAddEmployeeModal());
}

/* Customers — server-paged. The row actions look their record up from the
   page that is currently loaded, so the lookup uses the fetched rows rather
   than a global array that no longer holds everything.

   ARCHIVE IS THE ONLY ACTION, DELIBERATELY.

   There was an Edit button here that opened a form over the customer's name,
   email and contact number. A customer record belongs to the customer: they
   maintain those three fields themselves through Profile, and every one of
   them is identity — an administrator who can change an email address can
   change where a password reset goes. The administrator's legitimate need is
   to close an account, which Archive does.

   Removing the button is presentation and would stop nobody on its own
   (api/core/Rbac.php says so in its header). api/customers/save.php now
   refuses identity changes on its update path, which is the part that
   actually enforces this.

   The Employee Accounts tab is untouched. A staff record is the employer's
   record of an employee, not a person's own account, and an administrator must
   still be able to correct one. */
function renderCustomers(){
  EbPaginate.list(
    "cust",
    adminState.custPager,
    () => $("#customers-tbody"),
    (page, limit) => EbApi.get("customers/list.php", {
      page, limit,
      search: $("#search-customers")?.value || null,
      status: ($("#filter-customers")?.value === "all" ? null : $("#filter-customers")?.value) || null,
      sort: $("#cust-sort")?.value || "name",
    }),
    c => `
    <tr class="${c.status==="archived"?"archived":""}">
      <td class="td-name">${escHtml(c.name)}</td>
      <td class="td-email">
        ${escHtml(c.email)}
        ${c.canSignIn ? "" : `<span class="chip-nosignin"
          title="No password is set, so this person cannot sign in. They set one by registering at the storefront with this email — that claims this record.">No sign-in</span>`}
      </td>
      <td>${escHtml(c.contact || "—")}</td>
      <td><span class="badge ${c.status==="active"?"badge-ok":c.status==="retailer"?"badge-info":"badge-muted"}">${c.status}</span></td>
      <td class="muted">${fmtDate(c.joined)}</td>
      <td>
        <div class="td-actions">
          ${c.status!=="archived" ? `
            <button class="btn btn-ghost-danger btn-sm" data-archive-cust="${c.id}">Archive</button>
          ` : `<span class="muted" style="font-size:.78rem">Archived</span>`}
        </div>
      </td>
    </tr>`,
    {
      colspan: 6,
      empty: { title: "No customers found", hint: "Adjust the search or status filter." },
      after: (rows) => {
        /* Keep the loaded page available to the modals, which need the full
           record rather than just what the row shows. */
        CUSTOMERS.length = 0; rows.forEach(r => CUSTOMERS.push(r));
        const tbody = $("#customers-tbody");
        tbody.querySelectorAll("[data-archive-cust]").forEach(btn=>{
          btn.addEventListener("click", ()=> archiveCustomer(btn.dataset.archiveCust));
        });
      },
    }
  );

  const reset = ()=>{ adminState.custPager.page = 1; renderCustomers(); };
  if($("#search-customers") && !$("#search-customers").dataset.wired){
    $("#search-customers").dataset.wired = "1";
    $("#search-customers").addEventListener("input", debounce(reset, 300));
  }
  if($("#cust-sort") && !$("#cust-sort").dataset.wired){
    $("#cust-sort").dataset.wired = "1";
    $("#cust-sort").addEventListener("change", reset);
  }
  if($("#filter-customers") && !$("#filter-customers").dataset.wired){
    $("#filter-customers").dataset.wired = "1";
    $("#filter-customers").addEventListener("change", reset);
  }
}

function openAddCustomerModal(){
  openModal({
    title: "Add Customer",
    body: `<div class="field"><label>Full Name</label><input class="control" id="m-cust-name" placeholder="e.g. Juan dela Cruz"/><span class="field-error" id="m-cust-name-err"></span></div>
           <div class="field"><label>Email</label><input class="control" type="email" id="m-cust-email" placeholder="email@example.com"/></div>
           <div class="field"><label>Contact Number</label><input class="control" id="m-cust-contact" placeholder="+63 9XX XXX XXXX"/></div>`,
    confirmLabel: "Add Customer",
    onConfirm: async ()=>{
      const name    = $("#m-cust-name").value.trim();
      const email   = $("#m-cust-email").value.trim();
      const contact = $("#m-cust-contact").value.trim();
      if(!name){ $("#m-cust-name-err").textContent="Name is required."; return; }
      /* No optimistic push. This used to add a locally-invented row carrying
         id "cus-<timestamp>" BEFORE the request, and the catch below returns
         without removing it — so a rejected save (a duplicate email answers
         409) left a customer in the list that did not exist and whose id no
         endpoint recognised. loadAdminData() below refreshes from the server,
         which is where the real id comes from anyway. */
      try {
        await EbApi.post("customers/save.php", {
          name, email: $("#m-cust-email").value.trim(),
          contact: $("#m-cust-contact").value.trim(), status: "active",
        });
        await loadAdminData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Customer added.", "ok");
      renderCustomers();
    }
  });
}

function archiveCustomer(id){
  const c = CUSTOMERS.find(x=>x.id===id);
  if(!c) return;
  openModal({
    title: "Archive Customer",
    body: `<p>Archive <strong>${escHtml(c.name)}</strong>? The account will be hidden but remain on record.</p>`,
    confirmLabel: "Archive",
    confirmClass: "btn-ghost-danger",
    onConfirm: async ()=>{
      /* D11: no local change before the server agrees. This set
         c.status = "archived" first, and the catch below returns without
         undoing it — so a refused archive left the row displaying a status the
         database did not hold. loadAdminData() refreshes from the server on
         success, which is where the new status should come from anyway.

         customers/archive.php, not customers/save.php. This used to post the
         entire record back — name, email and contact included — to change one
         field, which is the only reason save.php ever needed to accept those
         on an update. Sending identity fields to change a status was always
         the wrong shape; it is now also refused. */
      try {
        await EbApi.post("customers/archive.php", { id: c.id, archived: true });
        await loadAdminData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Customer archived.", "warn");
      renderCustomers();
    }
  });
}

/* Role hierarchy, top to bottom: Super Admin (warmest/most alarming —
   highest authority) → Admin → the three staff roles get their own
   distinct cool colors so they're each identifiable, but sit visually
   "lighter" than the two admin tiers above them. Was one flat blue for
   every role, which read as no hierarchy at all. */
function roleBadgeClass(role){
  return {
    "Super Admin":        "badge-out",
    "Admin":               "badge-crit",
    "Inventory Staff":     "badge-ok",
    "Cashier":              "badge-info",
    "Online Orders Staff": "badge-purple",
  }[role] || "badge-muted";
}

/* Employees — server-paged. Small today (six accounts), converted for the same
   reason as the rest: the screen should not behave differently at 6 and 600. */
function renderEmployees(){
  EbPaginate.list(
    "emp",
    adminState.empPager,
    () => $("#employees-tbody"),
    (page, limit) => EbApi.get("users/list.php", {
      page, limit, status: "all",
      search: $("#search-employees")?.value || null,
    }),
    e => `
    <tr class="${e.status==="archived"?"archived":""}">
      <td><div style="display:flex;align-items:center;gap:10px">
        <div style="width:30px;height:30px;border-radius:50%;background:var(--gold);color:#1E1A0E;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:700;flex-shrink:0">${escHtml(e.avatar || initials(e.name))}</div>
        <span class="td-name">${escHtml(e.name)}</span>
      </div></td>
      <td class="td-email">${escHtml(e.email)}</td>
      <td><span class="badge ${roleBadgeClass(e.role)}">${escHtml(e.role || "—")}</span></td>
      <td><span class="badge ${e.status==="active"?"badge-ok":"badge-muted"}">${e.status}</span></td>
      <td>
        <div class="td-actions">
          ${e.status!=="archived" ? `
            <button class="btn btn-ghost btn-sm" data-edit-emp="${e.id}">Edit</button>
            <button class="btn btn-ghost-danger btn-sm" data-archive-emp="${e.id}">Archive</button>
          ` : `<span class="muted" style="font-size:.78rem">Archived</span>`}
        </div>
      </td>
    </tr>`,
    {
      colspan: 5,
      empty: { title: "No employees found", hint: "Adjust the search." },
      after: (rows) => {
        STAFF_ACCOUNTS.length = 0;
        rows.forEach(r => STAFF_ACCOUNTS.push({ ...r, roleId: r.role_id }));
        const tbody = $("#employees-tbody");
        tbody.querySelectorAll("[data-edit-emp]").forEach(btn=>{
          btn.addEventListener("click", ()=> openEditEmployeeModal(STAFF_ACCOUNTS.find(e=>String(e.id) === btn.dataset.editEmp)));
        });
        tbody.querySelectorAll("[data-archive-emp]").forEach(btn=>{
          btn.addEventListener("click", ()=> archiveEmployee(btn.dataset.archiveEmp));
        });
      },
    }
  );

  if($("#search-employees") && !$("#search-employees").dataset.wired){
    $("#search-employees").dataset.wired = "1";
    $("#search-employees").addEventListener("input", debounce(()=>{
      adminState.empPager.page = 1; renderEmployees();
    }, 300));
  }
}

const ROLES = ["Super Admin","Admin","Inventory Staff","Cashier","Online Orders Staff"];

function openAddEmployeeModal(){
  openModal({
    title: "Add Employee",
    body: `<div class="field"><label>Full Name</label><input class="control" id="m-emp-name" placeholder="Full name"/><span class="field-error" id="m-emp-name-err"></span></div>
           <div class="field"><label>Email</label><input class="control" type="email" id="m-emp-email" placeholder="email@elishabay.ph"/></div>
           <div class="field"><label>Role</label><select class="control" id="m-emp-role">${ROLES.map(r=>`<option>${r}</option>`).join("")}</select></div>
           <div class="field"><label>Password</label><input class="control" type="password" id="m-emp-pw" placeholder="Temporary password"/></div>`,
    confirmLabel: "Add Employee",
    onConfirm: async ()=>{
      const name  = $("#m-emp-name").value.trim();
      const email = $("#m-emp-email").value.trim();
      const role  = $("#m-emp-role").value;
      const pw    = $("#m-emp-pw").value;
      if(!name){ $("#m-emp-name-err").textContent="Name required."; return; }
      const roleRow = (adminState.roleList || []).find(r => r.name === role);
      try {
        /* The password is sent once and hashed server-side. It was previously
           stored in this array in plaintext, in a file served to the browser. */
        await EbApi.post("users/save.php", {
          name, email, role_id: roleRow ? roleRow.id : null, password: pw,
        });
        await loadAdminData();
      } catch(err){
        if(err.isValidation && err.fields.name)     { $("#m-emp-name-err").textContent = err.fields.name; return; }
        if(err.isValidation && err.fields.password) { $("#m-emp-name-err").textContent = err.fields.password; return; }
        toast(err.message, "err");
        return;
      }
      closeModal();
      toast("Employee added.", "ok");
      renderEmployees();
    }
  });
}

function openEditEmployeeModal(e){
  if(!e) return;
  openModal({
    title: "Edit Employee",
    body: `<div class="field"><label>Full Name</label><input class="control" id="m-emp-name" value="${escHtml(e.name)}"/></div>
           <div class="field"><label>Email</label><input class="control" type="email" id="m-emp-email" value="${escHtml(e.email)}"/></div>
           <div class="field"><label>Role</label><select class="control" id="m-emp-role">${ROLES.map(r=>`<option ${r===e.role?"selected":""}>${r}</option>`).join("")}</select></div>`,
    confirmLabel: "Save Changes",
    onConfirm: async ()=>{
      const role = $("#m-emp-role").value;
      const roleRow = (adminState.roleList || []).find(r => r.name === role);
      try {
        await EbApi.post("users/save.php", {
          id: e.id,
          name:  $("#m-emp-name").value.trim() || e.name,
          email: $("#m-emp-email").value.trim() || e.email,
          role_id: roleRow ? roleRow.id : null,
        });
        await loadAdminData();
      } catch(err){
        /* The server refuses a self-role-change and an escalation attempt.
           Both messages are worth showing verbatim. */
        toast(err.message, "err");
        return;
      }
      closeModal();
      toast("Employee updated.", "ok");
      renderEmployees();
    }
  });
}

function archiveEmployee(id){
  const e = STAFF_ACCOUNTS.find(x=>x.id===id);
  if(!e) return;
  if(e.id === adminState.currentUser?.id){ toast("Cannot archive yourself.", "err"); return; }
  openModal({
    title: "Archive Employee",
    body: `<p>Archive <strong>${escHtml(e.name)}</strong>? They will no longer be able to log in.</p>`,
    confirmLabel: "Archive",
    confirmClass: "btn-ghost-danger",
    onConfirm: async ()=>{
      try {
        /* The server also refuses archiving yourself and archiving the last
           account that can manage permissions. */
        await EbApi.post("users/archive.php", { id: e.id, archived: true });
        await loadAdminData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Employee archived.", "warn");
      renderEmployees();
    }
  });
}

/* ============================================================
   MODULE: B2B RETAIL PARTNER APPLICATIONS
   ============================================================ */
function b2bStatusBadge(status){
  const MAP = {
    pending:  { cls:"badge-warn", label:"Pending Review" },
    approved: { cls:"badge-ok",   label:"Approved" },
    rejected: { cls:"badge-out",  label:"Rejected" },
  };
  const m = MAP[status] || MAP.pending;
  return `<span class="badge ${m.cls}">${m.label}</span>`;
}

/* Gold/Silver/Bronze each get their own color instead of sharing the
   flat badge-muted tan — otherwise "Silver Tier" and "Bronze Tier"
   were visually identical to each other and to unrelated muted text. */
function tierBadge(tier){
  const cls = { Gold:"badge-tier-gold", Silver:"badge-tier-silver", Bronze:"badge-tier-bronze" }[tier] || "badge-muted";
  return `<span class="badge ${cls}">${escHtml(tier)} Tier</span>`;
}
const TIER_RANK = { Gold: 3, Silver: 2, Bronze: 1 };

function getFilteredSortedB2B(){
  const q      = ($("#search-b2b")?.value || "").toLowerCase();
  const statFilt = $("#filter-b2b-status")?.value || "all";
  const sort   = adminState.b2bSort;

  let rows = B2B_APPLICATIONS.filter(a=>{
    const matchQ = !q ||
      a.appId.toLowerCase().includes(q) ||
      a.businessName.toLowerCase().includes(q) ||
      a.applicantName.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q);
    const matchStat = statFilt === "all" || a.status === statFilt;
    return matchQ && matchStat;
  });

  rows = [...rows].sort((a,b)=>{
    /* Gold/Silver/Bronze aren't alphabetical-meaningful — rank them by
       standing instead so "sort by tier" actually orders best-to-worst
       partner rather than B-before-G-before-S. */
    let av, bv;
    if(sort.col === "tier"){
      av = TIER_RANK[a.tier] || 0; bv = TIER_RANK[b.tier] || 0;
    } else {
      av = a[sort.col]; bv = b[sort.col];
    }
    if(av<bv) return sort.dir==="asc" ? -1 : 1;
    if(av>bv) return sort.dir==="asc" ? 1 : -1;
    return 0;
  });

  return rows;
}

function renderB2B(){
  const tbody = $("#b2b-tbody");
  const all = getFilteredSortedB2B();

  const pageSize = adminState.b2bPageSize;
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  if(adminState.b2bPage > totalPages) adminState.b2bPage = totalPages;
  const page = adminState.b2bPage;
  const start = (page-1)*pageSize;
  const pageRows = all.slice(start, start+pageSize);

  tbody.innerHTML = pageRows.map(a=>`
    <tr>
      <td class="mono">${escHtml(a.appId)}</td>
      <td class="td-name">${escHtml(a.businessName)}<br><span class="muted" style="font-size:.78rem;font-weight:500">${escHtml(a.applicantName)} · ${escHtml(a.businessType)}</span></td>
      <td>
        <div style="font-size:.82rem">${escHtml(a.email)}</div>
        <div class="muted" style="font-size:.78rem">${escHtml(a.phone)}</div>
      </td>
      <td>
        ${a.requestedTerms ? `<span class="badge badge-info">${escHtml(a.requestedTerms)}</span>` : ""}
        ${a.tier ? `<div style="margin-top:4px">${tierBadge(a.tier)}</div>` : ""}
      </td>
      <td>${b2bStatusBadge(a.status)}</td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-view-app="${a.id}">View</button>
        ${a.status==="pending" ? `
          <button class="btn btn-ok btn-sm" data-approve-app="${a.id}">Approve</button>
          <button class="btn btn-ghost-danger btn-sm" data-reject-app="${a.id}">Reject</button>
        ` : ""}
      </div></td>
    </tr>`).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px">No applications match your search.</td></tr>`;

  const shownFrom = all.length ? start+1 : 0;
  const shownTo   = Math.min(start+pageSize, all.length);
  $("#b2b-showing").textContent = `Showing ${shownFrom} to ${shownTo} of ${all.length} entries`;

  const pag = $("#b2b-pagination");
  let pagHtml = `<button data-pg="prev" ${page<=1?"disabled":""} aria-label="Previous page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;
  for(let i=1;i<=totalPages;i++){
    pagHtml += `<button data-pg="${i}" class="${i===page?"active":""}">${i}</button>`;
  }
  pagHtml += `<button data-pg="next" ${page>=totalPages?"disabled":""} aria-label="Next page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>`;
  pag.innerHTML = pagHtml;

  pag.querySelectorAll("[data-pg]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(btn.dataset.pg === "prev") adminState.b2bPage = Math.max(1, page-1);
      else if(btn.dataset.pg === "next") adminState.b2bPage = Math.min(totalPages, page+1);
      else adminState.b2bPage = +btn.dataset.pg;
      renderB2B();
    });
  });

  $$("#b2b-table th[data-sort]").forEach(th=>{
    const isSorted = th.dataset.sort === adminState.b2bSort.col;
    th.classList.toggle("sorted", isSorted);
    th.classList.toggle("desc", isSorted && adminState.b2bSort.dir==="desc");
    if(!th.querySelector(".sort-arrow")){
      th.innerHTML += `<span class="sort-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    }
    th.onclick = ()=>{
      if(adminState.b2bSort.col === th.dataset.sort){
        adminState.b2bSort.dir = adminState.b2bSort.dir === "asc" ? "desc" : "asc";
      } else {
        adminState.b2bSort = { col: th.dataset.sort, dir: "asc" };
      }
      adminState.b2bPage = 1;
      renderB2B();
    };
  });

  /* String(...) wraps every id comparison in this file.

     A dataset value is ALWAYS a string, and b2b/list.php casts its id with
     (int) — so `x.id === btn.dataset.approveApp` compared 2 === "2", which is
     false. find() returned undefined, openApproveAppModal() hit its
     `if(!a) return`, and the operator saw an empty modal shell with no error at
     all. B2B view, approve and reject were all dead.

     Every other list here uses string ids ("cus-01", "bat-201"), so String()
     changes nothing for them — it removes the trap for the next numeric id
     somebody adds. */
  tbody.querySelectorAll("[data-view-app]").forEach(btn=>{
    btn.addEventListener("click", ()=> openViewAppModal(B2B_APPLICATIONS.find(x=>String(x.id) === btn.dataset.viewApp)));
  });
  tbody.querySelectorAll("[data-approve-app]").forEach(btn=>{
    btn.addEventListener("click", ()=> openApproveAppModal(B2B_APPLICATIONS.find(x=>String(x.id) === btn.dataset.approveApp)));
  });
  tbody.querySelectorAll("[data-reject-app]").forEach(btn=>{
    btn.addEventListener("click", ()=> openRejectAppModal(B2B_APPLICATIONS.find(x=>String(x.id) === btn.dataset.rejectApp)));
  });

  if($("#search-b2b")) $("#search-b2b").oninput = ()=>{ adminState.b2bPage = 1; renderB2B(); };
  if($("#filter-b2b-status")) $("#filter-b2b-status").onchange = ()=>{ adminState.b2bPage = 1; renderB2B(); };
  if($("#b2b-page-size")){
    $("#b2b-page-size").value = String(adminState.b2bPageSize);
    $("#b2b-page-size").onchange = (e)=>{ adminState.b2bPageSize = +e.target.value; adminState.b2bPage = 1; renderB2B(); };
  }
  const exportBtn = $("#export-b2b-btn");
  if(exportBtn) exportBtn.onclick = exportB2BCSV;
}

function openViewAppModal(a){
  if(!a) return;
  openModal({
    title: `${a.appId} — ${a.businessName}`,
    large: true,
    body: `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        ${b2bStatusBadge(a.status)}
        ${a.requestedTerms ? `<span class="badge badge-info">${escHtml(a.requestedTerms)} requested</span>` : ""}
        ${a.tier ? tierBadge(a.tier) : ""}
      </div>
      <!-- Same card sections as Order Detail (orders.css) so the groups read apart. -->
      <div class="order-detail-section">
        <div class="order-detail-heading">Applicant</div>
        <div class="detail-row"><span class="detail-row-label">Name</span><span class="detail-row-val">${escHtml(a.applicantName)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Email</span><span class="detail-row-val">${escHtml(a.email)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Phone</span><span class="detail-row-val">${escHtml(a.phone)}</span></div>
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Business</div>
        <div class="detail-row"><span class="detail-row-label">Business Name</span><span class="detail-row-val">${escHtml(a.businessName)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Business Type</span><span class="detail-row-val">${escHtml(a.businessType)}</span></div>
        ${a.requestedTerms ? `<div class="detail-row"><span class="detail-row-label">Requested Terms</span><span class="detail-row-val">${escHtml(a.requestedTerms)}</span></div>` : ""}
        <div class="detail-row"><span class="detail-row-label">Submitted</span><span class="detail-row-val">${fmtDate(a.submittedDate)}</span></div>
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Application Notes</div>
        <p style="font-size:.88rem;color:var(--text-muted);margin:0;white-space:pre-wrap">${escHtml(a.notes||"—")}</p>
      </div>
      ${a.status==="rejected" ? `<div class="order-detail-section" style="border-left:3px solid var(--out)">
        <div class="order-detail-heading">Rejection Reason</div>
        <p style="font-size:.88rem;color:var(--out-ink);margin:0">${escHtml(a.reason||"—")}</p>
      </div>` : ""}
    `,
    confirmLabel: null,
    cancelLabel: null   /* the header × closes it */
  });
}

function openApproveAppModal(a){
  if(!a) return;
  /* No "Credit Terms" select. It was rendered here but never sent to
     b2b/decide.php, so whatever was chosen was silently discarded. A retailer
     picks Net 30/60/90 per order at checkout. */
  const tierOpts = PARTNER_TIERS.map(t=>`<option>${t}</option>`).join("");
  openModal({
    title: `Approve ${a.businessName}`,
    body: `
      <p style="font-size:.9rem;margin-bottom:16px">Approving grants <strong>${escHtml(a.applicantName)}</strong> a retailer account at the tier below. As a retailer they choose Net 30, Net 60 or Net 90 terms at checkout on each order.</p>
      <div class="field"><label>Partner Account Tier</label><select class="control" id="m-app-tier">${tierOpts}</select></div>
    `,
    confirmLabel: "Approve Application",
    confirmClass: "btn-ok",
    onConfirm: async ()=>{
      const tier = $("#m-app-tier").value;
      try {
        /* Approval promotes the applicant's customer record to retailer, which
           is what unlocks wholesale terms elsewhere — so it is one server-side
           transaction rather than four separate array edits here. The old code
           also invented a customer row and a credit account locally, neither of
           which survived a refresh. */
        const { data } = await EbApi.post("b2b/decide.php", {
          app_id: a.appId, decision: "approved", tier,
        });
        await loadOpsData();
        await loadAdminData();
        if(!data.promoted){
          toast("Approved. No existing customer record to promote — the partner account is created at signup.", "warn");
        }
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Application approved.", "ok");
      renderB2B();
    }
  });
}

function openRejectAppModal(a){
  if(!a) return;
  openModal({
    title: `Reject ${a.businessName}`,
    body: `
      <p style="font-size:.9rem;margin-bottom:12px">Reject this application from <strong>${escHtml(a.applicantName)}</strong>?</p>
      <div class="field"><label>Reason for Rejection</label><textarea class="control" id="m-app-reason" rows="3" placeholder="e.g. Unable to verify business permit documents."></textarea></div>
    `,
    confirmLabel: "Reject Application",
    confirmClass: "btn-ghost-danger",
    onConfirm: async ()=>{
      const reason = $("#m-app-reason").value.trim();
      try {
        /* The server requires a reason — the applicant is told it. */
        await EbApi.post("b2b/decide.php", {
          app_id: a.appId, decision: "rejected", reason,
        });
        await loadOpsData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Application rejected.", "warn");
      renderB2B();
    }
  });
}

function exportB2BCSV(){
  const rows = getFilteredSortedB2B();
  const header = ["App ID","Business Name","Applicant","Email","Phone","Business Type","Requested Terms","Tier","Status","Submitted Date","Notes","Rejection Reason"];
  const csvRows = rows.map(a=>[
    a.appId, a.businessName, a.applicantName, a.email, a.phone, a.businessType,
    a.requestedTerms||"", a.tier||"", a.status, a.submittedDate, a.notes||"", a.reason||""
  ]);
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  const csv = [header, ...csvRows].map(r=>r.map(esc).join(",")).join("\r\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `b2b-applications-${ymd(new Date())}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("CSV exported.", "ok");
}

/* ============================================================
   MODULE: LANDING PAGE MAINTENANCE
   ============================================================ */

/* ============================================================
   IMAGE PIPELINE  (Landing Page module)
   ------------------------------------------------------------
   There is one upload endpoint for the whole system now —
   api/uploads/image.php (decision I1) — and one resolver for
   reading an image back, EbFormat.imageUrl() (I6). This module
   owns neither; it just hands the file to one and the stored path
   to the other.

   The comment that used to be here said storeImage() was "the ONLY
   place that knows where an image lives" and that swapping in a
   real backend would change nothing else. Both halves were wrong:
   the product modal had its own separate uploader that never went
   through this function at all, and the swap did change something
   else — the value became a path, which every reader then had to
   resolve. The lesson is written down rather than the plan.
   ============================================================ */
/* Uploads the file and returns the PATH the server stored it at.

   This used to be a FileReader plus a canvas: downscale to 1200px, re-encode
   JPEG at q0.72, resolve a data URL, and hold it in memory. Nothing persisted
   it, because content/save.php accepted no image keys — so a hero photo lived
   in SITE_CONTENT and in localStorage and nowhere else. It survived exactly as
   long as the browser did.

   Resizing and re-encoding now happen server-side in api/uploads/image.php,
   where the bytes can also be checked. A client-side downscale was never a
   security measure — a client can post whatever it likes — and doing it in two
   places would mean two answers to "what size is a hero image?". */
async function storeImage(file, purpose = "content"){
  if(!file || !/^image\//.test(file.type)){
    throw new Error("That file isn't an image.");
  }
  const data = await EbApi.upload(file, purpose);
  return data.path;
}

/* Products ranked for the Best Sellers picker. Revenue is units x price —
   the same numbers the Sales Report works from. */
function bestSellerRows(){
  return PRODUCTS.filter(p => !p.archived)
    .map(p => ({ ...p, revenue: p.price * p.sold }))
    .sort((a, b) => b.sold - a.sold);
}

/* Which products are currently featured: the admin's saved list, or the
   seed `best` flags the first time this screen is opened. */
function featuredIds(){
  if(SITE_CONTENT.featured && SITE_CONTENT.featured.length) return SITE_CONTENT.featured.slice();
  return PRODUCTS.filter(p => p.best).map(p => p.id);
}

function renderLanding(){
  const el = $("#landing-editor");
  el.innerHTML = `
    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg> Hero Section Images
        <span class="lp-hint">Shown in the hero carousel on the landing page</span>
      </div>
      <div class="lp-img-grid" id="lp-hero-grid">${renderHeroImageCards()}</div>
    </div>

    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg> Best Sellers
        <span class="lp-hint">Ranked by units sold — tick the products to feature</span>
      </div>
      <div class="lp-bs-grid" id="lp-bs-table">${renderBestSellerRows()}</div>
      <div class="lp-storage" id="lp-storage"></div>
    </div>

    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M4 6h16M4 12h16M4 18h7"/></svg> About Us</div>
      <div class="field"><textarea class="control" id="lp-about" rows="4">${escHtml(SITE_CONTENT.about)}</textarea></div>
    </div>
    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Vision & Mission</div>
      <div class="field"><label>Vision</label><textarea class="control" id="lp-vision" rows="2">${escHtml(SITE_CONTENT.vision)}</textarea></div>
      <div class="field"><label>Mission</label><textarea class="control" id="lp-mission" rows="2">${escHtml(SITE_CONTENT.mission)}</textarea></div>
    </div>
    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><rect x="1" y="4" width="22" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg> Contact Info</div>
      <div class="field"><label>Address</label><input class="control" id="lp-address" value="${escHtml(SITE_CONTENT.contact.address)}"/></div>
      <div class="field"><label>Phone</label><input class="control" id="lp-phone" value="${escHtml(SITE_CONTENT.contact.phone)}"/></div>
      <div class="field"><label>Email</label><input class="control" id="lp-email" value="${escHtml(SITE_CONTENT.contact.email)}"/></div>
      <div class="field"><label>Facebook URL</label><input class="control" id="lp-facebook" value="${escHtml(SITE_CONTENT.contact.facebook)}"/></div>
    </div>
    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg> Payment Accounts
        <span class="lp-hint">Shown at checkout when a customer pays by GCash or bank transfer</span>
      </div>
      <div class="lp-pay-grid" id="lp-pay-grid">${renderPayAccountCards()}</div>
    </div>
    <div class="lp-section">
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> FAQ Entries
        <button class="btn btn-ghost btn-sm" id="add-faq-btn" style="margin-left:auto">+ Add FAQ</button>
      </div>
      <div id="faq-list">${renderFAQItems()}</div>
    </div>
  `;
  wireFAQButtons();
  wireLandingImages();
  wirePayAccounts();
  updateStorageMeter();
  $("#save-landing-btn").onclick = saveLanding;
  $("#add-faq-btn").onclick = ()=>{
    SITE_CONTENT.faqs.push({ q:"", a:"" });
    $("#faq-list").innerHTML = renderFAQItems();
    wireFAQButtons();
  };
}


/* ---- Payment accounts (GCash, bank) --------------------------------
   The accounts customers pay INTO, shown at checkout and on a retailer's Pay
   form. The QR code is uploaded as "payment-qr", which the server stores
   LOSSLESS — a photo's compression would blur the code until a phone could not
   scan it. Like the hero images, an upload is not live until Save Changes. */
const PAY_ACCOUNT_DEFS = [
  { key: "gcash", title: "GCash",
    fields: [["name", "Account name"], ["number", "GCash number"]] },
  { key: "bank",  title: "Bank Transfer",
    fields: [["bank", "Bank"], ["name", "Account name"], ["number", "Account number"]] },
];

function renderPayAccountCards(){
  const pay = SITE_CONTENT.payment || {};
  return PAY_ACCOUNT_DEFS.map(function(def){
    const a = pay[def.key] || {};
    const has = !!a.qr;
    return `
      <div class="lp-img-card lp-pay-card" data-pay-acct="${def.key}">
        <div class="lp-pay-title">${def.title}</div>
        <div class="lp-img-thumb lp-pay-qr ${has ? "has" : ""}">
          ${has
            ? `<img src="${escHtml(imageUrl(a.qr))}" alt="${def.title} QR code">`
            : `<span class="lp-img-empty">No QR code</span>`}
        </div>
        <div class="lp-img-actions">
          <label class="btn btn-ghost btn-sm">
            ${has ? "Replace QR" : "Upload QR"}
            <input type="file" accept="image/png,image/jpeg,image/webp" data-pay-qr-file="${def.key}" hidden>
          </label>
          ${has ? `<button class="btn btn-ghost btn-sm lp-img-clear" data-pay-qr-clear="${def.key}">Remove</button>` : ""}
        </div>
        ${def.fields.map(([f, label]) => `
        <div class="field"><label>${label}</label>
          <input class="control" data-pay-field="${def.key}.${f}" value="${escHtml(a[f] || "")}"/></div>`).join("")}
      </div>`;
  }).join("");
}

/* Typed values are read into SITE_CONTENT before any re-render, so replacing a
   QR code does not wipe an account number that has not been saved yet. */
function collectPayFields(){
  SITE_CONTENT.payment = SITE_CONTENT.payment || {};
  $$("[data-pay-field]").forEach(function(el){
    const [acct, f] = el.dataset.payField.split(".");
    SITE_CONTENT.payment[acct] = SITE_CONTENT.payment[acct] || {};
    SITE_CONTENT.payment[acct][f] = el.value.trim();
  });
}

function wirePayAccounts(){
  const redraw = function(){
    $("#lp-pay-grid").innerHTML = renderPayAccountCards();
    wirePayAccounts();
  };
  $$("[data-pay-qr-file]").forEach(function(input){
    input.addEventListener("change", function(){
      const acct = input.dataset.payQrFile;
      collectPayFields();
      handleUpload(input.files[0], input, function(path){
        SITE_CONTENT.payment[acct] = SITE_CONTENT.payment[acct] || {};
        SITE_CONTENT.payment[acct].qr = path;
        redraw();
      }, "payment-qr");
    });
  });
  $$("[data-pay-qr-clear]").forEach(function(btn){
    btn.addEventListener("click", function(){
      collectPayFields();
      SITE_CONTENT.payment[btn.dataset.payQrClear].qr = "";
      redraw();
    });
  });
}

/* ---- Hero image cards ------------------------------------------------ */
function renderHeroImageCards(){
  return SITE_CONTENT.hero.map(function(slide, i){
    const has = !!slide.img;
    return `
      <div class="lp-img-card" data-hero="${i}">
        <div class="lp-img-thumb ${has ? "has" : ""}">
          ${has
            ? `<img src="${escHtml(imageUrl(slide.img))}" alt="${escHtml(slide.title)}">`
            : `<span class="lp-img-empty">No image</span>`}
        </div>
        <div class="lp-img-name">${escHtml(slide.title)}</div>
        <div class="lp-img-actions">
          <label class="btn btn-ghost btn-sm">
            ${has ? "Replace" : "Upload"}
            <input type="file" accept="image/png,image/jpeg,image/webp" data-hero-file="${i}" hidden>
          </label>
          ${has ? `<button class="btn btn-ghost btn-sm lp-img-clear" data-hero-clear="${i}">Remove</button>` : ""}
        </div>
      </div>`;
  }).join("");
}

/* ---- Best sellers table --------------------------------------------- */
function renderBestSellerRows(){
  const chosen = featuredIds();
  const rows = bestSellerRows();
  /* THE PHOTO IS READ-ONLY.

     It used to carry its own file input, writing to
     SITE_CONTENT.productImages[p.id] — an in-memory object with no table
     behind it, no key in content/save.php, and no reader anywhere except a
     `c.productImages` branch on the storefront that content/get.php has never
     returned. It was a complete second uploader for a concept that already had
     one, and everything it produced was discarded on reload.

     A product has ONE photo. It is set in Product Maintenance, stored on
     products.image_url, and served to the storefront by shop/products.php.
     Two places to set one thing is how the writer and the reader came to
     disagree in the first place; this screen shows the photo and says where to
     change it. */
  /* A GRID OF TILES, NOT A TABLE.

     Seven columns of numbers is the right shape for comparing rows and the
     wrong shape for this screen's actual job, which is picking a handful of
     products to put on the front page. Rank and units sold — the ranking the
     caption promises — were two cells among seven, weighted the same as
     rating; the photo, which is what the visitor will actually see, was a
     40px thumbnail in the last column.

     The tile inverts that. Photo, name, rank and units sold carry the weight;
     revenue, rating and stock drop to one quiet line so nothing is lost and
     nothing competes.

     THE CHECKBOX STAYS A REAL CHECKBOX, carrying data-feat="<product id>".
     Two places read `$$("[data-feat]")` — the change handler in
     wireLandingImages() and the save in saveLanding() — and a real input keeps
     both working untouched, submits normally, and comes with keyboard support
     and a checked state a screen reader already understands. A div dressed as
     a switch would need role="switch", aria-checked, its own key handling, and
     edits at both call sites: more code, less accessible. */
  return rows.map(function(p, i){
    const on   = chosen.includes(p.id);
    const src  = imageUrl(p);
    const st   = stockInfo(p);
    const cbId = "lp-feat-" + p.id;
    return `
      <div class="lp-tile ${on ? "is-featured" : ""}" data-feat-tile="${escHtml(p.id)}">
        <div class="lp-tile-media">
          ${src
            ? `<img src="${escHtml(src)}" alt="">`
            : `<span class="lp-img-empty" title="No photo — add one in Product Maintenance">No photo</span>`}
          <span class="lp-tile-rank" title="Rank by units sold">#${i + 1}</span>
        </div>

        <div class="lp-tile-body">
          <div class="lp-tile-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
          <div class="lp-tile-cat">${escHtml(p.cat)}</div>
          <div class="lp-tile-sold"><b>${p.sold.toLocaleString()}</b> sold</div>
          <div class="lp-tile-meta">
            ${peso(p.revenue)} · ${ratingText(p)} ·
            <!-- .badge, like every other stock pill in the portal. This said
                 class="pill", and no .pill rule exists anywhere: the colour
                 classes (badge-ok, badge-out…) only set a background and a text
                 colour, while the SHAPE — padding, rounded ends, weight — lives on
                 .badge. So the tile got the colour with no shape, which is the
                 "cut-off rectangle". Nothing was clipping it; nothing was shaping it. -->
            <span class="badge ${st.cls}">${st.label}</span>
          </div>
        </div>

        <div class="lp-tile-foot">
          <!-- The label wraps the input, so the whole control is one hit target
               and clicking the word toggles the box. The tick beside it is the
               third channel on top of the border and the tint: a selected tile
               must be identifiable without relying on colour. -->
          <label class="lp-feat-toggle" for="${cbId}">
            <input type="checkbox" id="${cbId}" data-feat="${p.id}" ${on ? "checked" : ""}>
            <span class="lp-feat-box" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>
            </span>
            <span class="lp-feat-text">${on ? "Featured" : "Feature"}</span>
          </label>
          <button class="btn btn-ghost btn-sm" data-goto-product="${escHtml(p.id)}">${src ? "Change" : "Add photo"}</button>
        </div>
      </div>`;
  }).join("");
}

/* ---- Wiring ---------------------------------------------------------- */
function wireLandingImages(){
  /* Hero uploads */
  $$("[data-hero-file]").forEach(function(input){
    input.addEventListener("change", function(){
      const i = +input.dataset.heroFile;
      handleUpload(input.files[0], input, function(path){
        SITE_CONTENT.hero[i].img = path;
        $("#lp-hero-grid").innerHTML = renderHeroImageCards();
        wireLandingImages(); updateStorageMeter();
      });
    });
  });
  $$("[data-hero-clear]").forEach(function(btn){
    btn.addEventListener("click", function(){
      SITE_CONTENT.hero[+btn.dataset.heroClear].img = "";
      $("#lp-hero-grid").innerHTML = renderHeroImageCards();
      wireLandingImages(); updateStorageMeter();
    });
  });

  /* Product photos are set in Product Maintenance, not here — see the note on
     the Photo column above. This jumps there rather than duplicating the
     uploader. */
  $$("[data-goto-product]").forEach(function(btn){
    btn.addEventListener("click", function(){
      if(!hasPerm("products.manage")){
        toast("Product photos are managed in Product Maintenance, which you do not have access to.", "warn");
        return;
      }
      navigate("products");
      toast("Open the product and use the image field to change its photo.", "ok");
    });
  });

  /* Featured checkboxes — kept in the ranked order shown on screen. */
  $$("[data-feat]").forEach(function(box){
    box.addEventListener("change", function(){
      const ids = $$("[data-feat]").filter(b => b.checked).map(b => b.dataset.feat);
      SITE_CONTENT.featured = ids;
      /* .lp-tile, not "tr". This read `box.closest("tr")` while the rows were
         a table; in a tile grid that returns null and the selected styling
         silently stops happening — no error, just a screen that no longer
         shows which products are featured. */
      const tile = box.closest(".lp-tile");
      if(tile){
        tile.classList.toggle("is-featured", box.checked);
        const label = tile.querySelector(".lp-feat-text");
        if(label) label.textContent = box.checked ? "Featured" : "Feature";
      }
      /* Zero ticked is a REAL answer — see the note in saveLanding(). Said out
         loud rather than treated as a mistake, because it is reachable now and
         used to not be. */
      if(!ids.length) toast("No products ticked — the carousel will fall back to the default set.", "warn");
    });
  });
}

function refreshBestSellerTable(){
  $("#lp-bs-table").innerHTML = renderBestSellerRows();
  wireLandingImages(); updateStorageMeter();
}

/* Upload, then hand the caller the stored PATH.

   `input` is the file input so it can be cleared afterwards — without that,
   choosing the same file again fires no change event and the control appears
   dead the second time.

   The toast says "Save Changes" deliberately. The file IS on the server at this
   point, but hero_slides does not point at it until content/save.php runs, so
   claiming the landing page is updated would be the preview-implies-persistence
   mistake this work exists to remove (I7). */
function handleUpload(file, input, done, purpose){
  if(!file) return;
  storeImage(file, purpose)
    .then(function(path){
      done(path);
      toast("Image uploaded. Save Changes to publish it to the landing page.", "ok");
    })
    .catch(function(err){
      /* Field errors from the upload endpoint are more specific than the
         envelope message — "Upload a JPEG, PNG or WebP image" beats
         "Check the highlighted fields". */
      toast((err.fields && err.fields.file) || err.message || "Upload failed.", "err");
    })
    .finally(function(){ if(input) input.value = ""; });
}

/* The 5MB browser-storage meter that used to live here is gone.

   It measured JSON.stringify(SITE_CONTENT) against localStorage's ~5MB ceiling
   and warned the administrator when the hero images were "close to the limit;
   remove an image or wait for the database". Every part of that is obsolete:
   images are files on disk, the landing content in localStorage is gone, and
   the ceiling it policed does not exist any more.

   Left as a stub rather than deleted outright because four call sites invoke it
   after an image change, and the honest replacement is "say what is actually
   stored" rather than a silently removed reassurance. */
function updateStorageMeter(){
  const el = $("#lp-storage");
  if(!el) return;
  const withPhotos = SITE_CONTENT.hero.filter(h => h.img).length;
  const total = SITE_CONTENT.hero.length;
  el.innerHTML = `<small>${withPhotos} of ${total} hero slides have a photo. Images are stored on the server — Save Changes to publish them.</small>`;
}

function renderFAQItems(){
  return SITE_CONTENT.faqs.map((f,i)=>`
    <div class="faq-entry" data-faq="${i}">
      <button class="faq-remove icon-btn" data-remove-faq="${i}" title="Remove FAQ"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      <div class="field"><label>Question ${i+1}</label><input class="control faq-q" value="${escHtml(f.q)}" data-faq-q="${i}"/></div>
      <div class="field"><label>Answer</label><textarea class="control faq-a" rows="2" data-faq-a="${i}">${escHtml(f.a)}</textarea></div>
    </div>`).join("");
}

function wireFAQButtons(){
  $$("[data-remove-faq]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      SITE_CONTENT.faqs.splice(+btn.dataset.removeFaq, 1);
      $("#faq-list").innerHTML = renderFAQItems();
      wireFAQButtons();
    });
  });
}

function saveLanding(){
  SITE_CONTENT.about        = $("#lp-about").value;
  SITE_CONTENT.vision       = $("#lp-vision").value;
  SITE_CONTENT.mission      = $("#lp-mission").value;
  SITE_CONTENT.contact.address  = $("#lp-address").value;
  SITE_CONTENT.contact.phone    = $("#lp-phone").value;
  SITE_CONTENT.contact.email    = $("#lp-email").value;
  SITE_CONTENT.contact.facebook = $("#lp-facebook").value;
  collectPayFields();
  $$("[data-faq-q]").forEach(el=> { SITE_CONTENT.faqs[+el.dataset.faqQ].q = el.value; });
  $$("[data-faq-a]").forEach(el=> { SITE_CONTENT.faqs[+el.dataset.faqA].a = el.value; });

  /* Featured list is read from the table so a save always matches what is
     ticked on screen, even if the change event was missed.

     No `if(ticked.length)` guard any more. That guard meant unticking the LAST
     featured product silently kept the previous list — the one state the
     administrator could not reach was "nothing is featured". An empty list is
     a real answer and means "fall back to each product's is_best flag". */
  SITE_CONTENT.featured = $$("[data-feat]").filter(b => b.checked).map(b => b.dataset.feat);

  /* ONE round trip, and the server's answer decides what the screen says.

     Two things were wrong here and both produced the same symptom — a save that
     looked like it worked.

     1. `hero` and `featured` were never in the body. content/save.php would not
        have accepted them anyway. So hero photos and the featured list lived in
        SITE_CONTENT and in localStorage and nowhere else, and vanished the
        moment the administrator signed out. That is defect 3.3.

     2. A second toast, `"Landing page changes saved."`, fired SYNCHRONOUSLY at
        the end of this function — outside the promise. A failed POST therefore
        showed an error toast AND a success toast. The screen claimed a save it
        had not got (I7).

     The localStorage mirror is gone with them. It existed so the preview iframe
     could show unsaved edits; the preview now shows what the server returns,
     which is the only state worth previewing. */
  const btn = $("#save-landing-btn");
  const restore = btn ? EbUI.busy(btn, "Saving…") : () => {};

  EbApi.post("content/save.php", {
    about:   SITE_CONTENT.about,
    vision:  SITE_CONTENT.vision,
    mission: SITE_CONTENT.mission,
    contact: SITE_CONTENT.contact,
    faqs:    (SITE_CONTENT.faqs || []).filter(f => (f.q || "").trim() && (f.a || "").trim()),
    /* Paths, not images. `img` holds whatever api/uploads/image.php returned. */
    hero:     (SITE_CONTENT.hero || []).map(h => ({ title: h.title, image: h.img || "" })),
    featured: SITE_CONTENT.featured,
    payment:  SITE_CONTENT.payment,
  }).then(({ data }) => {
    toast("Landing page saved: " + (data.updated || []).join(", ") + ".", "ok");
    updateStorageMeter();
  }).catch(err => {
    toast("Could not save landing content: " + (err.fields.hero || err.fields.featured || err.fields.payment || err.message), "err");
  }).finally(restore);
}

/* ============================================================
   MODULE: PRODUCTS (Catalog + Varieties, tabbed)
   ============================================================ */
function renderProducts(tab){
  const activeTab = tab || adminState.productsTabActive || "catalog";
  adminState.productsTabActive = activeTab;

  /* See renderUsers(): the highlight belongs to the render, so Catalog ⇄
     Varieties from the pills moves the sidebar and keeps "Products" lit. */
  syncNavHighlight("products", activeTab);

  /* switch tab */
  $$("[data-products-tab]").forEach(btn=>{
    const isActive = btn.dataset.productsTab === activeTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  $$(".tab-panel", $("#mod-products")).forEach(p=>{
    p.classList.toggle("active", p.id === `tab-${activeTab}`);
  });

  /* header action(s) per tab */
  $("#products-header-actions").innerHTML = activeTab === "catalog"
    ? `<select class="filter-select" id="filter-products" aria-label="Filter products">
         <option value="all">All</option>
         <option value="active">Active</option>
         <option value="archived">Archived</option>
       </select>
       <button class="btn btn-gold" id="add-product-btn">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
         Add Product
       </button>`
    : `<button class="btn btn-gold" id="add-variety-btn">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
         Add Variety
       </button>`;

  if(activeTab === "catalog") renderProductAdmin();
  else renderVarieties();

  /* tab click handlers. onclick for the same reason as the Users pills — this
     function re-runs on every switch and addEventListener stacked duplicates.
     The highlight is renderProducts()'s job now. */
  $$("[data-products-tab]").forEach(btn=>{
    btn.onclick = ()=> renderProducts(btn.dataset.productsTab);
  });
}

function renderProductAdmin(){
  const filter = $("#filter-products")?.value || "all";
  const grid   = $("#product-admin-grid");

  let list = PRODUCTS.filter(p =>
    filter === "all" ? true : filter === "archived" ? p.archived : !p.archived
  );

  /* The thumbnail used to be the camera SVG unconditionally, so this grid was
     the one screen in the system that never showed a product photo — the data
     was there the whole time (list.php sends image_url as `image`) and Point of
     Sale, Best Sellers and the storefront were all rendering it. The camera is
     the EMPTY STATE now, not the only state. Resolution goes through imageUrl()
     for the same reason it does everywhere else (decision I6): the stored value
     is application-root-relative and must not be resolved against this page. A
     path whose file has gone falls back to the placeholder via the delegated
     listener installed in core/index.js — no onerror attribute needed here. */
  grid.innerHTML = list.map(p=>{
    const src = imageUrl(p);
    return `
    <div class="product-admin-card ${p.archived?"archived":""}">
      <div class="pac-thumb">
        ${src
          /* NOT loading="lazy", deliberately.

             It was, because this grid renders the WHOLE catalogue at once and
             there is no pagination here. The cost was the defect this comment
             replaces: saving a photo re-renders this grid in place, and the
             freshly-inserted lazy <img> never fetched — the card kept showing
             the empty-state camera while Point of Sale, which does not set the
             attribute, showed the same photo immediately. "It saved everywhere
             except the screen I saved it on" is the worst possible reading of a
             successful write, and it sent us looking at the uploader.

             Affordable to drop: every image here has been through
             api/uploads/image.php, which caps the longest edge at 1600px and
             re-encodes to WebP q82 — tens of KB each, not hundreds. Restore
             lazy loading only together with pagination or an IntersectionObserver
             that is re-armed after each render. */
          ? `<img src="${escHtml(src)}" alt="${escHtml(p.name)}">`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`}
      </div>
      <div class="pac-body">
        <div class="pac-cat">${escHtml(p.cat)}</div>
        <div class="pac-name">${escHtml(p.name)}</div>
        <div class="pac-price">${peso(p.price)}</div>
        <div class="pac-actions">
          <button class="btn btn-ghost btn-sm" data-edit-prod="${p.id}">Edit</button>
          ${p.archived
            ? `<button class="btn btn-ok btn-sm" data-restore-prod="${p.id}">Restore</button>`
            : `<button class="btn btn-ghost-danger btn-sm" data-archive-prod="${p.id}">Archive</button>`}
        </div>
      </div>
    </div>`;
  }).join("") || `<p style="color:var(--text-muted)">No products found.</p>`;

  grid.querySelectorAll("[data-edit-prod]").forEach(btn=>{
    btn.addEventListener("click", ()=> openEditProductModal(PRODUCTS.find(p=>String(p.id) === btn.dataset.editProd)));
  });
  grid.querySelectorAll("[data-archive-prod]").forEach(btn=>{
    btn.addEventListener("click", ()=> archiveProduct(btn.dataset.archiveProd, true));
  });
  grid.querySelectorAll("[data-restore-prod]").forEach(btn=>{
    btn.addEventListener("click", ()=> archiveProduct(btn.dataset.restoreProd, false));
  });

  if($("#filter-products")) $("#filter-products").onchange = renderProductAdmin;
  const addBtn = $("#add-product-btn");
  if(addBtn) addBtn.onclick = openAddProductModal;
}

function productModalBody(p){
  const allCats = [...new Set(PRODUCTS.map(x=>x.cat))];
  const catOpts = allCats.map(c=>`<option ${p&&p.cat===c?"selected":""}>${escHtml(c)}</option>`).join("");
  return `
    <div class="field"><label>Product Name</label><input class="control" id="m-prod-name" value="${escHtml(p?.name||"")}" placeholder="Product name"/><span class="field-error" id="m-prod-name-err"></span></div>
    <div class="field"><label>Category</label><select class="control" id="m-prod-cat">${catOpts}</select></div>
    <div class="field"><label>Price (₱)</label><input class="control" type="number" id="m-prod-price" value="${p?.price||""}" min="0"/></div>
    <div class="field">
      <label>Product Image</label>
      <!-- has-image is the ONE switch for this field: it hides the placeholder,
           shows the preview and the Change/Remove pair, and turns the zone's
           click-to-upload off. The styles it drives are .img-* in portal.css —
           they were inline style= attributes here, which could not express the
           hover and focus states the buttons and the zoom trigger need. -->
      <div id="m-img-zone" class="img-zone ${p?.image?"has-image":""}">
        <!-- data-path holds the CANONICAL stored value (/uploads/products/….webp);
             src holds the RESOLVED url for this page. They are different strings
             and the save reads data-path, never src. Reading src back was fine
             while the value was a data URL and would now post a page-resolved
             "/elishabay/uploads/…" into the database — a path that only works
             on this install. -->
        <img id="m-prod-preview" class="img-preview"
             ${p?.image ? `src="${escHtml(imageUrl(p))}"` : ""}
             data-path="${escHtml(p?.image || "")}"
             alt="${escHtml(p?.name ? p.name + " — current photo" : "Product photo")}"
             role="button" tabindex="0" title="Click to view full size"/>
        <div id="m-img-placeholder" class="img-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
          <span class="img-ph-title">Click to upload image</span>
          <span class="img-ph-hint">PNG, JPG, WEBP</span>
        </div>
        <!-- Change is the old whole-zone behaviour, now stated rather than
             implied; Remove is what did not exist at all — before this, the
             only way out of a wrong photo was to upload a different one. -->
        <div id="m-img-actions" class="img-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="m-img-change">Change</button>
          <button type="button" class="btn btn-ghost-danger btn-sm" id="m-img-remove">Remove</button>
        </div>
        <div id="m-img-status" class="img-status"></div>
        <input type="file" id="m-prod-image" class="img-file" accept="image/png,image/jpeg,image/webp"/>
      </div>
    </div>
    <div class="field"><label>Description</label><textarea class="control" id="m-prod-desc" rows="3">${escHtml(p?.desc||"")}</textarea></div>
  `;
}

function openAddProductModal(){
  openModal({
    title: "Add Product",
    body: productModalBody(null),
    confirmLabel: "Add Product",
    onConfirm: async ()=>{
      const name = $("#m-prod-name").value.trim();
      if(!name){ $("#m-prod-name-err").textContent="Name required."; return; }
      /* The id, opening stock, rating and sold count are the server's to set.
         This used to mint "prod-"+Date.now() locally and push straight into
         the array, so the product existed only until the next refresh. */
      const catName = $("#m-prod-cat").value;
      const cat = CATEGORIES_DATA.find(c => c.name === catName);
      try {
        await EbApi.post("products/save.php", {
          name,
          category_id: cat ? cat.id : null,
          price: +$("#m-prod-price").value || 0,
          description: $("#m-prod-desc").value.trim(),
          /* data-path, not src. src is resolved for this page; data-path is the
             canonical value the database stores. */
          image: $("#m-prod-preview").dataset.path || null,
        });
        await loadCatalog();
      } catch(err){
        if(err.isValidation && err.fields.name) $("#m-prod-name-err").textContent = err.fields.name;
        else if(err.isValidation && err.fields.image) toast(err.fields.image, "err");
        else toast(err.message, "err");
        return;   /* modal stays open so the entered values are not lost */
      }
      closeModal();
      toast("Product added.", "ok");
      renderProductAdmin();
    }
  });
  setTimeout(attachImagePreview, 0);
}

function openEditProductModal(p){
  if(!p) return;
  openModal({
    title: "Edit Product",
    body: productModalBody(p),
    confirmLabel: "Save Changes",
    onConfirm: async ()=>{
      const catName = $("#m-prod-cat").value;
      const cat = CATEGORIES_DATA.find(c => c.name === catName);
      try {
        await EbApi.post("products/save.php", {
          id: p.id,
          name: $("#m-prod-name").value.trim() || p.name,
          category_id: cat ? cat.id : null,
          price: +$("#m-prod-price").value || p.price,
          description: $("#m-prod-desc").value.trim(),
          /* data-path is seeded from the product's current image and changed
             only by a successful upload or by Remove, so sending it always is
             correct: an untouched form re-sends the same path, and an emptied
             one posts null.

             null now MEANS REMOVE. It used to mean "keep the current one" —
             the endpoint could not tell an absent field from an explicit null,
             which is why Remove could not exist before this pass. Sending the
             field on every save is what makes the distinction usable; do not
             "optimise" it away to only-when-changed. */
          image: $("#m-prod-preview").dataset.path || null,
        });
        await loadCatalog();
      } catch(err){
        if(err.isValidation && err.fields.name) $("#m-prod-name-err").textContent = err.fields.name;
        else if(err.isValidation && err.fields.image) toast(err.fields.image, "err");
        else toast(err.message, "err");
        return;
      }
      closeModal();
      toast("Product updated.", "ok");
      renderProductAdmin();
    }
  });
  setTimeout(attachImagePreview, 0);
}

function attachImagePreview(){
  const input   = $("#m-prod-image");
  const preview = $("#m-prod-preview");
  const zone    = $("#m-img-zone");
  const status  = $("#m-img-status");
  if(!input) return;

  const setStatus = (msg, colour) => {
    if(!status) return;
    status.textContent = msg || "";
    status.style.color = colour || "var(--text-muted)";
  };

  /* The dropzone carried onclick="document.getElementById('m-prod-image').click()"
     inside the template string that builds this modal — an inline handler the
     brief rules out, and one a grep of the .html files could never find because
     it lives in JavaScript. Bound here instead, alongside the change handler it
     belongs with.

     NOW SCOPED TO THE EMPTY STATE. #m-img-zone wraps the preview as well as the
     placeholder, so while there was a photo in it every click on that photo
     opened the file picker — the one gesture an administrator makes to look at
     an image was the gesture that replaced it. With an image present the zone
     is inert and the three real controls (the image, Change, Remove) carry
     their own handlers. */
  if(zone) zone.addEventListener("click", e => {
    if(zone.classList.contains("has-image")) return;
    if(e.target.closest("button, #m-prod-preview")) return;
    input.click();
  });

  /* The image is a control: it opens the zoom view. Keyboard included, because
     a div-shaped button that only answers the mouse is not a button. */
  if(preview){
    const zoom = () => openLightbox(preview.src, preview.alt, preview);
    preview.addEventListener("click", zoom);
    preview.addEventListener("keydown", e => {
      if(e.key === "Enter" || e.key === " " || e.key === "Spacebar"){
        e.preventDefault();          /* Space would otherwise scroll the modal */
        zoom();
      }
    });
  }

  /* Change: what the whole zone used to do, said out loud. */
  $("#m-img-change")?.addEventListener("click", ()=> input.click());

  /* Remove: NOTHING IS DELETED HERE.
     ------------------------------------------------------------------------
     This clears the field, not the product. data-path is what the save posts
     (see the note in the markup), so emptying it makes the next Save Changes
     post image: null — which products/save.php now reads as "remove", where
     until this pass no request could clear the column at all. Cancel closes
     the modal without a request and the stored photo is untouched, so the
     status line has to say that the change is pending rather than done. */
  $("#m-img-remove")?.addEventListener("click", ()=>{
    preview.dataset.path = "";
    /* removeAttribute, not src="": an empty src resolves to the page URL, the
       browser fetches the HTML as an image, and the delegated error fallback
       swaps in the placeholder — a picture, where we want no picture. */
    preview.removeAttribute("src");
    zone.classList.remove("has-image");
    setStatus("Image removed. Save to apply it to the product.", "var(--out)");
  });

  /* THE FILE IS UPLOADED HERE, NOW — not carried along inside the product save.
     ------------------------------------------------------------------------
     This used to run a bare FileReader and hand the resulting data URL to
     products/save.php as a JSON string. That is why products.image_url held
     918KB of base64 and why every public catalogue response was 1.8MB.

     It also means what you see is a file the server has written and can serve
     back, not a local preview that might not survive the save (decision I7).
     The status line says which state we are in, because "the picture appeared"
     is not evidence that anything was stored. */
  input.addEventListener("change", async ()=>{
    const file = input.files[0];
    if(!file) return;

    setStatus("Uploading…");
    try {
      const data = await EbApi.upload(file, "products");
      preview.dataset.path = data.path;
      preview.src = imageUrl(data.path);
      /* One class instead of toggling display on the preview and the
         placeholder separately — the two could disagree, and did not have to. */
      zone.classList.add("has-image");
      setStatus(`Uploaded (${Math.round(data.bytes / 1024)} KB). Save to attach it to the product.`, "var(--ok)");
    } catch(err){
      /* A silent failure here is how an administrator ends up believing a photo
         is on file when it is not. Said plainly, and the previous image — if
         there was one — is left exactly as it was. */
      setStatus(err.fields.file || err.message, "var(--out)");
      toast(err.fields.file || err.message, "err");
    } finally {
      /* Cleared so choosing the SAME file again still fires a change event. */
      input.value = "";
    }
  });
}

function archiveProduct(id, archive){
  const p = PRODUCTS.find(x=>x.id===id);
  if(!p) return;
  const action = archive ? "Archive" : "Restore";
  openModal({
    title: `${action} Product`,
    body: `<p>${action} <strong>${escHtml(p.name)}</strong>? ${archive?"It will no longer appear in the shop.":"It will reappear in the shop."}</p>`,
    confirmLabel: action,
    confirmClass: archive ? "btn-ghost-danger" : "btn-ok",
    onConfirm: async ()=>{
      try {
        const { data } = await EbApi.post("products/archive.php", { id: p.id, archived: archive });
        await loadCatalog();
        closeModal();
        toast(`Product ${action.toLowerCase()}d.`, archive?"warn":"ok");
        /* Archiving does not remove stock, and saying so avoids a later
           argument about why inventory value did not move. */
        if(data.notice) toast(data.notice, "warn");
      } catch(err){
        toast(err.message, "err");
        return;
      }
      renderProductAdmin();
    }
  });
}

/* ============================================================
   MODULE: PRODUCT VARIETIES
   ============================================================ */
function renderVarieties(){
  const tbody = $("#varieties-tbody");
  tbody.innerHTML = CATEGORIES_DATA.map(cat=>{
    const count = PRODUCTS.filter(p=>p.cat===cat.name && !p.archived).length;
    return `<tr class="${cat.archived?"archived":""}">
      <td class="td-name">${escHtml(cat.name)}</td>
      <td>${count} product(s)</td>
      <td><span class="badge ${cat.archived?"badge-muted":"badge-ok"}">${cat.archived?"Archived":"Active"}</span></td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-edit-cat="${cat.id}">Edit</button>
        ${cat.archived
          ? `<button class="btn btn-ok btn-sm" data-restore-cat="${cat.id}">Restore</button>`
          : `<button class="btn btn-ghost-danger btn-sm" data-archive-cat="${cat.id}">Archive</button>`}
      </div></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-edit-cat]").forEach(btn=>{
    const cat = CATEGORIES_DATA.find(c=>String(c.id) === btn.dataset.editCat);
    btn.addEventListener("click", ()=> openModal({
      title:"Edit Variety",
      body:`<div class="field"><label>Category Name</label><input class="control" id="m-cat-name" value="${escHtml(cat.name)}"/></div>
            <div class="field"><label>Description</label><textarea class="control" id="m-cat-desc" rows="2">${escHtml(cat.desc)}</textarea></div>`,
      confirmLabel:"Save",
      onConfirm: async ()=>{
        try {
          await EbApi.post("categories/save.php", {
            id: cat.id,
            name: $("#m-cat-name").value.trim() || cat.name,
            description: $("#m-cat-desc").value.trim(),
          });
          await loadCatalog();
        } catch(err){ toast(err.message, "err"); return; }
        closeModal(); toast("Variety updated.","ok"); renderVarieties();
      }
    }));
  });
  tbody.querySelectorAll("[data-archive-cat]").forEach(btn=>{
    const cat = CATEGORIES_DATA.find(c=>String(c.id) === btn.dataset.archiveCat);
    btn.addEventListener("click", ()=> openModal({
      title:"Archive Variety",
      body:`<p>Archive <strong>${escHtml(cat.name)}</strong>?</p>`,
      confirmLabel:"Archive", confirmClass:"btn-ghost-danger",
      /* The server refuses this while active products still use the variety,
         and says how many. That check cannot live here — the browser is not
         what other clients talk to. */
      onConfirm: async ()=>{
        try {
          await EbApi.post("categories/archive.php", { id: cat.id, archived: true });
          await loadCatalog();
        } catch(err){ toast(err.message, "err"); return; }
        closeModal(); toast("Variety archived.","warn"); renderVarieties();
      }
    }));
  });
  tbody.querySelectorAll("[data-restore-cat]").forEach(btn=>{
    const cat = CATEGORIES_DATA.find(c=>String(c.id) === btn.dataset.restoreCat);
    btn.addEventListener("click", async ()=>{
      try {
        await EbApi.post("categories/archive.php", { id: cat.id, archived: false });
        await loadCatalog();
      } catch(err){ toast(err.message, "err"); return; }
      toast("Variety restored.","ok"); renderVarieties();
    });
  });

  const addBtn = $("#add-variety-btn");
  if(addBtn) addBtn.onclick = ()=> openModal({
    title:"Add Variety",
    body:`<div class="field"><label>Category Name</label><input class="control" id="m-cat-name" placeholder="e.g. Smoked Bangus"/></div>
          <div class="field"><label>Description</label><textarea class="control" id="m-cat-desc" rows="2"></textarea></div>`,
    confirmLabel:"Add Variety",
    onConfirm: async ()=>{
      const name=$("#m-cat-name").value.trim();
      if(!name) return;
      try {
        await EbApi.post("categories/save.php", {
          name, description: $("#m-cat-desc").value.trim(),
        });
        await loadCatalog();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal(); toast("Variety added.","ok"); renderVarieties();
    }
  });
}

/* ============================================================
   MODULE: BATCH TRACKING & QA TRACEABILITY
   ============================================================ */
function qaStatusBadge(status){
  const MAP = {
    passed:  { cls:"badge-ok",   label:"Certified" },
    pending: { cls:"badge-warn", label:"Pending QA" },
    failed:  { cls:"badge-out",  label:"Failed" },
  };
  const m = MAP[status] || MAP.pending;
  return `<span class="badge ${m.cls}">${m.label}</span>`;
}

function batchQtyStatus(remaining, total){
  const pct = total ? remaining / total : 0;
  if(remaining <= 0)  return { color:"var(--out)"  };
  if(pct <= .10)       return { color:"var(--crit)" };
  if(pct <= .30)       return { color:"var(--warn)" };
  return                { color:"var(--ok)"   };
}

function batchRow(b){
  const p = PRODUCTS.find(x=>x.id===b.productId);
  const expiryDate = b.expiryDate;
  /* From the server, which computes it as DATEDIFF(expiry_date, CURDATE()).

     This line read `- new Date("2026-06-17T00:00:00")` — days-to-expiry
     measured against a frozen constant, so the Batch Tracking screen's "days
     left" stopped moving in June 2026. A lot that expired weeks ago still
     showed a comfortable margin. */
  const daysLeft = typeof b.daysToExpiry === "number"
    ? b.daysToExpiry
    : Math.round((parseYmd(expiryDate) - parseYmd(dAgo(0))) / 864e5);
  const expiryColor = daysLeft<=0 ? "var(--out)" : daysLeft<=30 ? "var(--out)" : daysLeft<=90 ? "var(--warn)" : "var(--text)";
  const qty = batchQtyStatus(b.remainingQty, b.totalQty);
  return { b, p, expiryDate, daysLeft, expiryColor, qty };
}

function getFilteredSortedBatches(){
  const q      = ($("#search-batches")?.value || "").toLowerCase();
  const qaFilt = $("#filter-batch-qa")?.value || "all";
  const sort   = adminState.batchSort;

  let rows = BATCHES.map(batchRow).filter(r=>{
    const matchQ = !q ||
      r.b.lotCode.toLowerCase().includes(q) ||
      (r.p?.name||"").toLowerCase().includes(q) ||
      r.b.productId.toLowerCase().includes(q);
    const matchQa = qaFilt === "all" || r.b.labStatus === qaFilt;
    return matchQ && matchQa;
  });

  rows.sort((a,b)=>{
    let av, bv;
    switch(sort.col){
      case "productName": av=a.p?.name||""; bv=b.p?.name||""; break;
      case "prodDate":    av=a.b.prodDate;   bv=b.b.prodDate;   break;
      case "expiryDate":  av=a.expiryDate;   bv=b.expiryDate;   break;
      case "remainingQty":av=a.b.remainingQty; bv=b.b.remainingQty; break;
      case "qaStatus":    av=a.b.labStatus;   bv=b.b.labStatus;   break;
      default:            av=a.b.lotCode;    bv=b.b.lotCode;
    }
    if(av<bv) return sort.dir==="asc" ? -1 : 1;
    if(av>bv) return sort.dir==="asc" ? 1 : -1;
    return 0;
  });

  return rows;
}

function renderBatches(){
  const tbody = $("#batches-tbody");
  const all = getFilteredSortedBatches();

  /* pagination */
  const pageSize = adminState.batchPageSize;
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  if(adminState.batchPage > totalPages) adminState.batchPage = totalPages;
  const page = adminState.batchPage;
  const start = (page-1)*pageSize;
  const pageRows = all.slice(start, start+pageSize);

  tbody.innerHTML = pageRows.map(({b,p,expiryDate,daysLeft,expiryColor,qty})=>`
    <tr>
      <td class="mono">${escHtml(b.lotCode)}</td>
      <td class="td-name">${escHtml(p?.name||b.productId)}<span class="sku-chip">SKU-${escHtml(b.productId.toUpperCase())}</span></td>
      <td class="muted">${fmtDate(b.prodDate)}</td>
      <td style="color:${expiryColor};font-weight:700">${fmtDate(expiryDate)}</td>
      <td>
        <div class="qty-cell">
          <span class="qty-label">${b.remainingQty} <span class="of">/ ${b.totalQty}</span></span>
          <div class="stock-bar-wrap"><div class="stock-bar-fill" style="width:${b.totalQty?Math.round(b.remainingQty/b.totalQty*100):0}%;background:${qty.color}"></div></div>
        </div>
      </td>
      <td>${qaStatusBadge(b.labStatus)}</td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-edit-batch="${b.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
      </div></td>
    </tr>`).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px">No batches match your search.</td></tr>`;

  /* showing text + pagination controls */
  const shownFrom = all.length ? start+1 : 0;
  const shownTo   = Math.min(start+pageSize, all.length);
  $("#batches-showing").textContent = `Showing ${shownFrom} to ${shownTo} of ${all.length} entries`;

  const pag = $("#batches-pagination");
  let pagHtml = `<button data-pg="prev" ${page<=1?"disabled":""} aria-label="Previous page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;
  for(let i=1;i<=totalPages;i++){
    pagHtml += `<button data-pg="${i}" class="${i===page?"active":""}">${i}</button>`;
  }
  pagHtml += `<button data-pg="next" ${page>=totalPages?"disabled":""} aria-label="Next page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>`;
  pag.innerHTML = pagHtml;

  pag.querySelectorAll("[data-pg]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(btn.dataset.pg === "prev") adminState.batchPage = Math.max(1, page-1);
      else if(btn.dataset.pg === "next") adminState.batchPage = Math.min(totalPages, page+1);
      else adminState.batchPage = +btn.dataset.pg;
      renderBatches();
    });
  });

  /* sort header indicators + clicks */
  $$("#batches-table th[data-sort]").forEach(th=>{
    const isSorted = th.dataset.sort === adminState.batchSort.col;
    th.classList.toggle("sorted", isSorted);
    th.classList.toggle("desc", isSorted && adminState.batchSort.dir==="desc");
    if(!th.querySelector(".sort-arrow")){
      th.innerHTML += `<span class="sort-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    }
    th.onclick = ()=>{
      if(adminState.batchSort.col === th.dataset.sort){
        adminState.batchSort.dir = adminState.batchSort.dir === "asc" ? "desc" : "asc";
      } else {
        adminState.batchSort = { col: th.dataset.sort, dir: "asc" };
      }
      adminState.batchPage = 1;
      renderBatches();
    };
  });

  /* row action wiring */
  tbody.querySelectorAll("[data-edit-batch]").forEach(btn=>{
    btn.addEventListener("click", ()=> openEditBatchModal(BATCHES.find(x=>String(x.id) === btn.dataset.editBatch)));
  });

  /* toolbar wiring */
  if($("#search-batches")) $("#search-batches").oninput = ()=>{ adminState.batchPage = 1; renderBatches(); };
  if($("#filter-batch-qa")) $("#filter-batch-qa").onchange = ()=>{ adminState.batchPage = 1; renderBatches(); };
  if($("#batch-page-size")){
    $("#batch-page-size").value = String(adminState.batchPageSize);
    $("#batch-page-size").onchange = (e)=>{ adminState.batchPageSize = +e.target.value; adminState.batchPage = 1; renderBatches(); };
  }

  const addBtn = $("#add-batch-btn");
  if(addBtn) addBtn.onclick = openAddBatchModal;
  const exportBtn = $("#export-batches-btn");
  if(exportBtn) exportBtn.onclick = exportBatchesCSV;
}

function nextBatchCode(){
  const nums = BATCHES.map(b=>{
    const m = b.lotCode.match(/B(\d+)$/);
    return m ? +m[1] : 0;
  });
  const next = Math.max(0, ...nums) + 1;
  return `JBF-2026-B${String(next).padStart(3,"0")}`;
}

function batchModalBody(b){
  const opts = PRODUCTS.filter(p=>!p.archived).map(p=>
    `<option value="${p.id}" ${b&&b.productId===p.id?"selected":""}>SKU-${escHtml(p.id.toUpperCase())} — ${escHtml(p.name)}</option>`
  ).join("");
  const gradeOpts = QUALITY_GRADES.map(g=>`<option ${b?.qualityGrade===g?"selected":""}>${escHtml(g)}</option>`).join("");
  const labOpts = Object.entries(LAB_STATUSES).map(([val,label])=>
    `<option value="${val}" ${b?.labStatus===val?"selected":""}>${escHtml(label)}</option>`
  ).join("");
  const todayStr = "2026-06-17";
  return `
    <div class="field"><label>Target Product SKU *</label>
      <select class="control" id="m-batch-product">${opts}</select>
    </div>
    <div class="field">
      <label>Batch Code * <span class="field-hint" style="margin:0;display:inline">(auto-generated or custom)</span></label>
      <input class="control" id="m-batch-lot" value="${escHtml(b?.lotCode || nextBatchCode())}" placeholder="JBF-2026-BXXX"/>
      <span class="field-error" id="m-batch-lot-err"></span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;min-width:0">
      <div class="field" style="min-width:0"><label>Harvest Date *</label><input class="control" type="date" id="m-batch-harvest" value="${b?.harvestDate||todayStr}" style="min-width:0;padding-inline:10px"/></div>
      <div class="field" style="min-width:0"><label>Production Date *</label><input class="control" type="date" id="m-batch-prod" value="${b?.prodDate||todayStr}" style="min-width:0;padding-inline:10px"/></div>
      <div class="field" style="min-width:0"><label>Expiration Date *</label><input class="control" type="date" id="m-batch-expiry" value="${b?.expiryDate||addDays(todayStr,365)}" style="min-width:0;padding-inline:10px"/></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field"><label>Quantity Produced (Units) *</label><input class="control" type="number" id="m-batch-total" value="${b?.totalQty||""}" min="0" placeholder="e.g. 300"/></div>
      <div class="field"><label>Quality Grade / Certificate *</label><select class="control" id="m-batch-grade">${gradeOpts}</select></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field"><label>QA Inspector Name *</label><input class="control" id="m-batch-inspector" value="${escHtml(b?.qaInspector||"")}" placeholder="e.g. Rosa Dela Torre (QA Inspector)"/></div>
      <div class="field"><label>Microbiological / Lab Status</label><select class="control" id="m-batch-qa">${labOpts}</select></div>
    </div>
    <div class="field"><label>QA Inspection &amp; Processing Notes</label><textarea class="control" id="m-batch-notes" rows="3" placeholder="e.g. Microbiological swab test zero pathogenic count.">${escHtml(b?.notes||"")}</textarea></div>
  `;
}

function openAddBatchModal(){
  openModal({
    title:"Register Production Batch Code",
    body: batchModalBody(null),
    large: true,
    confirmLabel:"Register Batch Code",
    onConfirm: async ()=>{
      const lot = $("#m-batch-lot").value.trim();
      if(!lot){ $("#m-batch-lot-err").textContent = "Batch code required."; return; }
      if(BATCHES.some(x=>x.lotCode.toLowerCase()===lot.toLowerCase())){ $("#m-batch-lot-err").textContent = "Batch code already exists."; return; }
      /* The locally-built batch object that used to live here is gone with the
         optimistic insert it existed for. It also carried two hardcoded
         "2026-06-17" harvest and production dates — bare string literals, so
         the date sweep that caught `new Date("2026-06-17")` never saw them. */
      /* D11: not added locally first. A duplicate lot code answers 409 and
         the catch returns — which used to leave an invented batch sitting in
         BATCHES, with an id the server had never issued, until the next reload.
         The same defect as the add-customer row. loadInventoryData() below
         brings back the real record, including the id the server assigned. */
      try {
        await EbApi.post("batches/save.php", {
          lot_code: lot,
          product_id: $("#m-batch-product").value,
          harvest_date: $("#m-batch-harvest")?.value || null,
          production_date: $("#m-batch-prod").value,
          expiry_date: $("#m-batch-expiry").value,
          /* #m-batch-total, not #m-batch-qty. The input is declared as
             id="m-batch-total"; "m-batch-qty" matched nothing, so this line
             threw "Cannot read properties of null" inside an async handler —
             swallowed as an unhandled rejection. Registering a batch through
             the UI did nothing at all, silently, while batches/save.php passed
             every test aimed at it. */
          total_qty: +$("#m-batch-total").value || 0,
          quality_grade: $("#m-batch-grade")?.value || null,
          /* #m-batch-qa, not #m-batch-lab. The optional chaining hid this one:
             the select never matched, so whatever QA status the inspector
             chose was discarded and every batch saved as "pending". */
          lab_status: $("#m-batch-qa")?.value || "pending",
          qa_inspector: $("#m-batch-inspector")?.value || null,
          notes: $("#m-batch-notes")?.value || null,
        });
        await loadInventoryData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Batch code registered.", "ok");
      adminState.batchPage = 1;
      renderBatches();
    }
  });
}

function openEditBatchModal(b){
  if(!b) return;
  openModal({
    title:`Edit Production Batch (${b.lotCode})`,
    body: batchModalBody(b),
    large: true,
    confirmLabel:"Save Changes",
    onConfirm: async ()=>{
      const lot = $("#m-batch-lot").value.trim();
      if(!lot){ $("#m-batch-lot-err").textContent = "Batch code required."; return; }
      if(BATCHES.some(x=>x.id!==b.id && x.lotCode.toLowerCase()===lot.toLowerCase())){ $("#m-batch-lot-err").textContent = "Batch code already exists."; return; }
      /* D11: the batch object is not touched until the server has accepted
         the change. Assigning these ten fields first meant a rejected save
         still showed the new lot code, dates and QA status on screen — the row
         claimed an edit the database had refused. */
      try {
        await EbApi.post("batches/save.php", {
          id: b.id,
          lot_code: $("#m-batch-lot").value.trim() || b.lotCode,
          product_id: $("#m-batch-product").value,
          harvest_date: $("#m-batch-harvest")?.value || b.harvestDate,
          production_date: $("#m-batch-prod").value,
          expiry_date: $("#m-batch-expiry").value,
          quality_grade: $("#m-batch-grade")?.value || null,
          lab_status: $("#m-batch-qa")?.value || b.labStatus,   /* see note above */
          qa_inspector: $("#m-batch-inspector")?.value || null,
          notes: $("#m-batch-notes")?.value || null,
        });
        await loadInventoryData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Batch updated.", "ok");
      renderBatches();
    }
  });
}

function exportBatchesCSV(){
  const rows = getFilteredSortedBatches();
  const header = ["Lot Code","Linked Product","SKU","Harvest Date","Production Date","Expiration Date","Remaining Qty","Total Qty","Quality Grade","Lab Status","QA Inspector","Notes"];
  const csvRows = rows.map(({b,p,expiryDate})=>[
    b.lotCode, p?.name||b.productId, b.productId.toUpperCase(), b.harvestDate, b.prodDate, expiryDate,
    b.remainingQty, b.totalQty, b.qualityGrade, LAB_STATUSES[b.labStatus]||b.labStatus, b.qaInspector||"", b.notes||""
  ]);
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  const csv = [header, ...csvRows].map(r=>r.map(esc).join(",")).join("\r\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `batch-tracking-${ymd(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("CSV exported.", "ok");
}

/* ============================================================
   MODULE: INVENTORY REPORT
   ============================================================ */
/* Inventory Report — server-paged.

   Stock-level and movement filtering moved into the query. Filtering a page
   client-side meant "show me everything critical" returned only the critical
   items that happened to be on the page you were looking at — a stock report
   that under-reports the very thing it exists to surface. */
function renderInventory(){
  EbPaginate.list(
    "inv-report",
    adminState.invReportPager,
    () => $("#inventory-tbody"),
    (page, limit) => EbApi.get("products/list.php", {
      page, limit, status: "all", sort: "name",
      search: $("#search-inventory")?.value || null,
      level: ($("#filter-inventory")?.value === "all" ? null : $("#filter-inventory")?.value) || null,
      movement: ($("#filter-movement")?.value === "all" ? null : $("#filter-movement")?.value) || null,
      expiring: ($("#filter-expiring")?.value === "all" ? null : $("#filter-expiring")?.value) || null,
      /* Level and movement are filters over the bands, so the window has to
         travel with them: "everything Critical as measured yesterday" is one
         question, not two. */
      window: stockWindowParam(),
    }),
    p => {
      const si  = stockInfo(p);
      const mt  = movementType(p);
      const inv = p.inventory || {};
      const risk = inv.expiryRisk;

      /* Cover is the answer to "how long does this last", so a product with no
         sales in the window has no answer — not "forever". Shown as a dash
         with the reason on hover rather than a number that would sort as the
         safest thing in the catalogue. */
      const cover = inv.daysCover == null
        ? `<span class="muted" title="No sales in ${escHtml(inv.windowLabel || "the window")} — no rate to measure cover against.">—</span>`
        : `<span title="${escHtml(inv.levelReason || "")}">${inv.daysCover}d</span>`;

      return `<tr>
      <td class="td-name">${escHtml(p.name)}${p.archived?` <span class="badge badge-muted" style="font-size:.62rem">archived</span>`:""}</td>
      <td class="muted">${escHtml(p.cat)}</td>
      <td><strong>${p.stock}</strong></td>
      <td><span class="badge ${si.cls}"${si.reason?` title="${escHtml(si.reason)}"`:""}>${si.label}</span></td>
      <td>${cover}</td>
      <td><span class="badge ${mt.cls}">${mt.label}</span></td>
      <td class="muted">${(inv.perMonth ?? 0).toFixed(1)}/mo</td>
      <td>${risk
        ? `<span class="badge badge-warn" title="${escHtml(risk.note || "")}">${risk.daysToExpiry < 0 ? "Expired" : "Will expire"}</span>`
        : `<span class="muted">—</span>`}</td>
      <td>${peso(p.price)}</td>
      <td>${p.sold.toLocaleString("en-PH")}</td>
    </tr>`;
    },
    {
      colspan: 10,
      empty: { title: "No products match filters", hint: "Adjust the search or filters." },
      after: (rows, meta) => paintStockWindowNote("#inv-window-note", meta),
    }
  );

  const reset = ()=>{ adminState.invReportPager.page = 1; renderInventory(); };
  [["#search-inventory","input",true],["#filter-inventory","change",false],["#filter-movement","change",false],["#filter-expiring","change",false]]
    .forEach(([sel, evt, deb])=>{
      const el = $(sel);
      if(el && !el.dataset.wired){
        el.dataset.wired = "1";
        el.addEventListener(evt, deb ? debounce(reset, 300) : reset);
      }
    });

  /* Its own wiring rather than a fifth entry in the list above: changing the
     window changes what "Critical" MEANS, so the state it writes is read by
     every other filter's fetch. */
  const winSel = $("#filter-inv-window");
  if(winSel && !winSel.dataset.wired){
    winSel.dataset.wired = "1";
    winSel.value = adminState.stockWindow;
    if(window.EbSelect) EbSelect.sync(winSel);
    winSel.addEventListener("change", ()=>{
      adminState.stockWindow = winSel.value;
      reset();
    });
  }
}


/* ============================================================
   MODULE: SALES REPORT
   ============================================================ */
/* D1: the server decides what a named range means; this reads the answer.

   These nine boundaries used to be computed here, in parallel with PHP
   computing them in api/reports/sales.php. The two disagreed: PHP's
   `monday this week` against JavaScript's `getDate()-getDay()` put the start of
   "This Week" a day apart, so the Sales Report headline and the table beneath
   it were measuring different periods. Neither was wrong on its own; having two
   answers was.

   SERVER_DATES is filled by loadServerDates() during init, before any screen
   renders. If it is somehow absent the range resolves to today only and says so
   — a visibly empty report beats one silently measuring the wrong week. */
let SERVER_DATES = null;

async function loadServerDates(){
  try {
    const { data } = await EbApi.get("system/dates.php");
    SERVER_DATES = data;
    if(data.mysqlAgrees === false){
      /* PHP and MySQL disagree about what day it is. Every endpoint mixing
         CURDATE() with a PHP date is then straddling a boundary. */
      console.error("[dates] PHP and MySQL disagree on today:", data.drift);
      toast("Server clock mismatch — date filters may be wrong. Tell an administrator.", "err");
    }
    return true;
  } catch(err){
    console.error("[dates]", err);
    return false;
  }
}

function getDateRange(range){
  if(range === "custom"){
    const t = SERVER_DATES?.today || dAgo(0);
    return { start: adminState.salesCustomFrom || t, end: adminState.salesCustomTo || t };
  }
  const r = SERVER_DATES?.ranges?.[range];
  if(r) return { start: r.from, end: r.to };

  const t = SERVER_DATES?.today || dAgo(0);
  if(SERVER_DATES) console.warn("[dates] unknown range:", range);
  return { start: t, end: t };
}

/* Kept client-side: this is arithmetic on two dates the server already
   produced, not a decision about what a period means. */
function getPrevRange(start, end){
  const s = parseYmd(start);
  const e = parseYmd(end);
  const days = Math.round((e-s)/864e5)+1;
  const pe = new Date(s); pe.setDate(pe.getDate()-1);
  const ps = new Date(pe); ps.setDate(ps.getDate()-days+1);
  return { start: ymd(ps), end: ymd(pe) };
}

function getSalesByRange(range){
  const {start, end} = getDateRange(range);
  return ORDERS.filter(tx=> tx.date >= start && tx.date <= end);
}

/* ============================================================
   MODULE: MY PROFILE
   ------------------------------------------------------------
   A staff member editing their own account. Deliberately NOT in
   MOD_PERM: everyone signed in owns one, so there is nothing to gate
   on, and navigate()'s guard only bounces modules listed there.

   Reads api/users/me.php rather than adminState.currentUser. The
   session copy is what was true at sign-in; an administrator may have
   changed this person's role or name since, and a profile screen
   showing a stale value is a profile screen nobody can trust.
   ============================================================ */
async function renderProfile(){
  const panel = $("#mod-profile");
  if(!panel) return;

  const setVal  = (sel, v) => { const el = $(sel); if(el) el.value = v ?? ""; };
  const setText = (sel, v) => { const el = $(sel); if(el) el.textContent = v ?? ""; };

  try {
    const { data } = await EbApi.get("users/me.php");
    setVal("#pf-name",   data.name);
    setVal("#pf-email",  data.email);
    setVal("#pf-avatar", data.avatar);
    /* Read-only, and shown so the operator can SEE what they cannot change —
       an absent field invites the question, a disabled one answers it. */
    setText("#pf-role",   data.role || "—");
    setText("#pf-status", data.status === "active" ? "Active" : data.status);
    setText("#pf-id",     data.id);
  } catch(err){
    toast("Could not load your profile: " + err.message, "err");
    return;
  }

  wireProfileForms();
}

/* Bound once. renderProfile() runs on every visit to the screen, and a second
   listener on the same form would submit it twice. */
function wireProfileForms(){
  const form = $("#profile-form");
  if(form && !form.dataset.wired){
    form.dataset.wired = "1";
    form.addEventListener("submit", onProfileSave);
  }
  const pw = $("#password-form");
  if(pw && !pw.dataset.wired){
    pw.dataset.wired = "1";
    pw.addEventListener("submit", onPasswordSave);
  }
}

/* Clear every field error on a form before a fresh submit, so a message from
   the previous attempt cannot be mistaken for this one's. */
function clearFieldErrors(ids){
  ids.forEach(id => { const el = $("#" + id); if(el) el.textContent = ""; });
}

/* Paint the server's field errors. The server is the authority on what is
   wrong — mirroring its rules in the browser is how the two come to disagree,
   so the client only shows what it is told. */
function showFieldErrors(fields, map){
  Object.entries(fields || {}).forEach(([k, msg]) => {
    const el = $("#" + (map[k] || ""));
    if(el) el.textContent = msg;
  });
}

async function onProfileSave(e){
  e.preventDefault();
  clearFieldErrors(["pf-name-err", "pf-email-err"]);
  const btn = $("#pf-save");
  const restore = EbUI.busy(btn, "Saving…");
  try {
    /* Only the three editable fields are sent. role_id and status are not
       omitted as a courtesy — me-save.php refuses them with a 403 — but there
       is no reason to send what will be rejected. */
    const { data } = await EbApi.post("users/me-save.php", {
      name:   $("#pf-name").value.trim(),
      email:  $("#pf-email").value.trim(),
      avatar: $("#pf-avatar").value.trim(),
    });

    /* The topbar chip, the sidebar and the user menu all show this person's
       name; leaving them on the old one until the next reload would make the
       save look like it had not worked. applySignedInUser() is the single
       function that paints all of them. */
    if(adminState.currentUser){
      adminState.currentUser.name   = data.name;
      adminState.currentUser.email  = data.email;
      adminState.currentUser.avatar = data.avatar;
      applySignedInUser(adminState.currentUser);
    }
    toast(data.changed.length ? "Profile updated" : "Nothing to change", "ok");
  } catch(err){
    showFieldErrors(err.fields, { name: "pf-name-err", email: "pf-email-err" });
    toast(err.message || "Could not save your profile.", "err");
  } finally { restore(); }
}

async function onPasswordSave(e){
  e.preventDefault();
  clearFieldErrors(["pf-current-err", "pf-new-err", "pf-confirm-err"]);
  const btn = $("#pf-pw-save");
  const restore = EbUI.busy(btn, "Updating…");
  try {
    await EbApi.post("users/me-password.php", {
      current_password: $("#pf-current").value,
      new_password:     $("#pf-new").value,
      confirm_password: $("#pf-confirm").value,
    });
    /* Cleared on success only. A failed attempt keeps what was typed, so a
       mistyped confirmation does not cost the other two fields as well. */
    ["#pf-current", "#pf-new", "#pf-confirm"].forEach(sel => { $(sel).value = ""; });
    toast("Password updated. Other devices signed in as you have been signed out.", "ok");
  } catch(err){
    showFieldErrors(err.fields, {
      current_password: "pf-current-err",
      new_password:     "pf-new-err",
      confirm_password: "pf-confirm-err",
    });
    toast(err.message || "Could not change your password.", "err");
  } finally { restore(); }
}

/* Best sellers for the selected range.

   RANKED BY REVENUE, AND THE PANEL SAYS SO. api/reports/sales.php orders by
   revenue deliberately — its comment: "ranking by units flatters cheap
   products; a report used to decide what to make more of should rank by what
   actually earned". The units column sits right beside the revenue one, so a
   reader who assumes the list is ordered by units would misread every row.
   The note under the heading is what stops that.

   AND IT SAYS WHICH PERIOD. The Landing Page module ranks best sellers by
   lifetime products.sold; this ranks by revenue within the chosen range. The
   two disagree by design, and a heading that does not name the period turns
   that into a bug report. */
function renderTopProducts(rows, from, to){
  const body = $("#top-products-body");
  if(!body) return;
  const note = $("#top-products-note");
  if(note) note.textContent = `ranked by revenue · ${fmtDate(from)} – ${fmtDate(to)}`;

  if(!rows || !rows.length){
    /* An empty table with headers reads as a broken query. A period with no
       sales is a fact, and says so. */
    body.innerHTML = `<div class="alert-empty">
      <strong>No sales in this period</strong>
      Nothing was sold between ${escHtml(fmtDate(from))} and ${escHtml(fmtDate(to))}.
    </div>`;
    return;
  }

  body.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr>
      <th style="width:52px">#</th><th>Product</th>
      <th class="num" title="Counted as the money arrives. A Net 30/60/90 order contributes its units in the same proportion as its payments, so half paid is half its units — see Payment Schemes for what is still owed.">Units</th><th class="num">Revenue</th>
    </tr></thead>
    <tbody>${rows.map((r,i)=>`<tr>
      <td class="num-cell muted">${i+1}</td>
      <td><strong>${escHtml(r.name)}</strong></td>
      <td class="num-cell">${r.units.toLocaleString()}</td>
      <td class="num-cell"><strong>${peso(r.revenue)}</strong></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

/* renderByMethod() stood here, drawing the "Payment Methods in Period" panel.
   The panel is gone from portal/views/sales.html and the two GROUP BY queries
   that fed it are gone from api/reports/sales.php, so there is no `byMethod`
   in the response to render any more. */

/* Where the Net figures in the Sales Report came from, stated rather than
   asked to be trusted: what was received on Net accounts in the period, and
   what was sold on terms but has not come in yet. */
function renderCreditNote(c){
  const el = $("#sales-credit-note");
  if(!el) return;
  if(!c || (!c.received && !c.bookedCount)){ el.innerHTML = ""; return; }
  el.innerHTML =
    `Includes <strong>${peso(c.received)}</strong> received on Net accounts ` +
    `(${c.receivedCount} payment${c.receivedCount === 1 ? "" : "s"}). ` +
    (c.bookedCount
      ? `Sold on credit this period: ${peso(c.bookedTotal)} across ${c.bookedCount} order${c.bookedCount === 1 ? "" : "s"} — <strong>${peso(c.notYetReceived)}</strong> not yet received.`
      : "");
}

function renderSales(range){
  adminState.salesRange = range;
  $$("[data-range]").forEach(btn=> btn.classList.toggle("active", btn.dataset.range===range));
  if(!$$("[data-range]").length) return;

  /* custom date row */
  const customRow = $("#custom-range-row");
  if(customRow) customRow.classList.toggle("show", range==="custom");

  const {start, end} = getDateRange(range);

  /* Rows for the table below still come from the loaded ORDERS array, but the
     HEADLINE FIGURES are asked for from the server.

     Two reasons. The client-side sum had no status filter, so a cancelled
     order counted as revenue — the report overstated every period containing
     one. And summing an array only works while the browser holds every order,
     which stops being true the moment the list is paged.

     api/reports/sales.php excludes cancelled orders and aggregates in SQL. */
  const txs    = ORDERS.filter(tx=> tx.date >= start && tx.date <= end);
  let total  = sumRevenue(txs) + receivedBetween(start, end);
  let orders = txs.filter(isSaleOrder).length;
  let avg    = orders ? Math.round(total/orders) : 0;
  const online = txs.filter(t=>t.type==="online").length;

  /* Replace the local estimate with the server's figures as soon as they
     arrive, and re-render. Deliberately not awaited: the panel paints
     immediately from what is already loaded rather than blocking on a
     request. */
  if(!adminState._salesFetching){
    adminState._salesFetching = true;
    EbApi.get("reports/sales.php", { range: "custom", from: start, to: end })
      .then(({ data }) => {
        adminState.salesReport = data;
        const set = (sel, val) => { const el = $(sel); if(el) el.textContent = val; };
        set("#sales-total-val", peso(data.totals.revenue));
        set("#sales-orders-val", data.totals.orders);
        set("#sales-avg-val", peso(data.totals.average));
        /* This arrived in every response since the endpoint was written and
           was never read. Rendered here, in the same pass, so it cannot fall
           out of step with the totals above it. */
        renderTopProducts(data.topProducts, start, end);
        renderCreditNote(data.credit);
      })
      .catch(err => console.warn("[sales]", err.message))
      .finally(() => { adminState._salesFetching = false; });
  }

  /* comparison */
  const cmpToggle = $("#compare-toggle");
  const cmpSelect = $("#compare-select");
  let cmpTotal = null, cmpOrders = null;
  if(cmpToggle && cmpToggle.checked){
    const cmpKey = cmpSelect ? cmpSelect.value : "prev";
    let cs, ce;
    if(cmpKey === "prev"){ const p=getPrevRange(start,end); cs=p.start; ce=p.end; }
    else { const r=getDateRange(cmpKey); cs=r.start; ce=r.end; }
    const cmpTxs = ORDERS.filter(tx=> tx.date>=cs && tx.date<=ce);
    /* Counted by the SAME rule as the current period. This used to be every
       order in the range, cancelled ones included, measured against a
       current figure that excluded them — so the Orders badge understated
       growth whenever the comparison period had a cancellation. */
    cmpTotal  = sumRevenue(cmpTxs) + receivedBetween(cs, ce);
    cmpOrders = cmpTxs.filter(isSaleOrder).length;
  }

  function deltaBadge(curr, prev){
    if(prev===null) return "";
    if(!prev) return `<div><span class="sales-cmp-badge flat">—</span></div>`;
    const pct = Math.round(((curr-prev)/prev)*100);
    const cls = pct>0?"up":pct<0?"down":"flat";
    return `<div><span class="sales-cmp-badge ${cls}">${pct>0?"+":""}${pct}% vs prev</span></div>`;
  }

  /* Ids so the server's figures can replace these in place when they land. */
  $("#sales-summary").innerHTML = `
    <div class="sales-sum-card"><div class="sales-sum-label">Total Revenue</div><div class="sales-sum-val" id="sales-total-val">${peso(total)}</div>${deltaBadge(total,cmpTotal)}</div>
    <div class="sales-sum-card"><div class="sales-sum-label">Orders</div><div class="sales-sum-val" id="sales-orders-val">${orders}</div>${deltaBadge(orders,cmpOrders)}</div>
    <div class="sales-sum-card"><div class="sales-sum-label">Average Order</div><div class="sales-sum-val" id="sales-avg-val">${peso(avg)}</div></div>
    <div class="sales-sum-card"><div class="sales-sum-label">Online Orders</div><div class="sales-sum-val">${online}</div></div>
    <div class="sales-credit-note muted" id="sales-credit-note" style="grid-column:1/-1;font-size:.8rem"></div>
  `;

  /* chart */
  const dateMap = {};
  txs.filter(isRevenue).forEach(tx=>{ dateMap[tx.date]=(dateMap[tx.date]||0)+orderTotal(tx); });
  CREDIT_RECEIPTS.filter(r => r.paidDate >= start && r.paidDate <= end)
    .forEach(r => { dateMap[r.paidDate] = (dateMap[r.paidDate] || 0) + r.amount; });
  const sortedDates = Object.keys(dateMap).sort();
  const chartData   = sortedDates.map(d=>dateMap[d]);
  const chartLabels = sortedDates.map(d=> new Date(d+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"numeric"}));

  if(!adminState.salesChartType) adminState.salesChartType = "area";

  function redrawSalesChart(){
    const svgEl = $("#sparkline-sales-report");
    if(!chartData.length){ if(svgEl) svgEl.innerHTML=`<text x="50%" y="50%" text-anchor="middle" fill="var(--text-muted)" font-size="14">No sales in this period</text>`; return; }
    const type = adminState.salesChartType;
    if(type==="bar")       drawBarChart(svgEl, chartData, { labels:chartLabels, color:"var(--gold)" });
    else if(type==="area") drawSparkline(svgEl, chartData, { labels:chartLabels, color:"var(--gold)", smooth:true, lineWidth:2 });
    else                   drawSparkline(svgEl, chartData, { labels:chartLabels, color:"var(--gold)" });
  }

  requestAnimationFrame(redrawSalesChart);
  observeChart($("#sparkline-sales-report"), redrawSalesChart);

  $$("[data-sales-chart]").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.salesChart === adminState.salesChartType);
    btn.onclick = ()=>{
      adminState.salesChartType = btn.dataset.salesChart;
      $$("[data-sales-chart]").forEach(b=> b.classList.toggle("active", b.dataset.salesChart===adminState.salesChartType));
      requestAnimationFrame(redrawSalesChart);
    };
  });

  /* Transactions table — server-paged over the selected date range.

     Line totals come from orders.total, not from re-multiplying each item by
     its product's current price. That recomputation is why a price change used
     to alter what past periods appeared to have earned.

     TWO KINDS OF ROW, from api/reports/transactions.php: orders placed in the
     period, and payments received against Net accounts in it. It used to be
     orders alone, which left the report contradicting itself — a retailer
     settling a July invoice raised September's revenue while September's list
     showed nothing that could account for it, so the money looked invented.
     Read that endpoint for why the union is paged in SQL rather than stitched
     together here. */
  EbPaginate.list(
    "sales",
    adminState.salesPager,
    () => $("#sales-tbody"),
    (page, limit) => EbApi.get("reports/transactions.php", {
      page, limit, from: start, to: end,
    }),
    tx => {
      const method = payMethodLabel(tx.payMethod);

      /* A PAYMENT IS NOT A SALE, and the row says so rather than dressing one
         up as the other: no items, the account it settles in their place, and
         the scheme on the reference. Its own row class tints it, but the words
         carry the distinction — colour alone would leave it to be guessed. */
      if(tx.kind === "payment"){
        const on = tx.orderId
          ? `Payment on ${escHtml(tx.orderId)}`
          : "Payment on a Net account";
        return `<tr class="row-payment">
      <td class="mono">${escHtml(tx.id)}<div class="muted" style="font-size:.7rem">${escHtml(tx.scheme || "Net")} payment</div></td>
      <td>${escHtml(tx.customer)}</td>
      <td style="font-size:.8rem;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${on}</td>
      <td><strong>${peso(tx.total)}</strong><div class="muted" style="font-size:.72rem">received</div></td>
      <td><span class="badge ${methodBadgeClass(method)}">${escHtml(method)}</span></td>
      <td class="muted">${fmtDate(tx.date)}</td>
    </tr>`;
      }

      const summary = (tx.items || []).map(i => `${i.name || i.id} ×${i.qty}`).join(", ");
      return `<tr>
      <td class="mono">${escHtml(tx.id)}</td>
      <td>${escHtml(tx.customer)}</td>
      <td style="font-size:.8rem;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(summary)}</td>
      <td><strong>${peso(tx.total)}</strong>${tx.credit
        ? `<div class="muted" style="font-size:.72rem">${peso(tx.credit.paidAmount)} received so far</div>` : ""}</td>
      <td><span class="badge ${methodBadgeClass(method)}">${escHtml(method)}</span></td>
      <td class="muted">${fmtDate(tx.date)}</td>
    </tr>`;
    },
    { colspan: 6, empty: { title: "No transactions in this period", hint: "Try a different date range." } }
  );

  /* wire controls */
  $$("[data-range]").forEach(btn=>{ btn.onclick = ()=>{ adminState.salesPager.page = 1; renderSales(btn.dataset.range); }; });

  const applyCustom = $("#apply-custom");
  if(applyCustom) applyCustom.onclick = ()=>{
    const f=$("#sales-from").value, t=$("#sales-to").value;
    if(f&&t){ adminState.salesCustomFrom=f; adminState.salesCustomTo=t; renderSales("custom"); }
  };

  if(cmpToggle) cmpToggle.onchange = ()=>{
    /* Disabled, not hidden. The selector used to be display:none until the
       box was ticked, so the row re-flowed — and its width changed — on every
       click. It now stays put and greys out, which also leaves it visible
       that there is a period to choose once this is switched on.

       EbSelect mirrors the native <select> into its own trigger through a
       MutationObserver, and that observer does not watch ATTRIBUTES — so
       `disabled` has to be pushed across by hand. Without the sync the custom
       trigger stays clickable over a disabled select. */
    if(cmpSelect){
      cmpSelect.disabled = !cmpToggle.checked;
      if(window.EbSelect && EbSelect.sync) EbSelect.sync(cmpSelect);
    }
    renderSales(adminState.salesRange);
  };
  if(cmpSelect) cmpSelect.onchange = ()=> renderSales(adminState.salesRange);
}

/* ============================================================
   MODULE: PAYMENT SCHEMES
   ============================================================ */
/* Payment Schemes — Net accounts, and every payment toward them.

   The figures are the server's (payments/list.php → Payments::describeAccount):
   billed, paid so far, waiting for review, penalty and what is left. The same
   function feeds the retailer's own Payment Schemes page, so the two cannot
   disagree.

   "Mark Paid" is gone. A payment is recorded for what actually arrived (Record
   payment), and a retailer's own payments are verified or rejected one at a
   time (Review). The account marks itself paid once they cover it. Sorting is
   the server's — waiting-for-review first, then overdue, then by due date —
   because a column sort could only ever reorder the page on screen. */
const PAY_STATE_BADGE = {
  paid:    ["badge-ok",   "Paid"],
  overdue: ["badge-out",  "Overdue"],
  partial: ["badge-info", "Partly paid"],
  pending: ["badge-warn", "Unpaid"],
};
const CP_METHOD_LABEL = { gcash: "GCash", bank: "Bank Transfer", cash: "Cash" };
const CP_STATUS_BADGE = {
  pending:  ["badge-warn", "Waiting for review"],
  verified: ["badge-ok",   "Verified"],
  rejected: ["badge-out",  "Rejected"],
};

function renderPayments(){
  const penaltyEl = $("#penalty-rate");
  if(penaltyEl) penaltyEl.value = adminState.penaltyRate;

  const filterEl = $("#pay-filter");
  if(filterEl && !filterEl.dataset.wired){
    filterEl.dataset.wired = "1";
    filterEl.addEventListener("change", ()=>{ adminState.payPager.page = 1; renderPayments(); });
  }
  const filter = filterEl ? filterEl.value : "all";

  EbPaginate.list(
    "pay",
    adminState.payPager,
    () => $("#payments-tbody"),
    (page, limit) => EbApi.get("payments/list.php", { page, limit, filter }),
    a => {
      const [cls, label] = PAY_STATE_BADGE[a.state] || ["badge-warn", a.state];
      return `<tr class="${a.overdue ? "overdue-flag" : ""}">
      <td class="td-name">${escHtml(a.name)}<div class="muted" style="font-size:.72rem">${escHtml(a.orderId || a.id)}</div></td>
      <td><span class="badge badge-info">${escHtml(a.scheme)}</span></td>
      <td>${peso(a.billed)}${a.penalty ? `<div class="muted" style="font-size:.72rem">+${peso(a.penalty)} penalty</div>` : ""}</td>
      <td>${peso(a.paidAmount)}${a.pendingCount ? `<div style="font-size:.72rem;color:var(--warn)">${a.pendingCount} waiting · ${peso(a.pendingAmount)}</div>` : ""}</td>
      <td>${a.settled ? `<span class="muted">—</span>` : `<strong>${peso(a.remaining)}</strong>`}</td>
      <td class="${a.overdue ? "" : "muted"}">${fmtDate(a.dueDate)}${a.overdue ? ` <span class="muted" style="font-size:.72rem">(${a.daysPastDue}d late)</span>` : ""}</td>
      <td><span class="badge ${cls}">${label}</span></td>
      <td><div class="td-actions">
        <button class="btn ${a.pendingCount ? "btn-gold" : "btn-ghost"} btn-sm" data-review-pay="${escHtml(a.id)}">${a.pendingCount ? `Review (${a.pendingCount})` : "View"}</button>
        ${a.settled ? "" : `<button class="btn btn-ok btn-sm" data-record-pay="${escHtml(a.id)}">Record payment</button>`}
      </div></td>
    </tr>`;
    },
    {
      colspan: 8,
      empty: { title: "No payment accounts", hint: "Retailer Net accounts appear here once a Net order is placed." },
      after: (rows, meta) => {
        PAYMENT_ACCOUNTS.length = 0; rows.forEach(r => PAYMENT_ACCOUNTS.push(r));
        if(meta.penaltyRate != null) adminState.penaltyRate = meta.penaltyRate;
        const sum = $("#pay-summary");
        if(sum){
          sum.innerHTML = `
            <span><strong>${peso(meta.outstanding || 0)}</strong> outstanding</span>
            <span>${meta.overdueCount || 0} overdue</span>
            <span>${meta.reviewCount
              ? `<strong style="color:var(--warn)">${meta.reviewCount} payment${meta.reviewCount === 1 ? "" : "s"} waiting for review</strong> (${peso(meta.reviewAmount)})`
              : "No payments waiting for review"}</span>`;
        }
        wirePaymentRowActions();
      },
    }
  );

  const saveBtn = $("#save-penalty-btn");
  if(saveBtn) saveBtn.onclick = ()=>{
    /* The rate lives in the settings table. Previously it was held only in
       adminState, so it reset on every reload and the penalties shown were
       computed from a number nobody had actually saved. */
    const rate = +$("#penalty-rate").value || 0;
    EbApi.post("settings/save.php", { penalty_rate: rate })
      .then(async () => {
        adminState.penaltyRate = rate;
        await loadOpsData();
        toast(`Penalty rate set to ${rate}%.`, "ok");
        renderPayments();
      })
      .catch(err => toast(err.message, "err"));
  };
}

/* Row actions, wired after each page is drawn — the rows are rendered by
   EbPaginate.list after renderPayments() has returned. */
function wirePaymentRowActions(){
  document.querySelectorAll("#payments-tbody [data-review-pay]").forEach(btn=>{
    btn.addEventListener("click", ()=> openPaymentReview(btn.dataset.reviewPay));
  });
  document.querySelectorAll("#payments-tbody [data-record-pay]").forEach(btn=>{
    btn.addEventListener("click", ()=> openRecordPayment(btn.dataset.recordPay));
  });
}

/* One account: its order, its figures, and every payment toward it — amount,
   date, method, reference and screenshot — newest first. This is where three
   separate transfers toward one balance are read side by side. A payment the
   retailer sent can be verified, or rejected with a reason they will see. */
async function openPaymentReview(id){
  let data;
  try { ({ data } = await EbApi.get("payments/get.php", { id })); }
  catch(err){ toast(err.message, "err"); return; }
  const a = data.account, o = data.order;

  const rows = data.payments.map(p => {
    const [cls, label] = CP_STATUS_BADGE[p.status] || ["badge-muted", p.status];
    const shot = p.proof ? imageUrl(p.proof) : "";
    const via = p.source === "customer" ? "sent by the retailer"
              : p.source === "staff"    ? "recorded at the counter"
              : "settled before payment tracking";
    return `
      <div class="cp-row cp-${escHtml(p.status)}">
        <div class="cp-main">
          <div class="cp-amount">${peso(p.amount)} <span class="badge ${cls}">${label}</span></div>
          <div class="muted cp-meta">Paid ${fmtDate(p.paidDate)} · ${escHtml(CP_METHOD_LABEL[p.method] || "method not recorded")}${p.refNum ? ` · ref <code>${escHtml(p.refNum)}</code>` : ""} · ${via}</div>
          ${p.note ? `<div class="muted cp-meta">${escHtml(p.note)}</div>` : ""}
          ${p.decidedBy ? `<div class="muted cp-meta">${p.status === "rejected" ? "Rejected" : "Verified"} by ${escHtml(p.decidedBy)}, ${fmtDateTime(p.decidedAt)}</div>` : ""}
          ${p.status === "rejected" && p.rejectReason ? `<div class="cp-reason">Reason: ${escHtml(p.rejectReason)}</div>` : ""}
          ${p.status === "pending" ? `
            <div class="cp-actions">
              <button class="btn btn-ok btn-sm" data-cp-verify="${p.id}">Verify</button>
              <button class="btn btn-ghost-danger btn-sm" data-cp-reject="${p.id}">Reject…</button>
            </div>
            <div class="cp-reject hide" data-cp-reject-box="${p.id}">
              <textarea class="control" rows="2" maxlength="500" placeholder="Why is this payment rejected? The retailer sees this." data-cp-reason="${p.id}"></textarea>
              <button class="btn btn-ghost-danger btn-sm" data-cp-reject-go="${p.id}">Reject payment</button>
            </div>` : ""}
        </div>
        ${shot ? `<a class="cp-shot" href="${escHtml(shot)}" target="_blank" rel="noopener noreferrer" title="Open full size"><img src="${escHtml(shot)}" alt="Payment screenshot" loading="lazy"></a>` : ""}
      </div>`;
  }).join("") || `<p class="muted">No payments yet.</p>`;

  openModal({
    title: `${a.name} — ${a.scheme}`,
    large: true,
    body: `
      <div class="cp-summary">
        <div><span class="muted">Order</span><strong>${o ? escHtml(o.id) : "—"}</strong>${o ? `<small class="muted">${fmtDate(o.date)} · ${escHtml(o.status)}</small>` : ""}</div>
        <div><span class="muted">Billed</span><strong>${peso(a.billed)}</strong></div>
        <div><span class="muted">Paid</span><strong>${peso(a.paidAmount)}</strong></div>
        ${a.penalty ? `<div><span class="muted">Penalty</span><strong style="color:var(--out-ink)">${peso(a.penalty)}</strong></div>` : ""}
        <div><span class="muted">Left</span><strong>${peso(a.remaining)}</strong></div>
        <div><span class="muted">Due</span><strong>${fmtDate(a.dueDate)}</strong>${a.overdue ? `<small style="color:var(--out-ink)">${a.daysPastDue} days late</small>` : ""}</div>
      </div>
      <div class="cp-list">${rows}</div>`,
    confirmLabel: null,
    cancelLabel: "Close",
    onOpen: () => wirePaymentReview(id),
  });
}

function wirePaymentReview(accountId){
  const list = document.querySelector(".cp-list");
  if(!list) return;
  const decide = async (pid, decision, reason) => {
    try {
      const { data } = await EbApi.post("payments/decide.php", { payment_id: +pid, decision, reason });
      toast(decision === "verify"
        ? `Payment verified — ${data.account.settled ? "account settled" : peso(data.account.remaining) + " left"}.`
        : "Payment rejected. The retailer will see your reason.", "ok");
      closeModal();
      renderPayments();
      loadOpsData();
      /* Reopened, so the next payment on the same account can be checked
         without hunting for the row again. */
      openPaymentReview(accountId);
    } catch(err){ toast(err.message, "err"); }
  };
  list.querySelectorAll("[data-cp-verify]").forEach(b =>
    b.addEventListener("click", () => decide(b.dataset.cpVerify, "verify")));
  list.querySelectorAll("[data-cp-reject]").forEach(b =>
    b.addEventListener("click", () => {
      list.querySelector(`[data-cp-reject-box="${b.dataset.cpReject}"]`)?.classList.toggle("hide");
    }));
  list.querySelectorAll("[data-cp-reject-go]").forEach(b =>
    b.addEventListener("click", () => {
      const pid = b.dataset.cpRejectGo;
      const reason = list.querySelector(`[data-cp-reason="${pid}"]`).value.trim();
      if(!reason){ toast("Say why the payment is rejected — the retailer sees this.", "warn"); return; }
      decide(pid, "reject", reason);
    }));
}

/* Money received at the counter (or a transfer staff watched arrive), recorded
   as exactly what came in. Verified at once by the person recording it. */
function openRecordPayment(id){
  const a = PAYMENT_ACCOUNTS.find(x => String(x.id) === String(id));
  if(!a) return;
  const today = (typeof SERVER_DATES !== "undefined" && SERVER_DATES?.today) || ymd(new Date());
  openModal({
    title: `Record payment — ${a.name}`,
    body: `
      <p style="font-size:.88rem;margin-bottom:12px">${escHtml(a.scheme)} · billed ${peso(a.billed)} · paid ${peso(a.paidAmount)} · <strong>${peso(a.payable)} can be recorded</strong>${a.pendingAmount ? ` (${peso(a.pendingAmount)} sent by the retailer is waiting for review)` : ""}.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label>Amount received</label><input class="control" type="number" step="0.01" min="0.01" max="${a.payable}" id="m-rp-amount" value="${a.payable.toFixed(2)}"><span class="field-error" id="m-rp-amount-err"></span></div>
        <div class="field"><label>Method</label><select class="control" id="m-rp-method"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="bank">Bank Transfer</option></select></div>
        <div class="field"><label>Reference number</label><input class="control" id="m-rp-ref" maxlength="100" placeholder="Required for GCash / bank"><span class="field-error" id="m-rp-ref-err"></span></div>
        <div class="field"><label>Date received</label><input class="control" type="date" id="m-rp-date" value="${today}" max="${today}"></div>
      </div>
      <div class="field"><label>Note (optional)</label><input class="control" id="m-rp-note" maxlength="500"></div>`,
    confirmLabel: "Record payment",
    confirmClass: "btn-ok",
    onConfirm: async ()=>{
      $("#m-rp-amount-err").textContent = "";
      $("#m-rp-ref-err").textContent = "";
      try {
        const { data } = await EbApi.post("payments/record.php", {
          account_id: a.id,
          amount:     parseFloat($("#m-rp-amount").value),
          method:     $("#m-rp-method").value,
          ref_num:    $("#m-rp-ref").value.trim() || null,
          paid_date:  $("#m-rp-date").value || null,
          note:       $("#m-rp-note").value.trim() || null,
        });
        closeModal();
        toast(`Recorded ${peso(data.payment.amount)} — ${data.account.settled ? "account settled" : peso(data.account.remaining) + " left"}.`, "ok");
        await loadOpsData();
        renderPayments();
      } catch(err){
        const f = err.fields || {};
        if(f.amount)  $("#m-rp-amount-err").textContent = f.amount;
        if(f.ref_num) $("#m-rp-ref-err").textContent = f.ref_num;
        if(!f.amount && !f.ref_num) toast(err.message, "err");
      }
    }
  });
}

/* ============================================================
   MODULE: TRANSACTION HISTORY
   ============================================================ */
/* Payment History — server-paged.

   Totals come from orders.total (what was charged) rather than being
   recomputed from each product's current price, which is what txTotal(items)
   did — a price edit silently rewrote historical transaction amounts. */
function renderTransactions(){
  EbPaginate.list(
    "tx",
    adminState.txPager,
    () => $("#transactions-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      page, limit, sort: "newest",
      search: $("#search-transactions")?.value || null,
      type: ($("#filter-tx-type")?.value === "all" ? null : $("#filter-tx-type")?.value) || null,
    }),
    tx => {
      const summary = (tx.items || []).map(i => `${i.name || i.id} ×${i.qty}`).join(", ");
      const method = payMethodLabel(tx.payMethod);
      return `
    <tr>
      <td class="mono">${escHtml(tx.id)}</td>
      <td class="td-name">${escHtml(tx.customer)}</td>
      <td style="font-size:.8rem;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(summary)}">${escHtml(summary)}</td>
      <td style="font-size:.75rem;color:var(--text-muted)">${escHtml(tx.batch || "—")}</td>
      <td><strong>${peso(tx.total)}</strong></td>
      <td><span class="badge ${methodBadgeClass(method)}">${escHtml(method)}</span></td>
      <td><span class="badge ${tx.type==="online"?"badge-ok":"badge-warn"}">${escHtml(tx.type)}</span></td>
      <td class="muted" style="font-size:.8rem">${escHtml(tx.contact || "—")}</td>
      <td class="mono" style="font-size:.78rem">${tx.trackingNumber ? escHtml(tx.trackingNumber) : `<span class="muted">—</span>`}</td>
      <td class="muted">${fmtDate(tx.date)}</td>
    </tr>`;
    },
    {
      colspan: 10,
      empty: { title: "No transactions found", hint: "Adjust the search or filters." },
    }
  );

  /* The payment-method filter is applied client-side to the loaded page for
     now: orders/list.php has no method filter, and adding one belongs with
     that endpoint rather than being faked here. Noted rather than hidden. */
  const reset = ()=>{ adminState.txPager.page = 1; renderTransactions(); };
  if($("#search-transactions") && !$("#search-transactions").dataset.wired){
    $("#search-transactions").dataset.wired = "1";
    $("#search-transactions").addEventListener("input", debounce(reset, 300));
  }
  if($("#filter-tx-type") && !$("#filter-tx-type").dataset.wired){
    $("#filter-tx-type").dataset.wired = "1";
    $("#filter-tx-type").addEventListener("change", reset);
  }
}


/* ============================================================
   MODULE: AUDIT LOG
   ============================================================ */
/* Audit log — server-paged.

   The most important of the conversions: this table grows by one row for every
   action anyone takes, forever. Filtering and slicing it in the browser meant
   downloading the entire history to show ten lines of it, and the search box
   only ever searched the rows that happened to be loaded. */
function renderAudit(){
  const typeColors = { restock:"badge-ok", user:"badge-info", product:"badge-warn", order:"badge-purple", system:"badge-crit" };

  EbPaginate.list(
    "audit",
    adminState.auditPager,
    () => $("#audit-tbody"),
    (page, limit) => EbApi.get("audit/list.php", {
      page, limit,
      search: $("#search-audit")?.value || null,
      type: ($("#filter-audit-type")?.value === "all" ? null : $("#filter-audit-type")?.value) || null,
    }),
    e => `
    <tr>
      <td style="white-space:nowrap;font-size:.82rem;color:var(--text-muted)">${fmtDateTime(e.ts)}</td>
      <td class="td-name">${escHtml(e.actor)}${e.actorArchived ? ` <span class="badge badge-muted" title="This account has since been archived">archived</span>` : ""}</td>
      <td><span class="badge ${typeColors[e.type]||"badge-muted"}">${escHtml(e.type)}</span></td>
      <td style="font-size:.88rem">${escHtml(e.desc)}</td>
    </tr>`,
    {
      colspan: 4,
      empty: { title: "No log entries found", hint: "Adjust the search or type filter." },
      after: (rows, meta) => {
        /* Populate the type filter from what the log actually contains rather
           than a hardcoded list that drifts as new entry types appear. */
        const sel = $("#filter-audit-type");
        if(sel && meta.types && !sel.dataset.filled){
          sel.dataset.filled = "1";
          const current = sel.value;
          sel.innerHTML = `<option value="all">All types</option>` +
            meta.types.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join("");
          sel.value = current || "all";
        }
      },
    }
  );

  /* Filters reset to page 1 — staying on page 9 of a narrower result set shows
     nothing and reads as "no matches". */
  const reset = ()=>{ adminState.auditPager.page = 1; renderAudit(); };
  if($("#search-audit") && !$("#search-audit").dataset.wired){
    $("#search-audit").dataset.wired = "1";
    $("#search-audit").addEventListener("input", debounce(reset, 300));
  }
  if($("#filter-audit-type") && !$("#filter-audit-type").dataset.wired){
    $("#filter-audit-type").dataset.wired = "1";
    $("#filter-audit-type").addEventListener("change", reset);
  }
}

/* Typing in a search box now costs a request per keystroke, so it waits for a
   pause. 300ms is short enough to feel immediate and long enough that a
   ten-character search is one request rather than ten. */
function debounce(fn, ms){
  let t;
  return (...args)=>{ clearTimeout(t); t = setTimeout(()=>fn(...args), ms); };
}

/* ============================================================
   MODULE: ROLES & PERMISSIONS
   ============================================================ */
function slugify(name){
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"") || "role";
}

function permAreas(){
  const areas = {};
  Object.entries(PERMISSIONS).forEach(([key, def])=>{
    (areas[def.area] ||= []).push({ key, ...def });
  });
  return areas;
}

function roleCard(role, index, isSuperAdmin){
  const areas = permAreas();
  const granted = isSuperAdmin ? null : (ROLE_PERMISSIONS[role] || (ROLE_PERMISSIONS[role]=[]));
  const totalPerms = isSuperAdmin ? Object.keys(PERMISSIONS).length : granted.length;
  const meta = isSuperAdmin
    ? { slug:"super-admin", desc:"Full unrestricted system access, RBAC control, and account management." }
    : (ROLE_META[role] || { slug:slugify(role), desc:"Custom role — no description set." });

  const modules = Object.entries(areas).map(([area, perms])=>{
    const rows = perms.map(p=>{
      /* A Super-Admin-only permission is shown to every role — so it is plain
         that it exists and who holds it — but locked off. The server refuses it
         anyway (Rbac::SYSTEM_ONLY); a switch that looks usable and then fails
         on save would only teach people to distrust the screen. */
      const reserved = !isSuperAdmin && !!p.systemOnly;
      const checked = isSuperAdmin || (!reserved && granted.includes(p.key));
      const locked  = isSuperAdmin || reserved;
      return `<label class="role-toggle-row ${locked?"locked":""}"${reserved?` title="Super Admin only — this cannot be granted to another role."`:""}>
        <span>${escHtml(p.label)}${p.systemOnly?` <span class="badge badge-muted" style="font-size:.6rem">Super Admin only</span>`:""}</span>
        <span class="switch">
          <input type="checkbox" data-role="${escHtml(role)}" data-perm-key="${p.key}" ${checked?"checked":""} ${locked?"disabled":""}/>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </span>
      </label>`;
    }).join("");
    return `<div class="role-module-label">${escHtml(area)} Module</div>${rows}`;
  }).join("");

  return `<div class="role-card" data-role-card="${escHtml(role)}">
    <div class="role-card-head">
      <div>
        <h3>${escHtml(role)}</h3>
        <span class="role-slug-badge">${escHtml(meta.slug)}</span>
      </div>
      <div class="role-head-actions">
      ${ROLE_DEFAULTS[role] ? `<button class="btn btn-ghost btn-sm" data-default-role="${escHtml(role)}" title="Restore this role's original permissions">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        Default
      </button>` : ""}
      <button class="btn btn-ghost btn-sm" data-save-role="${escHtml(role)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        Save Matrix
      </button>
      </div>
    </div>
    <p class="role-desc">${escHtml(meta.desc)}</p>
    <!-- Master switch: every permission this role can be given, on or off in
         one go. Super-Admin-only permissions stay locked either way. -->
    <label class="role-toggle-row role-all ${isSuperAdmin?"locked":""}">
      <span><strong>All permissions</strong><small>Turn every permission on or off</small></span>
      <span class="switch">
        <input type="checkbox" data-role-all="${escHtml(role)}" ${isSuperAdmin?"checked disabled":""}/>
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </span>
    </label>
    ${modules}
    <div class="role-card-foot">
      <span>Role ID: #${index}</span>
      <span>Total Permissions: <strong data-role-total="${escHtml(role)}">${totalPerms}</strong></span>
    </div>
  </div>`;
}

function renderRoles(){
  const roles = ["Super Admin", ...Object.keys(ROLE_PERMISSIONS)];
  $("#roles-matrix").innerHTML = roles.map((role,i)=> roleCard(role, i+1, role==="Super Admin")).join("");

  /* The master switch reflects "is everything grantable on?", and flipping it
     sets every grantable switch through their own change handlers below, so the
     role's list and total stay in step exactly as with single clicks. */
  const permBoxes = card => [...card.querySelectorAll("input[data-perm-key]:not(:disabled)")];
  const syncAll = card => {
    const all = card.querySelector("input[data-role-all]");
    if(!all || all.disabled) return;
    const boxes = permBoxes(card);
    all.checked = boxes.length > 0 && boxes.every(b => b.checked);
    all.indeterminate = !all.checked && boxes.some(b => b.checked);
  };
  $$("#roles-matrix [data-role-card]").forEach(syncAll);
  /* Default: set each grantable switch to the factory list, through the
     same change handlers, so the list, the total and the master stay in
     step. Nothing is stored until Save Matrix. */
  $$("#roles-matrix [data-default-role]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const card = btn.closest("[data-role-card]");
      const want = new Set(ROLE_DEFAULTS[btn.dataset.defaultRole] || []);
      permBoxes(card).forEach(b=>{
        const on = want.has(b.dataset.permKey);
        if(b.checked !== on){ b.checked = on; b.dispatchEvent(new Event("change")); }
      });
      syncAll(card);
      toast(`${btn.dataset.defaultRole} reset to default — click Save Matrix to keep it.`, "ok");
    });
  });

  $$("#roles-matrix input[data-role-all]:not(:disabled)").forEach(all=>{
    all.addEventListener("change", ()=>{
      const card = all.closest("[data-role-card]");
      const on = all.checked;   /* read once: each box's handler re-syncs `all` */
      permBoxes(card).forEach(b=>{
        if(b.checked !== on){ b.checked = on; b.dispatchEvent(new Event("change")); }
      });
      syncAll(card);
    });
  });

  $$("#roles-matrix input[data-perm-key]:not(:disabled)").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      syncAll(cb.closest("[data-role-card]"));
      const role = cb.dataset.role;
      const key  = cb.dataset.permKey;
      const list = ROLE_PERMISSIONS[role] || (ROLE_PERMISSIONS[role]=[]);
      if(cb.checked){
        if(!list.includes(key)) list.push(key);
      } else {
        const i = list.indexOf(key);
        if(i>-1) list.splice(i,1);
      }
      const totalEl = $(`[data-role-total="${role}"]`);
      if(totalEl) totalEl.textContent = list.length;
      /* if the change affects the currently logged-in user's own role, refresh their nav immediately */
      if(adminState.currentUser?.role === role) applyRBAC();
    });
  });

  $$("#roles-matrix [data-save-role]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const role = btn.dataset.saveRole;
      if(role === "Super Admin"){ toast("Super Admin always has full access.", "warn"); return; }

      /* This used to toast "saved" and write a local audit line — the checkbox
         changes lived in ROLE_PERMISSIONS in memory and were gone on reload.
         The screen that decides everyone's access was the one screen that
         silently discarded its edits. */
      const roleRow = (adminState.roleList || []).find(r => r.name === role);
      if(!roleRow){ toast(`Could not identify role "${role}". Reload and try again.`, "err"); return; }

      const restore = EbUI.busy(btn, "Saving…");
      try {
        await EbApi.post("roles/save.php", {
          id: roleRow.id,
          name: role,
          description: (ROLE_META[role] && ROLE_META[role].desc) || null,
          permissions: ROLE_PERMISSIONS[role] || [],
        });
        await loadAdminData();
        /* Re-read the signed-in user's own permissions: if they just changed
           their own role's grants, the nav must reflect it now rather than
           after a reload. */
        await EbSession.bootstrap();
        applyRBAC();
        toast(`${role} permission matrix saved.`, "ok");
        renderRoles();
      } catch(err){
        /* The server refuses removing rbac.manage from your own role, and
           refuses editing a system role. Both messages are worth showing. */
        toast(err.message, "err");
        await loadAdminData();
        renderRoles();
      } finally { restore(); }
    });
  });

  $("#add-role-btn").onclick = ()=>{
    openModal({
      title:"Create New Role",
      body:`<div class="field"><label>Role Name</label>
              <input class="control" id="m-role-name" placeholder="e.g. Warehouse Supervisor"/>
              <span class="field-error" id="m-role-name-err"></span></div>
            <div class="field"><label>Slug <span style="font-weight:400;color:var(--text-muted)">(auto-generated, editable)</span></label>
              <input class="control" id="m-role-slug" placeholder="warehouse-supervisor"/></div>
            <div class="field"><label>Description</label>
              <textarea class="control" id="m-role-desc" rows="2" placeholder="What this role is for…"></textarea></div>`,
      confirmLabel:"Create Role", confirmClass:"btn-red",
      onConfirm: async ()=>{
        const name = $("#m-role-name").value.trim();
        const err  = $("#m-role-name-err");
        err.textContent = "";
        if(!name){ err.textContent = "Role name is required."; return; }
        if(name === "Super Admin" || ROLE_PERMISSIONS[name]){ err.textContent = "A role with this name already exists."; return; }
        const desc = $("#m-role-desc").value.trim() || "Custom role — no description set.";
        try {
          /* Creates the row server-side and returns its id, so the new role can
             be granted permissions immediately. Previously it existed only in
             three in-memory objects and vanished on reload. */
          await EbApi.post("roles/save.php", { name, description: desc, permissions: [] });
          await loadAdminData();
          if(!ROLES.includes(name)) ROLES.push(name);
        } catch(e){
          err.textContent = e.message;
          return;
        }
        closeModal();
        toast(`Role "${name}" created.`, "ok");
        renderRoles();
      }
    });
    setTimeout(()=>{
      const nameEl = $("#m-role-name"), slugEl = $("#m-role-slug");
      nameEl?.addEventListener("input", ()=>{ slugEl.value = slugify(nameEl.value); });
    }, 60);
  };
}

/* ============================================================
   MODAL CLOSE WIRING
   ============================================================ */
function initModal(){
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-overlay").addEventListener("click", e=>{
    if(e.target === $("#modal-overlay")) closeModal();
  });
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape" && $("#modal-overlay").classList.contains("open")) closeModal();
  });
}

/* ============================================================
   MODULE DESCRIPTIONS
   One-line "what this screen is for" note rendered under each
   module heading. Injected once at startup so every panel stays
   in sync from a single map instead of duplicated markup.
   ============================================================ */
const MOD_DESC = {
  pos:            "Ring up walk-in customers — pick products, build the cart, then send it to checkout.",
  "pos-payment":     "Take payment for the current walk-in cart and issue the customer's receipt.",
  notifications:  "Every system alert in one place — new orders, payments, stock levels, returns and audit events.",
  "online-txns":     "Browse all online orders with their current status, customer details and totals.",
  ordersqueue:    "Incoming orders awaiting review — accept, place on hold, or cancel each one.",
  paymentverify:  "Check uploaded payment proofs against order totals before approving them.",
  orderstatus:    "Move accepted orders forward through shipping, delivery and completion.",
  orderhistory:   "Full record of completed online transactions for reference and reporting.",
  receipts:       "Generate and print official receipts for any online order.",
  returns:        "Handle return requests end to end — validate, approve, then process the refund.",
  users:          "Create and maintain customer and employee accounts, including roles and archiving.",
  b2b:            "Review business partner applications and assign Net 30/60/90 credit tiers.",
  landing:        "Edit the public website's About, Vision, Mission, contact details and FAQs.",
  products:       "Manage the product catalog and the varieties customers can order from.",
  inventory:      "Read-only stock report — levels, movement speed and pricing across every product.",
  "inventory-manage": "Restock, replenish in bulk, record disposals and returns, and archive products.",
  expiry:         "Track batch expiry dates and dispose of stock before it goes out of date.",
  sales:          "Revenue, order volume and trends over any date range, with comparison periods.",
  payments:       "Monitor retailer credit terms, outstanding balances and overdue accounts.",
  transactions:   "Complete ledger of every walk-in and online sale recorded by the system.",
  audit:          "Chronological log of every staff action taken across the system.",
};

function initModDescriptions(){
  Object.entries(MOD_DESC).forEach(([mod, text])=>{
    const panel = document.getElementById("mod-" + mod);
    if(!panel) return;
    const h2 = panel.querySelector(".mod-header h2");
    /* Skip panels that already carry their own hand-written hint. */
    if(!h2 || h2.nextElementSibling?.tagName === "P") return;
    const p = document.createElement("p");
    p.className = "mod-desc";
    p.textContent = text;
    h2.insertAdjacentElement("afterend", p);
  });
}

/* ============================================================
   LANDING PAGE LIVE PREVIEW — opens the real public site in an
   in-app panel (iframe) so Super Admin stays logged into this
   portal while checking their landing-page edits. The public
   page reads the same SITE_CONTENT (via localStorage, written by
   saveLanding()) and patches itself on load.
   ============================================================ */
function openLandingPreview(){
  const overlay = $("#preview-overlay");
  const frame   = $("#preview-iframe");
  /* ?preview=1 strips the customer login/cart from the public page, so the
     visitor auth modal is not reachable from inside the admin.

     The signed-in identity rides along in the URL: the Landing Page module
     is available to any role holding `landing.manage`, so this is opened
     from the Sub-Admin portal just as often as from Super Admin, and the
     preview badge has to name whoever is actually here. */
  const who = adminState.currentUser || {};
  const params = new URLSearchParams({ preview: "1" });
  if(who.role) params.set("as", who.role);
  if(who.name) params.set("who", who.name);
  frame.src = PORTAL_BASE_PATH + "public/index.html?" + params.toString();
  overlay.classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeLandingPreview(){
  $("#preview-overlay").classList.remove("open");
  $("#preview-iframe").src = "about:blank";
  document.body.style.overflow = "";
}
function initLandingPreview(){
  const btn = $("#view-landing-btn");
  if(btn) btn.addEventListener("click", openLandingPreview);
  $("#preview-close-btn")?.addEventListener("click", closeLandingPreview);
  $("#preview-refresh-btn")?.addEventListener("click", ()=>{
    const frame = $("#preview-iframe");
    frame.src = frame.src;
  });
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape" && $("#preview-overlay").classList.contains("open")) closeLandingPreview();
  });
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  initTheme();
  initLogin();
  initSidebar();
  initUserDropdown();
  initModal();
  initModDescriptions();
  initLandingPreview();
  /* Lives in admin-orders.js and reads the shell's bell markup, so it has
     to run here rather than on DOMContentLoaded. */
  if(typeof initNotifBell === "function") initNotifBell();
  /* Same reason as the bell: it binds markup from portal/views/reviews.html.
     Guarded so a portal built without reviews.js still boots. */
  if(typeof initReviews === "function") initReviews();
}

/* init() must not run until Core/module-loader.js has injected the portal
   shell and the portal/views/*.html partials — initSidebar(), initModDescriptions()
   and initLandingPreview() all read markup that lives in those partials, and
   all three fail silently if it is absent.

   Portals built on the loader carry <div id="portal-root">; the loader calls
   init() itself once injection finishes. The listener below is the fallback
   for any page still using the old monolithic markup. */
if (!document.getElementById("portal-root")) {
  document.addEventListener("DOMContentLoaded", init);
}


/* ============================================================
   TOPBAR SEARCH — jump to any module
   ------------------------------------------------------------
   Reads the sidebar itself, so it only ever offers what this role can
   open (RBAC hides the rest with display:none) and never drifts from the
   menu. Choosing a result clicks that sidebar button, which is the same
   path as navigating by hand. Delegated from document because the shell
   is injected after this file runs.
   ============================================================ */
(function(){
  let items = [], sel = 0;
  const $in   = () => document.getElementById("topbar-search-input");
  const $list = () => document.getElementById("topbar-search-list");
  const clean = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();

  function collect(){
    return [...document.querySelectorAll("#sidebar .nav-item[data-mod]")]
      .filter(b => b.style.display !== "none" && b.closest(".nav-group")?.style.display !== "none")
      .map(b => {
        const group  = clean(b.closest(".nav-group")?.querySelector(".nav-group-label"));
        const parent = b.classList.contains("sub") ? clean(b.closest(".nav-sub-list")?.previousElementSibling) : "";
        return { btn: b, label: clean(b), where: [group, parent].filter(Boolean).join(" › ") };
      });
  }
  function draw(q){
    const list = $list(); if(!list) return;
    q = q.trim().toLowerCase();
    if(!q){ close(); return; }
    items = collect().filter(i => (i.label + " " + i.where).toLowerCase().includes(q))
      .sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q))
      .slice(0, 8);
    sel = 0;
    list.innerHTML = items.length
      ? items.map((i, n) => `<button type="button" class="tsr-item${n === 0 ? " on" : ""}" role="option" data-n="${n}">
          <span class="tsr-label">${escHtml(i.label)}</span><span class="tsr-where">${escHtml(i.where)}</span></button>`).join("")
      : `<div class="tsr-empty">No module matches "${escHtml(q)}"</div>`;
    list.hidden = false;
    $in()?.setAttribute("aria-expanded", "true");
  }
  function close(){
    const list = $list(); if(list){ list.hidden = true; list.innerHTML = ""; }
    $in()?.setAttribute("aria-expanded", "false");
  }
  function go(n){
    const it = items[n]; if(!it) return;
    close(); const inp = $in(); if(inp){ inp.value = ""; inp.blur(); }
    const sub = it.btn.closest(".nav-sub-list");   /* open a collapsed parent first */
    if(sub && getComputedStyle(sub).display === "none") sub.previousElementSibling?.click();
    it.btn.click();
  }
  function mark(){
    $list()?.querySelectorAll(".tsr-item").forEach((b, n) => b.classList.toggle("on", n === sel));
  }

  document.addEventListener("input", e => { if(e.target.id === "topbar-search-input") draw(e.target.value); });
  document.addEventListener("focusin", e => { if(e.target.id === "topbar-search-input" && e.target.value) draw(e.target.value); });
  document.addEventListener("keydown", e => {
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && $in()){
      e.preventDefault(); $in().focus(); $in().select(); return;
    }
    if(e.target.id !== "topbar-search-input") return;
    if(e.key === "ArrowDown"){ e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); mark(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if(e.key === "Enter"){ e.preventDefault(); go(sel); }
    else if(e.key === "Escape"){ close(); e.target.blur(); }
  });
  document.addEventListener("mousedown", e => {
    const hit = e.target.closest?.(".tsr-item");
    if(hit){ e.preventDefault(); go(Number(hit.dataset.n)); return; }
    if(!e.target.closest?.("#topbar-search")) close();
  });
})();


/* ============================================================
   TOPBAR REFRESH — reload the current screen's data in place
   ------------------------------------------------------------
   Re-fetches the shared catalogue, then re-renders the module that is
   open (its own fetches run again) on the tab it is on. No page reload,
   so the sidebar, the open module and its filters all stay put.
   ============================================================ */
document.addEventListener("click", async e => {
  const btn = e.target.closest?.("#topbar-refresh");
  if(!btn || btn.classList.contains("is-spinning")) return;
  btn.classList.add("is-spinning");
  btn.disabled = true;
  try {
    if(typeof loadCatalog === "function") await loadCatalog();
    const mod = adminState.currentModule || "dashboard";
    navigate(mod, TAB_MEMORY[mod]?.() || undefined, NAV_REFRESH);
    toast("Refreshed.", "ok");
  } catch(err){
    toast("Could not refresh: " + (err.message || err), "err");
  } finally {
    setTimeout(() => { btn.classList.remove("is-spinning"); btn.disabled = false; }, 500);
  }
});
