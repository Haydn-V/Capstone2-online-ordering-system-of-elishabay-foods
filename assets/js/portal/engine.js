"use strict";

/* ===== CONFIG (mirrors the public site's brand config) ===== */
const CONFIG = {
  brand: "Elisha Bay", company: "Juris Bay Foods, Inc.", currency: "₱",
  address: "148 Brgy. Mangin, Dagupan City, Pangasinan",
  phone: "+63 900 000 0000", email: "hello@elishabay.ph",
  facebook: "facebook.com/elishabayfoods",
};

/* Project root derived from this script's URL, so links back to public/ work in any install folder. */
const PORTAL_BASE_PATH = (() => {
  const src = (document.currentScript && document.currentScript.src) || "";
  const i = src.indexOf("assets/js/portal/");
  return i >= 0 ? src.slice(0, i) : "/";
})();

/* ===== CATALOGUE: PRODUCTS and CATEGORIES_DATA are filled from the API by loadCatalog() before the first render, replaced in place ===== */
/* Filled from api/categories/list.php by loadCatalog(); starts empty so a failed load shows an empty table and an error, not fake data. */
let CATEGORIES_DATA = [];

/* Filled from api/products/list.php by loadCatalog(); starts empty so a failed load shows an empty table and an error, not fake data. */
let PRODUCTS = [];

/* ===== STAFF ACCOUNTS ===== */
/* Passwords were removed from the browser; sign-in uses api/auth/login.php with bcrypt hashes. Never add a password field here. */
/* Filled from api/users/list.php by loadAdminData(); starts empty (no staff roster is shipped to the browser). */
let STAFF_ACCOUNTS = [];

/* ===== RBAC: permission catalogue and role grants ===== */
const PERMISSIONS = {
  "users.manage":     { area:"Maintenance",    label:"Manage customer accounts" },
  "employees.manage": { area:"Maintenance",    label:"Manage employee accounts" },
  "rbac.manage":       { area:"System",         label:"Manage roles & permissions" },
  /* Super Admin only (systemOnly), mirroring Rbac::SYSTEM_ONLY; roles/save.php refuses it for other roles. */
  "vat.manage":        { area:"System",         label:"Manage VAT settings", systemOnly:true },
  "credit.limits":     { area:"Finance",        label:"Edit retailer tier credit budgets & Net term interest rates", systemOnly:true },
  "b2b.review":         { area:"Maintenance",    label:"Review B2B partner applications" },
  "landing.manage":      { area:"Maintenance",    label:"Manage landing page content" },
  "products.manage":      { area:"Maintenance",    label:"Manage products & varieties" },
  "inventory.report":       { area:"Inventory",      label:"View inventory report" },
  "inventory.manage":         { area:"Inventory",      label:"Restock, adjust & archive inventory" },
  "sales.report":               { area:"Reports",        label:"View sales report" },
  /* Expenses and the net income statement in the Sales Report export (migration 032; Admin by default). */
  "reports.financial":          { area:"Reports",        label:"View net income & enter expenses" },
  "batches.manage":               { area:"Reports",        label:"Manage batch tracking & QA" },
  "payments.manage":                 { area:"Finance",        label:"Manage payment schemes" },
  "transactions.view":                 { area:"Finance",        label:"View transaction history" },
  "audit.view":                          { area:"Finance",        label:"View audit log" },
  "pos.use":                               { area:"Point of Sale",  label:"Use point of sale (walk-in orders)" },
  "orders.view":                             { area:"Online Orders",  label:"View online orders" },
  "orders.accept":                             { area:"Online Orders",  label:"Accept/hold/reject orders, verify payments" },
  "orders.status":                               { area:"Online Orders",  label:"Update order status" },
  "orders.returns":                                { area:"Online Orders",  label:"Process returns & refunds" },
  /* Added to match migration 011 so its switch shows and the count is right. */
  "reviews.moderate": { area:"Maintenance",    label:"Moderate customer product reviews" },
  /* Super Admin only (Rbac::SYSTEM_ONLY): shown on the matrix so the full list is visible, but never grantable. */
  "shipping.manage":      { area:"Maintenance",   label:"Manage shipping rates", systemOnly:true },
  /* Super Admin and Admin only (Rbac::ADMIN_ONLY): the Super Admin can switch it on for the Admin role. */
  "refunds.large":        { area:"Online Orders", label:"Approve & process large refunds", adminOnly:true },
};

/* Super Admin's current permissions (from roles/list.php); its locked ones (superLocked) are always on. */
const SUPER_PERMS = [];

/* Roles editable on the Roles & Permissions screen (Super Admin is kept apart in SUPER_PERMS). */
const ROLE_PERMISSIONS = {
  "Admin":               Object.keys(PERMISSIONS).filter(k => k !== "rbac.manage" && !PERMISSIONS[k].systemOnly && !PERMISSIONS[k].adminOnly),
  "Cashier":             ["pos.use","transactions.view","sales.report","payments.manage"],
  "Inventory Staff":     ["inventory.report","inventory.manage","batches.manage","audit.view"],
  "Online Orders Staff": ["orders.view","orders.accept","orders.status","orders.returns","transactions.view","payments.manage"],
};

/* Display info (badge and blurb) for role cards; custom roles are added here too. */
/* Default permissions of the built-in roles (same as db/seed.sql), restored by the matrix's Default button. */
const ROLE_DEFAULTS = {
  "Admin": ["users.manage","employees.manage","b2b.review","landing.manage","products.manage","inventory.report","inventory.manage",
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

/* Checks the permissions the server sent with the session (from role_permissions); no permission is granted before the session loads. */
function hasPerm(key){
  const user = adminState.currentUser;
  if(!user) return false;
  /* "a|b" means any of the listed permissions (e.g. User Management opens with either accounts permission). */
  if(String(key).includes("|")) return String(key).split("|").some(k => hasPerm(k));
  if(window.EbSession && EbSession.isSignedIn()) return EbSession.can(key);
  return false;
}

/* mod key -> required permission (mods not listed here are always visible, e.g. dashboard) */
const MOD_PERM = {
  users:"users.manage|employees.manage", b2b:"b2b.review", landing:"landing.manage", products:"products.manage",
  inventory:"inventory.report", "inventory-manage":"inventory.manage", expiry:"inventory.manage",
  sales:"sales.report", batches:"batches.manage",
  payments:"payments.manage", transactions:"transactions.view", audit:"audit.view",
  pos:"pos.use", "pos-payment":"pos.use",
  ordersqueue:"orders.accept", paymentverify:"orders.accept", orderstatus:"orders.status",
  "online-txns":"orders.view", orderhistory:"transactions.view", receipts:"orders.view", returns:"orders.returns",
  roles:"rbac.manage",
  reviews:"reviews.moderate",
  vat:"vat.manage",
  shipping:"shipping.manage",
};

/* Hide every [data-perm] element the user lacks and collapse empty nav groups (run after login). */
/* Delegates to core/rbac.js; this only hides things, while Rbac::require() in PHP is the real control. */
function applyRBAC(){ return EbRbac.apply(); }

/* ===== CUSTOMERS ===== */
/* Filled from api/customers/list.php by loadAdminData(); starts empty. */
let CUSTOMERS = [];

/* ===== DATES: always use the real (server) date, never a fixed one, and format in local time, never toISOString() (UTC), so dates match MySQL's CURDATE() ===== */

/** A Date as local YYYY-MM-DD (never toISOString(), which is UTC). */
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

/** Today or n days before it, using the server's Manila date (local clock only before system/dates.php answers). */
function dAgo(n){
  const base = SERVER_DATES?.today;
  if(base) return n === 0 ? base : addDays(base, -n);
  const d = new Date(); d.setDate(d.getDate() - n); return ymd(d);
}

function addDays(str, n){ const d = parseYmd(str); d.setDate(d.getDate() + n); return ymd(d); }

/* ===== BATCH TRACKING & QA TRACEABILITY ===== */
const QUALITY_GRADES = ["Grade A Export Quality","Grade B Standard Quality","Grade C Local Market"];
const LAB_STATUSES = {
  passed:  "Passed (Commercial Sterility Certified)",
  pending: "Pending Lab Results",
  failed:  "Failed (Contamination Detected)",
};

/* Filled from api/batches/list.php. */
/* Filled from api/batches/list.php by loadInventoryData(); starts empty. */
let BATCHES = [];

/* ORDERS holds walk-in and online orders together, filled from api/orders/list.php by loadOrders(); starts empty (the old seed arrays were removed). */
let ORDERS = [];

/* ===== ONLINE ORDERS: status workflow, returns and notifications ===== */
const STATUS_TRANSITIONS = {
  /* One straight line; cancelling only before acceptance. On Hold is retired: only an order already held can leave it. */
  "pending":   ["accepted","cancelled"],
  "accepted":  ["shipping"],
  "shipping":  ["delivered"],
  "delivered": ["completed"],
  "on-hold":   ["accepted","cancelled"],
  "completed": [],
  "cancelled": [],
};
/* Online pickup orders skip shipping: staff complete them at handover or cancel (mirrors PICKUP_TRANSITIONS in api/orders/status.php). */
const PICKUP_TRANSITIONS = {
  "pending":  ["completed","cancelled"],
  "on-hold":  ["completed","cancelled"],
  "accepted": ["completed"],
};
/* The statuses an order can move to next, using the pickup map for online pickups. */
function nextStatuses(o){
  if(!o) return [];
  const map = o.type === "online" && o.orderType === "pickup" ? PICKUP_TRANSITIONS : STATUS_TRANSITIONS;
  return map[o.status] || [];
}
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

/* Filled from api/returns/list.php by loadOpsData(); starts empty. */
let RETURNS = [];

/* Filled from api/notifications/list.php by loadOpsData(); starts empty. */
let NOTIFICATIONS = [];

/* ===== PAYMENT ACCOUNTS (retailers) ===== */
/* Filled from api/payments/list.php by loadOpsData(); starts empty. */
let PAYMENT_ACCOUNTS = [];

/* ===== B2B RETAIL PARTNER APPLICATIONS ===== */
const PARTNER_TIERS = ["Bronze","Silver","Gold"];

/* Filled from api/b2b/list.php by loadOpsData(); starts empty. */
let B2B_APPLICATIONS = [];

/* ===== SITE CONTENT (Landing Page Maintenance) ===== */
const SITE_CONTENT = {
  /* Default landing content matching the live public page (confirm the contact details in the module). */
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
    facebook: "facebook.com/elishabayfoods",
    email: "hello@jurisbayfoods.ph",
  },
  /* GCash/bank accounts customers pay into, filled from content/get.php. */
  payment: {
    gcash: { name: "", number: "", qr: "" },
    bank:  { bank: "", name: "", number: "", qr: "" },
  },

  /* Hero slide photos; titles match HERO_PANELS on the public page. */
  hero: [
    { title:"Pesto Bangus",    img:"" },
    { title:"Adobo Bangus",    img:"" },
    { title:"Asian Steak",     img:"" },
    { title:"Tuyo Delizioso",  img:"" },
    { title:"Ba-yo Signature", img:"" },
  ],

  /* Product ids in the Best Sellers carousel (empty = each product's own best flag), saved to featured_products by content/save.php. */
  featured: [],

  /* A product's photo lives on the product (the old productImages map was removed). */
};

/* ===== AUDIT LOG ===== */
/* Filled from api/audit/list.php by loadAdminData(); starts empty. */
let AUDIT_LOG = [];

/* ===== APP STATE ===== */
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
  /* Pagers for tables that used to rely on a fixed-height scroll area (Paginate format). */
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
  /* Sort by urgency, matching the bell and the dashboard panel. */
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
  /* Stock Overview's search and filter values live here because the table is rebuilt on every keystroke. */
  invOverviewQuery: "",
  invOverviewLevel: "all",
  /* Sales window for stock bands on the Inventory Report and Stock Overview (see STOCK_WINDOWS). */
  stockWindow:   "month",
  /* Window for the restock form's suggested quantity (see RESTOCK_BASES in inventory.js). */
  restockBasis:  "week",
};

/* ===== HELPERS ===== */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
/* Thin aliases for the shared helpers in core/format.js, kept because hundreds of call sites use these names. */
/* Function declarations (not const arrows) so they are hoisted and safe to call from anywhere. */
function peso(n)         { return EbFormat.peso(n); }
function escHtml(s)      { return EbFormat.escHtml(s); }
function fmtDate(s)      { return EbFormat.fmtDate(s); }
function fmtDateTime(s)  { return EbFormat.fmtDateTime(s); }
function stockInfo(n)    { return EbFormat.stockInfo(n); }
function movementType(n) { return EbFormat.movementType(n); }

/* Stock bands are rates over a sales window (see api/core/Inventory.php); the window is a per-session view choice on two screens and never changes PRODUCTS or the stored default. */
const STOCK_WINDOWS = [
  ["month",     "Last 30 days"],
  ["week",      "Last 7 days"],
  ["yesterday", "Yesterday"],
];

function stockWindowParam(){
  return adminState.stockWindow || "month";
}

/* Only the option list; the <select> and its id are written literally in each screen's markup (keep the inventory.html copy in step). */
function stockWindowOptions(){
  return STOCK_WINDOWS.map(([v, label]) =>
    `<option value="${v}"${adminState.stockWindow === v ? " selected" : ""}>Measured: ${escHtml(label)}</option>`
  ).join("");
}

/* Caption from the response, so a fallback to the default is never labelled "Yesterday". */
function paintStockWindowNote(sel, meta){
  const el = $(sel);
  if(!el) return;
  const label = (meta && meta.windowLabel) || "";
  el.textContent = label
    ? `Stock levels and movement measured over ${label}, from completed orders.`
    : "";
}

/* Show the rating honestly: "No ratings yet" when there are no published reviews instead of 0.0, taking the whole product so rating and count always go together. */
function ratingText(p){
  const n = Number(p && p.reviewCount) || 0;
  if(n <= 0) return "No ratings yet";
  return `${Number(p.rating).toFixed(1)}★ (${n})`;
}

/* The shared image resolver (EbFormat.imageUrl). */
function imageUrl(rec)   { return EbFormat.imageUrl(rec); }

function getProduct(id){ return PRODUCTS.find(p=>p.id===id); }

/* Estimated arrival window as text: "Oct 29 – Oct 31, 2026" (or one date when both match). */
function etaText(e){ return EbFormat.etaRange ? EbFormat.etaRange(e && (e.from || e.etaFrom), e && (e.to || e.etaTo)) : ""; }

/* New-lot dates (mirrors Inventory::shelfLifeMonths / autoExpiry / productionDateError in api/core/Inventory.php):
   the production date may be today or up to one month back, and the expiry is never typed in, it is the production
   date plus the category's shelf life: bottled bangus 1 year, deboned (boneless) bangus 6 months. */
