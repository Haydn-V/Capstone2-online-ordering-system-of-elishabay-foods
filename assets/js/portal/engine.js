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
};

/* Roles editable from the Roles & Permissions screen. "Super Admin" is
   not listed here — it always has every permission, unconditionally. */
const ROLE_PERMISSIONS = {
  "Admin":               Object.keys(PERMISSIONS).filter(k => k !== "rbac.manage"),
  "Cashier":             ["pos.use","transactions.view","sales.report","payments.manage"],
  "Inventory Staff":     ["inventory.report","inventory.manage","batches.manage","audit.view"],
  "Online Orders Staff": ["orders.view","orders.accept","orders.status","orders.returns","transactions.view","payments.manage"],
};

/* Display metadata (slug badge + blurb) for the Roles & Permissions cards.
   Custom roles created via "Create New Role" get an entry pushed here too. */
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
  notifSort:     "newest",
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
function isRevenue(o){ return !!o && REVENUE_STATUSES.includes(o.status); }
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
function initTheme(){
  const btn = $("#theme-btn");
  if(!btn) return;
  btn.addEventListener("click", ()=>{
    adminState.theme = adminState.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", adminState.theme);
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
  }));

  if(EbRbac.can("orders.returns")){
    jobs.push(EbApi.get("returns/list.php", { limit: 200 }).then(r => {
      RETURNS.length = 0;
      r.data.forEach(x => RETURNS.push(x));
    }));
  }

  if(EbRbac.can("payments.manage")){
    jobs.push(EbApi.get("payments/list.php").then(r => {
      PAYMENT_ACCOUNTS.length = 0;
      r.data.forEach(x => PAYMENT_ACCOUNTS.push(x));
      /* The penalty rate is a stored setting now, not a number typed into the
         screen and lost on reload. */
      if(r.meta && r.meta.penaltyRate != null) adminState.penaltyRate = r.meta.penaltyRate;
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
  $("#login-view").classList.add("hide");
  $("#admin-app").classList.remove("hide");
  $("#sidebar-name").textContent      = user.name;
  $("#sidebar-role").textContent      = user.role;
  $("#topbar-role-label").textContent = "Signed in as " + user.role;
  $("#sidebar-avatar").textContent    = avatar;
  $("#topbar-avatar").textContent     = avatar;
  $("#topbar-avatar").title           = user.name;
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
   LOGIN
   ============================================================ */
function initLogin(){
  /* Already signed in? Skip the login screen. Fires and forgets: the login
     form below is wired either way, and checkSessionAuth() hides it if the
     session turns out to be valid. */
  checkSessionAuth();

  const form     = $("#login-form");
  const errBox   = $("#login-error");
  const emailEl  = $("#login-email");
  const pwEl     = $("#login-pw");
  const pwToggle = $("#pw-toggle");
  const eyeIcon  = $("#eye-icon");

  const eyeHide = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  const eyeShow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

  pwToggle.addEventListener("click", ()=>{
    const hidden = pwEl.type === "password";
    pwEl.type = hidden ? "text" : "password";
    eyeIcon.innerHTML = hidden ? eyeHide : eyeShow;
  });

  form.addEventListener("submit", async e=>{
    e.preventDefault();
    const email = emailEl.value.trim();
    const pw    = pwEl.value;
    $("#err-email").textContent = "";
    $("#err-pw").textContent    = "";
    errBox.classList.remove("show");

    let valid = true;
    if(!email){ $("#err-email").textContent = "Email is required."; valid=false; }
    if(!pw)   { $("#err-pw").textContent    = "Password is required."; valid=false; }
    if(!valid) return;

    /* Disabled for the duration so a double-click cannot fire two logins,
       and so the button reflects that something is happening. */
    const btn = $("#login-btn");
    const label = btn ? btn.textContent : "";
    if(btn){ btn.disabled = true; btn.textContent = "Signing in…"; }

    try {
      /* The password leaves the browser and is checked against a bcrypt hash
         in MySQL. It is never compared here, and no credential list exists in
         this file any more. portalRole() makes the server refuse an account
         that belongs to a different portal. */
      const user = await EbSession.login(email, pw, portalRole());
      applySignedInUser(user);
      await loadCatalog();
      navigate("dashboard");
    } catch(err){
      /* Field-level messages where the server gave them, one banner otherwise. */
      if(err.fields && err.fields.email)    $("#err-email").textContent = err.fields.email;
      if(err.fields && err.fields.password) $("#err-pw").textContent    = err.fields.password;
      if(!err.fields || (!err.fields.email && !err.fields.password)){
        errBox.textContent = err.message;
        errBox.classList.add("show");
      }
      pwEl.value = "";
    } finally {
      if(btn){ btn.disabled = false; btn.textContent = label; }
    }
  });
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

function navigate(mod, tab){
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
    "online-txns":    renderOnlineTxns,
    ordersqueue:   renderQueue,
    paymentverify: renderPaymentVerify,
    orderstatus:   renderOrderStatus,
    orderhistory:  renderHistory,
    receipts:      renderReceipts,
    returns:       renderReturns,
  };
  if(renders[mod]) renders[mod]();

  /* mobile: close sidebar */
  if(window.innerWidth <= 900){
    $("#sidebar").classList.remove("open");
    $("#sidebar-overlay").classList.remove("show");
  }
  /* scroll to top */
  $("#main-content").scrollTo(0,0);
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

  /* Cross-links inside a panel — "View All" on the dashboard, "Back" on the POS
     payment screen. These were `onclick="navigate('sales')"` in the markup,
     which the brief rules out and which only worked because navigate() happened
     to be a global; the moment engine.js becomes a module they break silently,
     with no reference for a linter or a grep to find. Same delegation as the
     sidebar, driven by data-goto. */
  $$("[data-goto]").forEach(btn=>{
    btn.addEventListener("click", ()=> navigate(btn.dataset.goto, btn.dataset.tab));
  });

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
  $("#topbar-avatar").addEventListener("click", e => {
    e.stopPropagation();
    userWrap.classList.toggle("open");
  });
  document.addEventListener("click", () => userWrap.classList.remove("open"));
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
function renderDashboard(){
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

  /* ── deltas ── */
  const todayStr       = dAgo(0);
  const thisMonthStart = todayStr.slice(0,7)+"-01";
  const lmEnd          = addDays(thisMonthStart, -1);
  const lmStart        = lmEnd.slice(0,7)+"-01";

  const totalSales     = sumRevenue(ORDERS);
  const todayTx        = ORDERS.filter(tx=>tx.date===todayStr);
  const todaySales     = sumRevenue(todayTx);
  const yesterdaySales = sumRevenue(ORDERS.filter(tx=>tx.date===dAgo(1)));
  const thisMonthRev   = sumRevenue(ORDERS.filter(tx=>tx.date>=thisMonthStart&&tx.date<=todayStr));
  const lastMonthRev   = sumRevenue(ORDERS.filter(tx=>tx.date>=lmStart&&tx.date<=lmEnd));
  const lowStock       = PRODUCTS.filter(p=>!p.archived&&p.stock<=10&&p.stock>0).length;
  const outStock       = PRODUCTS.filter(p=>!p.archived&&p.stock===0).length;
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

  $("#dash-stats").innerHTML = `
    <div class="stat-card" style="--accent-color:var(--gold-ink);--accent-bg:var(--gold-dim)">
      <div class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg></div>
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value">${peso(totalSales)}</div>
      <div class="stat-sub">${ORDERS.length} total transactions</div>
      ${deltaBadge(thisMonthRev, lastMonthRev, "vs last month")}
    </div>
    <div class="stat-card" style="--accent-color:var(--ok-ink);--accent-bg:rgba(24,169,87,.12)">
      <div class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div>
      <div class="stat-label">Today's Sales</div>
      <div class="stat-value">${peso(todaySales)}</div>
      <div class="stat-sub"><span class="stat-trend up">↑ ${todayTx.length} orders</span></div>
      ${deltaBadge(todaySales, yesterdaySales, "vs yesterday")}
    </div>
    <div class="stat-card" style="--accent-color:var(--crit);--accent-bg:rgba(234,88,12,.1)">
      <div class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div class="stat-label">Critical Stock</div>
      <div class="stat-value">${lowStock}</div>
      <div class="stat-sub">${outStock} product(s) out of stock</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--info);--accent-bg:rgba(59,130,246,.1)">
      <div class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
      <div class="stat-label">Customers</div>
      <div class="stat-value">${activeCustomers}</div>
      <div class="stat-sub">${retailers} retailer(s)</div>
    </div>
  `;

  /* sparkline — daily sales for past 7 days */
  const days = [];
  const labels = [];
  for(let i=6;i>=0;i--){
    const d = dAgo(i);
    const total = sumRevenue(ORDERS.filter(tx=>tx.date===d));
    days.push(total);
    labels.push(new Date(d+"T00:00:00").toLocaleDateString("en-PH",{weekday:"short"}));
  }
  const weekTotal = days.reduce((a,b)=>a+b,0);
  $("#dash-week-total").textContent = peso(weekTotal);

  if(!adminState.chartType) adminState.chartType = "line";

  function redrawDashChart(){
    const svgEl = $("#sparkline-sales");
    const type = adminState.chartType;
    if(type === "bar")   drawBarChart(svgEl, days, { labels, color:"var(--gold)" });
    else if(type==="area") drawSparkline(svgEl, days, { labels, color:"var(--gold)", smooth:true, lineWidth:2 });
    else                 drawSparkline(svgEl, days, { labels, color:"var(--gold)" });
  }

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

  /* notifications */
  const notifs = [];
  PRODUCTS.filter(p=>!p.archived && p.stock===0).forEach(p=>
    notifs.push({ dot:"red", text:`<strong>${escHtml(p.name)}</strong> is out of stock.`, time:"Stock Alert" })
  );
  PRODUCTS.filter(p=>!p.archived && p.stock>0 && p.stock<=10).forEach(p=>
    notifs.push({ dot:"crit", text:`<strong>${escHtml(p.name)}</strong> has only ${p.stock} units left.`, time:"Low Stock" })
  );
  PAYMENT_ACCOUNTS.filter(isOverdue).forEach(a=>
    notifs.push({ dot:"red", text:`Payment overdue: <strong>${escHtml(a.name)}</strong> owes ${peso(a.balance)}.`, time:"Finance Alert" })
  );
  notifs.push({ dot:"gold", text:"Monthly sales report ready for review.", time:"System" });
  notifs.push({ dot:"ok",   text:"All employee accounts verified.", time:"System" });

  $("#dash-notif-count").textContent = notifs.length;
  $("#dash-notifs").innerHTML = notifs.map(n=>`
    <div class="notif-item ${n.dot}">
      <div class="notif-text"><p>${n.text}</p><small>${n.time}</small></div>
    </div>`).join("");

  /* notif badge in topbar */
  const urgentCount = notifs.filter(n=>n.dot==="red").length;
  const badge = $("#notif-badge");
  badge.style.display = urgentCount > 0 ? "block" : "none";

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
    }),
    c => `
    <tr class="${c.status==="archived"?"archived":""}">
      <td class="td-name">${escHtml(c.name)}</td>
      <td class="td-email">${escHtml(c.email)}</td>
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
        <span class="badge badge-info">${escHtml(a.requestedTerms)}</span>
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
        <span class="badge badge-info">${escHtml(a.requestedTerms)} requested</span>
        ${a.tier ? tierBadge(a.tier) : ""}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <p style="font-size:.88rem"><strong>Applicant:</strong><br>${escHtml(a.applicantName)}</p>
        <p style="font-size:.88rem"><strong>Business Type:</strong><br>${escHtml(a.businessType)}</p>
        <p style="font-size:.88rem"><strong>Email:</strong><br>${escHtml(a.email)}</p>
        <p style="font-size:.88rem"><strong>Phone:</strong><br>${escHtml(a.phone)}</p>
        <p style="font-size:.88rem"><strong>Submitted:</strong><br>${fmtDate(a.submittedDate)}</p>
        <p style="font-size:.88rem"><strong>Requested Terms:</strong><br>${escHtml(a.requestedTerms)}</p>
      </div>
      <div class="field"><label>Application Notes</label><p style="font-size:.88rem;color:var(--text-muted)">${escHtml(a.notes||"—")}</p></div>
      ${a.status==="rejected" ? `<div class="field"><label>Rejection Reason</label><p style="font-size:.88rem;color:var(--out-ink)">${escHtml(a.reason||"—")}</p></div>` : ""}
    `,
    confirmLabel: null,
    cancelLabel: "Close"
  });
}

function openApproveAppModal(a){
  if(!a) return;
  const termOpts = ["Net 30","Net 60","Net 90"].map(t=>`<option ${a.requestedTerms===t?"selected":""}>${t}</option>`).join("");
  const tierOpts = PARTNER_TIERS.map(t=>`<option ${a.requestedTerms==="Net 90"&&t==="Gold"?"selected":""}>${t}</option>`).join("");
  openModal({
    title: `Approve ${a.businessName}`,
    body: `
      <p style="font-size:.9rem;margin-bottom:16px">Approving grants <strong>${escHtml(a.applicantName)}</strong> a retailer account with the credit line and tier below.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label>Credit Terms</label><select class="control" id="m-app-terms">${termOpts}</select></div>
        <div class="field"><label>Partner Account Tier</label><select class="control" id="m-app-tier">${tierOpts}</select></div>
      </div>
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
    a.requestedTerms, a.tier||"", a.status, a.submittedDate, a.notes||"", a.reason||""
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
async function storeImage(file){
  if(!file || !/^image\//.test(file.type)){
    throw new Error("That file isn't an image.");
  }
  const data = await EbApi.upload(file, "content");
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
      <div class="lp-bs-wrap"><table class="lp-bs-table" id="lp-bs-table">${renderBestSellerRows()}</table></div>
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
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> FAQ Entries
        <button class="btn btn-ghost btn-sm" id="add-faq-btn" style="margin-left:auto">+ Add FAQ</button>
      </div>
      <div id="faq-list">${renderFAQItems()}</div>
    </div>
  `;
  wireFAQButtons();
  wireLandingImages();
  updateStorageMeter();
  $("#save-landing-btn").onclick = saveLanding;
  $("#add-faq-btn").onclick = ()=>{
    SITE_CONTENT.faqs.push({ q:"", a:"" });
    $("#faq-list").innerHTML = renderFAQItems();
    wireFAQButtons();
  };
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
  const head = `
    <thead><tr>
      <th style="width:44px"></th><th>#</th><th>Product</th>
      <th class="num">Units sold</th><th class="num">Revenue</th>
      <th class="num">Rating</th><th>Stock</th><th>Photo</th>
    </tr></thead>`;
  /* The Photo column is READ-ONLY.

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
  const body = rows.map(function(p, i){
    const on   = chosen.includes(p.id);
    const src  = imageUrl(p);
    const st   = stockInfo(p);
    return `
      <tr class="${on ? "is-featured" : ""}">
        <td><input type="checkbox" data-feat="${p.id}" ${on ? "checked" : ""}></td>
        <td class="lp-rank">${i + 1}</td>
        <td><b>${escHtml(p.name)}</b><small>${escHtml(p.cat)}</small></td>
        <td class="num">${p.sold.toLocaleString()}</td>
        <td class="num">${peso(p.revenue)}</td>
        <td class="num">${p.rating.toFixed(1)}</td>
        <td><span class="pill ${st.cls}">${st.label}</span></td>
        <td>
          <div class="lp-cell-img">
            ${src
              ? `<img src="${escHtml(src)}" alt="${escHtml(p.name)}">`
              : `<span class="lp-img-empty sm" title="No photo — add one in Product Maintenance">—</span>`}
            <button class="btn btn-ghost btn-sm" data-goto-product="${escHtml(p.id)}">${src ? "Change" : "Add photo"}</button>
          </div>
        </td>
      </tr>`;
  }).join("");
  return head + "<tbody>" + body + "</tbody>";
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
      box.closest("tr").classList.toggle("is-featured", box.checked);
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
function handleUpload(file, input, done){
  if(!file) return;
  storeImage(file)
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
  }).then(({ data }) => {
    toast("Landing page saved: " + (data.updated || []).join(", ") + ".", "ok");
    updateStorageMeter();
  }).catch(err => {
    toast("Could not save landing content: " + (err.fields.hero || err.fields.featured || err.message), "err");
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
        ? `<span class="muted" title="No sales in the last ${inv.windowDays || 90} days — no rate to measure cover against.">—</span>`
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
    { colspan: 10, empty: { title: "No products match filters", hint: "Adjust the search or filters." } }
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
  let total  = sumRevenue(txs);
  let orders = txs.filter(t=>t.status!=="cancelled").length;
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
    cmpTotal  = sumRevenue(cmpTxs);
    cmpOrders = cmpTxs.length;
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
  `;

  /* chart */
  const dateMap = {};
  txs.filter(isRevenue).forEach(tx=>{ dateMap[tx.date]=(dateMap[tx.date]||0)+orderTotal(tx); });
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
     to alter what past periods appeared to have earned. */
  EbPaginate.list(
    "sales",
    adminState.salesPager,
    () => $("#sales-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      page, limit, sort: "newest", from: start, to: end,
    }),
    tx => {
      const summary = (tx.items || []).map(i => `${i.name || i.id} ×${i.qty}`).join(", ");
      const method = payMethodLabel(tx.payMethod);
      return `<tr>
      <td class="mono">${escHtml(tx.id)}</td>
      <td>${escHtml(tx.customer)}</td>
      <td style="font-size:.8rem;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(summary)}</td>
      <td><strong>${peso(tx.total)}</strong></td>
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
    if(cmpSelect) cmpSelect.style.display = cmpToggle.checked ? "block" : "none";
    renderSales(adminState.salesRange);
  };
  if(cmpSelect) cmpSelect.onchange = ()=> renderSales(adminState.salesRange);
}

/* ============================================================
   MODULE: PAYMENT SCHEMES
   ============================================================ */
function renderPayments(){
  const penaltyEl = $("#penalty-rate");
  if(penaltyEl) penaltyEl.value = adminState.penaltyRate;

  const sort = adminState.paySort;
  const sorted = [...PAYMENT_ACCOUNTS].sort((a,b)=>{
    /* Outstanding/Due Date/Status aren't plain fields on the record —
       balance reads 0 once paid, so sort "Outstanding" by the actual
       amount owed and "Status" by the same rank the badge uses. */
    let av, bv;
    if(sort.col === "balance"){ av = a.paid?-1:a.balance; bv = b.paid?-1:b.balance; }
    else if(sort.col === "statusRank"){
      const rank = x => x.paid ? 0 : isOverdue(x) ? 2 : 1;
      av = rank(a); bv = rank(b);
    } else { av = a[sort.col]; bv = b[sort.col]; }
    if(av<bv) return sort.dir==="asc" ? -1 : 1;
    if(av>bv) return sort.dir==="asc" ? 1 : -1;
    return 0;
  });

  /* Payment schemes — server-paged.

     `overdue` and the penalty are computed by the endpoint against CURDATE(),
     not derived here, so an account cannot sit at "3 days late" because nobody
     reopened the screen. The column sort below still orders the loaded page;
     payments/list.php has no sort parameter, and adding one belongs with that
     endpoint rather than being faked here. */
  EbPaginate.list(
    "pay",
    adminState.payPager,
    () => $("#payments-tbody"),
    (page, limit) => EbApi.get("payments/list.php", { page, limit }),
    a => {
      const overdue = a.overdue;
      return `<tr class="${overdue&&!a.paid?"overdue-flag":""}">
      <td class="td-name">${escHtml(a.name)}</td>
      <td class="td-email">${escHtml(a.email || "—")}</td>
      <td><span class="badge badge-info">${escHtml(a.scheme)}</span></td>
      <td>${a.paid ? `<span class="muted">Paid</span>` : `<strong>${peso(a.balance)}</strong>${a.penalty ? ` <span class="muted" style="font-size:.72rem">+${peso(a.penalty)} penalty</span>` : ""}</td>`}
      <td class="${overdue&&!a.paid?"":"muted"}">${fmtDate(a.dueDate)}${overdue&&!a.paid?` <span class="muted" style="font-size:.72rem">(${a.daysPastDue}d)</span>`:""}</td>
      <td><span class="badge ${a.paid?"badge-ok":overdue?"badge-out":"badge-warn"}">${a.paid?"Paid":overdue?"Overdue":"Pending"}</span></td>
      <td><div class="td-actions">
        ${!a.paid ? `<button class="btn btn-ok btn-sm" data-mark-paid="${a.id}">Mark Paid</button>` : ""}
        <button class="btn btn-ghost btn-sm" data-view-pay="${a.id}">View</button>
      </div></td>
    </tr>`;
    },
    {
      colspan: 7,
      empty: { title: "No payment accounts", hint: "Retailer credit accounts appear here." },
      after: (rows, meta) => {
        PAYMENT_ACCOUNTS.length = 0; rows.forEach(r => PAYMENT_ACCOUNTS.push(r));
        if(meta.penaltyRate != null) adminState.penaltyRate = meta.penaltyRate;
        wirePaymentRowActions();
      },
    }
  );

  $$("#payments-table th[data-sort]").forEach(th=>{
    const isSorted = th.dataset.sort === adminState.paySort.col;
    th.classList.toggle("sorted", isSorted);
    th.classList.toggle("desc", isSorted && adminState.paySort.dir==="desc");
    if(!th.querySelector(".sort-arrow")){
      th.innerHTML += `<span class="sort-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    }
    th.onclick = ()=>{
      if(adminState.paySort.col === th.dataset.sort){
        adminState.paySort.dir = adminState.paySort.dir === "asc" ? "desc" : "asc";
      } else {
        adminState.paySort = { col: th.dataset.sort, dir: "asc" };
      }
      adminState.payPager.page = 1;
      renderPayments();
    };
  });

  /* Restored: extracting the row-action wiring above had removed this
     handler's opening line along with it. penaltyEl is already declared
     earlier in this function, so only the button binding is re-added. */
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

/* Row actions for the payment table.

   Extracted because the rows are now drawn by EbPaginate.list after the render
   function has already returned — wiring them inline would have bound handlers
   to a tbody that was still empty. */
function wirePaymentRowActions(){
  document.querySelectorAll("#payments-tbody [data-mark-paid]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const acct = PAYMENT_ACCOUNTS.find(a=>String(a.id) === btn.dataset.markPaid);
      if(!acct) return;
      openModal({
        title:"Mark as Paid",
        body:`<p>Mark <strong>${escHtml(acct.name)}</strong>'s balance of <strong>${peso(acct.balance)}</strong> as paid?</p>`,
        confirmLabel:"Mark Paid", confirmClass:"btn-ok",
        onConfirm: async ()=>{
          try {
            /* The settled amount, including any penalty, is computed by the
               server from the real due date — not from what this screen
               happens to be showing. */
            const { data } = await EbApi.post("payments/settle.php", { id: acct.id, paid: true });
            await loadOpsData();
            closeModal();
            toast(`Marked as paid — ${peso(data.settled)}${data.penalty ? ` (incl. ${peso(data.penalty)} penalty)` : ""}.`, "ok");
            renderPayments();
          } catch(err){ toast(err.message, "err"); }
        }
      });
    });
  });

  document.querySelectorAll("#payments-tbody [data-view-pay]").forEach(btn=>{
    const acct = PAYMENT_ACCOUNTS.find(a=>String(a.id) === btn.dataset.viewPay);
    btn.addEventListener("click", ()=> openModal({
      title:"Payment Details",
      body:`<p><strong>Retailer:</strong> ${escHtml(acct.name)}</p>
            <p><strong>Email:</strong> ${escHtml(acct.email)}</p>
            <p><strong>Scheme:</strong> ${escHtml(acct.scheme)}</p>
            <p><strong>Balance:</strong> ${peso(acct.balance)}</p>
            <p><strong>Due Date:</strong> ${fmtDate(acct.dueDate)}</p>
            <p><strong>Status:</strong> ${acct.paid?"Paid":isOverdue(acct)?"Overdue":"Pending"}</p>
            ${isOverdue(acct)&&!acct.paid?`<p style="margin-top:10px;color:var(--out-ink);font-size:.88rem">Penalty applied: ${adminState.penaltyRate}% / month.</p>`:""}`,
      confirmLabel:null, cancelLabel:"Close"
    }));
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
      const checked = isSuperAdmin || granted.includes(p.key);
      const locked  = isSuperAdmin;
      return `<label class="role-toggle-row ${locked?"locked":""}">
        <span>${escHtml(p.label)}</span>
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
      <button class="btn btn-ghost btn-sm" data-save-role="${escHtml(role)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        Save Matrix
      </button>
    </div>
    <p class="role-desc">${escHtml(meta.desc)}</p>
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

  $$("#roles-matrix input[type=checkbox]:not(:disabled)").forEach(cb=>{
    cb.addEventListener("change", ()=>{
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