function lotToday(){ return adminState.serverToday || ymd(new Date()); }
function shelfLifeMonths(productId){
  const p = getProduct(productId);
  if(!p) return 6;
  return p.categoryId === "cat-bg" || /bottled/i.test(p.cat || "") ? 12 : 6;
}
function addMonths(str, n){ const d = parseYmd(str); d.setMonth(d.getMonth() + n); return ymd(d); }
function autoExpiry(productId, prodDate){ return addMonths(prodDate || lotToday(), shelfLifeMonths(productId)); }
function prodDateMin(){ return addMonths(lotToday(), -1); }
function shelfLifeText(productId){ return shelfLifeMonths(productId) === 12 ? "1 year (bottled)" : "6 months (deboned)"; }
/* Lock a production-date input to [one month back, today] and keep its read-only expiry in step. */
function wireLotDates(prodEl, expEl, hintEl, productIdFn){
  if(!prodEl) return;
  prodEl.min = prodDateMin(); prodEl.max = lotToday();
  const sync = ()=>{
    const pid = productIdFn();
    if(expEl){ expEl.value = prodEl.value ? autoExpiry(pid, prodEl.value) : ""; window.EbDate?.sync(expEl); }
    if(hintEl) hintEl.textContent = prodEl.value ? `Set automatically: production date + ${shelfLifeText(pid)}.` : "";
  };
  prodEl.addEventListener("change", sync);
  prodEl.addEventListener("input", sync);
  sync();
  return sync;
}
function prodDateProblem(v){
  if(!v) return "";
  if(v > lotToday()) return "The production date cannot be later than today.";
  if(v < prodDateMin()) return `The production date can be at most one month back (${fmtDate(prodDateMin())} or later).`;
  return "";
}

function payMethodLabel(m){ return EbFormat.payMethodLabel(m); }

/* Different badge colours per payment method. */
function methodBadgeClass(method){
  return {
    GCash:         "badge-info",
    Cash:          "badge-ok",
    "Bank Transfer":"badge-purple",
    /* Net schemes get their own badge instead of the grey "unknown" one. */
    "Net 30":      "badge-warn",
    "Net 60":      "badge-warn",
    "Net 90":      "badge-warn",
  }[method] || "badge-muted";
}

/* Cart pricing only (current prices); for past orders use orderTotal(). */
function txTotal(items){
  return items.reduce((s,it) => {
    const p = PRODUCTS.find(x=>x.id===it.id);
    return s + (p ? p.price * it.qty : 0);
  }, 0);
}

/* What the buyer actually pays: orders.total less a retailer's discount (tax.amountDue), same as their invoice and
   My Orders. Every list, card and revenue sum uses this; only the Order Detail popup shows the pre-discount total. */
function orderGross(o){
  if(!o) return 0;
  const n = Number(o.total);
  if(Number.isFinite(n) && o.total !== null && o.total !== "") return n;
  console.warn("[money] order has no stored total, recomputing from current prices:", o.id);
  return txTotal(o.items || []);
}
function orderTotal(o){
  const w = +(o?.tax?.withholdingTax || 0), i = +(o?.tax?.termInterest || 0);
  return (w > 0 || i > 0) ? +o.tax.amountDue : orderGross(o);
}
function orderDueHtml(o){
  const w = +(o?.tax?.withholdingTax || 0), i = +(o?.tax?.termInterest || 0);
  const notes = [w > 0 ? `${EbFormat.pesoExact(w)} retailer discount` : "", i > 0 ? `+ ${EbFormat.pesoExact(i)} interest` : ""].filter(Boolean);
  return notes.length
    ? `${peso(orderTotal(o))}<div class="muted" style="font-size:.72rem;font-weight:500;white-space:nowrap">${w > 0 ? "after " : ""}${notes.join(" · ")}</div>`
    : peso(orderTotal(o));
}

/* Statuses that count as revenue, mirroring Revenue::STATUSES in api/core/Revenue.php (change both together). */
const REVENUE_STATUSES = ["completed"];
/* Net orders count through their verified payments by paid date: revenue = sumRevenue(orders) + receivedBetween(from, to). */
const CREDIT_PAY_METHODS = ["net30", "net60", "net90"];
function isCreditOrder(o){ return !!o && CREDIT_PAY_METHODS.includes(o.payMethod); }
function isRevenue(o){ return !!o && REVENUE_STATUSES.includes(o.status) && !isCreditOrder(o); }
/* A sale for counting: completed paid-at-sale orders plus Net orders that committed stock (same rule as reports/sales.php). */
function isSaleOrder(o){
  return isRevenue(o) || (isCreditOrder(o) && ["accepted","shipping","delivered","completed"].includes(o.status));
}
/* Verified, non-legacy payments toward Net accounts, from api/payments/received.php. */
let CREDIT_RECEIPTS = [];
/* Net payments received, less refunds paid out, in the range; refunds come off on the day they were paid. */
let REFUNDS_PAID = [];
function refundedBetween(from, to){
  return REFUNDS_PAID
    .filter(r => (!from || r.date >= from) && (!to || r.date <= to))
    .reduce((s, r) => s + r.amount, 0);
}
function receivedBetween(from, to){
  return CREDIT_RECEIPTS
    .filter(r => (!from || r.paidDate >= from) && (!to || r.paidDate <= to))
    .reduce((s, r) => s + r.amount, 0) - refundedBetween(from, to);
}
function sumRevenue(list){ return list.filter(isRevenue).reduce((s,o)=>s+orderTotal(o),0); }

function txItemsSummary(items){
  return items.map(it => {
    const p = PRODUCTS.find(x=>x.id===it.id);
    return p ? `${p.name} ×${it.qty}` : it.id;
  }).join(", ");
}

/* Overdue comes from the server's daysPastDue (computed against CURDATE()). */
function isOverdue(acct){
  if(!acct || acct.paid) return false;
  if(typeof acct.daysPastDue === "number") return acct.daysPastDue > 0;
  /* Fallback before load, using the server's today. */
  const today = SERVER_DATES?.today;
  return today ? String(acct.dueDate) < today : false;
}

/* Local-only audit entry for screens not yet using an endpoint (endpoints write the real audit row); delete once all are wired. */
/* Raises the UI notification for an action only; the real audit row is written by the server and appears on the next load. */
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

/* ===== TOAST ===== */
/* Aliases for the toast and modal in core/ui.js. */
function toast(msg, type="ok"){ return EbUI.toast(msg, type); }

/* ===== MODAL ===== */
function openModal(opts){ return EbUI.openModal(opts); }
function closeModal(){ return EbUI.closeModal(); }

/* ===== IMAGE LIGHTBOX: a general "show this image bigger" overlay (here because its styles are in portal.css), built once on first use ===== */
let lightboxOpener = null;      /* what to give focus back to on close */

function lightboxEl(){
  let el = $("#eb-lightbox");
  if(el) return el;

  /* Built from a markup string so verify-structure.py can see the id; aria-modal while open. */
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
  /* Closes only from its X or Escape, like every other popup. */

  /* Escape is caught in the capture phase and stopped, so it closes only the lightbox and not the modal underneath. */
  document.addEventListener("keydown", e => {
    if(!el.classList.contains("open")) return;

    if(e.key === "Escape"){
      e.stopPropagation();
      closeLightbox();
      return;
    }
    /* Focus trap: Tab stays on the close button. */
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
  /* Clear the image on close so it is not kept in memory or flashed next time. */
  el.querySelector("img").removeAttribute("src");
  /* Return focus to the image that opened it. */
  if(lightboxOpener && document.contains(lightboxOpener)) lightboxOpener.focus();
  lightboxOpener = null;
}

/* ===== SPARKLINE CHART (SVG line) ===== */
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
  /* The gradient fill is always a <path>, so it needs real path syntax. */
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

/* ===== CHART RESIZE: charts register a redraw function, replayed by one shared observer when their width changes ===== */
let _chartResizeObserver = null;
function observeChart(svgEl, redraw){
  if(!svgEl || typeof ResizeObserver === "undefined") return;
  svgEl.__redraw = redraw;
  if(!_chartResizeObserver){
    let timer = 0;
    _chartResizeObserver = new ResizeObserver(entries=>{
      /* Debounced with a timer, since rAF pauses in background tabs. */
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

/* ===== THEME TOGGLE ===== */
/* The theme button opens the Light/Dark/System menu (theme.js); charts redraw in the new colours. */
function initTheme(){
  window.addEventListener("eb-theme-change", e => {
    adminState.theme = e.detail.theme;
    if(typeof redrawCharts === "function") redrawCharts();
  });
}

/* ===== SESSION: identity comes from api/auth/me.php (httponly session cookie), with the role re-read from the database on every load ===== */

/* ===== CATALOGUE LOADING: replaces PRODUCTS and CATEGORIES_DATA in place after sign-in, before the first render ===== */
async function loadCatalog(){
  try {
    /* Load dates, products and categories together and render only when all three arrive (limit=200 covers the catalogue for now). */
    const [products, categories] = await Promise.all([
      EbApi.get("products/list.php",   { limit: 200, status: "all" }),
      EbApi.get("categories/list.php", { status: "all" }),
      loadServerDates(),
    ]);

    PRODUCTS.length = 0;
    products.data.forEach(p => PRODUCTS.push(p));

    CATEGORIES_DATA.length = 0;
    categories.data.forEach(c => CATEGORIES_DATA.push(c));

    /* Only fetch batches and the adjustment log for roles allowed to read them, avoiding 403 toasts. */
    if (EbRbac.canAny("inventory.report", "batches.manage", "inventory.manage")) {
      await loadInventoryData();
    }
    await loadOrders();
    await loadAdminData();
    await loadOpsData();

    /* Clear the cached derived alerts so overdue and expiry alerts appear after the data loads. */
    if(typeof refreshDerivedNotifications === "function") refreshDerivedNotifications();

    return true;
  } catch(err){
    /* Show load failures loudly. */
    console.error("[catalog]", err);
    toast("Could not load the product catalogue: " + err.message, "err");
    return false;
  }
}

/* Admin tables (employees, customers, audit log, role matrix), each loaded only with its own permission. */
/* Operational data (returns, notifications, payments, B2B, landing content), each loaded only with its own permission. */
async function loadOpsData(){
  const jobs = [];

  /* The bell is in the shared shell, so every role loads notifications. */
  jobs.push(EbApi.get("notifications/list.php", { limit: 100 }).then(r => {
    NOTIFICATIONS.length = 0;
    r.data.forEach(n => NOTIFICATIONS.push(n));
    adminState.unreadNotifs = r.meta ? r.meta.unread : 0;
    /* Unread counts per level for the bell. */
    adminState.unreadByPriority = (r.meta && r.meta.unreadByPriority) || null;
    /* The type-to-level table comes from the server, so browser-derived alerts sort on the same scale (orders.js has a fallback copy). */
    if(r.meta && r.meta.priorityMap && typeof NOTIF_PRIORITY_MAP !== "undefined"){
      NOTIF_PRIORITY_MAP = r.meta.priorityMap;
    }
  }));

  if(EbRbac.can("orders.returns")){
    jobs.push(EbApi.get("returns/list.php", { limit: 200 }).then(r => {
      RETURNS.length = 0;
      r.data.forEach(x => RETURNS.push(x));
      adminState.largeRefund = (r.meta && r.meta.largeRefund) || null;
    }));
  }

  /* Net-account payments used by every revenue figure computed in the browser (see receivedBetween()). */
  if(EbRbac.canAny("sales.report", "payments.manage")){
    jobs.push(EbApi.get("payments/received.php").then(r => {
      CREDIT_RECEIPTS = r.data || [];
      REFUNDS_PAID = (r.meta && r.meta.refunds) || [];
    }));
  }

  if(EbRbac.can("payments.manage")){
    jobs.push(EbApi.get("payments/list.php").then(r => {
      PAYMENT_ACCOUNTS.length = 0;
      r.data.forEach(x => PAYMENT_ACCOUNTS.push(x));
      /* The penalty rate is a stored setting. */
      if(r.meta && r.meta.penaltyRate != null) adminState.penaltyRate = r.meta.penaltyRate;
      /* Payment meta for the dashboard badge, counted over all accounts. */
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
      if(r.data.heroText) SITE_CONTENT.heroText = r.data.heroText;
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

  if(EbRbac.can("employees.manage")){
    jobs.push(
      EbApi.get("users/list.php", { limit: 200, status: "all" }).then(r => {
        STAFF_ACCOUNTS.length = 0;
        r.data.forEach(u => STAFF_ACCOUNTS.push({
          id: u.id, name: u.name, email: u.email, avatar: u.avatar,
          status: u.status, role: u.role, roleId: u.role_id,
        }));
      })
    );
  }
  if(EbRbac.can("users.manage")){
    jobs.push(
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
      /* Rebuild the Roles screen's data from role_permissions. */
      /* Add any permission key the server has that this file does not, so it always gets a switch. */
      (r.data.permissions || []).forEach(p => {
        if(!PERMISSIONS[p.key]) PERMISSIONS[p.key] = { area: p.area, label: p.label };
        Object.assign(PERMISSIONS[p.key], { systemOnly: !!p.systemOnly, adminOnly: !!p.adminOnly, superLocked: !!p.superLocked });
      });
      Object.keys(ROLE_PERMISSIONS).forEach(k => delete ROLE_PERMISSIONS[k]);
      r.data.roles.forEach(role => {
        if(role.isSystem) SUPER_PERMS.splice(0, SUPER_PERMS.length, ...role.permissions);
        else ROLE_PERMISSIONS[role.name] = role.permissions;
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

/* Load orders separately (limit=500 for now; per-screen server paging is the real fix). */
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

/* Load batches and the adjustment log, so inventory screens can refresh just this after a stock movement. */
async function loadInventoryData(){
  try {
    const jobs = [EbApi.get("batches/list.php", { limit: 200, sort: "expiry" })];
    if (EbRbac.canAny("inventory.report", "inventory.manage")) {
      jobs.push(EbApi.get("inventory/adjustments.php", { limit: 200 }));
    }
    const [batches, adjustments] = await Promise.all(jobs);

    BATCHES.length = 0;
    batches.data.forEach(b => BATCHES.push(b));

    /* Store the server's date so every "days left" figure uses the same clock. */
    if (batches.meta && batches.meta.today) adminState.serverToday = batches.meta.today;

    /* The next suggested lot code, prefilled into restock forms and refreshed after every stock movement. */
    if (batches.meta && batches.meta.nextLotCode) adminState.nextLotCode = batches.meta.nextLotCode;

    if (adjustments) {
      ADJUSTMENTS.length = 0;
      adjustments.data.forEach(a => ADJUSTMENTS.push(a));
    }

    /* Units sold per product per day (Restock tab chart), from the server so roles without the order list see it too. */
    if (EbRbac.canAny("inventory.report", "inventory.manage")) {
      try { adminState.dailySales = (await EbApi.get("inventory/daily-sales.php", { days: 14 })).data || {}; }
      catch(e){ console.warn("[inventory] daily sales", e); }
    }
    return true;
  } catch(err){
    console.error("[inventory]", err);
    toast("Could not load inventory data: " + err.message, "err");
    return false;
  }
}

/* Show the signed-in user in the shell (shared by the session check and login). */
function applySignedInUser(user){
  adminState.currentUser = user;

  const avatar = user.avatar || initials(user.name);
  $("#admin-app").classList.remove("hide");
  $("#sidebar-name").textContent      = user.name;
  $("#sidebar-role").textContent      = user.role;
  /* Name and role in the top bar. */
  $("#topbar-user-name").textContent  = user.name;
  $("#topbar-role-label").textContent = user.role;
  $("#sidebar-avatar").textContent    = avatar;
  $("#topbar-avatar").textContent     = avatar;
  /* The chip's accessible name as one sentence (its text parts are aria-hidden). */
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

/* True if a valid session was found and the app was shown (async). */
async function checkSessionAuth(){
  try {
    const user = await EbSession.bootstrap();
    if(!user) return false;

    /* Signed in to the wrong portal: send them to the landing page (the server enforces this too). */
    const expected = portalRole();
    if(expected && user.role !== expected){
      window.location.href = PORTAL_BASE_PATH + "public/index.html";
      return false;
    }

    applySignedInUser(user);
    await loadCatalog();      /* real rows before anything renders */
    renderDashboard();
    /* Reopen the module named in the address (#online-txns) after a reload, otherwise mark the dashboard as the first history entry. */
    const fromHash = decodeURIComponent((location.hash || "").slice(1)).split("/");
    /* A guard entry sits below the dashboard: pressing Back past the first page asks to sign out instead of leaving. */
    const base = location.pathname + location.search;
    history.replaceState({ ebMod: "dashboard", ebGuard: true }, "", base + "#dashboard");
    history.pushState({ ebMod: "dashboard" }, "", base + "#dashboard");
    if(fromHash[0] && fromHash[0] !== "dashboard" && document.getElementById("mod-" + fromHash[0])){
      navigate(fromHash[0], fromHash[1] || undefined);
    }
    return true;
  } catch(err){
    console.error("[session]", err);
    return false;
  }
}

/* ===== SIGN-IN: staff sign in on the landing page only; no session sends them back there ===== */
const LANDING_URL = PORTAL_BASE_PATH + "public/index.html";

async function initLogin(){
  const ok = await checkSessionAuth();
  if(!ok) window.location.replace(LANDING_URL);
}

/* ===== SIDEBAR / NAVIGATION ===== */

/* Modules that remember their last tab; resolved here so the sidebar highlight and the render use the same tab. */
const TAB_MEMORY = {
  users:              () => adminState.userTabActive     || "customers",
  products:           () => adminState.productsTabActive || "catalog",
  "inventory-manage": () => adminState.invTab            || "overview",
};

/** The one sidebar highlight rule, called by navigate() and by renders (safe to call twice). */
function syncNavHighlight(mod, tab){
  $$(".nav-item").forEach(btn => btn.classList.remove("active"));

  $$(".nav-item").forEach(btn => {
    if(btn.dataset.mod !== mod) return;
    /* The parent row (or a plain module) stays highlighted, since it is the only indicator in icon-only mode. */
    if(!btn.dataset.tab) btn.classList.add("active");
    /* The matching sub-item. */
    if(btn.dataset.tab === tab) btn.classList.add("active");
  });

  /* Drawers (Inventory Management, User Management, Products) stay closed unless the open module is inside them. */
  $$(".nav-parent").forEach(p => {
    const sub = p.nextElementSibling;
    const inside = sub?.classList.contains("nav-sub-list") && sub.querySelector(".nav-item.active");
    p.classList.toggle("collapsed", !(inside || p.classList.contains("active")));
  });
  /* Reopen a collapsed group or drawer so the highlighted item is visible (icon-only mode is left alone). */
  $$(".nav-item.active").forEach(btn => {
    btn.closest(".nav-group")?.classList.remove("collapsed");
    const parent = btn.closest(".nav-sub-list")?.previousElementSibling;
    if(parent?.classList.contains("nav-parent")) parent.classList.remove("collapsed");
  });
}

/* Refresh re-renders in place without enterModule(), keeping search, filters and page. */
const NAV_REFRESH = "__refresh";
/* True while navigate() runs because of the browser's Back/Forward, so it does not add another history entry. */
let NAV_FROM_HISTORY = false;
window.addEventListener("popstate", e => {
  const st = e.state;
  /* Back while a popup is open closes the popup and keeps the current module (the history step is put back). */
  const overlay = document.getElementById("modal-overlay");
  if(overlay && overlay.classList.contains("open")){
    closeModal();
    history.pushState({ ebMod: adminState.currentModule, ebTab: (TAB_MEMORY[adminState.currentModule]?.() || null) }, "",
      location.pathname + location.search + "#" + adminState.currentModule);
    return;
  }
  if(!st || !st.ebMod || typeof navigate !== "function") return;
  /* Back from the first page: stay in the portal and offer to sign out (Cancel keeps you here). */
  if(st.ebGuard){
    history.pushState({ ebMod: adminState.currentModule || "dashboard" }, "",
      location.pathname + location.search + "#" + (adminState.currentModule || "dashboard"));
    if(typeof logout === "function") logout();
    return;
  }
  NAV_FROM_HISTORY = true;
  try { navigate(st.ebMod, st.ebTab || undefined); }
  finally { NAV_FROM_HISTORY = false; }
});

function navigate(mod, tab, intent){
  /* deactivate all panels and nav items */
  /* If the module is not allowed, go back to the dashboard. */
  if(MOD_PERM[mod] && !hasPerm(MOD_PERM[mod])){
    toast("You don't have access to that section.", "err");
    if(mod !== "dashboard") return navigate("dashboard");
  }

  $$(".mod-panel").forEach(p  => p.classList.remove("active"));

  adminState.currentModule = mod;
  const panel = $(`#mod-${mod}`);
  if(panel) panel.classList.add("active");

  /* One value drives both highlight and render (see TAB_MEMORY). */
  const activeTab = tab || TAB_MEMORY[mod]?.() || undefined;

  syncNavHighlight(mod, activeTab);

  /* On arrival, reset the destination's filters, then apply this navigation's intent, before rendering. */
  const isRefresh = intent === NAV_REFRESH;

  /* Browser history: every move to another module (or tab) is a history entry, so Back and Forward step through the
     modules visited instead of leaving the portal. Moves made BY Back/Forward are not recorded again. */
  if(!isRefresh && !NAV_FROM_HISTORY){
    const cur = history.state && history.state.ebMod ? history.state : null;
    const next = { ebMod: mod, ebTab: tab || null };
    const url = location.pathname + location.search + "#" + mod + (tab ? "/" + tab : "");
    if(!cur) history.replaceState(next, "", url);
    else if(cur.ebMod !== next.ebMod || (cur.ebTab || null) !== next.ebTab) history.pushState(next, "", url);
  }
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
    /* Reviews fetch on arrival because their rows are filtered on the server by tab. */
    reviews:       loadReviews,
    /* Fetches its own data on arrival — assets/js/portal/vat.js. */
    vat:           renderVat,
    /* assets/js/portal/shipping.js — fetches the rate tables on arrival. */
    shipping:      renderShipping,
  };
  /* The intent lasts for one render, cleared in finally even if the render throws. */
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

/* A shortcut's filter is a one-shot intent passed to navigate() and cleared after one render, and every arrival resets the screen's filters, so a filter never sticks around. */
let NAV_INTENT = null;

/* Read one field of the current navigation's intent (undefined if none). */
function navIntent(key){
  return NAV_INTENT ? NAV_INTENT[key] : undefined;
}

/* Per screen: how to reset to default filters and what an intent can override. */
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
    /* The Inventory Report filter lives on its select element, so reset writes the element. */
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
      /* Sync EbSelect after setting .value directly, so the trigger shows the active filter. */
      if(window.EbSelect) EbSelect.sync(el);
    },
  },
  sales: {
    /* The report opens on its own default range unless told otherwise. */
    reset(){ adminState.salesRange = "today"; },
    apply(intent){ if(intent.range) adminState.salesRange = intent.range; },
  },
  ordersqueue: {
    reset(){ adminState.queueFilter = "pending"; if(adminState.queuePager) adminState.queuePager.page = 1; },
    apply(intent){ if(intent.status) adminState.queueFilter = intent.status; },
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

/* Wire [data-goto] links (no inline onclick), idempotently since the dashboard rebuilds its cards. */
function wireGoto(root = document){
  $$("[data-goto]", root).forEach(btn=>{
    if(btn.dataset.gotoWired) return;
    btn.dataset.gotoWired = "1";
    btn.addEventListener("click", ()=>{
      /* data-filter-level/-range/-status become the intent for NAV_ENTRY. */
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
    /* .nav-parent navigation is bound below with its drawer toggle, in one handler. */
    if(btn.classList.contains("nav-parent")) return;
    btn.addEventListener("click", ()=> navigate(btn.dataset.mod, btn.dataset.tab));
  });
  $$(".dash-shortcut-btn[data-mod]").forEach(btn=>{
    btn.addEventListener("click", ()=> navigate(btn.dataset.mod, btn.dataset.tab));
  });

  /* Filter inputs marked data-refilters="<screen>" reset to page 1 and re-render that screen (replacing inline handlers). */
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
      /* Warn loudly about an unknown data-refilters value. */
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
    if (window.innerWidth <= 900) {
      const open = sidebar.classList.toggle("open");
      overlay.classList.toggle("show", open);
    } else {
      $("#admin-app").classList.toggle("sidebar-collapsed");
      /* Redraw charts explicitly after collapsing the sidebar. */
      redrawCharts();
    }
  });
  overlay.addEventListener("click", ()=>{
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
  });

  $("#sidebar-logout")?.addEventListener("click", logout);

  $$(".nav-group-label").forEach(label => {
    label.addEventListener("click", () => {
      label.closest(".nav-group").classList.toggle("collapsed");
    });
  });

  /* Parent row: clicking the chevron only opens/closes the drawer; clicking elsewhere navigates and keeps the drawer open. */
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

  /* Keep aria-expanded in step with the open class. */
  const setOpen = open => {
    userWrap.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  trigger.addEventListener("click", e => {
    e.stopPropagation();
    setOpen(!userWrap.classList.contains("open"));
  });

  document.addEventListener("click", () => setOpen(false));

  /* Escape closes the menu and returns focus to the trigger. */
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
      /* Also destroy the server session on logout. */
      try { await EbSession.logout(); } catch(_){}
      window.location.href = PORTAL_BASE_PATH + "public/index.html";
    }
  });
}

/* ===== MODULE: DASHBOARD ===== */

/* Dashboard tiles are buttons that open the screen behind their number (some with a one-shot filter); a tile whose destination the role cannot open is a plain div, and the sub-line is a separate button. */
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

/* Inventory dashboard rule (by permission, never role name): has inventory.report or inventory.manage AND NOT sales.report. */
function isInventoryDashboard(){
  return (hasPerm("inventory.report") || hasPerm("inventory.manage")) && !hasPerm("sales.report");
}

/* Notification types that count as inventory matters. */
const INVENTORY_NOTIF_TYPES = ["inventory", "expiry", "batch-qa"];

/* Orders Waiting for Approval panel: pending online orders, oldest first with their wait time, fetched fresh on every dashboard visit. */
/* Short payment note for the approval rows, matching paymentNote() in orders.js: cash pickup, credit terms and walk-ins need no proof. */
function apprProofText(o){
  if(o.proof && o.proof.uploaded) return "✓ Proof";
  if(o.type === "walk-in") return "Paid at counter";
  if(o.payMethod === "cash" && o.orderType === "pickup") return "Pay on pickup";
  if(isCreditOrder(o)) return "Not yet paid for this term";
  return "No proof";
}
function apprProofTone(o){
  const t = apprProofText(o);
  return t === "✓ Proof" ? "ok" : t === "No proof" ? "no" : "muted";
}

async function renderApprovalPanel(){
  const panel = $("#dash-approval-panel");
  if(!panel) return;
  const show = hasPerm("orders.accept");
  panel.classList.toggle("hide", !show);
  if(!show) return;

  const statsEl = $("#dash-appr-stats"), listEl = $("#dash-appr-list");
  listEl.innerHTML = EbUI.skeletonBlock(4);
  let rows, meta;
  try {
    ({ data: rows, meta } = await EbApi.get("orders/list.php", {
      type: "online", status: "pending", sort: "oldest", limit: 100,
    }));
  } catch(err){
    listEl.innerHTML = `<div class="appr-empty">Could not load orders: ${escHtml(err.message)}</div>`;
    return;
  }
  const counts   = (meta && meta.counts) || {};
  const pending  = (meta && meta.total) || rows.length;
  const withProof= rows.filter(o => o.proof && o.proof.uploaded).length;
  const value    = rows.reduce((n, o) => n + orderTotal(o), 0);
  const ageH     = o => (Date.now() - new Date(String(o.datetime).replace(" ", "T")).getTime()) / 36e5;
  const late     = rows.filter(o => ageH(o) >= 24).length;
  const ago = o => {
    const h = ageH(o);
    if(!isFinite(h)) return "";
    if(h < 1)  return `${Math.max(1, Math.round(h * 60))} min`;
    if(h < 24) return `${Math.floor(h)} hr`;
    return `${Math.floor(h / 24)} day${h >= 48 ? "s" : ""}`;
  };

  /* Neutral numbers on white cards; colour only in the icon chip. */
  const ICO = {
    clock: `<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>`,
    proof: `<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><polyline points="9 15 11 17 15 13"/>`,
    alert: `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
    pause: `<circle cx="12" cy="12" r="9"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/>`,
    cash:  `<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>`,
  };
  const stat = (label, val, tone, icon, status = "pending", note = "") => {
    const tag = status ? "button" : "div";
    return `<${tag} ${status ? `type="button" data-goto="ordersqueue" data-filter-status="${status}"` : ""} class="appr-stat tone-${tone}${status ? "" : " is-static"}">
      <span class="appr-stat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICO[icon]}</svg></span>
      <span class="appr-stat-body"><span class="appr-stat-val">${val}</span><span class="appr-stat-lbl">${label}</span>${note ? `<span class="appr-stat-note">${note}</span>` : ""}</span>
    </${tag}>`;
  };
  statsEl.innerHTML =
      stat("Waiting for approval", pending, "gold", "clock")
    + stat("Proof uploaded", withProof, "ok", "proof")
    + stat("Waiting over 24 hrs", late, "alert", "alert", "pending", late ? "Needs action" : "")
    + stat("Value waiting", peso(value), "gold", "cash", "");

  listEl.innerHTML = rows.length
    ? rows.slice(0, 5).map(o => `
      <button type="button" class="appr-row" data-goto="ordersqueue" data-filter-status="pending">
        <span class="appr-row-id mono-sm">${escHtml(o.id)}</span>
        <span class="appr-row-cust">${escHtml(o.customer)}</span>
        <span class="appr-row-proof ${apprProofTone(o)}">${apprProofText(o)}</span>
        <span class="appr-row-total">${peso(orderTotal(o))}</span>
        <span class="appr-row-age ${ageH(o) >= 24 ? "late" : ""}">${ago(o)} ago</span>
      </button>`).join("")
      + (pending > 5 ? `<button type="button" class="appr-more" data-goto="ordersqueue" data-filter-status="pending">Showing 5 of ${pending} — view all in Order Queue →</button>` : "")
    : `<div class="appr-empty">No orders waiting — the queue is clear.</div>`;
  wireGoto(panel);
}

function renderDashboard(){
  renderApprovalPanel();
  /* Decide once which dashboard this is; every panel follows it. */
  const invView = isInventoryDashboard();
  const showPanel = (sel, on) => { const el = $(sel); if(el) el.classList.toggle("hide", !on); };
  showPanel("#dash-sales-panel",  !invView);
  showPanel("#dash-recent-panel", !invView);
  showPanel("#dash-rank-panel",    invView);
  /* Tell the grid too, since list heights in portal.css depend on whether the sales panel is shown. */
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

  /* Payment Schemes badge: payments to review take priority over overdue accounts; empty hides it. */
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
  /* Critical Stock uses the server's band (not a fixed count) so it matches the Inventory Report it links to. */
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

  /* Critical Stock links to Stock Overview if the user can restock, otherwise the Inventory Report, otherwise nowhere. */
  const stockDest = hasPerm("inventory.manage")
    ? { mod: "inventory-manage", tab: "overview", perm: "inventory.manage" }
    : hasPerm("inventory.report")
      ? { mod: "inventory", tab: null, perm: "inventory.report" }
      : null;

  /* Inventory dashboard tiles: Critical and Out of Stock open filtered (one-shot), Total Products and Stock on Hand open unfiltered. */
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
        /* The archived count is information only, not a link. */
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
        sub: `${ORDERS.length} total transactions${refundedBetween(null, null) ? ` · less ${peso(refundedBetween(null, null))} refunds` : ""}`,
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
        /* Today's Sales opens the report on Today once. */
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
        /* The retailer sub-line opens Customers filtered to retailers once. */
        subLink: { mod: "users", tab: "customers", perm: "users.manage",
                intent: { status: "retailer" },
                aria: `${retailers} retailer(s). Show retailer accounts.` },
      }),
    ].join("");

    /* The cards are rebuilt on every visit, so their listeners are too. */
    wireGoto($("#dash-stats"));
  }

  /* 7-day sales sparkline, skipped on the inventory dashboard. */
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
    /* Inline colours darkened to reach 4.5:1 on cream. */
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

  /* System Notifications reads the same rows, permissions, order and levels as the bell and the Notifications module. */
  /* On the inventory dashboard this panel (and its count) shows inventory notifications only. */
  const dashFeed = (typeof visibleNotifications === "function")
    ? visibleNotifications().filter(n => !invView || INVENTORY_NOTIF_TYPES.includes(n.type))
    : [];

  const dashNotifs = (typeof sortByUrgency === "function")
    ? sortByUrgency(dashFeed).slice(0, 8)
    : dashFeed.slice(0, 8);

  const dashUnread = dashFeed.filter(n=>!n.read).length;

  /* The badge shows the unread count, not the total. */
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

  /* The top bar badge is set by initNotifBadge() in orders.js, not here. */
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
      <td><span class="badge ${methodBadgeClass(payMethodLabel(tx.payMethod))}">${escHtml(payMethodLabel(tx.payMethod) || "—")}</span></td>
      <td class="muted">${fmtDate(tx.date)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">No transactions yet.</td></tr>`;
}

/* Product Rankings come from api/reports/top-products.php (same rules as the Sales Report), with the stock column showing the measured band. */
function renderDashRankings(){
  const body = $("#dash-rankings");
  const note = $("#dash-rank-note");
  if(!body) return;

  const wholeRow = html =>
    `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">${html}</td></tr>`;

  body.innerHTML = EbUI.loadingRow(5);

  EbApi.get("reports/top-products.php", { range: "week", limit: 5 })
    .then(({ data, meta }) => {
      const r = meta && meta.range;
      if(note){
        note.textContent = r && r.from
          ? `by units sold · ${fmtDate(r.from)} – ${fmtDate(r.to)}`
          : "by units sold this week";
      }
      if(!data || !data.length){
        /* Say in words when the period has no sales. */
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

/* ===== MODULE: USER MANAGEMENT ===== */
function renderUsers(tab){
  /* Each tab has its own permission: Customer Accounts (users.manage), Employee Accounts (employees.manage). */
  const canCust = hasPerm("users.manage"), canEmp = hasPerm("employees.manage");
  $$("[data-user-tab]").forEach(btn => btn.classList.toggle("hide", btn.dataset.userTab === "customers" ? !canCust : !canEmp));
  let activeTab = tab || adminState.userTabActive || "customers";
  if(activeTab === "customers" && !canCust) activeTab = "employees";
  if(activeTab === "employees" && !canEmp) activeTab = "customers";
  adminState.userTabActive = activeTab;

  /* Highlight the sidebar in the render, however the screen was reached. */
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
  /* Show the filter set for the active tab in the merged toolbar. */
  $$(".tab-filters", $("#mod-users")).forEach(f=>{
    f.classList.toggle("active", f.dataset.tabFilters === activeTab);
  });

  /* header action button */
  $("#users-header-actions").innerHTML = activeTab === "customers"
    ? `<button class="btn btn-gold" id="add-customer-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Add Customer</button>`
    : ``;

  if(activeTab === "customers") renderCustomers();
  else renderEmployees();

  /* Tab handlers use onclick (assignment) so re-renders do not stack listeners. */
  $$("[data-user-tab]").forEach(btn=>{
    btn.onclick = ()=> renderUsers(btn.dataset.userTab);
  });
  const addCust = $("#add-customer-btn");
  if(addCust) addCust.addEventListener("click", ()=> openAddCustomerModal());
  const addEmp = $("#add-employee-btn");
  /* Only the Super Admin adds or edits employees (api/users/save.php refuses everyone else). */
  if(addEmp) addEmp.classList.toggle("hide", !adminState.currentUser?.isSystem);
  if(addEmp && !addEmp.dataset.wired){ addEmp.dataset.wired = "1"; addEmp.addEventListener("click", ()=> openAddEmployeeModal()); }
}

/* Customers are server-paged and only have Archive, since name, email and contact belong to the customer (customers/save.php enforces this); Employee Accounts can still be edited. */
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
          title="Invited, not signed up yet: no password is set. The invitation email links to the storefront sign-up with this email, which claims this record.">Invited · not signed up</span>`}
      </td>
      <td>${escHtml(c.contact || "—")}</td>
      <td><span class="badge ${c.status==="active"?"badge-ok":c.status==="retailer"?"badge-info":"badge-muted"}">${c.status}</span></td>
      <td class="muted">${fmtDate(c.joined)}</td>
      <td>
        <div class="td-actions">
          ${c.status!=="archived" ? `
            ${c.canSignIn ? "" : `<button class="btn btn-ghost btn-sm" data-invite-cust="${c.id}" title="Email the 'create your account' link again">Resend invite</button>`}
            <button class="btn btn-ghost-danger btn-sm" data-archive-cust="${c.id}">Archive</button>
          ` : `<span class="muted" style="font-size:.78rem">Archived</span>`}
        </div>
      </td>
    </tr>`,
    {
      colspan: 6,
      empty: { title: "No customers found", hint: "Adjust the search or status filter." },
      after: (rows) => {
        /* Update these rows in the full customer list (used by the dashboard counts and the modals) instead of
           replacing the list with just this page or filter, which made the dashboard show only the last page viewed. */
        rows.forEach(r => { const i = CUSTOMERS.findIndex(c => c.id === r.id); if(i > -1) CUSTOMERS[i] = r; else CUSTOMERS.push(r); });
        const tbody = $("#customers-tbody");
        tbody.querySelectorAll("[data-archive-cust]").forEach(btn=>{
          btn.addEventListener("click", ()=> archiveCustomer(btn.dataset.archiveCust));
        });
        tbody.querySelectorAll("[data-invite-cust]").forEach(btn=>{
          btn.addEventListener("click", async ()=>{
            const restore = EbUI.busy(btn, "Sending…");
            try {
              const { data } = await EbApi.post("customers/invite.php", { id: btn.dataset.inviteCust });
              toast(data.mailLive ? "Invitation emailed again." : "Invitation saved to the mail log (email is not set up on this install).", "ok");
            } catch(err){ toast(err.message, "err"); }
            finally { restore(); }
          });
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
    body: `<p class="field-hint" style="margin:0 0 14px">They get an email inviting them to create their password on the website.
             Until they do, you can still file their walk-in purchases under them at the POS (Customer on Record).</p>
           <div class="field"><label>Full Name</label><input class="control" id="m-cust-name" placeholder="e.g. Juan dela Cruz"/><span class="field-error" id="m-cust-name-err"></span></div>
           <div class="field"><label>Email</label><input class="control" type="email" id="m-cust-email" placeholder="email@example.com"/></div>
           <div class="field"><label>Contact Number</label><input class="control" id="m-cust-contact" placeholder="+63 9XX XXX XXXX"/></div>`,
    confirmLabel: "Add Customer",
    onConfirm: async ()=>{
      const name    = $("#m-cust-name").value.trim();
      const email   = $("#m-cust-email").value.trim();
      const contact = $("#m-cust-contact").value.trim();
      if(!name){ $("#m-cust-name-err").textContent="Name is required."; return; }
      /* No optimistic insert; refresh from the server after saving. */
      try {
        var { data: saved } = await EbApi.post("customers/save.php", {
          name, email: $("#m-cust-email").value.trim(),
          contact: $("#m-cust-contact").value.trim(), status: "active",
        });
        await loadAdminData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast(saved.invited
        ? (saved.mailLive ? `Customer added. An invitation to create their account was emailed to ${saved.email}.`
                          : "Customer added. The invitation went to the mail log (email is not set up on this install).")
        : "Customer added, but the invitation email could not be sent. Use “Resend invite” in the list.", saved.invited ? "ok" : "warn");
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
      /* Archive only after the server agrees, using customers/archive.php (status only). */
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

/* Role badge colours by hierarchy: Super Admin, Admin, then distinct cooler colours for staff roles. */
function roleBadgeClass(role){
  return {
    "Super Admin":        "badge-out",
    "Admin":               "badge-crit",
    "Inventory Staff":     "badge-ok",
    "Cashier":              "badge-info",
    "Online Orders Staff": "badge-purple",
  }[role] || "badge-muted";
}

/* Employees are server-paged too. */
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
            ${adminState.currentUser?.isSystem ? `<button class="btn btn-ghost btn-sm" data-edit-emp="${e.id}">Edit</button>` : ""}
            ${+e.is_system === 1 && !adminState.currentUser?.isSystem ? "" : `<button class="btn btn-ghost-danger btn-sm" data-archive-emp="${e.id}">Archive</button>`}
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
        /* The password is sent once and hashed on the server. */
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
        /* Show the server's refusals (own role change, escalation) as is. */
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
        /* The server also refuses archiving yourself or the last rbac.manage account. */
        await EbApi.post("users/archive.php", { id: e.id, archived: true });
        await loadAdminData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast("Employee archived.", "warn");
      renderEmployees();
    }
  });
}

/* ===== MODULE: B2B RETAIL PARTNER APPLICATIONS ===== */
function b2bStatusBadge(status){
  const MAP = {
    pending:  { cls:"badge-warn", label:"Pending Review" },
    approved: { cls:"badge-ok",   label:"Approved" },
    rejected: { cls:"badge-out",  label:"Rejected" },
  };
  const m = MAP[status] || MAP.pending;
  return `<span class="badge ${m.cls}">${m.label}</span>`;
}

/* Different colours for Gold, Silver and Bronze. */
function tierBadge(tier){
  const cls = { Gold:"badge-tier-gold", Silver:"badge-tier-silver", Bronze:"badge-tier-bronze" }[tier] || "badge-muted";
  return `<span class="badge ${cls}">${escHtml(tier)} Tier</span>`;
}
const TIER_RANK = { Gold: 3, Silver: 2, Bronze: 1 };
const TIERS = ["Bronze", "Silver", "Gold"];

/* Tier budgets (api/payments/tiers.php), fetched once per screen that needs them. */
async function loadTierLimits(){
  try {
    const { data } = await EbApi.get("payments/tiers.php");
    adminState.creditLimits = data.limits;
  } catch(_){ /* the picker still works without the amounts */ }
  return adminState.creditLimits || null;
}

/* Bronze / Silver / Gold radio cards with a medal, each showing its Net credit budget; `current` marks the partner's present tier. */
function tierPickerHtml(selected, limits, current = null){
  const medal = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 22l5-3 5 3-1.5-8"/></svg>`;
  return `<div class="tier-pick" role="radiogroup" aria-label="Partner tier">${TIERS.map(t => `
    <label class="tier-pick-opt tb-${t.toLowerCase()}">
      <input type="radio" name="m-tier" value="${t}" ${t === selected ? "checked" : ""}/>
      <span class="tier-pick-card">
        <span class="tier-pick-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        <span class="tb-medal tier-pick-medal" aria-hidden="true">${medal}</span>
        <span class="tier-pick-name">${t}</span>
        <span class="tier-pick-amt">${limits ? peso(limits[t]) : "—"}</span>
        <span class="tier-pick-sub">${t === current ? "Current tier" : "Net credit budget"}</span>
      </span>
    </label>`).join("")}</div>`;
}

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
    /* Sort tiers by rank, not alphabetically. */
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
      <td>${b2bStatusBadge(a.status)}${a.status === "approved" && a.tier ? `<div style="margin-top:4px">${tierBadge(a.tier)}</div>` : ""}</td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-view-app="${a.id}">View</button>
        ${a.status === "approved" && a.isRetailer ? `<button class="btn btn-gold btn-sm" data-tier-app="${a.id}">Change Tier</button>` : ""}
        ${a.status==="pending" ? `
          <button class="btn btn-ok btn-sm" data-approve-app="${a.id}">Approve</button>
          <button class="btn btn-ghost-danger btn-sm" data-reject-app="${a.id}">Reject</button>
        ` : ""}
      </div></td>
    </tr>`).join("") || `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:32px">No applications match your search.</td></tr>`;

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

  /* Compare ids with String(), since dataset values are strings and b2b ids are numbers. */
  tbody.querySelectorAll("[data-view-app]").forEach(btn=>{
    btn.addEventListener("click", ()=> openViewAppModal(B2B_APPLICATIONS.find(x=>String(x.id) === btn.dataset.viewApp)));
  });
  tbody.querySelectorAll("[data-approve-app]").forEach(btn=>{
    btn.addEventListener("click", ()=> openApproveAppModal(B2B_APPLICATIONS.find(x=>String(x.id) === btn.dataset.approveApp)));
  });
  tbody.querySelectorAll("[data-tier-app]").forEach(btn=>{
    btn.addEventListener("click", ()=> openChangeTierModal(B2B_APPLICATIONS.find(x=>String(x.id) === btn.dataset.tierApp)));
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
  const budgetBtn = $("#tier-budgets-btn");
  if(budgetBtn) budgetBtn.onclick = openTierBudgets;
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
        ${b2bStatusBadge(a.status)}${a.status === "approved" && a.tier ? tierBadge(a.tier) : ""}
      </div>
      <!-- The TIN is what the reviewer checks against BIR records to confirm
           the store is real, so it leads, set apart from the other details. -->
      <div class="b2b-tin-card${a.birTin ? "" : " is-missing"}">
        <div>
          <div class="b2b-tin-label">BIR TIN</div>
          <div class="b2b-tin-val">${a.birTin ? escHtml(a.birTin) : "Not provided"}</div>
        </div>
        <span class="b2b-tin-hint">${a.birTin ? "Verify against BIR records before approving." : "Ask the applicant for their TIN before approving."}</span>
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
        ${a.address ? `<div class="detail-row"><span class="detail-row-label">Business Address</span><span class="detail-row-val">${escHtml(a.address)}</span></div>` : ""}
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

async function openApproveAppModal(a){
  if(!a) return;
  /* The tier sets how much the retailer may owe on Net terms at once. */
  const limits = await loadTierLimits();
  openModal({
    title: `Approve ${a.businessName}`,
    body: `
      <p style="font-size:.9rem;margin-bottom:12px">Approving grants <strong>${escHtml(a.applicantName)}</strong> a retailer account for <strong>${escHtml(a.businessName)}</strong>.</p>
      <p style="font-size:.86rem;color:var(--text-muted);margin:0 0 12px">They can then use every payment method: Cash, GCash, Bank Transfer and Net 30 / 60 / 90 credit terms, chosen at checkout on each order.</p>
      <div class="field">
        <label>Partner tier</label>
        ${tierPickerHtml("Bronze", limits)}
        <span class="field-hint">Unpaid Net balances plus a new Net order cannot go above the tier's budget. You can change the tier later.</span>
      </div>
      <div class="b2b-tin-card${a.birTin ? "" : " is-missing"}" style="margin:0">
        <div><div class="b2b-tin-label">BIR TIN</div><div class="b2b-tin-val">${a.birTin ? escHtml(a.birTin) : "Not provided"}</div></div>
      </div>
    `,
    confirmLabel: "Approve Application",
    confirmClass: "btn-ok",
    onConfirm: async ()=>{
      try {
        /* Approval is one server transaction that promotes the customer to retailer. */
        const { data } = await EbApi.post("b2b/decide.php", {
          app_id: a.appId, decision: "approved",
          tier: $('input[name="m-tier"]:checked')?.value || "Bronze",
        });
        adminState.lastB2bMail = data;
        await loadOpsData();
        await loadAdminData();
        if(!data.promoted){
          toast("Approved. No existing customer record to promote — the partner account is created at signup.", "warn");
        }
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast(b2bMailNote("Application approved.", adminState.lastB2bMail, a.email), adminState.lastB2bMail?.emailed ? "ok" : "warn");
      renderB2B();
    }
  });
}

/* Upgrade or downgrade an approved partner's tier, which changes their Net credit budget straight away. */
async function openChangeTierModal(a){
  if(!a) return;
  const limits = await loadTierLimits();
  openModal({
    title: `Change Tier — ${a.businessName}`,
    body: `
      <p style="font-size:.9rem;margin-bottom:12px"><strong>${escHtml(a.applicantName)}</strong> is currently ${tierBadge(a.tier || "Bronze")}.</p>
      <div class="field">
        <label>New tier</label>
        ${tierPickerHtml(a.tier || "Bronze", limits, a.tier || "Bronze")}
        <span class="field-hint">The new budget applies to their next Net order. Orders already placed are not affected.</span>
      </div>`,
    confirmLabel: "Save Tier",
    onConfirm: async ()=>{
      const tier = $('input[name="m-tier"]:checked')?.value;
      if(!tier || tier === (a.tier || "Bronze")){ closeModal(); return; }
      try {
        const { data } = await EbApi.post("b2b/tier.php", { app_id: a.appId, tier });
        adminState.lastB2bMail = data;
        await loadOpsData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast(b2bMailNote(`${a.businessName} is now ${tier} tier.`, adminState.lastB2bMail, a.email), adminState.lastB2bMail?.emailed ? "ok" : "warn");
      renderB2B();
    }
  });
}

/* Toast text saying whether the applicant's email actually went out (the server reports emailed / mailLive). */
function b2bMailNote(done, res, email){
  if(!res) return done;
  if(res.emailed && res.mailLive !== false) return `${done} Email sent to ${email}.`;
  if(res.emailed) return `${done} Email saved but not delivered (mail is not set up) — let ${email} know directly.`;
  return `${done} The email to ${email} could not be sent — let them know directly.`;
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
        const { data } = await EbApi.post("b2b/decide.php", {
          app_id: a.appId, decision: "rejected", reason,
        });
        adminState.lastB2bMail = data;
        await loadOpsData();
      } catch(err){ toast(err.message, "err"); return; }
      closeModal();
      toast(b2bMailNote("Application rejected.", adminState.lastB2bMail, a.email), "warn");
      renderB2B();
    }
  });
}

function exportB2BCSV(){
  const rows = getFilteredSortedB2B();
  const header = ["App ID","Business Name","Applicant","Email","Phone","Business Type","BIR TIN","Business Address","Status","Tier","Submitted Date","Notes","Rejection Reason"];
  const csvRows = rows.map(a=>[
    a.appId, a.businessName, a.applicantName, a.email, a.phone, a.businessType,
    a.birTin||"", a.address||"", a.status, a.status === "approved" ? (a.tier||"") : "", a.submittedDate, a.notes||"", a.reason||""
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
      <div class="lp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg> Hero Text
        <span class="lp-hint">The words over the hero image</span>
      </div>
      ${(() => { const h = SITE_CONTENT.heroText || {}; return `
      <div class="lp-hero-text">
        <div class="field"><label for="lp-hero-tagline">Header tagline</label>
          <input class="control" id="lp-hero-tagline" maxlength="120" value="${escHtml(h.tagline || "")}" placeholder="Every Mouthful is Delightful."/>
          <span class="field-hint">Shown large, in quotation marks (added automatically).</span>
          <span class="field-error" id="lp-hero-tagline-err"></span></div>
        <div class="field"><label for="lp-hero-highlight">Highlighted word</label>
          <input class="control" id="lp-hero-highlight" maxlength="40" value="${escHtml(h.highlight || "")}" placeholder="Delightful"/>
          <span class="field-hint">A word from the tagline shown in gold italics. Leave blank for none.</span>
          <span class="field-error" id="lp-hero-highlight-err"></span></div>
        <div class="field lp-hero-wide"><label for="lp-hero-lead">Text under the tagline</label>
          <textarea class="control" id="lp-hero-lead" rows="2" maxlength="240" placeholder="Every product starts with fresh, locally-sourced milkfish…">${escHtml(h.lead || "")}</textarea></div>
        <div class="field"><label>First stat</label>
          <div class="lp-stat-row"><input class="control" id="lp-stat1-value" maxlength="12" value="${escHtml(h.stat1_value || "")}" placeholder="100%" aria-label="First stat number"/>
          <input class="control" id="lp-stat1-label" maxlength="30" value="${escHtml(h.stat1_label || "")}" placeholder="Natural" aria-label="First stat label"/></div></div>
        <div class="field"><label>Second stat</label>
          <div class="lp-stat-row"><input class="control" id="lp-stat2-value" maxlength="12" value="${escHtml(h.stat2_value || "")}" placeholder="9+" aria-label="Second stat number"/>
          <input class="control" id="lp-stat2-label" maxlength="30" value="${escHtml(h.stat2_label || "")}" placeholder="years of craft" aria-label="Second stat label"/></div>
          <span class="field-hint">Leave both boxes empty to hide a stat.</span></div>
      </div>
      <div class="lp-hero-preview" aria-hidden="true"><div class="lp-hp-stats" id="lp-hp-stats"></div><p class="lp-hp-tag" id="lp-hp-tag"></p><p class="lp-hp-lead" id="lp-hp-lead"></p></div>`; })()}
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
  paintLandingTabs(el);
  wireHeroTextPreview();
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


/* Landing Page sections grouped into tabs. Every section stays in the page (only hidden), so Save Changes still saves all of them. */
const LP_TABS = [
  { id: "hero",    label: "Hero",               sections: [0, 1] },
  { id: "best",    label: "Best Sellers",       sections: [2] },
  { id: "about",   label: "About & Vision",     sections: [3, 4] },
  { id: "contact", label: "Contact & Payments", sections: [5, 6] },
  { id: "faq",     label: "FAQs",               sections: [7] },
];
/* Live preview of the hero text under its fields, matching how the storefront draws it. */
function readHeroText(){
  const v = id => ($(id)?.value || "").trim();
  return { tagline: v("#lp-hero-tagline"), highlight: v("#lp-hero-highlight"), lead: v("#lp-hero-lead"),
           stat1_value: v("#lp-stat1-value"), stat1_label: v("#lp-stat1-label"),
           stat2_value: v("#lp-stat2-value"), stat2_label: v("#lp-stat2-label") };
}
function wireHeroTextPreview(){
  const paint = () => {
    const h = readHeroText();
    let tag = escHtml(h.tagline || "");
    const i = h.highlight ? h.tagline.toLowerCase().indexOf(h.highlight.toLowerCase()) : -1;
    if(i >= 0) tag = escHtml(h.tagline.slice(0, i)) + "<em>" + escHtml(h.tagline.slice(i, i + h.highlight.length)) + "</em>" + escHtml(h.tagline.slice(i + h.highlight.length));
    $("#lp-hp-tag").innerHTML = h.tagline ? `&ldquo;${tag}&rdquo;` : "";
    $("#lp-hp-lead").textContent = h.lead;
    $("#lp-hp-stats").innerHTML = [[h.stat1_value, h.stat1_label], [h.stat2_value, h.stat2_label]]
      .filter(([a, b]) => a || b).map(([a, b]) => `<div><b>${escHtml(a)}</b><span>${escHtml(b)}</span></div>`).join("");
    const hlErr = $("#lp-hero-highlight-err");
    if(hlErr) hlErr.textContent = h.highlight && i < 0 ? "This word is not in the tagline." : "";
  };
  ["#lp-hero-tagline","#lp-hero-highlight","#lp-hero-lead","#lp-stat1-value","#lp-stat1-label","#lp-stat2-value","#lp-stat2-label"]
    .forEach(id => $(id)?.addEventListener("input", paint));
  paint();
}

function paintLandingTabs(el){
  const sections = [...el.querySelectorAll(":scope > .lp-section")];
  LP_TABS.forEach(t => t.sections.forEach(i => { if(sections[i]) sections[i].dataset.lpTab = t.id; }));
  const bar = document.createElement("div");
  bar.className = "tabs lp-tabs";
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Landing page sections");
  bar.innerHTML = LP_TABS.map(t => `<button type="button" class="tab-btn" role="tab" data-lp-tab="${t.id}">${t.label}</button>`).join("");
  el.prepend(bar);
  const show = id => {
    adminState.landingTab = id;
    bar.querySelectorAll("[data-lp-tab]").forEach(b => { const on = b.dataset.lpTab === id; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    sections.forEach(sec => { sec.hidden = sec.dataset.lpTab !== id; });
  };
  bar.querySelectorAll("[data-lp-tab]").forEach(b => b.addEventListener("click", () => show(b.dataset.lpTab)));
  show(LP_TABS.some(t => t.id === adminState.landingTab) ? adminState.landingTab : "hero");
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
/* Product names for a hero slide's picker, plus "Custom name…" for wording
   that is not a product name (the slide's current title if it is one). */
function heroNameOptions(current){
  const names = PRODUCTS.filter(p => !p.archived).map(p => p.name);
  /* A custom name is listed as its own option, so every card shows its real
     name in the same single dropdown. */
  const own = current && !names.includes(current)
    ? `<option value="${escHtml(current)}" selected>${escHtml(current)}</option>` : "";
  return own
    + names.map(n => `<option value="${escHtml(n)}"${n === current ? " selected" : ""}>${escHtml(n)}</option>`).join("")
    + `<option value="__custom">Type a custom name…</option>`;
}

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
        <!-- The product this slide features. Picking one renames the slide;
             "Custom name…" keeps any other wording. -->
        <div class="lp-hero-name">
          <select class="control" data-hero-pick="${i}" aria-label="Product shown on hero slide ${i + 1}">
            ${heroNameOptions(slide.title)}
          </select>
          <input class="control lp-hero-custom hide" data-hero-title="${i}"
                 maxlength="100" value="${escHtml(slide.title)}" placeholder="Slide name" aria-label="Custom name for hero slide ${i + 1}">
        </div>
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
  /* Slide name: a product from the list, or typed. Saved with Save Changes. */
  $$("[data-hero-pick]").forEach(function(sel){
    sel.addEventListener("change", function(){
      const i = +sel.dataset.heroPick;
      const custom = $(`[data-hero-title="${i}"]`);
      if(sel.value === "__custom"){
        custom.classList.remove("hide"); custom.focus(); custom.select();
      } else {
        custom.classList.add("hide");
        custom.value = sel.value;
        SITE_CONTENT.hero[i].title = sel.value;
        const img = $(`[data-hero="${i}"] .lp-img-thumb img`); if(img) img.alt = sel.value;
      }
    });
  });
  $$("[data-hero-title]").forEach(function(inp){
    const i = +inp.dataset.heroTitle;
    inp.addEventListener("input", function(){
      SITE_CONTENT.hero[i].title = inp.value;
    });
    /* Done typing: fold the name back into the dropdown and hide the box. */
    const finish = function(){
      const v = inp.value.trim();
      if(!v){ inp.focus(); toast("Give the slide a name.", "warn"); return; }
      SITE_CONTENT.hero[i].title = v;
      $("#lp-hero-grid").innerHTML = renderHeroImageCards();
      wireLandingImages();
    };
    inp.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); finish(); } });
    inp.addEventListener("blur", function(){ if(!inp.classList.contains("hide")) finish(); });
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
  SITE_CONTENT.heroText     = readHeroText();
  if(!SITE_CONTENT.heroText.tagline){ toast("The header tagline cannot be empty.", "err"); return; }
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
    heroText: SITE_CONTENT.heroText,
    about:   SITE_CONTENT.about,
    vision:  SITE_CONTENT.vision,
    mission: SITE_CONTENT.mission,
    contact: SITE_CONTENT.contact,
    faqs:    (SITE_CONTENT.faqs || []).filter(f => (f.q || "").trim() && (f.a || "").trim()),
    /* Paths, not images. `img` holds whatever api/uploads/image.php returned. */
    hero:     (SITE_CONTENT.hero || []).map(h => ({ id: h.id, title: String(h.title || "").trim(), image: h.img || "" })),
    featured: SITE_CONTENT.featured,
    payment:  SITE_CONTENT.payment,
  }).then(({ data }) => {
    toast("Landing page saved: " + (data.updated || []).join(", ") + ".", "ok");
    updateStorageMeter();
  }).catch(err => {
    const f = err.fields || {};
    toast("Could not save landing content: " + (f.hero_tagline || f.hero_highlight || f.hero_lead || f.hero || f.featured || f.payment || err.message), "err");
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
          /* Not lazy-loaded, so a newly saved photo shows immediately in this grid (images are small WebP). */
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
  const n = p?.nutrition || {};
  const nutInput = (key, label, unit) => `
      <div class="field nut-field"><label for="m-nut-${key}">${label}</label>
        <div class="unit-input"><input class="control" type="number" min="0" step="any" id="m-nut-${key}" data-nut="${key}" value="${escHtml(n[key] ?? "")}" placeholder="—"/><span>${unit}</span></div>
      </div>`;
  return `
  <div class="prod-form">
  <div class="pf-col">
  <section class="pf-section">
    <h4 class="pf-title">Basic details</h4>
    <div class="field"><label for="m-prod-name">Product Name</label><input class="control" id="m-prod-name" value="${escHtml(p?.name||"")}" placeholder="Product name"/><span class="field-error" id="m-prod-name-err"></span></div>
    <div class="pf-grid pf-grid-3">
      <div class="field"><label for="m-prod-cat">Category</label><select class="control" id="m-prod-cat">${catOpts}</select></div>
      <div class="field"><label for="m-prod-price">Price</label>
        <div class="unit-input unit-pre"><span>₱</span><input class="control" type="number" id="m-prod-price" value="${p?.price||""}" min="0"/></div></div>
      <div class="field"><label for="m-prod-weight">Net Weight</label>
        <div class="unit-input"><input class="control" type="number" id="m-prod-weight" value="${p?.weightG ?? ""}" min="1" step="1" placeholder="e.g. 500"/><span>g</span></div>
        <span class="field-error" id="m-prod-weight-err"></span></div>
    </div>
  </section>
  <section class="pf-section">
    <h4 class="pf-title">Product image</h4>
    <div class="field">
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
  </section>
  </div>
  <div class="pf-col">
  <section class="pf-section">
    <h4 class="pf-title">Nutrition facts <small>per serving · optional</small></h4>
    <div class="pf-grid pf-grid-2">
      <div class="field"><label for="m-nut-serving_size">Serving Size</label><input class="control" id="m-nut-serving_size" data-nut="serving_size" maxlength="40" value="${escHtml(n.serving_size ?? "")}" placeholder="e.g. 100 g (1 fillet)"/></div>
      <div class="field"><label for="m-nut-servings">Servings per Pack</label><input class="control" type="number" min="0" step="any" id="m-nut-servings" data-nut="servings" value="${escHtml(n.servings ?? "")}" placeholder="—"/></div>
    </div>
    <div class="pf-grid pf-grid-4 nut-grid">
      ${nutInput("calories","Calories","kcal")}
      ${nutInput("protein","Protein","g")}
      ${nutInput("fat","Total Fat","g")}
      ${nutInput("sat_fat","Saturated Fat","g")}
      ${nutInput("carbs","Carbohydrates","g")}
      ${nutInput("sugar","Sugars","g")}
      ${nutInput("cholesterol","Cholesterol","mg")}
      ${nutInput("sodium","Sodium","mg")}
    </div>
    <span class="field-error" id="m-nut-err"></span>
  </section>
  <section class="pf-section">
    <h4 class="pf-title">Description</h4>
    <div class="field"><textarea class="control" id="m-prod-desc" rows="4" aria-label="Description" placeholder="Short description shown on the storefront">${escHtml(p?.desc||"")}</textarea></div>
  </section>
  </div>
  </div>`;
}

/* Weight + nutrition fields, shared by Add and Edit. Blank inputs are sent as
   blank; the server drops them, so an all-empty label stores NULL. */
function productLabelPayload(){
  const nutrition = {};
  document.querySelectorAll(".prod-form [data-nut]").forEach(el=>{
    nutrition[el.dataset.nut] = el.value.trim();
  });
  return { net_weight_g: $("#m-prod-weight").value.trim(), nutrition };
}

function showProductFieldErrors(err){
  if(!err.isValidation) return false;
  const f = err.fields || {};
  if(f.name) $("#m-prod-name-err").textContent = f.name;
  if(f.net_weight_g) $("#m-prod-weight-err").textContent = f.net_weight_g;
  if(f.nutrition) $("#m-nut-err").textContent = f.nutrition;
  if(f.image) toast(f.image, "err");
  return !!(f.name || f.net_weight_g || f.nutrition || f.image);
}

function openAddProductModal(){
  openModal({
    title: "Add Product",
    large: true,
    body: productModalBody(null),
    confirmLabel: "Add Product",
    onConfirm: async ()=>{
      document.querySelectorAll(".prod-form .field-error").forEach(e=>e.textContent="");
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
          /* data-path holds the stored path; src is resolved for this page. */
          image: $("#m-prod-preview").dataset.path || null,
          ...productLabelPayload(),
        });
        await loadCatalog();
      } catch(err){
        if(!showProductFieldErrors(err)) toast(err.message, "err");
        return;   /* modal stays open so the entered values are not lost */
      }
      closeModal();
      toast("Product added.", "ok");
      renderProductAdmin();
    }
  });
  $("#modal").classList.add("modal-product");   /* reset by the next openModal */
  setTimeout(attachImagePreview, 0);
}

function openEditProductModal(p){
  if(!p) return;
  openModal({
    title: "Edit Product",
    large: true,
    body: productModalBody(p),
    confirmLabel: "Save Changes",
    onConfirm: async ()=>{
      document.querySelectorAll(".prod-form .field-error").forEach(e=>e.textContent="");
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
          ...productLabelPayload(),
        });
        await loadCatalog();
      } catch(err){
        if(!showProductFieldErrors(err)) toast(err.message, "err");
        return;
      }
      closeModal();
      toast("Product updated.", "ok");
      renderProductAdmin();
    }
  });
  $("#modal").classList.add("modal-product");   /* reset by the next openModal */
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
      /* The server refuses archiving a variety that still has active products. */
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

/* ===== MODULE: BATCH TRACKING & QA TRACEABILITY ===== */
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
  /* Days to expiry come from the server (DATEDIFF against CURDATE()). */
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
        <button class="btn btn-ghost btn-sm" data-trace-batch="${escHtml(b.lotCode)}" title="Find who bought this batch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          Trace
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
  tbody.querySelectorAll("[data-trace-batch]").forEach(btn=>{
    btn.addEventListener("click", ()=> openBatchTrace(btn.dataset.traceBatch));
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
  const traceBtn = $("#trace-batch-btn");
  if(traceBtn) traceBtn.onclick = () => openBatchTrace();
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
  const todayStr = lotToday();
  const pid = b ? b.productId : (PRODUCTS.find(p=>!p.archived) || {}).id;
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
      <div class="field" style="min-width:0"><label>Production Date *</label><input class="control" type="date" id="m-batch-prod" value="${b?.prodDate||todayStr}" style="min-width:0;padding-inline:10px"/>
        <span class="field-error" id="m-batch-prod-err"></span></div>
      <div class="field" style="min-width:0"><label>Expiration Date <span class="muted" style="font-weight:400">(automatic)</span></label><input class="control lot-auto-date" type="date" id="m-batch-expiry" value="${b?.expiryDate||autoExpiry(pid, todayStr)}" disabled style="min-width:0;padding-inline:10px"/></div>
    </div>
    <span class="field-hint" id="m-batch-expiry-hint" style="display:block;margin:-6px 0 12px"></span>
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

/* The modal's production date is limited to a month back; the expiry follows it (an existing batch keeps its dates
   until its product or production date is changed). */
function wireBatchDates(b){
  const prod = $("#m-batch-prod"), exp = $("#m-batch-expiry"), hint = $("#m-batch-expiry-hint"), sel = $("#m-batch-product");
  const keep = ()=> b && sel.value === b.productId && prod.value === b.prodDate;
  const sync = wireLotDates(prod, exp, hint, ()=> sel.value);
  /* An older batch's own production date may sit outside the window; keep it selectable while unchanged. */
  if(b && b.prodDate && b.prodDate < prod.min) prod.min = b.prodDate;
  const syncAll = ()=>{ sync(); if(keep()){ exp.value = b.expiryDate; window.EbDate?.sync(exp); hint.textContent = "Unchanged dates are kept as recorded."; } };
  sel.addEventListener("change", syncAll);
  prod.addEventListener("change", syncAll);
  syncAll();
}

function openAddBatchModal(){
  openModal({
    title:"Register Production Batch Code",
    body: batchModalBody(null),
    large: true,
    onOpen: () => wireBatchDates(null),
    confirmLabel:"Register Batch Code",
    onConfirm: async ()=>{
      const lot = $("#m-batch-lot").value.trim();
      if(!lot){ $("#m-batch-lot-err").textContent = "Batch code required."; return; }
      if(BATCHES.some(x=>x.lotCode.toLowerCase()===lot.toLowerCase())){ $("#m-batch-lot-err").textContent = "Batch code already exists."; return; }
      const prodBad = prodDateProblem($("#m-batch-prod").value);
      if(prodBad){ $("#m-batch-prod-err").textContent = prodBad; return; }
      /* No locally built batch object; the server creates the record. */
      /* Not added locally first; reload to get the real record and id. */
      try {
        await EbApi.post("batches/save.php", {
          lot_code: lot,
          product_id: $("#m-batch-product").value,
          harvest_date: $("#m-batch-harvest")?.value || null,
          production_date: $("#m-batch-prod").value,
          expiry_date: $("#m-batch-expiry").value,
          /* The quantity input's id is m-batch-total. */
          total_qty: +$("#m-batch-total").value || 0,
          quality_grade: $("#m-batch-grade")?.value || null,
          /* The QA status select's id is m-batch-qa. */
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
    onOpen: () => wireBatchDates(b),
    confirmLabel:"Save Changes",
    onConfirm: async ()=>{
      const lot = $("#m-batch-lot").value.trim();
      if(!lot){ $("#m-batch-lot-err").textContent = "Batch code required."; return; }
      if(BATCHES.some(x=>x.id!==b.id && x.lotCode.toLowerCase()===lot.toLowerCase())){ $("#m-batch-lot-err").textContent = "Batch code already exists."; return; }
      const changed = $("#m-batch-product").value !== b.productId || $("#m-batch-prod").value !== b.prodDate;
      const prodBad = changed ? prodDateProblem($("#m-batch-prod").value) : "";
      if(prodBad){ $("#m-batch-prod-err").textContent = prodBad; return; }
      /* Update the batch on screen only after the server accepts the change. */
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

/* ===== BATCH TRACE (recall) =====
   Pick a product, then one of its batches: api/batches/trace.php lists every order that took units from that batch —
   who bought them, how many, where they went and how to reach them — so a spoiled or recalled batch can be followed up. */
function openBatchTrace(lotCode){
  const pre = lotCode ? BATCHES.find(b => b.lotCode === lotCode) : null;
  /* Only products that have at least one batch on record. */
  const withBatches = PRODUCTS.filter(p => BATCHES.some(b => b.productId === p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const productOpts = withBatches.map(p =>
    `<option value="${escHtml(p.id)}" ${pre && pre.productId === p.id ? "selected" : ""}>${escHtml(p.name)}</option>`).join("");

  openModal({
    title: "Trace a Batch",
    large: true,
    confirmLabel: "Trace",
    cancelLabel: "Close",
    body: `
      <p class="field-hint" style="margin:0 0 12px">Find every customer who received units from a batch — for a
        complaint, a spoiled product or a recall. Choose the product, then its batch code.</p>
      <div class="bt-pick">
        <div class="field"><label for="bt-product">Product</label>
          <select class="control" id="bt-product">${pre ? "" : `<option value="">Choose a product</option>`}${productOpts}</select></div>
        <div class="field"><label for="bt-lot">Batch code</label>
          <select class="control" id="bt-lot"></select></div>
      </div>
      <span class="field-error" id="bt-err" role="alert"></span>
      <div id="bt-results" class="bt-results"></div>`,
    onConfirm: runTrace,
    onOpen(){
      $("#bt-product").addEventListener("change", () => { fillLots(); $("#bt-results").innerHTML = ""; });
      $("#bt-lot").addEventListener("change", () => { $("#bt-results").innerHTML = ""; });
      fillLots(pre ? pre.lotCode : null);
      if(pre) runTrace();
    },
  });

  /* The chosen product's batches, newest first, with stock left and expiry so the right one is easy to spot. */
  function fillLots(selected){
    const pid = $("#bt-product").value;
    const lots = BATCHES.filter(b => b.productId === pid)
      .sort((a, b) => String(b.prodDate || "").localeCompare(String(a.prodDate || "")) || b.lotCode.localeCompare(a.lotCode));
    const sel = $("#bt-lot");
    sel.innerHTML = pid
      ? (lots.map(b => `<option value="${escHtml(b.lotCode)}" ${selected === b.lotCode ? "selected" : ""}>${escHtml(b.lotCode)} — ${b.remainingQty}/${b.totalQty} left · expires ${escHtml(fmtDate(b.expiryDate))}</option>`).join("")
         || `<option value="">No batches for this product</option>`)
      : `<option value="">Choose a product first</option>`;
    sel.disabled = !pid || !lots.length;
    if(window.EbSelect && EbSelect.sync) EbSelect.sync(sel);
  }

  async function runTrace(){
    const lot = $("#bt-lot").value;
    const err = $("#bt-err");
    err.textContent = "";
    if(!lot){ err.textContent = "Choose the product and its batch code."; return; }
    const box = $("#bt-results");
    box.innerHTML = `<p class="field-hint">Looking up who bought ${escHtml(lot)}…</p>`;
    const btn = $("#modal-footer .btn-gold");
    const restore = EbUI.busy(btn, "Tracing…");
    try {
      const { data } = await EbApi.get("batches/trace.php", { lot });
      box.innerHTML = traceResultsHtml(data);
      $("#bt-export")?.addEventListener("click", () => exportTraceCsv(data));
    } catch(e){
      box.innerHTML = "";
      err.textContent = e.message;
    } finally { restore(); }
  }
}

function traceResultsHtml(d){
  const b = d.batch, s = d.summary;
  const stat = (label, val, warn) => `<div class="mini-stat"><span class="mini-stat-label">${label}</span><span class="mini-stat-val${warn ? " bt-warn" : ""}">${val}</span></div>`;
  const status = st => `<span class="badge ${st === "completed" ? "badge-ok" : st === "cancelled" ? "badge-crit" : "badge-info"}">${escHtml(STATUS_LABEL[st] || st)}</span>`;
  const rows = d.buyers.map(x => `
    <tr>
      <td><div class="mono">${escHtml(x.orderId)}</div><div class="bt-contact">${escHtml(fmtDateTime(x.date))}</div></td>
      <td><div class="td-name">${escHtml(x.customer || "—")}${x.retailer ? ` <span class="badge badge-warn">Retailer</span>` : ""}</div>
        <div class="bt-contact">${[x.contact, x.email].filter(Boolean).map(escHtml).join(" · ") || "No contact on record"}</div></td>
      <td class="bt-channel">${escHtml(x.channel)}<div class="bt-contact">${escHtml(x.fulfil)}</div></td>
      <td class="bt-where" title="${escHtml(x.shipTo || "")}">
        <div class="bt-place">${escHtml(x.fulfil === "Delivery" ? (x.area || x.shipTo || "—") : "Picked up at the store")}</div>
        ${x.tracking ? `<div class="bt-contact">Tracking ${escHtml(x.tracking)}</div>` : ""}</td>
      <td class="num"><strong>${x.qty}</strong></td>
      <td class="num">${x.returned ? `<span class="bt-warn">${x.returned}</span>` : "0"}</td>
      <td>${status(x.status)}</td>
    </tr>`).join("");

  return `
    <div class="bt-head">
      <div><div class="bt-lot">${escHtml(b.lotCode)}</div>
        <div class="bt-meta">${escHtml(b.productName)} · produced ${escHtml(fmtDate(b.productionDate))} · expires ${escHtml(fmtDate(b.expiryDate))}
          · ${b.totalQty} made, ${b.remainingQty} still in stock · QA ${escHtml(LAB_STATUSES[b.labStatus] || b.labStatus)}</div></div>
      ${d.buyers.length ? `<button type="button" class="btn btn-ghost btn-sm" id="bt-export">Export recall list (CSV)</button>` : ""}
    </div>
    <div class="mini-stat-group bt-stats">
      ${stat("Orders", s.orders)}
      ${stat("Customers", s.customers)}
      ${stat("Units sold", s.unitsSold)}
      ${stat("Returned", s.unitsReturned)}
      ${stat("Still with buyers", s.unitsOut, s.unitsOut > 0)}
    </div>
    ${d.buyers.length ? `
      <div class="table-wrap"><table class="data-table bt-table">
        <thead><tr><th>Order &amp; date</th><th>Customer &amp; contact</th><th>Channel</th><th>Went to</th><th class="num">Qty</th><th class="num">Returned</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : `<div class="alert-empty"><strong>No sales recorded from this batch yet.</strong>
        <span>Orders placed before batch tracking started have no batch on record, so they cannot be traced here.</span></div>`}`;
}

/* The recall list as a CSV: one row per order, with the contact details needed to reach each buyer. */
function exportTraceCsv(d){
  const b = d.batch;
  const header = ["Batch", "Product", "Order", "Date", "Customer", "Contact", "Email", "Channel", "Fulfilment", "Went to", "Tracking", "Qty", "Returned", "Status"];
  const rows = d.buyers.map(x => [b.lotCode, b.productName, x.orderId, x.date, x.customer || "", x.contact || "", x.email || "",
    x.channel, x.fulfil, x.shipTo || "", x.tracking || "", x.qty, x.returned, STATUS_LABEL[x.status] || x.status]);
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [header, ...rows].map(r => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `batch-recall-${b.lotCode}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Recall list exported.", "ok");
}

/* ============================================================
   MODULE: INVENTORY REPORT
   ============================================================ */
const fmtNum = n => Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 });

/* Legend lines for the automatic rules (meta.inventoryModel from products/list.php, api/core/Inventory.php):
   stock level by days of stock left at the product's sales rate, movement against the store's average product. */
function paintInvLegend(m){
  const item = (cls, text) => `<span class="inv-legend-item"><span class="inv-dot ${cls}"></span> ${text}</span>`;
  const lv = $("#inv-legend");
  const avg = m.averageUnits > 0 ? `${fmtNum(Math.ceil(m.averageUnits))}+ sold, the store average` : "at or above the store average";
  if(lv) lv.innerHTML =
    item("inv-ok",   "Safe") +
    item("inv-warn", "Low") +
    item("inv-crit", "Critical") +
    item("inv-out",  "Out of Stock") +
    `<span class="inv-legend-sep" aria-hidden="true"></span>` +
    item("inv-ok",   `Fast Moving (${avg})`) +
    item("inv-warn", "Slow Moving (sold, below average)") +
    item("inv-muted","Non-Moving (none sold)");
}

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

      return `<tr>
      <td class="td-name">${escHtml(p.name)}${p.archived?` <span class="badge badge-muted" style="font-size:.62rem">archived</span>`:""}</td>
      <td class="muted">${escHtml(p.cat)}</td>
      <td><strong>${p.stock}</strong></td>
      <td><span class="badge ${si.cls}"${si.reason?` title="${escHtml(si.reason)}"`:""}>${si.label}</span></td>
      <td><span class="badge ${mt.cls}"${inv.perMonth != null ? ` title="${(inv.perMonth).toFixed(1)} sold per month"` : ""}>${mt.label}</span></td>
      <td>${risk
        ? `<span class="badge badge-warn" title="${escHtml(risk.note || "")}">${risk.daysToExpiry < 0 ? "Expired" : "Will expire"}</span>`
        : `<span class="muted">—</span>`}</td>
      <td>${peso(p.price)}</td>
      <td>${p.sold.toLocaleString("en-PH")}</td>
    </tr>`;
    },
    {
      colspan: 8,
      empty: { title: "No products match filters", hint: "Adjust the search or filters." },
      after: (rows, meta) => {
        paintStockWindowNote("#inv-window-note", meta);
        if(meta.inventoryModel){ adminState.invModel = meta.inventoryModel; paintInvLegend(meta.inventoryModel); }
      },
    }
  );

  /* Export buttons load the exporter on first use. */
  const exportInv = kind => import("./inventory-export.js")
    .then(m => m.openInventoryExport(kind))
    .catch(err => toast("Could not open the export: " + err.message, "err"));
  if($("#inv-export-pdf")) $("#inv-export-pdf").onclick = () => exportInv("pdf");
  if($("#inv-export-csv")) $("#inv-export-csv").onclick = () => exportInv("csv");

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
    adminState.pwMissing = mountPwChecklist($("#pf-new"));
  }
}

/* New-password rules, mirroring Auth::passwordProblem() in api/core/Auth.php (and PW_RULES in the storefront's site.js). */
const PW_RULES = [
  { id: "len",   label: "At least 8 characters",       test: v => v.length >= 8 },
  { id: "upper", label: "One uppercase letter (A–Z)",  test: v => /[A-Z]/.test(v) },
  { id: "lower", label: "One lowercase letter (a–z)",  test: v => /[a-z]/.test(v) },
  { id: "num",   label: "One number (0–9)",            test: v => /[0-9]/.test(v) },
  { id: "sym",   label: "One symbol (e.g. ! @ # $ %)", test: v => /[^A-Za-z0-9]/.test(v) },
];
/* Checklist under a new-password input, ticking each rule as it is met; returns a function giving the first unmet rule (or null). */
function mountPwChecklist(input){
  if(!input) return () => null;
  const ul = document.createElement("ul");
  ul.className = "pw-rules";
  ul.setAttribute("aria-live", "polite");
  ul.innerHTML = PW_RULES.map(r => `<li data-rule="${r.id}"><span class="pw-rule-ic" aria-hidden="true"></span>${r.label}</li>`).join("");
  (input.closest(".pw-wrap") || input).insertAdjacentElement("afterend", ul);
  const paint = () => PW_RULES.forEach(r => ul.querySelector(`[data-rule="${r.id}"]`).classList.toggle("is-met", r.test(input.value)));
  input.addEventListener("input", paint);
  paint();
  return () => PW_RULES.find(r => !r.test(input.value)) || null;
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
  const miss = adminState.pwMissing && adminState.pwMissing();
  if(miss){ $("#pf-new-err").textContent = `Your password needs: ${miss.label.toLowerCase()}.`; return; }
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
    $("#pf-new").dispatchEvent(new Event("input"));
    /* Hide the fields again after saving, so a new password is never left on screen. */
    $$("#password-form .pw-toggle").forEach(b => { if(b.getAttribute("aria-pressed") === "true") b.click(); });
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
function renderCreditNote(c, refunds){
  const el = $("#sales-credit-note");
  if(!el) return;
  const refundText = refunds && refunds.amount
    ? `Less <strong>${peso(refunds.amount)}</strong> refunded (${refunds.count} refund${refunds.count === 1 ? "" : "s"} paid out in this period). `
    : "";
  if(!c || (!c.received && !c.bookedCount)){ el.innerHTML = refundText; return; }
  el.innerHTML = refundText +
    `Includes <strong>${peso(c.received)}</strong> received on Net accounts ` +
    `(${c.receivedCount} payment${c.receivedCount === 1 ? "" : "s"}). ` +
    (c.bookedCount
      ? `Sold on credit this period: ${peso(c.bookedTotal)} across ${c.bookedCount} order${c.bookedCount === 1 ? "" : "s"} — <strong>${peso(c.notYetReceived)}</strong> not yet received.`
      : "");
}

function renderSales(range){
  adminState.salesRange = range;
  /* Export buttons load the exporter on first use. */
  const exportWith = kind => import("./sales-export.js")
    .then(m => m.openSalesExport(kind))
    .catch(err => toast("Could not open the export: " + err.message, "err"));
  if($("#sales-export-pdf")) $("#sales-export-pdf").onclick = () => exportWith("pdf");
  if($("#sales-export-csv")) $("#sales-export-csv").onclick = () => exportWith("csv");
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
        renderCreditNote(data.credit, data.refunds);
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
  REFUNDS_PAID.filter(r => r.date >= start && r.date <= end)
    .forEach(r => { dateMap[r.date] = (dateMap[r.date] || 0) - r.amount; });
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

  /* Interest per Net term; editable only with credit.limits (Super Admin), shown read-only to everyone else. */
  const INT_TERMS = ["net30","net60","net90"];
  const canEditInt = EbRbac.can("credit.limits");
  const paintInterest = ()=> INT_TERMS.forEach(t=>{
    const el = $("#interest-rate-" + t); if(!el) return;
    if(adminState.interestRates && document.activeElement !== el) el.value = adminState.interestRates[t];
    el.readOnly = !canEditInt;
  });
  paintInterest();

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
      <td class="td-name">${escHtml(a.name)}${a.tier ? ` <span class="pay-tier">${tierBadge(a.tier)}</span>` : ""}<div class="muted" style="font-size:.72rem">${escHtml(a.orderId || a.id)}</div></td>
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
        if(meta.interestRates){ adminState.interestRates = meta.interestRates; paintInterest(); }
        if(meta.creditLimits) adminState.creditLimits = meta.creditLimits;
        const sum = $("#pay-summary");
        if(sum){
          /* Four tiles: what is owed, what is late, what needs checking, and the tier budgets. */
          const od = meta.overdueCount || 0, rv = meta.reviewCount || 0;
          const tile = (cls, label, value, sub) => `<div class="pay-tile ${cls}"><span class="pay-tile-label">${label}</span><b class="pay-tile-val">${value}</b><small>${sub}</small></div>`;
          sum.innerHTML =
            tile("", "Outstanding", peso(meta.outstanding || 0), "Owed on open Net accounts")
            + tile(od ? "is-bad" : "is-ok", "Overdue", od, od ? `account${od === 1 ? "" : "s"} past due` : "Nothing past due")
            + tile(rv ? "is-warn" : "is-ok", "Waiting for review", rv, rv ? `${peso(meta.reviewAmount)} to verify` : "No payments to check")
            + (meta.creditLimits ? `<div class="pay-tile pay-tile-budgets"><span class="pay-tile-label">Net budgets per tier</span><div class="pay-budgets">${TIERS.map(t => `<span class="pay-budget">${tierBadge(t)}<b>${peso(meta.creditLimits[t])}</b></span>`).join("")}</div></div>` : "");
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

  const saveInt = $("#save-interest-btn");
  if(saveInt) saveInt.onclick = ()=>{
    const body = {};
    for(const t of INT_TERMS){
      const v = $("#interest-rate-" + t).value.trim();
      if(v === "" || isNaN(+v) || +v < 0 || +v > 100){ toast(`Enter a ${t.replace("net","Net ")} interest from 0 to 100%.`, "err"); return; }
      body["interest_rate_" + t] = +v;
    }
    EbApi.post("settings/save.php", body)
      .then(() => {
        adminState.interestRates = { net30: body.interest_rate_net30, net60: body.interest_rate_net60, net90: body.interest_rate_net90 };
        toast(`Interest saved: Net 30 ${body.interest_rate_net30}%, Net 60 ${body.interest_rate_net60}%, Net 90 ${body.interest_rate_net90}%. It applies to new Net orders.`, "ok");
        renderPayments();
      })
      .catch(err => toast(err.message, "err"));
  };
}

/* Super Admin only (credit.limits): the most a retailer of each tier may owe on Net terms at once. */
async function openTierBudgets(){
  const limits = await loadTierLimits();
  if(!limits){ toast("Could not load the tier budgets. Try again.", "err"); return; }
  const hints = {
    Bronze: "New partners start here.",
    Silver: "For partners who pay on time.",
    Gold:   "For the most trusted partners.",
  };
  openModal({
    title: "Tier Credit Budgets",
    body: `
      <p class="tb-intro">The most a retailer may owe on <strong>Net 30 / 60 / 90</strong> at once. A new Net order is refused when their unpaid Net balances plus that order would go above their tier's budget.</p>
      <div class="tb-list">
        ${TIERS.map(t => `
          <div class="tb-card tb-${t.toLowerCase()}">
            <div class="tb-who">
              <span class="tb-medal" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 22l5-3 5 3-1.5-8"/></svg></span>
              <div><label class="tb-name" for="tb-${t}">${t} Tier</label><div class="tb-hint">${hints[t]}</div></div>
            </div>
            <div class="tb-amt">
              <span class="tb-peso" aria-hidden="true">₱</span>
              <input class="control" type="number" id="tb-${t}" value="${Math.round(limits[t])}" min="0" step="100" inputmode="numeric"/>
            </div>
            <span class="field-error tb-err" data-tb-err="${t}"></span>
          </div>`).join("")}
      </div>
      <p class="tb-foot">Budgets must go up by tier (Bronze ≤ Silver ≤ Gold). Changes apply to each retailer's next Net order; orders already placed are not affected.</p>`,
    confirmLabel: "Save Budgets",
    async onConfirm(){
      $$("[data-tb-err]").forEach(e => e.textContent = "");
      const payload = {};
      TIERS.forEach(t => { payload[t] = $("#tb-" + t).value.trim(); });
      if(!(+payload.Bronze <= +payload.Silver && +payload.Silver <= +payload.Gold)){
        $('[data-tb-err="Silver"]').textContent = "Budgets must go up by tier: Bronze ≤ Silver ≤ Gold.";
        return;
      }
      const btn = $("#modal-footer .btn-gold");
      const restore = EbUI.busy(btn, "Saving…");
      try {
        const { data } = await EbApi.post("payments/tiers.php", { limits: payload });
        adminState.creditLimits = data.limits;
        closeModal();
        toast(data.changed.length ? "Tier budgets saved." : "Nothing changed.", "ok");
        /* Refresh the tier cards' amounts on B2B, which shows the budgets. */
        renderB2B();
      } catch(err){
        if(err.isValidation && err.fields){
          Object.entries(err.fields).forEach(([k, msg]) => { const el = $(`[data-tb-err="${k}"]`); if(el) el.textContent = msg; });
        } else toast(err.message, "err");
      } finally { restore(); }
    },
  });
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
        <div class="field" id="m-rp-ref-field"><label><span data-ref-label>Reference number</span></label><input class="control" id="m-rp-ref" maxlength="100"><span class="field-error" id="m-rp-ref-err"></span></div>
        <div class="field"><label>Date received</label><input class="control" type="date" id="m-rp-date" value="${today}" max="${today}"></div>
      </div>
      <div class="field"><label>Note (optional)</label><input class="control" id="m-rp-note" maxlength="500"></div>`,
    confirmLabel: "Record payment",
    confirmClass: "btn-ok",
    /* GCash and bank each get their own reference field and rules; cash needs none. */
    onOpen(){
      const sel = $("#m-rp-method"), field = $("#m-rp-ref-field");
      const ref = EbUI.splitRefField($("#m-rp-ref"), () => sel.value, field.querySelector("label"));
      const sync = () => { field.hidden = sel.value === "cash"; ref.refresh(); $("#m-rp-ref-err").textContent = ""; };
      sel.addEventListener("change", sync);
      sync();
    },
    onConfirm: async ()=>{
      $("#m-rp-amount-err").textContent = "";
      $("#m-rp-ref-err").textContent = "";
      $("#m-rp-ref").classList.remove("is-invalid");
      /* Mark the reference box and put the cursor there. */
      const refFail = msg => {
        $("#m-rp-ref-err").textContent = msg;
        const box = $("#m-rp-ref")._ebRef ? $("#m-rp-ref")._ebRef.input() : $("#m-rp-ref");
        box?.classList.add("is-invalid");
        box?.focus();
      };
      /* Same format rule as Payments::checkRef; the server also refuses a reference already used. */
      const method = $("#m-rp-method").value;
      const refRaw = $("#m-rp-ref").value.trim();
      const refClean = refRaw.replace(/[\s-]/g, "").toUpperCase();
      if((method === "gcash" || method === "bank") && !refRaw){ refFail(`Enter the ${method === "gcash" ? "GCash" : "bank"} reference number.`); return; }
      if(method === "gcash" && refRaw && !/^\d{13}$/.test(refClean)){ refFail("GCash reference numbers are 13 digits."); return; }
      if(method === "bank" && refRaw && !/^[A-Z0-9]{6,20}$/.test(refClean)){ refFail("Enter the 6–20 character reference from your bank's confirmation."); return; }
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
        if(f.ref_num) refFail(f.ref_num);
        toast(f.ref_num || f.amount || err.message, "err");
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
      <td><strong>${orderDueHtml(tx)}</strong></td>
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
  const typeColors = { restock:"badge-ok", user:"badge-info", product:"badge-warn", order:"badge-purple", system:"badge-crit", report:"badge-ok" };

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
  const granted = isSuperAdmin ? SUPER_PERMS : (ROLE_PERMISSIONS[role] || (ROLE_PERMISSIONS[role]=[]));
  const totalPerms = granted.length;
  const meta = isSuperAdmin
    ? { slug:"super-admin", desc:"Controls roles, staff accounts and system settings (locked on). Day-to-day work such as POS can be switched off." }
    : (ROLE_META[role] || { slug:slugify(role), desc:"Custom role — no description set." });

  const modules = Object.entries(areas).map(([area, perms])=>{
    const rows = perms.map(p=>{
      /* A Super-Admin-only permission is shown to every role — so it is plain
         that it exists and who holds it — but locked off. The server refuses it
         anyway (Rbac::SYSTEM_ONLY); a switch that looks usable and then fails
         on save would only teach people to distrust the screen. */
      /* Admin-only permissions are open on the Admin role's card and locked on every other role. */
      const reserved = !isSuperAdmin && (!!p.systemOnly || (!!p.adminOnly && meta.slug !== "admin"));
      /* On the Super Admin's card only the locked keys are fixed on; the rest it may switch off for itself. */
      const required = isSuperAdmin && !!p.superLocked;
      const checked = required || (!reserved && granted.includes(p.key));
      const locked  = required || reserved;
      return `<label class="role-toggle-row ${locked?"locked":""}"${reserved?` title="${p.adminOnly ? "Super Admin and Admin only — it can be granted to the Admin role only." : "Super Admin only — this cannot be granted to another role."}"`
          : required?` title="Always on for the Super Admin, so it can never lose control of the system."`:""}>
        <span>${escHtml(p.label)}${required?` <span class="badge badge-muted" style="font-size:.6rem">Required</span>`:""}${p.systemOnly?` <span class="badge badge-muted" style="font-size:.6rem">Super Admin only</span>`
          : p.adminOnly?` <span class="badge badge-muted" style="font-size:.6rem">Super Admin &amp; Admin only</span>`:""}</span>
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
      ${!isSuperAdmin && !ROLE_DEFAULTS[role] ? `<button class="btn btn-ghost btn-sm role-delete-btn" data-delete-role="${escHtml(role)}" title="Delete this custom role">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        Delete
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
    <label class="role-toggle-row role-all">
      <span><strong>All permissions</strong><small>${isSuperAdmin ? "Turn every switchable permission on or off" : "Turn every permission on or off"}</small></span>
      <span class="switch">
        <input type="checkbox" data-role-all="${escHtml(role)}"/>
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
      const list = role === "Super Admin" ? SUPER_PERMS : (ROLE_PERMISSIONS[role] || (ROLE_PERMISSIONS[role]=[]));
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
      const isSuper = role === "Super Admin";

      /* This used to toast "saved" and write a local audit line — the checkbox
         changes lived in ROLE_PERMISSIONS in memory and were gone on reload.
         The screen that decides everyone's access was the one screen that
         silently discarded its edits. */
      const roleRow = (adminState.roleList || []).find(r => isSuper ? r.isSystem : r.name === role);
      if(!roleRow){ toast(`Could not identify role "${role}". Reload and try again.`, "err"); return; }

      const restore = EbUI.busy(btn, "Saving…");
      try {
        await EbApi.post("roles/save.php", {
          id: roleRow.id,
          name: isSuper ? roleRow.name : role,
          description: (ROLE_META[role] && ROLE_META[role].desc) || null,
          permissions: isSuper ? SUPER_PERMS : (ROLE_PERMISSIONS[role] || []),
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

  /* Delete — custom roles only (built-ins have no button, and
     roles/delete.php refuses them anyway). Refused while staff still hold it. */
  $$("#roles-matrix [data-delete-role]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const role = btn.dataset.deleteRole;
      const roleRow = (adminState.roleList || []).find(r => r.name === role);
      if(!roleRow){ toast(`Could not identify role "${role}". Reload and try again.`, "err"); return; }
      const inUse = roleRow.totalUsers || 0;
      openModal({
        title: "Delete Role",
        body: `<p>Delete the <strong>${escHtml(role)}</strong> role and all its permissions?</p>
               ${inUse
                 ? `<p class="field-error" style="display:block;margin-top:10px">${inUse} staff account${inUse === 1 ? " is" : "s are"} still assigned to this role. Move them to another role in Employee Accounts first.</p>`
                 : `<p class="muted" style="margin-top:8px">This cannot be undone.</p>`}`,
        confirmLabel: "Delete Role", confirmClass: "btn-red",
        onConfirm: async ()=>{
          try {
            await EbApi.post("roles/delete.php", { id: roleRow.id });
          } catch(e){ toast(e.message, "err"); return; }
          closeModal();
          await loadAdminData();
          const i = ROLES.indexOf(role); if(i > -1) ROLES.splice(i, 1);
          delete ROLE_META[role];
          toast(`Role "${role}" deleted.`, "ok");
          renderRoles();
        }
      });
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
/* Popups close only from their X, Close/Cancel buttons or Escape; a click on the backdrop just shakes the popup as a hint, so nothing typed is ever lost. */
function wireBackdropClose(backdrop, box){
  if(!backdrop) return;
  backdrop.addEventListener("click", e => {
    if(e.target !== backdrop) return;
    const el = box();
    if(!el) return;
    el.classList.remove("modal-nudge"); void el.offsetWidth; el.classList.add("modal-nudge");
  });
}

/* Show/hide password: any .pw-toggle beside a password input (one delegated listener for every screen and popup). */
const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
document.addEventListener("click", e => {
  const btn = e.target.closest?.(".pw-toggle");
  if(!btn) return;
  const input = btn.parentElement.querySelector("input");
  if(!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.innerHTML = show ? EYE_SHUT : EYE_OPEN;
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  btn.setAttribute("aria-pressed", String(show));
  input.focus();
});

function initModal(){
  $("#modal-close").addEventListener("click", closeModal);
  wireBackdropClose($("#modal-overlay"), () => $("#modal-overlay .modal"));
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
  ordersqueue:    "Incoming orders awaiting review — accept or cancel each one.",
  paymentverify:  "Check uploaded payment proofs against order totals before approving them.",
  orderstatus:    "Move accepted orders forward through shipping, delivery and completion.",
  orderhistory:   "Full record of online and walk-in transactions for reference and reporting.",
  receipts:       "Generate and print official receipts for completed online and walk-in orders.",
  returns:        "Handle return requests end to end — validate, approve, then process the refund.",
  users:          "Create and maintain customer and employee accounts, including roles and archiving.",
  b2b:            "Review business partner applications and set each partner's Bronze, Silver or Gold tier.",
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

/* Tab strips that scroll sideways (phones) fade at the edge that has more tabs, so it is clear they can be swiped,
   and a tapped tab scrolls fully into view. The fade itself is CSS (.strip-more-left / .strip-more-right). */
(function tabStripHints(){
  const SEL = ".tabs, .return-tabs, .inv-action-tabs, .vat-tabs, .rev-tabs, .date-range-tabs";
  const mark = el => {
    const more = el.scrollWidth - el.clientWidth;
    el.classList.toggle("strip-more-right", more > 2 && el.scrollLeft < more - 2);
    el.classList.toggle("strip-more-left", more > 2 && el.scrollLeft > 2);
  };
  let queued = false;
  const markAll = () => {
    if(queued) return;
    queued = true;
    /* A short timer rather than requestAnimationFrame, which pauses in background tabs. */
    setTimeout(() => { queued = false; document.querySelectorAll(SEL).forEach(mark); }, 60);
  };
  document.addEventListener("scroll", e => { if(e.target instanceof Element && e.target.matches(SEL)) mark(e.target); }, true);
  document.addEventListener("click", e => {
    const tab = e.target instanceof Element ? e.target.closest("button, a") : null;
    if(tab && tab.parentElement && tab.parentElement.matches(SEL)) tab.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  });
  window.addEventListener("resize", markAll);
  /* Re-check when modules render or panels show/hide; class changes on the strips themselves (ours) are ignored. */
  new MutationObserver(muts => {
    if(muts.some(m => m.type === "childList" || !(m.target instanceof Element && m.target.matches(SEL)))) markAll();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  markAll();
})();

/* Phone card tables: each cell carries its column heading as data-label, so on narrow screens (portal.css) a row can
   show as a small card of "LABEL  value" lines instead of a table you have to scroll sideways. */
(function labelTableCells(){
  const label = table => {
    const heads = [...table.querySelectorAll("thead th")].map(th => th.textContent.replace(/\s+/g, " ").trim());
    if(!heads.length) return;
    table.querySelectorAll("tbody tr").forEach(tr => {
      let col = 0;
      [...tr.children].forEach(td => {
        if(!td.hasAttribute("data-label")) td.setAttribute("data-label", heads[col] || "");
        /* Long text (descriptions, addresses, product lists) takes the full card width instead of a squeezed half. */
        const text = td.textContent.replace(/\s+/g, " ").trim();
        td.classList.toggle("td-wide", text.length > 30);
        /* Nothing to show (no value, no image or control): hidden on phone cards instead of a bare label. */
        td.classList.toggle("td-empty", (text === "" || text === "—") && !td.querySelector("img, svg, input, button, select"));
        col += td.colSpan || 1;
      });
    });
  };
  let queued = false;
  const run = () => {
    if(queued) return;
    queued = true;
    setTimeout(() => { queued = false; document.querySelectorAll(".content table.data-table, .modal table.data-table").forEach(label); }, 60);
  };
  new MutationObserver(muts => { if(muts.some(m => m.type === "childList")) run(); })
    .observe(document.body, { childList: true, subtree: true });
  run();
})();
