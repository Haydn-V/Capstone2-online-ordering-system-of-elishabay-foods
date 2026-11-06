/* ===== Storefront script: CONFIG (brand), DATA (products, FAQs, certs), state (cart, theme, auth, filters), render factories and UI primitives (modal, toast, drawer) ===== */
"use strict";

/* Same format rule as Payments::checkRef (the server also refuses a reference already used). */
function refFormatError(method, ref){
  const c = String(ref || "").replace(/[\s-]/g, "").toUpperCase();
  if(method === "gcash" && !/^\d{13}$/.test(c)) return "GCash reference numbers are 13 digits.";
  if(method === "bank" && !/^[A-Z0-9]{6,20}$/.test(c)) return "Enter the 6–20 character reference from your bank's confirmation.";
  return "";
}


/* ---------- CONFIG: brand source of truth ---------- */
const CONFIG = {
  brand: "Elisha Bay",
  company: "Juris Bay Foods, Inc.",
  motto: "Every Mouthful is Delightful",
  currency: "₱",
  address: "148 Brgy. Mangin, Dagupan City, Pangasinan",
  phone: "+63 900 000 0000",
  email: "hello@elishabay.ph",
  facebook: "facebook.com/elishabayfoods",
  certifications: [
    { code: "DOST", label: "Dept. of Science & Technology" },
    { code: "DTI",  label: "Dept. of Trade & Industry" },
    { code: "FDA",  label: "Food & Drug Administration" },
    { code: "PEDAI",label: "Phil. Entrepreneurs & Dev. Assoc." },
  ],
};

/* Staff credentials were removed from this file; sign-in posts to api/auth/login.php (bcrypt in MySQL). */

/* Project root from this script's URL, so routes work from public/ and public/profile/ in any install folder. */
const BASE_PATH = (() => {
  const src = (document.currentScript && document.currentScript.src) || "";
  const marker = "assets/js/public/";
  const i = src.indexOf(marker);
  return i >= 0 ? src.slice(0, i) : "/";
})();

/* Role to portal path; keys must match the role names exactly. */
const STAFF_ROUTES = {
  "Super Admin":         BASE_PATH + "portal/super-admin/",
  "Admin":               BASE_PATH + "portal/admin/",
  "Inventory Staff":     BASE_PATH + "portal/inventory/",
  "Cashier":             BASE_PATH + "portal/cashier/",
  "Online Orders Staff": BASE_PATH + "portal/orders/",
};

/* ---------- DATA: categories ---------- */
/* Starting category chips, replaced by renderCatChips() with the categories actually in use. */
let CATEGORIES = ["All", "Deboned Bangus", "Bottled Gourmet Bangus"];

/* Products: tint is the jar illustration's colour. */
/* Filled from api/shop/products.php by loadShopCatalog() at startup. */
/* Filled from api/shop/products.php by loadShopProducts(); starts empty. */
let PRODUCTS = [];
/* False until the first catalogue answer; until then the grid and carousel show skeleton cards. */
let CATALOG_READY = false;

/* FAQs start empty and come only from content/get.php (the faqs table), so a failed load shows an error instead of stale text. */
let FAQS = [];
let FAQS_LOADED = false;

/* ===== APP STATE ===== */
/* The theme is set by assets/js/theme.js; this only reads it. */
const _savedTheme = document.documentElement.getAttribute("data-theme") || "light";

/* Never restore sign-in from localStorage (editable in the console); the page starts signed out until the server confirms. */
const _savedAuth = { loggedIn:false, name:"", email:"", id:null, status:null };

const state = {
  theme: _savedTheme,
  cart: [],                        // [{id, qty}]
  auth: _savedAuth,
  filter: { search:"", category:"All", sort:"featured" },
};

/* ===== HELPERS ===== */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const peso = n => CONFIG.currency + n.toLocaleString("en-PH");
const getProduct = id => PRODUCTS.find(p => p.id === id);
const txId = () => "EB-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random()*900+100);

/* Availability from the public catalogue (exact stock, inStock and stockLevel); productMax() caps the stepper at stock, but checkout re-checks stock on the server. */
/* The cart can hold up to the product's available stock (CART_MAX_QTY is only a safety ceiling, matching
   api/shop/cart-save.php and migration 029); one add from the product popup is at most what is still available. */
const CART_MAX_QTY = 9999;


/* Max quantity of one product, falling back to CART_MAX_QTY when stock is unknown. */
function productMax(p){
  const stock = p && typeof p.stock === "number" ? p.stock : null;
  if(stock === null) return CART_MAX_QTY;
  return Math.max(1, Math.min(CART_MAX_QTY, stock));
}

/* Most that one add can put in the cart: the available stock, minus what is already in the cart. */
function addMax(p){
  const inCart = (state.cart.find(i => p && i.id === p.id) || {}).qty || 0;
  return Math.max(1, productMax(p) - inCart);
}

/* Every capped stepper describes its limit (for assistive tech). */
function qtyCapAttrs(p){
  const max = productMax(p);
  if(max >= CART_MAX_QTY) return `aria-label="Quantity"`;
  return `aria-label="Quantity, maximum ${max} available" title="Only ${max} in stock"`;
}

/* The visible cap line only shows for low-stock bands, so it does not repeat the stock pill. */
function qtyCapHint(p){
  const max = productMax(p);
  if(!p || typeof p.stock !== "number" || max >= CART_MAX_QTY) return "";
  if(p.stockLevel !== "crit" && p.stockLevel !== "warn") return "";
  return `<small class="qty-cap">Max ${max} — all we have left</small>`;
}

/* Mirrors api/uploads/image.php's 8MB limit and accepted types, to refuse obviously wrong files early (the server re-checks). */
/* Payment methods keyed by the exact value the API takes (cash, gcash, bank, net30/60/90); label is for display only. */
const PAY_METHODS_UI = {
  cash:  "Cash",
  gcash: "GCash",
  bank:  "Bank Transfer",
  net30: "Net 30",
  net60: "Net 60",
  net90: "Net 90",
};
const payLabel = key => PAY_METHODS_UI[key] || key;

/* Credit terms mirroring Payments::CREDIT, labelled as "Pay within N days"; the server decides if they are allowed. */
const CREDIT_METHODS = [
  { key: "net30", label: "Net 30", hint: "Pay within 30 days" },
  { key: "net60", label: "Net 60", hint: "Pay within 60 days" },
  { key: "net90", label: "Net 90", hint: "Pay within 90 days" },
];
const isCreditMethod = key => CREDIT_METHODS.some(m => m.key === key);

const UPLOAD_MAX_MB  = 8;
const UPLOAD_ACCEPT  = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };

/* Payment account card (name, number, QR) from Landing Page Maintenance, used at checkout and on the retailer Pay form, saying so when nothing is published. */
/* Delegated copy buttons for payQrHtml. */
document.addEventListener("click", async e => {
  const b = e.target.closest(".pay-copy"); if(!b) return;
  const text = b.dataset.copy || "";
  try { await navigator.clipboard.writeText(text); }
  catch(_){ const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch(__){} t.remove(); }
  const was = b.textContent; b.textContent = "Copied"; b.classList.add("is-done");
  setTimeout(() => { b.textContent = was; b.classList.remove("is-done"); }, 1600);
});

/* On phones, scroll to and focus the first error. */
function focusFirstError(root){
  const bad = root.querySelector(".field.has-error, .has-error, [aria-invalid=\"true\"]");
  if(!bad) return;
  const target = bad.matches("input, select, textarea") ? bad
    : bad.querySelector("input:not([type=hidden]), select, textarea, .ebs-trigger, .up-drop") || bad;
  bad.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  setTimeout(() => { try { target.focus({ preventScroll: true }); } catch(_){} }, 250);
}

/* Track the visible viewport height so phone sheets keep the pinned bar above the on-screen keyboard. */
(function trackVisibleHeight(){
  const vv = window.visualViewport; if(!vv) return;
  const set = () => {
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    document.documentElement.style.setProperty("--vvtop", vv.offsetTop + "px");
  };
  vv.addEventListener("resize", set); vv.addEventListener("scroll", set); set();
})();

/* On phones the Sales Invoice is scaled down (never rearranged), with tap for full size; printing uses its own full-size copy. */
/* Full-screen invoice viewer, fitted to the width. */
function openInvoiceViewer(src){
  if(!src) return;
  const v = document.createElement("div");
  v.className = "inv-viewer"; v.setAttribute("role", "dialog"); v.setAttribute("aria-label", "Sales invoice");
  v.innerHTML = `<div class="inv-viewer-bar"><b>Sales Invoice</b>
      <button type="button" class="inv-viewer-close" aria-label="Close">&times;</button></div>
    <div class="inv-viewer-body"><div class="inv-viewer-page"></div></div>`;
  const page = v.querySelector(".inv-viewer-page"), body = v.querySelector(".inv-viewer-body");
  const sheet = src.cloneNode(true); sheet.style.zoom = ""; page.appendChild(sheet);
  document.body.appendChild(v);
  const fit = () => {
    sheet.style.zoom = "";
    sheet.style.zoom = String(Math.min(1, (body.clientWidth - 24) / (sheet.offsetWidth || 499)));
  };
  const close = () => { v.remove(); window.removeEventListener("resize", fit); document.removeEventListener("keydown", onKey, true); };
  const onKey = e => { if(e.key === "Escape"){ e.stopPropagation(); close(); } };
  v.querySelector(".inv-viewer-close").addEventListener("click", close);
  window.addEventListener("resize", fit); document.addEventListener("keydown", onKey, true);
  fit(); v.querySelector(".inv-viewer-close").focus();
}

function fitInvoices(){
  document.querySelectorAll(".receipt-invoice").forEach(box => {
    const inv = box.querySelector(".eb-invoice"); if(!inv) return;
    inv.style.zoom = "";
    if(box.classList.contains("is-full")) return;
    const natural = inv.scrollWidth, room = box.clientWidth;
    const fit = natural > room + 1;
    box.classList.toggle("is-fit", fit);
    if(fit) inv.style.zoom = String(Math.max(0.5, room / natural));
    if(!box.dataset.fitWired){
      box.dataset.fitWired = "1";
      box.addEventListener("click", () => {
        if(box.classList.contains("is-fit")) openInvoiceViewer(box.querySelector(".eb-invoice"));
      });
    }
  });
}
new MutationObserver(muts => {
  if(muts.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.matches?.(".receipt-invoice") || n.querySelector?.(".receipt-invoice")))))
    { requestAnimationFrame(fitInvoices); setTimeout(fitInvoices, 400); }   /* again once the modal has finished opening */
}).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("resize", () => requestAnimationFrame(fitInvoices));

function payQrHtml(method){
  const pay = (window.EB_LANDING && window.EB_LANDING.payment) || {};
  const a = pay[method] || {};
  const title = method === "bank" ? "Bank Transfer" : "GCash";
  const rows = [];
  if(method === "bank" && a.bank) rows.push(`<div class="pay-qr-row"><span>Bank</span><b>${esc(a.bank)}</b></div>`);
  if(a.name)   rows.push(`<div class="pay-qr-row"><span>Account name</span><b>${esc(a.name)}</b></div>`);
  /* Copy buttons for account numbers, since people often pay from the same phone. */
  if(a.number) rows.push(`<div class="pay-qr-row"><span>${method === "bank" ? "Account number" : "GCash number"}</span><span class="pay-qr-num"><b class="pay-qr-mono">${esc(a.number)}</b><button type="button" class="pay-copy" data-copy="${escAttr(a.number)}" aria-label="Copy number">Copy</button></span></div>`);
  if(!a.qr && !rows.length){
    return `<div class="pay-qr pay-qr-empty">Our ${title} details are not published yet. Contact us for where to send your payment.</div>`;
  }
  /* The QR is a link that opens the full-size image in a new tab (rel="noopener"), not a modal over the checkout. */
  /* Account details above the QR and the instruction below, so the code gets the full width. */
  return `<div class="pay-qr">
      <div class="pay-qr-head">
        <div class="pay-qr-title">Pay by ${title}</div>
        ${rows.join("")}
      </div>
      ${a.qr ? `<a class="pay-qr-fig" href="${escAttr(imageUrl(a.qr))}" target="_blank" rel="noopener noreferrer">
        <img class="pay-qr-img" src="${escAttr(imageUrl(a.qr))}" alt="${title} QR code">
        <span class="pay-qr-zoom">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>
          Open full size
        </span>
      </a>` : ""}
      <div class="pay-qr-hint">${a.qr
        ? "Scan the code with your app — tap it to open it full size on another device — then"
        : "Send your payment, then"} upload the screenshot below.</div>
    </div>`;
}

function productAvailable(p){
  if(!p) return false;
  return p.inStock !== undefined ? p.inStock : (p.stock === undefined || p.stock > 0);
}

function stockInfo(stockOrProduct){
  /* Accepts a product (public shape) or a bare number (seeded shape). */
  if(stockOrProduct && typeof stockOrProduct === "object"){
    const p = stockOrProduct;
    if(p.stockLevel){
      const MAP = {
        out:  { cls:"stock-out",  label: p.stockLabel || "Out of Stock" },
        crit: { cls:"stock-crit", label: p.stockLabel || "Only a few left" },
        warn: { cls:"stock-warn", label: p.stockLabel || "Low stock" },
        ok:   { cls:"stock-ok",   label: p.stockLabel || "In Stock" },
      };
      return MAP[p.stockLevel] || MAP.ok;
    }
    return stockInfo(p.stock);
  }
  const stock = stockOrProduct;
  if(stock <= 0)   return { cls:"stock-out",  label:"Out of Stock" };
  if(stock <= 10)  return { cls:"stock-crit", label:`Critical · ${stock} left` };
  if(stock <= 100) return { cls:"stock-warn", label:`Low · ${stock} left` };
  return { cls:"stock-ok", label:"In Stock" };
}

/* ---------- Inline SVG icon set (no emojis) ---------- */
const ICONS = {
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  menu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  cart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  chev:'<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeoff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>',
  spark:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/></svg>',
  star:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>',
  starhalf:'<svg viewBox="0 0 24 24"><defs><linearGradient id="hg"><stop offset="50%" stop-color="currentColor"/><stop offset="50%" stop-color="transparent"/></linearGradient></defs><path fill="url(#hg)" stroke="currentColor" stroke-width="1.2" d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>',
  user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  logout:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  bag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/></svg>',
  pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  facebook:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z"/></svg>',
  instagram:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>',
  leaf:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 16-9 0 8-5 16-9 16z"/><path d="M4 20s3-3 7-3"/></svg>',
  fish:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12c3-5 9-6 15-2-3 5-9 6-15 2zM21 10c-2 1-2 3 0 4M6 12c-2-1-4 0-5 2 2 1 3 1 5 0"/><circle cx="16" cy="11" r=".6" fill="currentColor"/></svg>',
  jar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2h8M7 6h10v13a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3z"/><path d="M7 11h10"/></svg>',
  camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
};
function icon(name, cls=""){ return `<span class="${cls}" aria-hidden="true">${ICONS[name]||""}</span>`; }

/* Shared image resolver (EbFormat.imageUrl), declared as a function so it is hoisted. */
function imageUrl(rec){ return EbFormat.imageUrl(rec); }

/* Escape all database text before putting it into markup (esc for text, escAttr for attributes), which closed a stored XSS through product descriptions. */
function esc(v){ return EbFormat.escHtml(v == null ? "" : v); }

/* A name written properly, as the server stores it (CustomerName::proper): each word capitalised ("juan dela cruz" ->
   "Juan Dela Cruz", "mary-ann" -> "Mary-Ann"), mixed-case words kept (McArthur), suffixes II-IX in capitals. */
function properName(v){
  return String(v || "").trim().replace(/\s+/g, " ").split(" ").map((w, i) => {
    if(!w) return w;
    if(i > 0 && /^(ii|iii|iv|vi|vii|viii|ix)$/i.test(w)) return w.toUpperCase();
    const lower = w.toLowerCase();
    if(w !== lower && w !== w.toUpperCase()) return w.charAt(0).toUpperCase() + w.slice(1);
    return lower.replace(/(^|[-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }).join(" ");
}
/* The name shown everywhere (CustomerName::display): "Juan D. Dela Cruz" — only the middle initial. */
function displayName(first, middle, last){
  const m = properName(middle);
  return [properName(first), m ? m.charAt(0).toUpperCase() + "." : "", properName(last)].filter(Boolean).join(" ");
}
/* Tidy name fields as the customer leaves them (sign-up and My Profile), and preview how the name will show. */
document.addEventListener("focusout", e => {
  const el = e.target;
  if(el && el.matches && el.matches("#rg-first, #rg-middle, #rg-last, #pf-first, #pf-middle, #pf-last") && el.value.trim()) el.value = properName(el.value);
});
document.addEventListener("input", e => {
  const el = e.target;
  if(!el || !el.matches || !el.matches("#rg-first, #rg-middle, #rg-last, #pf-first, #pf-middle, #pf-last")) return;
  const pre = el.id.slice(0, 3);
  const v = id => (document.getElementById(pre + id)?.value || "");
  const out = document.getElementById(pre === "rg-" ? "rg-name-preview" : "pf-name-preview");
  if(!out) return;
  const show = v("first").trim() && v("last").trim();
  out.hidden = !show;
  if(show) out.textContent = "Shown as: " + displayName(v("first"), v("middle"), v("last"));
});
function escAttr(v){ return esc(v); }

/* Image holder takes four arguments; the fourth is the photo, and leaving it out always shows the placeholder. */
/* srcset for an uploaded photo: the browser picks the 400px or 800px copy (api/uploads/thumb.php) or the original; empty when there are no copies. */
function photoSrcset(rec){
  const s = EbFormat.thumbUrl(rec, 400), m = EbFormat.thumbUrl(rec, 800), full = imageUrl(rec);
  return s === full ? "" : `${s} 400w, ${m} 800w, ${full} 1600w`;
}

function jarSVG(tint, label, cls="jar", img="", srcset="", sizes=""){
  /* Real photo when one is uploaded, otherwise a placeholder; img is already resolved by imageUrl(). */
  /* label and img are escaped. */
  const L = escAttr(label);
  if(img){
    return `<div class="img-holder has-photo" aria-label="${L}" title="${L}">
      <img src="${escAttr(img)}"${srcset ? ` srcset="${escAttr(srcset)}" sizes="${escAttr(sizes)}"` : ""} alt="${L}" loading="lazy" decoding="async" draggable="false">
    </div>`;
  }
  const camIcon = ICONS.camera || '';
  return `<div class="img-holder" aria-label="${L}" title="${L}">
    <span class="ph-icon" aria-hidden="true">${camIcon}</span>
    <span class="ph-label">Product Photo</span>
  </div>`;
}

/* ===== STAR RATING: products with no published reviews show "No ratings yet" instead of 0.0 stars; count is a required argument ===== */
function starRating(r, count){
  const n = Number(count);
  if(!Number.isFinite(n)){
    throw new TypeError("starRating(rating, count): count is required — see the note above.");
  }
  if(n <= 0){
    /* No reviews yet. */
    return '<span class="stars stars-none">No ratings yet</span>';
  }
  const label = `Rated ${r.toFixed(1)} out of 5, from ${n} review${n === 1 ? "" : "s"}`;
  let html = `<span class="stars" aria-label="${label}">`;
  for(let i=1;i<=5;i++){
    if(r >= i)        html += ICONS.star;
    else if(r >= i-.5)html += ICONS.starhalf;
    else              html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>';
  }
  /* The review count sits beside the average (aria-hidden, since the label already says it). */
  html += `<span class="rv">${r.toFixed(1)}</span><span class="rc" aria-hidden="true">(${n})</span></span>`;
  return html;
}

/* Photo card rating badge: one star with the honest-zero rule (no badge when unrated). */
function ratingBadge(p){
  const n = Number(p.reviewCount);
  if(!Number.isFinite(n) || n <= 0) return "";
  const label = `Rated ${p.rating.toFixed(1)} out of 5, from ${n} review${n === 1 ? "" : "s"}`;
  return `<span class="pc-rating-badge" aria-label="${label}">${icon("star")}<b>${p.rating.toFixed(1)}</b><span aria-hidden="true">(${n})</span></span>`;
}

/* ===== RENDER: product card factory (Shop and Best Sellers), using imageUrl() so every card shows its photo ===== */
/* Photo-first card using only real data (category, price, rating, sold count, stock, Add); stock sits on the photo and "N sold" in the bar so cards in a row stay the same height, and Add adds one (quantity is chosen in the product modal). */
function createProductCard(p, {ribbon=false}={}){
  const s = stockInfo(p);
  const out = !productAvailable(p);
  const el = document.createElement("article");
  el.className = "card product-card";
  el.dataset.id = p.id;
  el.innerHTML = `
    <div class="pc-media" data-detail="${escAttr(p.id)}" role="button" tabindex="0" aria-label="View ${escAttr(p.name)} details">
      ${jarSVG(p.tint, p.name, 'jar', imageUrl(p), photoSrcset(p), "(max-width: 640px) 50vw, 320px")}
      <div class="pc-scrim" aria-hidden="true"></div>
      <div class="pc-overlay">
        <div class="pc-overlay-top">
          ${ribbon && p.best ? `<span class="bs-ribbon">${icon("star")} Best Seller</span>` : ""}
          <span class="pc-cat">${esc(p.cat)}</span>
          <h3 class="pc-name">${esc(p.name)}</h3>
          <span class="price"><span class="cur">${CONFIG.currency}</span>${p.price}</span>
        </div>
        <div class="pc-overlay-bottom">
          ${ratingBadge(p)}
          <span class="stock-pill ${s.cls}">${s.label}</span>
        </div>
      </div>
    </div>
    <div class="pc-foot">
      <span class="pc-sold">${p.sold.toLocaleString()} sold</span>
      <button class="btn btn-primary btn-add" data-add="${escAttr(p.id)}" ${out?"disabled":""}>
        ${out ? "Sold Out" : icon("bag")+" Add to Order"}
      </button>
    </div>`;
  return el;
}

/* Shop sort options as a table of comparator plus optional cap (Top 5/10), mirroring $sortMap in api/shop/products.php. */
const bySold = (a,b) => (b.sold - a.sold) || a.name.localeCompare(b.name);
const SHOP_SORTS = {
  "featured":     { cmp: (a,b)=> (b.best - a.best) || bySold(a,b),  limit: null },
  "best-selling": { cmp: bySold,                                    limit: null },
  "top-5":        { cmp: bySold,                                    limit: 5    },
  "top-10":       { cmp: bySold,                                    limit: 10   },
  "name-asc":     { cmp: (a,b)=> a.name.localeCompare(b.name),      limit: null },
  "price-asc":    { cmp: (a,b)=> a.price - b.price,                 limit: null },
  "price-desc":   { cmp: (a,b)=> b.price - a.price,                 limit: null },
};

/* Render the shop grid with filters, search and sort, all client-side, applying the Top N cap after category and search filters. */
function renderProducts(){
  const grid = $("#product-grid");
  if(!grid) return;
  if(!CATALOG_READY){ grid.innerHTML = window.EbUI ? EbUI.skeletonCards(8) : ""; return; }
  const { search, category, sort } = state.filter;
  let list = PRODUCTS.filter(p=>{
    const matchCat = category === "All" || p.cat === category;
    const q = search.trim().toLowerCase();
    const matchQ = !q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  const mode    = SHOP_SORTS[sort] || SHOP_SORTS.featured;
  const matched = list.length;
  list.sort(mode.cmp);
  if(mode.limit) list = list.slice(0, mode.limit);

  /* Write the result line here in both cases, naming the cap and total when the list is capped. */
  const countEl = $("#product-count");
  if(countEl){
    countEl.dataset.owned = "1";
    countEl.innerHTML = (mode.limit && matched > mode.limit)
      ? `Showing the top <strong>${list.length}</strong> best sellers of <strong>${matched}</strong>` +
        (category === "All" ? "" : ` in ${esc(category)}`)
      : `Showing <strong>${list.length}</strong> product${list.length === 1 ? "" : "s"}`;
  }

  grid.innerHTML = "";
  if(!list.length){
    grid.innerHTML = `<div class="no-results">${icon("search")}<h3 style="font-size:1.6rem;margin:10px 0 4px">No products found</h3><p>Try a different search or category.</p></div>`;
    return;
  }
  list.forEach(p => grid.appendChild(createProductCard(p, {ribbon:true})));
}

/* Grid or sideways-row view for the product list; the class stays on #product-grid across re-renders. */
function wireShopView(){
  const grid    = $("#product-grid");
  const gridBtn = $("#view-grid-btn");
  const rowBtn  = $("#view-row-btn");
  if(!grid || !gridBtn || !rowBtn) return;

  function setView(view){
    const isRow = view === "row";
    grid.classList.toggle("view-row", isRow);
    gridBtn.classList.toggle("active", !isRow);
    rowBtn.classList.toggle("active", isRow);
    gridBtn.setAttribute("aria-pressed", String(!isRow));
    rowBtn.setAttribute("aria-pressed", String(isRow));
    try { localStorage.setItem("eb-shop-view", view); } catch(_){}
  }

  let saved = "grid";
  try { saved = localStorage.getItem("eb-shop-view") === "row" ? "row" : "grid"; } catch(_){}
  setView(saved);

  gridBtn.addEventListener("click", ()=> setView("grid"));
  rowBtn.addEventListener("click", ()=> setView("row"));

  /* In row view, turn a plain mouse wheel's vertical scroll into sideways scrolling (skipping gestures that are already horizontal). */
  grid.addEventListener("wheel", (e)=>{
    if(!grid.classList.contains("view-row")) return;
    if(Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    grid.scrollLeft += e.deltaY;
  }, { passive:false });
}

/* best sellers — 3-D fan carousel */
function renderBestSellers(){
  const track = $("#bestsellers-track");
  if(!track) return;
  if(!CATALOG_READY){ track.className = "bs-skeleton"; track.innerHTML = window.EbUI ? EbUI.skeletonCards(3) : ""; return; }
  /* Use the Landing Page module's chosen list, falling back to each product's best flag. */
  const picked = (window.EB_LANDING && Array.isArray(window.EB_LANDING.featured))
    ? window.EB_LANDING.featured : null;
  const items = picked && picked.length
    ? picked.map(id => PRODUCTS.find(p => p.id === id)).filter(Boolean)
    : PRODUCTS.filter(p => p.best);
  const total = items.length;
  let current = 0;

  track.className = "bs-carousel";
  track.innerHTML =
    '<div class="bsc-stage" id="bsc-stage"></div>' +
    '<div class="bsc-nav">' +
      '<button class="bsc-btn bsc-prev" aria-label="Previous slide">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
      '</button>' +
      '<div class="bsc-dots" id="bsc-dots"></div>' +
      '<button class="bsc-btn bsc-next" aria-label="Next slide">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>' +
      '</button>' +
    '</div>';

  const stage   = $("#bsc-stage");
  const dotsWrap = $("#bsc-dots");

  const slides = items.map(function(p, i){
    const slide = document.createElement("div");
    slide.className = "bsc-slide";
    slide.appendChild(createProductCard(p, {ribbon:true}));
    slide.addEventListener("click", function(){
      if(i !== current){ current = i; navPaint(); }
    });
    stage.appendChild(slide);
    return slide;
  });

  const dots = items.map(function(_, i){
    const d = document.createElement("button");
    d.className = "bsc-dot" + (i === 0 ? " active" : "");
    d.setAttribute("aria-label", "Go to slide " + (i+1));
    d.addEventListener("click", function(){ current = i; navPaint(); });
    dotsWrap.appendChild(d);
    return d;
  });

  /* Wheel geometry: WHEEL_STEP is the angle between cards (see --wheel-origin in styles.css). */
  var WHEEL_STEP  = 17;                 /* degrees between cards */
  var WHEEL_SCALE = [1, 0.94, 0.86];
  var WHEEL_OP    = [1, 0.9, 0.5];
  var WHEEL_Z     = [10, 8, 6];

  function paint(){
    slides.forEach(function(slide, i){
      var offset = ((i - current + total) % total);
      var norm   = offset > total / 2 ? offset - total : offset;
      var abs    = Math.abs(norm);
      var step   = Math.min(abs, 2);

      var angle = norm * WHEEL_STEP;
      var scale = WHEEL_SCALE[step];
      var op    = abs > 2 ? 0 : WHEEL_OP[step];
      var zi    = WHEEL_Z[step];

      var card = slide.firstElementChild;
      var tf   = "rotate(" + angle + "deg)";

      /* A card wrapping from one end to the other snaps instead of animating through the centre. */
      var prevNorm = slide._norm;
      if(prevNorm !== undefined && Math.abs(norm - prevNorm) > 2){
        var saved     = slide.style.transition;
        var savedCard = card ? card.style.transition : "";
        slide.style.transition = "none";
        if(card) card.style.transition = "none";
        slide.style.transform = tf;
        slide.style.opacity   = op;
        if(card) card.style.transform = "scale(" + scale + ")";
        void slide.offsetHeight;                 /* flush so it isn't animated */
        slide.style.transition = saved;
        if(card) card.style.transition = savedCard;
      } else {
        slide.style.transform = tf;
        slide.style.opacity   = op;
        if(card) card.style.transform = "scale(" + scale + ")";
      }

      slide._norm = norm;
      slide.style.zIndex = zi;
      slide.setAttribute("data-active", abs === 0 ? "true" : "false");
      slide.style.cursor = abs === 0 ? "grab" : "pointer";
    });
    dots.forEach(function(d, i){ d.classList.toggle("active", i === current); });
  }

  /* Rapid clicks use a short transition so cards do not pile up. */
  var lastNav = 0, fastTimer = null;
  function navPaint(){
    var now = Date.now();
    if(now - lastNav < 900){
      stage.classList.add("fast");
      clearTimeout(fastTimer);
      fastTimer = setTimeout(function(){ stage.classList.remove("fast"); }, 900);
    }
    lastNav = now;
    paint();
    /* After a manual choice, restart the full dwell time (stay paused while hovered). */
    pause();
    if(!hovering) resume();
  }

  track.querySelector(".bsc-prev").addEventListener("click", function(e){
    e.stopPropagation();
    current = (current - 1 + total) % total;
    navPaint();
  });
  track.querySelector(".bsc-next").addEventListener("click", function(e){
    e.stopPropagation();
    current = (current + 1) % total;
    navPaint();
  });

  /* touch/swipe */
  var sx = 0;
  stage.addEventListener("touchstart", function(e){ sx = e.touches[0].clientX; pause(); }, {passive:true});
  stage.addEventListener("touchend", function(e){
    var dx = e.changedTouches[0].clientX - sx;
    if(Math.abs(dx) > 50){
      current = dx < 0 ? (current+1)%total : (current-1+total)%total;
      paint();
    }
    resume();
  });

  /* Mouse drag: hold and drag sideways to turn the wheel, one card per DRAG_STEP pixels and at most one per DRAG_GAP_MS so it stays easy to follow; a real drag swallows the click that follows so no card opens. */
  var DRAG_STEP = 180, DRAG_GAP_MS = 450, lastDragTurn = 0, dragX = null, dragMoved = 0, dragSuppress = false;
  stage.addEventListener("dragstart", function(e){ e.preventDefault(); });
  stage.addEventListener("mousedown", function(e){
    if(e.button !== 0 || e.target.closest("button, a, input")) return;
    dragX = e.clientX; dragMoved = 0; dragSuppress = false;
    pause();
    stage.classList.add("dragging");
  });
  window.addEventListener("mousemove", function(e){
    if(dragX === null) return;
    var dx = e.clientX - dragX;
    if(Math.abs(dx) >= DRAG_STEP && Date.now() - lastDragTurn >= DRAG_GAP_MS){
      /* Drag left brings the next card in, matching the touch swipe; the normal glide is kept (not the fast one). */
      current = dx < 0 ? (current + 1) % total : (current - 1 + total) % total;
      dragX = e.clientX;
      lastDragTurn = Date.now();
      dragSuppress = true;
      paint();
      pause();
    }
    dragMoved += Math.abs(e.movementX || 0);
    if(dragMoved > 6) dragSuppress = true;
  });
  window.addEventListener("mouseup", function(){
    if(dragX === null) return;
    dragX = null;
    stage.classList.remove("dragging");
    /* The click (if any) fires right after mouseup, so clear the flag once it has had its chance. */
    setTimeout(function(){ dragSuppress = false; }, 0);
    if(!hovering) resume();
  });
  stage.addEventListener("click", function(e){
    if(dragSuppress){ e.stopPropagation(); e.preventDefault(); dragSuppress = false; }
  }, true);

  /* auto-rotate */
  var timer = null;
  /* 0.8s glide (the CSS transition) + 1.0s at rest in the centre. */
  var WHEEL_GLIDE_MS = 800, WHEEL_HOLD_MS = 1000;
  function resume(){
    clearInterval(timer);
    timer = setInterval(function(){
      current = (current + 1) % total;      /* right-to-left travel */
      paint();
    }, WHEEL_GLIDE_MS + WHEEL_HOLD_MS);
  }
  function pause(){ clearInterval(timer); }

  /* Track hover so an arrow click does not resume autoplay while the pointer is still on the carousel. */
  var hovering = false;
  track.addEventListener("mouseenter", function(){ hovering = true;  pause();  });
  track.addEventListener("mouseleave", function(){ hovering = false; resume(); });

  paint();
  resume();
}

/* ===== RENDER: certifications, FAQ, trust badges ===== */
function renderCerts(){
  const make = c => `<div class="cert"><span class="ring">${esc(c.code)}</span><small>${esc(c.label)}</small></div>`;
  const aboutCerts = $("#about-certs");
  if(aboutCerts) aboutCerts.innerHTML = CONFIG.certifications.map(make).join("");
  /* Trust badges removed (no element exists); certifications stay. */
  const footCerts = $("#foot-certs");
  if(footCerts) footCerts.innerHTML = CONFIG.certifications.map(c=>`<span>${esc(c.code)}</span>`).join("");
}

function createFaqItem(qa, idx){
  const item = document.createElement("div");
  item.className = "faq-item";
  const aid = `faq-a-${idx}`, qid = `faq-q-${idx}`;
  item.innerHTML = `
    <button class="faq-q" id="${qid}" aria-expanded="false" aria-controls="${aid}">
      <span>${esc(qa.q)}</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    <div class="faq-a" id="${aid}" role="region" aria-labelledby="${qid}"><div class="inner">${esc(qa.a)}</div></div>`;
  const btn = $(".faq-q", item), ans = $(".faq-a", item);
  btn.addEventListener("click", ()=>{
    const open = item.classList.toggle("open");
    btn.setAttribute("aria-expanded", open);
    ans.style.maxHeight = open ? ans.scrollHeight + "px" : 0;
  });
  return item;
}
function renderFaqs(){
  const wrap = $("#faq-wrap");
  if(!wrap) return;
  wrap.innerHTML = "";

  if(!FAQS.length){
    /* Show an error state (not fake rows), distinguishing loading from a failed load. */
    const note = document.createElement("div");
    note.className = "faq-empty muted";
    note.style.cssText = "padding:18px 0;text-align:center";
    note.textContent = FAQS_LOADED
      ? "No questions have been published yet."
      : "Couldn't load the questions just now — please refresh.";
    wrap.appendChild(note);
    return;
  }

  FAQS.forEach((qa,i)=> wrap.appendChild(createFaqItem(qa,i)));
}

/* ===== UI PRIMITIVE: TOAST ===== */
function showToast(msg, type="success", opts={}){
  /* Toast: the message is escaped, either #toast-wrap or #toast-root is accepted, and with neither it logs to the console; keep behaviour in step with EbUI.toast() in core/ui.js. */
  const wrap = $("#toast-wrap") || $("#toast-root");
  if(!wrap){ console.log(`[${type}] ${msg}`); return; }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  /* Non-success toasts show a CSS dot instead of an icon. */
  t.innerHTML = `<span class="ic">${type==="success"?ICONS.check:""}</span><span class="toast-msg">${esc(msg)}</span>`;

  let timer = null;
  const dismiss = () => {
    if(timer){ clearTimeout(timer); timer = null; }
    t.classList.add("out");
    setTimeout(()=>t.remove(), 320);
  };

  /* Optional Undo action (with a longer display time), used instead of a confirm dialog. */
  if(opts.action && typeof opts.action.onClick === "function"){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = opts.action.label || "Undo";
    btn.addEventListener("click", ()=>{ dismiss(); opts.action.onClick(); });
    t.appendChild(btn);
  }

  wrap.appendChild(t);
  timer = setTimeout(dismiss, opts.duration || (opts.action ? 6000 : 2600));
}

/* ===== UI PRIMITIVE: MODAL (product detail, login, register, checkout, receipt) ===== */
let lastFocus = null;
function openModal(title, bodyHTML, {wide=false, onOpen}={}){
  /* Every modal node is optional so a missing element never breaks opening; only a missing scrim stops it. */
  const scrim = $("#modal-scrim");
  const body  = $("#modal-body");
  if(!scrim || !body){
    console.warn("[modal] no #modal-scrim / #modal-body on this page — cannot open:", title);
    return;
  }

  lastFocus = document.activeElement;
  const titleEl = $("#modal-title");
  if(titleEl) titleEl.textContent = title;
  body.innerHTML = bodyHTML;
  /* Scroll the reused modal back to the top when opening. */
  const modalEl = $("#modal"); if(modalEl) modalEl.scrollTop = 0;
  $("#modal")?.classList.toggle("wide", wide);
  scrim.classList.add("open");
  document.body.style.overflow = "hidden";
  $("#modal")?.classList.remove("is-auth");   /* auth's onOpen adds it back */
  if(onOpen) onOpen(body);
  const f = body.querySelector("input,select,textarea,button");
  if(f) setTimeout(()=>f.focus(), 60);
}
/* Sign-up step 2: email code verification replaces the form; register-verify.php creates the account, and Edit details goes back. */
function showSignupOtp(root, info){
  const panel = root.querySelector('#ap-register');
  const form  = root.querySelector('#reg-form');
  if(!panel || !form) return;
  panel.querySelector('#otp-step')?.remove();
  form.style.display = "none";
  const head = panel.querySelector('.auth-panel-head');
  if(head) head.style.display = "none";

  const box = document.createElement('div');
  box.id = 'otp-step'; box.className = 'otp-step';
  box.innerHTML = `
    <div class="otp-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>
    <h3 class="otp-title">Verify your email</h3>
    <p class="otp-sub">We sent a 6-digit code to <b>${esc(info.email || "your email")}</b>. Enter it below to create your account.</p>
    <div class="otp-boxes" role="group" aria-label="Verification code">
      ${Array.from({length:6}, (_, i) => `<input class="otp-box" inputmode="numeric" autocomplete="${i === 0 ? "one-time-code" : "off"}" maxlength="1" aria-label="Digit ${i + 1}">`).join("")}
    </div>
    <span class="field-error otp-err" id="otp-err"></span>
    ${info.devCode ? `<p class="otp-dev">Test mode — email sending is not set up on this server. Your code is <b>${esc(info.devCode)}</b>.</p>`
      : !info.mailLive ? `<p class="otp-dev otp-warn">Email sending is not set up on this server yet, so no code was sent. Please contact us to finish creating your account.</p>`
      : info.emailed === false ? `<p class="otp-dev otp-warn">We couldn't send the email just now. Wait a minute and tap <b>Resend code</b>.</p>` : ""}
    <button type="button" class="auth-submit" id="otp-go">Verify &amp; Create Account ${_authArrow}</button>
    <div class="otp-links">
      <button type="button" class="otp-link" id="otp-resend" disabled>Resend code</button>
      <span class="otp-timer" id="otp-timer"></span>
      <span class="otp-dot">·</span>
      <button type="button" class="otp-link" id="otp-back">Edit details</button>
    </div>`;
  panel.appendChild(box);

  const boxes = [...box.querySelectorAll('.otp-box')];
  const err = box.querySelector('#otp-err');
  const go  = box.querySelector('#otp-go');
  const resend = box.querySelector('#otp-resend');
  const timerEl = box.querySelector('#otp-timer');
  const code = () => boxes.map(b => b.value).join('');

  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      if(b.value && boxes[i + 1]) boxes[i + 1].focus();
      err.textContent = '';
      if(code().length === 6) submit();
    });
    b.addEventListener('keydown', e => {
      if(e.key === 'Backspace' && !b.value && boxes[i - 1]){ boxes[i - 1].focus(); boxes[i - 1].value = ''; }
      if(e.key === 'Enter') submit();
    });
    b.addEventListener('paste', e => {
      const d = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if(!d) return;
      e.preventDefault();
      boxes.forEach((x, n) => { x.value = d[n] || ''; });
      (boxes[d.length] || boxes[5]).focus();
      if(d.length === 6) submit();
    });
  });

  let tick = null;
  const countdown = secs => {
    clearInterval(tick);
    resend.disabled = true;
    const end = Date.now() + secs * 1000;
    const draw = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      timerEl.textContent = left ? `in ${left}s` : '';
      if(!left){ resend.disabled = false; clearInterval(tick); }
    };
    draw(); tick = setInterval(draw, 1000);
  };
  countdown(info.resendIn || 60);

  let busy = false;
  async function submit(){
    if(busy) return;
    const c = code();
    if(c.length !== 6){ err.textContent = 'Enter all 6 digits.'; return; }
    busy = true; go.disabled = true; go.textContent = 'Verifying…';
    try {
      const { data } = await EbApi.post("shop/register-verify.php", { code: c });
      clearInterval(tick);
      signIn(data.customer);
      /* signIn() already says "Welcome, name!". */
      if(data.claimedExistingRecord) showToast("Welcome back — we found your previous orders.", "success");
    } catch(e){
      err.textContent = e.message;
      boxes.forEach(x => { x.value = ''; }); boxes[0].focus();
      if(e.status === 410){ setTimeout(back, 1200); }
    } finally {
      busy = false; go.disabled = false; go.innerHTML = `Verify &amp; Create Account ${_authArrow}`;
    }
  }
  function back(){
    clearInterval(tick);
    box.remove(); form.style.display = ""; if(head) head.style.display = "";
  }
  go.addEventListener('click', submit);
  box.querySelector('#otp-back').addEventListener('click', back);
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try {
      const { data } = await EbApi.post("shop/register-verify.php", { resend: true });
      err.textContent = '';
      showToast("A new code is on its way.", "info");
      const dev = box.querySelector('.otp-dev b'); if(dev && data.devCode) dev.textContent = data.devCode;
      countdown(data.resendIn || 60);
    } catch(e){
      err.textContent = e.message;
      if(e.status === 410) setTimeout(back, 1200); else resend.disabled = false;
    }
  });
  setTimeout(() => boxes[0].focus(), 60);
}

/* Forgot password replaces the Sign In form: email, then code plus new password (same answer for unknown emails). */
function showForgot(root){
  const panel = root.querySelector('#ap-login');
  const form  = root.querySelector('#login-form');
  if(!panel || !form) return;
  panel.querySelector('#fp-step')?.remove();
  const head = panel.querySelector('.auth-panel-head');
  form.style.display = "none"; if(head) head.style.display = "none";

  const box = document.createElement('div');
  box.id = 'fp-step'; box.className = 'otp-step fp-step';
  panel.appendChild(box);
  let tick = null;
  const back = () => { clearInterval(tick); box.remove(); form.style.display = ""; if(head) head.style.display = ""; };
  const lockIc = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

  /* Step 1 — which account */
  const stepEmail = (prefill = "") => {
    clearInterval(tick);
    box.innerHTML = `
      <div class="otp-ic" aria-hidden="true">${lockIc}</div>
      <h3 class="otp-title">Forgot your password?</h3>
      <p class="otp-sub">Enter the email you signed up with and we will send you a 6-digit code to reset it.</p>
      <div class="auth-field fp-field">
        <label for="fp-email">Email address *</label>
        <div class="auth-input-group">
          <span class="auth-input-icon" aria-hidden="true">${ICONS.mail}</span>
          <input class="auth-input" id="fp-email" type="email" placeholder="you@email.com" autocomplete="email" value="${esc(prefill)}"/>
        </div>
        <span class="field-error" id="fp-err"></span>
      </div>
      <button type="button" class="auth-submit" id="fp-send">Send code ${_authArrow}</button>
      <div class="otp-links"><button type="button" class="otp-link" id="fp-back">Back to sign in</button></div>`;
    const inp = box.querySelector('#fp-email'), err = box.querySelector('#fp-err'), go = box.querySelector('#fp-send');
    box.querySelector('#fp-back').addEventListener('click', back);
    const send = async () => {
      const email = inp.value.trim();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent = 'Enter a valid email address.'; inp.focus(); return; }
      go.disabled = true; go.textContent = 'Sending code…';
      try {
        const { data } = await EbApi.post("shop/password-reset.php", { email });
        stepCode(data, email);
      } catch(e){
        err.textContent = e.fields?.email || e.message;
        go.disabled = false; go.innerHTML = `Send code ${_authArrow}`;
      }
    };
    go.addEventListener('click', send);
    inp.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); send(); } });
    inp.addEventListener('input', () => { err.textContent = ''; });
    setTimeout(() => inp.focus(), 60);
  };

  /* Step 2 — code + new password */
  const stepCode = (info, email) => {
    box.innerHTML = `
      <div class="otp-ic" aria-hidden="true">${lockIc}</div>
      <h3 class="otp-title">Reset your password</h3>
      <p class="otp-sub">If an account exists for <b>${esc(info.email || email)}</b>, we sent it a 6-digit code. Enter it with your new password.</p>
      <div class="otp-boxes" role="group" aria-label="Reset code">
        ${Array.from({length:6}, (_, i) => `<input class="otp-box" inputmode="numeric" autocomplete="${i === 0 ? "one-time-code" : "off"}" maxlength="1" aria-label="Digit ${i + 1}">`).join("")}
      </div>
      <span class="field-error otp-err" id="fp-code-err"></span>
      ${info.devCode ? `<p class="otp-dev">Test mode — email sending is not set up on this server. Your code is <b>${esc(info.devCode)}</b>.</p>` : ""}
      <div class="auth-field fp-field">
        <label for="fp-pw">New password *</label>
        <div class="auth-input-group">
          <span class="auth-input-icon" aria-hidden="true">${_lockIcon}</span>
          <input class="auth-input" id="fp-pw" type="password" placeholder="Create a strong password" autocomplete="new-password"/>
        </div>
        <span class="field-error" id="fp-pw-err"></span>
      </div>
      <div class="auth-field fp-field">
        <label for="fp-pw2">Confirm new password *</label>
        <div class="auth-input-group">
          <span class="auth-input-icon" aria-hidden="true">${_lockIcon}</span>
          <input class="auth-input" id="fp-pw2" type="password" placeholder="Type it again" autocomplete="new-password"/>
        </div>
        <span class="field-error" id="fp-pw2-err"></span>
      </div>
      <button type="button" class="auth-submit" id="fp-go">Reset password ${_authArrow}</button>
      <div class="otp-links">
        <button type="button" class="otp-link" id="fp-resend" disabled>Resend code</button>
        <span class="otp-timer" id="fp-timer"></span>
        <span class="otp-dot">·</span>
        <button type="button" class="otp-link" id="fp-change">Change email</button>
      </div>`;
    const boxes = [...box.querySelectorAll('.otp-box')];
    const codeErr = box.querySelector('#fp-code-err'), pw = box.querySelector('#fp-pw'), pw2 = box.querySelector('#fp-pw2');
    const pwErr = box.querySelector('#fp-pw-err'), pw2Err = box.querySelector('#fp-pw2-err');
    const pwMissing = mountPwChecklist(pw);
    const go = box.querySelector('#fp-go'), resend = box.querySelector('#fp-resend'), timerEl = box.querySelector('#fp-timer');
    const code = () => boxes.map(b => b.value).join('');
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        b.value = b.value.replace(/\D/g, '').slice(-1);
        if(b.value){ (boxes[i + 1] || pw).focus(); }
        codeErr.textContent = '';
      });
      b.addEventListener('keydown', e => {
        if(e.key === 'Backspace' && !b.value && boxes[i - 1]){ boxes[i - 1].focus(); boxes[i - 1].value = ''; }
      });
      b.addEventListener('paste', e => {
        const d = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if(!d) return;
        e.preventDefault();
        boxes.forEach((x, n) => { x.value = d[n] || ''; });
        (d.length === 6 ? pw : boxes[d.length]).focus();
      });
    });
    [pw, pw2].forEach(x => {
      x.addEventListener('input', () => { pwErr.textContent = ''; pw2Err.textContent = ''; });
      x.addEventListener('keydown', e => { if(e.key === 'Enter') submit(); });
    });
    const countdown = secs => {
      clearInterval(tick); resend.disabled = true;
      const end = Date.now() + secs * 1000;
      const draw = () => {
        const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        timerEl.textContent = left ? `in ${left}s` : '';
        if(!left){ resend.disabled = false; clearInterval(tick); }
      };
      draw(); tick = setInterval(draw, 1000);
    };
    countdown(info.resendIn || 60);

    let busy = false;
    async function submit(){
      if(busy) return;
      let bad = false;
      if(code().length !== 6){ codeErr.textContent = 'Enter all 6 digits.'; bad = true; }
      const miss = pwMissing();
      if(miss){ pwErr.textContent = `Your password needs: ${miss.label.toLowerCase()}.`; bad = true; }
      else if(pw.value !== pw2.value){ pw2Err.textContent = 'The two passwords do not match.'; bad = true; }
      if(bad) return;
      busy = true; go.disabled = true; go.textContent = 'Saving…';
      try {
        const { data } = await EbApi.post("shop/password-reset.php", { code: code(), password: pw.value, confirm: pw2.value });
        clearInterval(tick);
        signIn(data.customer);
        showToast("Password changed — you're signed in.", "success");
      } catch(e){
        const f = e.fields || {};
        if(f.password) pwErr.textContent = f.password;
        else if(f.confirm) pw2Err.textContent = f.confirm;
        else { codeErr.textContent = e.message; boxes.forEach(x => { x.value = ''; }); boxes[0].focus(); }
        if(e.status === 410) setTimeout(() => stepEmail(email), 1200);
      } finally {
        busy = false; go.disabled = false; go.innerHTML = `Reset password ${_authArrow}`;
      }
    }
    go.addEventListener('click', submit);
    box.querySelector('#fp-change').addEventListener('click', () => stepEmail(email));
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      try {
        const { data } = await EbApi.post("shop/password-reset.php", { resend: true });
        codeErr.textContent = '';
        showToast("A new code is on its way.", "info");
        const dev = box.querySelector('.otp-dev b'); if(dev && data.devCode) dev.textContent = data.devCode;
        countdown(data.resendIn || 60);
      } catch(e){
        codeErr.textContent = e.message;
        if(e.status === 410) setTimeout(() => stepEmail(email), 1200); else resend.disabled = false;
      }
    });
    setTimeout(() => boxes[0].focus(), 60);
  };

  stepEmail(root.querySelector('#lg-email')?.value.trim() || "");
}

function closeModal(){
  /* Guarded so pressing Escape on a page without a modal never throws. */
  $("#modal-scrim")?.classList.remove("open");
  document.body.style.overflow = "";
  /* Remove the auth styling only after the fade-out, unless something reopened. */
  setTimeout(() => {
    if(!$("#modal-scrim")?.classList.contains("open")) $("#modal")?.classList.remove("is-auth");
  }, 400);
  if(lastFocus) lastFocus.focus();
}

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

/* ===== CART logic ===== */
/* Count products, not units, the same as api/shop/cart.php's count. */
const cartLineCount = () => state.cart.length;
/* Skip a cart line whose product is not loaded yet instead of throwing. */
const cartSubtotal = () => state.cart.reduce((s,i)=>{
  const p = getProduct(i.id);
  return s + (p ? p.price * i.qty : 0);
}, 0);

let pendingCartAdd = null; // item queued while user logs in

/* ===== CART PERSISTENCE: the cart is stored on the account (migration 007, api/shop/cart.php and cart-save.php), never in localStorage ===== */

/* Save one line to the server after the UI updates, rolling back and telling the shopper if it fails. */
async function saveCartLine(id, qty, rollback){
  if(!state.auth.loggedIn) return false;
  try {
    await EbApi.post("shop/cart-save.php", { product_id: id, qty });
    return true;
  } catch(err){
    if(typeof rollback === "function") rollback();
    updateCartBadge(); renderCart();
    showToast(err.message || "Your cart could not be saved. Please try again.", "info");
    return false;
  }
}

/* Merge product fields from the cart response into PRODUCTS (without overwriting richer catalogue rows). */
function mergeCartProducts(items){
  (items || []).forEach(it => {
    if(getProduct(it.id)) return;
    PRODUCTS.push({
      id: it.id, name: it.name, price: it.price, image: it.image,
      tint: it.tint, cat: it.cat, desc: "", long: "", nutri: "",
      /* A cart-derived product has reviewCount 0, so it shows "No ratings yet". */
      rating: 0, reviewCount: 0, sold: 0, best: false,
      inStock: it.inStock, stock: it.stock,
      stockLevel: it.stockLevel, stockLabel: it.stockLabel,
    });
  });
}

/* Load and render the signed-in customer's cart; returns the payload, or null (leaving the cart alone) on failure. */
async function loadServerCart(){
  if(!state.auth.loggedIn) return null;
  try {
    const { data } = await EbApi.get("shop/cart.php");
    mergeCartProducts(data.items);
    state.cart = data.items.map(i => ({ id: i.id, qty: i.qty }));
    updateCartBadge();
    renderCart();

    /* Tell the shopper what the server changed in their saved cart. */
    (data.changes || []).forEach(c => {
      const what = c.action === "clamped"
        ? `quantity reduced to ${c.qty}`
        : "removed from your cart";
      showToast(`${c.name} ${c.reason} — ${what}.`, "info");
    });

    return data;
  } catch(err){
    /* 401 is the ordinary "not signed in" case and says nothing worth saying. */
    if(err && err.status !== 401) console.warn("cart load failed:", err.message);
    return null;
  }
}

async function addToCart(id, qty=1){
  if(!state.auth.loggedIn){
    pendingCartAdd = { id, qty };
    openLogin(`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> Sign in to add items to your cart`);
    return;
  }
  const p = getProduct(id);
  if(!productAvailable(p)) { showToast("That product is out of stock", "info"); return; }
  const line = state.cart.find(i=>i.id===id);
  const prevQty = line ? line.qty : 0;
  const newQty = prevQty + qty;
  /* Refuse quantities above the shelf stock (the server re-checks). */
  const max = productMax(p);
  if(newQty > max){
    /* Say how many are available, and how many more fit given what is already in the cart. */
    const room = Math.max(0, max - prevQty);
    const what = `Only ${max} of ${p.name} available`;
    showToast(prevQty
      ? `${what} — you already have ${prevQty} in your cart${room ? `, so you can add ${room} more` : ""}.`
      : `${what}.`, "info");
    return;
  }
  if(line) line.qty = newQty; else state.cart.push({id, qty});
  updateCartBadge(true);
  renderCart();
  showToast(`${p.name} added to cart`, "success");
  /* Update the screen first, then the server, rolling back if refused. */
  await saveCartLine(id, newQty, () => {
    if(prevQty > 0){ const l = state.cart.find(i=>i.id===id); if(l) l.qty = prevQty; }
    else state.cart = state.cart.filter(i=>i.id!==id);
  });
}
/* Add several lines at once (Reorder), capped at stock, with one refresh. */
async function addManyToCart(lines){
  let added = 0; const skipped = [];
  const saves = [];
  for(const {id, qty} of lines){
    const p = getProduct(id);
    if(!productAvailable(p)){ skipped.push(p ? p.name : id); continue; }
    const line = state.cart.find(i=>i.id===id);
    const prev = line ? line.qty : 0;
    const next = Math.min(prev + qty, productMax(p));
    if(next <= prev){ skipped.push(p.name); continue; }
    if(line) line.qty = next; else state.cart.push({id, qty: next});
    added++;
    saves.push(saveCartLine(id, next, () => {
      if(prev > 0){ const l = state.cart.find(i=>i.id===id); if(l) l.qty = prev; }
      else state.cart = state.cart.filter(i=>i.id!==id);
    }));
  }
  updateCartBadge(true); renderCart();
  await Promise.all(saves);
  return { added, skipped };
}
function setQty(id, qty){
  /* The minimum stays 1 for typed input; removing is the minus button's job. */
  qty = Math.max(1, Math.min(qty, productMax(getProduct(id))));
  const line = state.cart.find(i=>i.id===id);
  if(!line) return;
  const prevQty = line.qty;
  if(prevQty === qty) return;
  line.qty = qty;
  updateCartBadge(); renderCart();
  saveCartLine(id, qty, () => { const l = state.cart.find(i=>i.id===id); if(l) l.qty = prevQty; });
}
/* Removal is immediate with an Undo toast that restores the line in its original position. */
function removeFromCart(id){
  const idx = state.cart.findIndex(i => i.id === id);
  if(idx < 0) return;
  const [line] = state.cart.splice(idx, 1);
  const p = getProduct(id);
  updateCartBadge(); renderCart();
  showToast(`${p ? p.name : "Item"} removed from your cart`, "info", {
    action: { label: "Undo", onClick: () => restoreCartLine(idx, line) },
  });
  /* qty 0 deletes; if refused, the line comes back without another write. */
  saveCartLine(id, 0, () => restoreCartLine(idx, line, false));
}

function restoreCartLine(idx, line, persist=true){
  /* Undo does not overwrite a quantity the shopper re-added meanwhile. */
  if(state.cart.some(i => i.id === line.id)) return;
  state.cart.splice(Math.min(idx, state.cart.length), 0, line);
  updateCartBadge(true); renderCart();
  if(persist){
    saveCartLine(line.id, line.qty, () => {
      state.cart = state.cart.filter(i => i.id !== line.id);
    });
  }
}

function updateCartBadge(bounce=false){
  const n = cartLineCount();
  // update both pill badge and mobile badge
  [$("#cart-badge"), $("#cart-badge-mob")].forEach(b=>{ if(b){ b.textContent=n; b.classList.toggle("show",n>0); } });
  if(bounce){
    const ic = $("#cart-icon");
    if(ic){ ic.classList.remove("cart-icon-anim"); void ic.offsetWidth; ic.classList.add("cart-icon-anim"); }
  }
}

function renderCart(){
  const body = $("#cart-body"), foot = $("#cart-foot");
  if(!body || !foot) return;
  if(!state.cart.length){
    body.innerHTML = `<div class="cart-empty">${icon("bag")}<div><b style="font-family:'Cormorant Garamond';font-size:1.4rem">Your cart is empty</b><p>Add some gourmet goodness to get started.</p></div><button class="btn btn-ghost" id="cart-shop">Browse the Shop</button></div>`;
    foot.innerHTML = "";
    $("#cart-shop")?.addEventListener("click", goToShop);
    return;
  }
  body.innerHTML = "";
  state.cart.forEach(item=>{
    const p = getProduct(item.id);
    const line = document.createElement("div");
    line.className = "cart-line";
    line.innerHTML = `
      <div class="thumb">${jarSVG(p.tint, p.name, 'jar', imageUrl(p), photoSrcset(p), "96px")}</div>
      <div class="cl-info">
        <b>${esc(p.name)}</b>
        <span class="cl-unit">${peso(p.price)} each</span>
        <div class="cl-qty-row">
          <div class="stepper" data-cart-stepper="${escAttr(p.id)}">
            <button type="button" data-cstep="-1" aria-label="Decrease">${ICONS.minus}</button>
            <input type="number" value="${item.qty}" min="1" max="${productMax(p)}" aria-label="Quantity of ${escAttr(p.name)}" />
            <button type="button" data-cstep="1" aria-label="Increase">${ICONS.plus}</button>
          </div>
          <span class="price cl-total"><span class="cur">${CONFIG.currency}</span>${(p.price*item.qty).toLocaleString("en-PH")}</span>
        </div>
      </div>
      <button class="cl-remove" data-remove="${escAttr(p.id)}" aria-label="Remove ${escAttr(p.name)}">${ICONS.trash}</button>`;
    body.appendChild(line);
  });
  const sub = cartSubtotal();
  foot.innerHTML = `
    <div class="summary-row"><span>Subtotal (${cartLineCount()} ${cartLineCount()===1?"product":"products"})</span><span>${peso(sub)}</span></div>
    <div class="summary-row"><span>Shipping</span><span>Calculated at checkout</span></div>
    <div class="summary-row total"><span>Total</span><span>${peso(sub)}</span></div>
    <button class="btn btn-primary btn-block" id="checkout-btn">Proceed to Checkout</button>`;
  $("#checkout-btn").addEventListener("click", openCheckout);
}

function openCart(){ $("#cart-scrim").classList.add("open"); $("#cart-drawer").classList.add("open"); document.body.style.overflow="hidden"; }
function closeCart(){ $("#cart-scrim").classList.remove("open"); $("#cart-drawer").classList.remove("open"); document.body.style.overflow=""; }

/* ===== LOCKOUT COUNTDOWN: show a ticking wait from the server's retryAfter and disable the button until it ends ===== */
let lockTimer = null;

function stopLockCountdown(root){
  if(lockTimer){ clearInterval(lockTimer); lockTimer = null; }
  const box = (root || document).querySelector("#lg-lock");
  if(box){ box.hidden = true; box.textContent = ""; }
  const btn = (root || document).querySelector("#login-form [type=submit]");
  if(btn) btn.disabled = false;
}

function startLockCountdown(root, seconds, message){
  const box = root.querySelector("#lg-lock");
  const btn = root.querySelector("#login-form [type=submit]");
  if(!box){ showToast(message, "info"); return; }

  if(lockTimer){ clearInterval(lockTimer); lockTimer = null; }

  let left = Math.max(0, Number(seconds) || 0);

  /* No number from the server: show its message and leave the form usable. */
  if(left <= 0){
    box.hidden = false;
    box.textContent = message;
    return;
  }

  const paint = () => {
    const m = Math.floor(left / 60), sec = left % 60;
    const clock = m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
    box.textContent = `Too many failed sign-in attempts. Try again in ${clock}.`;
  };

  box.hidden = false;
  paint();
  if(btn) btn.disabled = true;

  lockTimer = setInterval(() => {
    left -= 1;
    if(left <= 0){
      clearInterval(lockTimer); lockTimer = null;
      box.hidden = true; box.textContent = "";
      if(btn) btn.disabled = false;
      return;
    }
    paint();
  }, 1000);
}

/* ===== PRODUCT REVIEWS (read-only list under the product detail): ratings can only be written from My Orders on a completed order, and every review is a verified purchase ===== */
function reviewStars(n){
  let html = `<span class="stars" aria-label="${n} out of 5">`;
  for(let i=1;i<=5;i++){
    html += i <= n ? ICONS.star
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>';
  }
  return html + "</span>";
}

/* 1 to 5 star histogram (bars aria-hidden). */
function reviewSpread(spread, total){
  if(!total) return "";
  return `<div class="rev-spread">` + [5,4,3,2,1].map(n=>{
    const c = Number(spread?.[String(n)] || 0);
    const pct = total ? Math.round((c / total) * 100) : 0;
    return `<div class="rev-spread-row">
      <span class="rev-spread-n">${n}${ICONS.star}</span>
      <span class="rev-spread-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      <span class="rev-spread-c">${c}</span>
    </div>`;
  }).join("") + `</div>`;
}

async function loadProductReviews(productId, root){
  const host = root?.querySelector("#pd-reviews");
  if(!host) return;
  try{
    const { data } = await EbApi.get("shop/reviews.php", { product_id: productId, limit: 20 });

    /* With no reviews, say so in a sentence. */
    if(!data.review_count){
      host.innerHTML = `<h4 class="pd-rev-title">Reviews</h4>
        <p class="pd-rev-empty">No ratings yet. Reviews come from customers who
        bought this product — yours will appear here once your order is completed.</p>`;
      return;
    }

    const head = `<h4 class="pd-rev-title">Reviews</h4>
      <div class="pd-rev-head">
        <div class="pd-rev-avg">
          <span class="pd-rev-num">${data.avg_rating.toFixed(1)}</span>
          ${reviewStars(Math.round(data.avg_rating))}
          <span class="pd-rev-count">${data.review_count} review${data.review_count===1?"":"s"}</span>
        </div>
        ${reviewSpread(data.spread, data.review_count)}
      </div>`;

    const list = data.reviews.map(r=>`
      <li class="rev-item">
        <div class="rev-top">
          ${reviewStars(r.rating)}
          <span class="rev-author">${esc(r.author)}</span>
          <span class="rev-verified" title="This customer bought this product">
            ${ICONS.check || ""}Verified purchase</span>
          <span class="rev-date">${EbFormat.fmtDate(r.date)}${r.edited ? " · edited" : ""}</span>
        </div>
        ${r.comment ? `<p class="rev-body">${esc(r.comment)}</p>` : ""}
      </li>`).join("");

    host.innerHTML = head + `<ul class="rev-list">${list}</ul>` +
      (data.review_count > data.reviews.length
        ? `<p class="pd-rev-more">Showing ${data.reviews.length} of ${data.review_count}.</p>`
        : "");

    /* The customer's own review at any status, with the moderator's reason when rejected. */
    if(data.mine && data.mine.status !== "published"){
      const held = data.mine.status === "pending";
      host.insertAdjacentHTML("beforeend", `
        <div class="rev-mine rev-mine-${data.mine.status}">
          <b>Your review is ${held ? "waiting to be checked" : "not published"}.</b>
          ${held
            ? "Someone will look at it shortly. Ratings are never held for being low — only the wording is checked."
            : (data.mine.reason ? esc(data.mine.reason) : "Contact us if you would like to know more.")}
        </div>`);
    }
  }catch(err){
    /* Report a reviews failure without breaking the product modal. */
    host.innerHTML = `<h4 class="pd-rev-title">Reviews</h4>
      <p class="pd-rev-empty">Reviews could not be loaded just now.</p>`;
    console.warn("[reviews]", err);
  }
}

/* ===== PRODUCT DETAIL modal ===== */
function pdWeight(g){ return g >= 1000 ? `${+(g/1000).toFixed(2)} kg` : `${g} g`; }

/* Nutrition facts label from Product Maintenance values, skipping empty rows. */
function nutritionPanel(n){
  if(!n) return "";
  const rows = [
    ["calories","Calories","kcal",true], ["fat","Total Fat","g"], ["sat_fat","Saturated Fat","g",false,true],
    ["cholesterol","Cholesterol","mg"], ["sodium","Sodium","mg"], ["carbs","Total Carbohydrates","g"],
    ["sugar","Sugars","g",false,true], ["protein","Protein","g"],
  ].filter(([k]) => n[k] != null)
   .map(([k,label,unit,big,sub]) => `<div class="nf-row${big?" nf-big":""}${sub?" nf-sub":""}"><span>${label}</span><b>${+n[k]} ${unit}</b></div>`)
   .join("");
  const serving = [n.serving_size ? `Serving size <b>${esc(n.serving_size)}</b>` : "",
                   n.servings != null ? `Servings per pack <b>${+n.servings}</b>` : ""].filter(Boolean).join(" · ");
  if(!rows && !serving) return "";
  return `<div class="pd-nutri nf" id="pd-nf" aria-hidden="true">
    <div class="nf-head">Nutrition Facts
      <button type="button" class="nf-back" data-nf-toggle aria-label="Back to photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>
    ${serving ? `<div class="nf-serving">${serving}</div>` : ""}
    ${rows ? `<div class="nf-per">Amount per serving</div>${rows}` : ""}
  </div>`;
}

function openProductDetail(id){
  const p = getProduct(id);
  const s = stockInfo(p);
  const out = !productAvailable(p);
  const nfHtml = nutritionPanel(p.nutrition);
  const body = `
    <div class="pd-grid">
      <!-- The nutrition label opens OVER the photo, in the same square, so the
           pop-up keeps its size instead of growing a tall label column. -->
      <div class="pd-media">${jarSVG(p.tint, p.name, 'jar', imageUrl(p), photoSrcset(p), "(max-width: 640px) 100vw, 560px")} ${p.best?`<span class="ribbon">${icon("star")} Best Seller</span>`:""}${nfHtml}</div>
      <div class="pd-info">
        <span class="pc-cat">${esc(p.cat)}</span>
        <div class="pc-meta" style="margin:8px 0">${starRating(p.rating, p.reviewCount)} <span>· ${p.sold.toLocaleString()} sold</span></div>
        ${p.desc ? `<p class="pd-desc">${esc(p.desc)}</p>` : ""}
        ${p.weightG || nfHtml ? `<div class="pd-weight">
          ${p.weightG ? `<span>Net weight <b>${pdWeight(p.weightG)}</b></span>` : ""}
          ${nfHtml ? `<button type="button" class="pd-nf-btn" data-nf-toggle aria-controls="pd-nf" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v4M14 3v4"/><rect x="5" y="7" width="14" height="14" rx="2"/><path d="M9 12h6M9 16h4"/></svg>
            <span data-nf-label>Nutrition facts</span></button>` : ""}
        </div>` : ""}
        <span class="stock-pill ${s.cls}">${s.label}</span>
        <div class="pd-price">${peso(p.price)}</div>
        <div class="pd-actions">
          ${out?"":`<div class="stepper" data-stepper>
            <button type="button" data-step="-1" aria-label="Decrease quantity">${ICONS.minus}</button>
            <input type="number" value="1" min="1" max="${addMax(p)}" ${qtyCapAttrs(p)} />
            <button type="button" data-step="1" aria-label="Increase quantity">${ICONS.plus}</button>
          </div>`}
          <button class="btn btn-primary" data-add-detail="${escAttr(p.id)}" ${out?"disabled":""}>${out?"Sold Out":icon("cart")+" Add to Cart"}</button>
        </div>
        ${out ? "" : qtyCapHint(p)}
      </div>
    </div>
    <!-- Filled by loadProductReviews() after the modal opens. Rendered as a
         placeholder rather than left out entirely so the section has a stable
         position: injecting a whole block later would shift the buttons under
         somebody's cursor mid-click. -->
    <section class="pd-reviews" id="pd-reviews" aria-live="polite">
      <h4 class="pd-rev-title">Reviews</h4>
      <p class="pd-rev-empty">Loading reviews…</p>
    </section>`;
  openModal(p.name, body, {wide:true, onOpen:(root)=>{
    root.querySelector("[data-add-detail]")?.addEventListener("click", e=>{
      const qty = parseInt(root.querySelector(".stepper input")?.value || "1", 10);
      /* Signed out, addToCart() swaps this popup to Sign In, so leave it open instead of jumping to the cart. */
      if(!state.auth.loggedIn){ addToCart(e.currentTarget.dataset.addDetail, qty); return; }
      addToCart(e.currentTarget.dataset.addDetail, qty);
      closeModal(); openCart();
    });
    /* Nutrition facts: flips the photo square to the label and back. */
    const media = root.querySelector(".pd-media"), nfBtn = root.querySelector(".pd-nf-btn");
    root.querySelectorAll("[data-nf-toggle]").forEach(b => b.addEventListener("click", () => {
      const on = media.classList.toggle("show-nf");
      root.querySelector("#pd-nf")?.setAttribute("aria-hidden", String(!on));
      if(nfBtn){
        nfBtn.setAttribute("aria-expanded", String(on));
        nfBtn.classList.toggle("is-on", on);
        nfBtn.querySelector("[data-nf-label]").textContent = on ? "Show photo" : "Nutrition facts";
      }
    }));
    /* Load reviews without blocking the modal. */
    loadProductReviews(p.id, root);
  }});
}

/* ===== CHECKOUT (Delivery/Pickup, Cash/GCash/Bank) ===== */
/* Edit switch for a checkout section (signed-in only). */
function coEditSwitch(key){
  if(!state.auth.loggedIn) return "";
  return `<label class="co-edit" title="Turn on to change these details">
    <input type="checkbox" role="switch" data-lock="${key}">
    <span class="co-edit-track" aria-hidden="true"></span>
    <span class="co-edit-text">Edit</span>
  </label>`;
}

function openCheckout(){
  if(!state.cart.length) return;
  closeCart();
  const sub = cartSubtotal();

  /* Credit term tiles show for retailers only (presentation; api/shop/checkout.php re-checks). */
  const isRetailer = state.auth.status === "retailer";
  /* Summary line shows name, qty x unit price, and amount. */
  const itemsHTML = state.cart.map(i=>{
    const p=getProduct(i.id);
    return `<div class="li">
      <span class="li-name">${esc(p.name)}</span>
      <span class="li-qty">${i.qty} × ${peso(p.price)}</span>
      <span class="li-amt">${peso(p.price*i.qty)}</span>
    </div>`;
  }).join("");

  const body = `
    <form id="checkout-form" novalidate>
      <!-- Order summary -->
      <div class="co-section">
        <div class="co-title">Order Summary</div>
        <div class="co-summary">
          ${itemsHTML}
          <!-- VAT breakdown from shop/quote.php (same Tax::compute() as the
               checkout). Prices already include VAT, so it explains the
               total rather than adding to it. -->
          <div class="co-vat" id="co-vat" hidden></div>
          <!-- Delivery only: our own estimate (api/core/Shipping.php), not an
               LBC quotation. Subtotal + Estimated Delivery Fee = Grand Total. -->
          <div class="co-ship" id="co-ship" hidden></div>
          <div class="li tot"><span class="li-name" id="co-tot-label">Total</span><span class="li-amt" id="co-tot-amt">${peso(sub)}</span></div>
          <!-- Filled only for a retailer registered as a withholding agent — see
               the quote in onOpen below. Empty and hidden for everyone else. -->
          <div class="co-tax-note" id="co-tax-note" hidden></div>
        </div>
      </div>

      <!-- Order type -->
      <div class="co-section">
        <div class="co-title">Order Type</div>
        <div class="toggle-group" id="order-type">
          <button type="button" class="tg active" data-type="delivery">Delivery <small>via LBC courier</small></button>
          <button type="button" class="tg" data-type="pickup">Pickup <small>Dagupan City</small></button>
        </div>
        <!-- The delivery address: the shared picker (address-picker.js), not a
             free-text box. Region → Province → City → Barangay, then the street
             and ZIP typed. Hidden for pickup, which stores no address at all. -->
        <div class="co-address" id="address-field">
          <div class="co-subtitle co-lock-head" id="co-address-title">Delivery Address ${coEditSwitch("addr")}</div>
          <div class="co-lock-body" data-lock-body="addr">
            ${EbAddress.markup("co", { variant: "field", required: true })}
          </div>
        </div>
      </div>

      <!-- Contact -->
      <div class="co-section">
        <div class="co-title">Your Details</div>
        ${coEditSwitch("details")}
        <div class="co-lock-body" data-lock-body="details">
          <div class="field"><label for="co-name">Full Name *</label><input class="control" id="co-name" type="text" autocomplete="name" placeholder="Juan dela Cruz" value="${escAttr(state.auth.loggedIn?state.auth.name:"")}"><span class="field-error" data-err></span></div>
          <div class="field"><label for="co-contact">Contact Number *</label><input class="control" id="co-contact" type="tel" autocomplete="tel" placeholder="09xx xxx xxxx"><span class="field-error" data-err></span></div>
        </div>
        <!-- The five inline style properties that used to be on this label are
             in .co-save now, and the checkbox is drawn rather than left as the
             browser default — it was the one control on this form with no
             relationship to the rest of the site. -->
        <label class="co-save hide" id="co-save-profile-wrap">
          <input type="checkbox" id="co-save-profile">
          <span class="co-save-box" aria-hidden="true">${ICONS.check}</span>
          <span class="co-save-text">Save this contact number and address to my profile</span>
        </label>
      </div>

      <!-- Payment -->
      <div class="co-section">
        <div class="co-title">Payment Method</div>
        <!-- Three choices, shown as three choices. This was a native <select>,
             which meant the two options that change what the form ASKS FOR —
             GCash and Bank Transfer both reveal a reference number and a
             screenshot field — were hidden behind a dropdown that had to be
             opened to discover them. The Order Type toggle directly above it
             was already doing the same job in the pattern this now uses, so
             the form was answering one question two different ways.
             The values are unchanged: the payment variable still reads
             "Cash" / "GCash" / "Bank Transfer" and still drives both the proof
             block and the pay_method sent to the server. -->
        <div class="toggle-group co-pay" id="co-payment" role="group" aria-label="Payment method">
          <button type="button" class="tg active" data-pay="cash">Cash <small>Pay when you collect</small></button>
          <button type="button" class="tg" data-pay="gcash">GCash <small>Screenshot required</small></button>
          <button type="button" class="tg" data-pay="bank">Bank Transfer <small>Screenshot required</small></button>
          ${isRetailer ? CREDIT_METHODS.map(m => `
          <button type="button" class="tg tg-credit" data-pay="${m.key}">${m.label} <small>${m.hint}</small></button>`).join("") : ""}
        </div>
        <div id="proof-block" class="hide">
          <!-- Filled by payQrHtml() for the method picked: the account to send to
               and its QR code, from Landing Page Maintenance. -->
          <div id="co-pay-qr"></div>
          <div class="field" id="co-ref-field"><label><span data-ref-label>Reference Number</span> *</label><input class="control" id="co-ref" type="text" maxlength="30" autocomplete="off"><span class="field-error" data-err></span></div>
          <div class="field" id="co-proof-field">
            <label for="co-proof">Payment Screenshot *</label>
            <!-- A REAL file input. What used to be here was a div with
                 role=button whose click handler flipped a boolean and printed
                 the hardcoded string "payment-proof.jpg attached (mock)". No
                 file picker ever opened, no file was ever read, and no column
                 existed to store one. That is defect 3.4.

                 The input itself is now visually hidden and driven by the
                 label below it. A file input carrying the generic .control
                 class put Chrome's grey "Choose File" chrome inside a styled
                 text field — two controls fighting, neither of them ours. It
                 stays a real input in the DOM (not replaced by a click
                 handler): the label's for-attribute opens the picker, it
                 remains keyboard-reachable, and .up-input:focus-visible draws
                 the ring on the zone.

                 NOTE: this whole block is a template literal. No backticks. -->
            <input class="up-input" id="co-proof" type="file" accept="image/png,image/jpeg,image/webp">
            <label class="up-drop" for="co-proof" id="co-proof-drop">
              <span class="up-ic" aria-hidden="true">${ICONS.camera || ICONS.search}</span>
              <span class="up-cta">Choose an image</span>
              <span class="up-hint">PNG, JPEG or WebP · up to ${UPLOAD_MAX_MB}MB · or drop it here</span>
            </label>
            <div class="up-card hide" id="co-proof-card">
              <img class="up-thumb" id="co-proof-preview" alt="Payment screenshot preview">
              <div class="up-meta">
                <b id="co-proof-name"></b>
                <span id="co-proof-size"></span>
              </div>
              <div class="up-acts">
                <button type="button" class="up-btn" data-proof-replace>Replace</button>
                <button type="button" class="up-btn up-btn-danger" data-proof-remove>Remove</button>
              </div>
            </div>
            <span class="field-error" data-err></span>
          </div>
          <div class="note-mock">Your screenshot is sent to our staff for verification. We do not process card payments on this site.</div>
        </div>
      </div>

      <!-- Notes -->
      <div class="co-section">
        <div class="co-title">Order Notes (optional)</div>
        <div class="field"><textarea class="control" id="co-notes" rows="2" placeholder="Any special instructions?"></textarea></div>
      </div>

      <!-- Pinned, not appended. The button used to sit at the natural end of a
           form six sections long, so on a phone the shopper scrolled past the
           notes box to reach it and lost sight of the total on the way. Sticky
           to the bottom of the scrolling modal, with the figure they are
           agreeing to beside it. -->
      <div class="co-footer">
        <div class="co-foot-total"><span>Total</span><b id="co-foot-amt">${peso(sub)}</b></div>
        <button type="submit" class="btn btn-primary co-submit">Place Order</button>
      </div>
    </form>`;

  openModal("Checkout", body, {wide:true, onOpen:(root)=>{
    /* `payment` now holds the API key, not a display string. */
    let orderType = "delivery", payment = "cash";

    /* Withholding retailers are told the amount to actually transfer, from shop/quote.php. */
    /* Re-quote when order type or delivery address changes; the newest answer wins. */
    let quoteSeq = 0, quoteTimer = null;
    const refreshQuote = () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(runQuote, 250); };
    function runQuote(){
      const seq = ++quoteSeq;
      const body = { items: state.cart.map(i => ({ id: i.id, qty: i.qty })), order_type: orderType, pay_method: payment };
      if (orderType === "delivery" && typeof addr !== "undefined") body.address = addr.value();
      EbApi.post("shop/quote.php", body)
        .then(({ data }) => {
          if (seq !== quoteSeq) return;
          const t = data.tax, note = root.querySelector("#co-tax-note");
          const money = EbFormat.pesoExact;
          const vat = root.querySelector("#co-vat");
          if (vat) {
            const row = (k, v) => `<div class="li co-vat-row"><span class="li-name">${k}</span><span class="li-amt">${money(v)}</span></div>`;
            vat.innerHTML = row("VATable Sales", t.vatableSales)
              + row(`VAT (${+t.vatRate || 12}%)`, t.vatAmount)
              + (t.vatExemptSales > 0 ? row("VAT-Exempt Sales", t.vatExemptSales) : "")
              + `<div class="co-vat-note">Prices already include VAT.</div>`;
            vat.hidden = false;
          }
          /* Shipping block: destination, distance, weight, zone, fee. */
          const ship = root.querySelector("#co-ship"), q = t.shipping;
          const goods = +(t.total - (t.shippingFee || 0)).toFixed(2);
          if (ship) {
            if (orderType === "delivery" && q) {
              const kv = (k, v) => `<div class="co-ship-row"><span>${k}</span><b>${v}</b></div>`;
              ship.innerHTML = `<div class="li co-sub-row"><span class="li-name">Subtotal</span><span class="li-amt">${money(goods)}</span></div>
                <div class="co-ship-box">
                  <div class="co-ship-head">Delivery estimate <small>from ${esc(q.origin || "Dagupan City")}</small></div>
                  ${kv("Delivery Destination", q.destination ? esc(q.destination) : "Choose your address below")}
                  ${q.distanceKm != null ? kv("Estimated Distance", `${Math.round(q.distanceKm).toLocaleString()} km`) : ""}
                  ${kv("Total Product Weight", `${(+q.weightKg).toFixed(2)} kg`)}
                  ${q.remote ? kv("Island / remote area fee", `+ ${money(q.remoteFee)}`) : ""}
                  <div class="co-ship-fee"><span>Estimated Delivery Fee</span><b>${q.destination ? money(q.fee) : "—"}</b></div>
                  ${q.destination && q.eta ? `<div class="co-ship-eta"><span>Estimated Arrival</span><b>${esc(EbFormat.etaRange(q.eta.from, q.eta.to))}</b></div>` : ""}
                  ${q.paused ? `<div class="co-ship-alert is-paused"><strong>Deliveries to ${esc(q.destination)} are paused right now.</strong>${q.remote && q.remote.note ? ` ${esc(q.remote.note)}` : ""} You can't place a delivery there until they resume.</div>`
                    : q.remote ? `<div class="co-ship-alert">Island / remote area — delivery depends on boat and flight schedules and the weather, so it may take longer than estimated.${q.remote.note ? ` ${esc(q.remote.note)}` : ""}</div>`
                    : q.destination && q.eta ? `<div class="co-ship-note">Estimate only, counted Monday to Saturday${q.eta.holidays && q.eta.holidays.length ? ` and skipping ${esc(q.eta.holidays.join(", "))}` : " (no deliveries on holidays)"}, including ${q.eta.packDays} day${q.eta.packDays === 1 ? "" : "s"} to pack your order.</div>` : ""}
                </div>`;
              ship.hidden = false;
            } else {
              ship.innerHTML = ""; ship.hidden = true;
            }
          }
          /* Always "Total" — the label stays put whether or not a fee is added. */
          const amt = root.querySelector("#co-tot-amt"); if (amt) amt.textContent = money(t.total);
          const foot = root.querySelector("#co-foot-amt"); if (foot) foot.textContent = money(t.total);

          if (!note) return;
          /* Buying on Net terms: the term's interest is added to what the retailer pays. */
          const interest = t.termInterest > 0
            ? `<div class="li"><span class="li-name">Add: ${esc(t.termScheme || "Net terms")} interest (${+t.termInterestRate}%)</span>`
              + `<span class="li-qty"></span><span class="li-amt">+ ${money(t.termInterest)}</span></div>` : "";
          if (!(t.withholdingTax > 0) && interest) {
            note.innerHTML = interest
              + `<div class="li tot"><span class="li-name">Amount to pay</span><span class="li-qty"></span>`
              + `<span class="li-amt">${money(t.amountDue)}</span></div>`;
            note.hidden = false;
            return;
          }
          if (!(t.withholdingTax > 0)) {
            /* Retailer discount missed only because the order is under the minimum item count. */
            const sf = t.discountShortfall;
            if (sf) {
              note.innerHTML = `<div class="li"><span class="li-name">Add ${sf.short} more item${sf.short === 1 ? "" : "s"} to get your ${+sf.rate}% retailer discount</span>`
                + `<span class="li-qty">minimum ${sf.minQty} items</span><span class="li-amt"></span></div>`;
              note.hidden = false;
            } else note.hidden = true;
            return;
          }
          note.innerHTML = `<div class="li"><span class="li-name">Less: retailer discount (${+t.withholdingRate}%)</span>`
            + `<span class="li-qty"></span><span class="li-amt">− ${money(t.withholdingTax)}</span></div>`
            + interest
            + `<div class="li tot"><span class="li-name">Amount to pay</span><span class="li-qty"></span>`
            + `<span class="li-amt">${money(t.amountDue)}</span></div>`;
          note.hidden = false;
        })
        .catch(() => { /* The checkout computes it anyway; the summary is a courtesy. */ });
    }
    const addrField = root.querySelector("#address-field");
    /* The address picker controller for the checkout. */
    const addr = EbAddress.mount(root, "co");
    /* Address picked or changed: re-estimate the delivery fee. */
    addrField?.addEventListener("change", refreshQuote);
    runQuote();

    /* Prefill from the saved profile: identity from the session, only empty fields filled, everything stays editable, and nothing is written back unless the save box is ticked; failures are logged and the form is left untouched. */
    const prefilled = { contact: false, address: false };

    /* Signed in: address and details open locked on the saved profile, unlocked by the Edit switch; the save box shows only while something is unlocked. */
    const setLock = (key, locked) => {
      const body = root.querySelector(`[data-lock-body="${key}"]`);
      const sw = root.querySelector(`[data-lock="${key}"]`);
      if (!body || !sw) return;
      body.inert = locked;
      body.classList.toggle("co-locked", locked);
      sw.checked = !locked;
      const anyOpen = [...root.querySelectorAll("[data-lock]")].some(s => s.checked);
      root.querySelector("#co-save-profile-wrap")?.classList.toggle("hide", !anyOpen);
      if (!anyOpen) { const cb = root.querySelector("#co-save-profile"); if (cb) cb.checked = false; }
    };
    root.querySelectorAll("[data-lock]").forEach(sw =>
      sw.addEventListener("change", () => setLock(sw.dataset.lock, !sw.checked)));
    const unlockAll = () => { setLock("addr", false); setLock("details", false); };

    if (state.auth.loggedIn) {
      setLock("addr", true);
      setLock("details", true);
      (async () => {
        let profile;
        try {
          const { data } = await EbApi.get("shop/profile.php");
          profile = data;
        } catch (err) {
          console.warn("[checkout] could not load profile for prefill:", err.message);
          unlockAll();   /* nothing saved to show — let them type */
          return;
        }
        /* The modal may already be closed by the time this resolves. */
        if (!root.isConnected) return;

        const fillIfEmpty = (sel, value) => {
          const el = root.querySelector(sel);
          if (!el || !value) return false;
          if (el.value.trim() !== "") return false;   /* never clobber typing */
          el.value = value;
          el.classList.add("is-prefilled");
          /* Remove the prefill marker once the customer edits the field. */
          el.addEventListener("input", () => el.classList.remove("is-prefilled"), { once: true });
          return true;
        };

        prefilled.contact = fillIfEmpty("#co-contact", profile.contact);
        /* The address uses the picker's own prefill, which follows the same rules. */
        prefilled.address = await addr.prefill(profile.address);
        refreshQuote();
        if (!root.querySelector("#co-name").value.trim() && profile.name) {
          root.querySelector("#co-name").value = profile.name;
        }

        /* Open any section whose saved data is incomplete. */
        if (!addr.validate(true)) { addr.clearErrors(); setLock("addr", false); }
        const n = root.querySelector("#co-name").value.trim();
        const c = root.querySelector("#co-contact").value.trim();
        if (!n || !/^[0-9 +\-]{7,}$/.test(c)) setLock("details", false);
      })();
    }

    // order type toggle (delivery shows address, pickup hides)
    root.querySelectorAll("#order-type .tg").forEach(b=>{
      b.addEventListener("click", ()=>{
        root.querySelectorAll("#order-type .tg").forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        orderType = b.dataset.type;
        addrField.classList.toggle("hide", orderType==="pickup");
        syncPayForOrderType();
        refreshQuote();
      });
    });

    /* Cash is pickup-only, so it is disabled with a "Pickup only" hint for delivery; this also runs once at start because the form opens on Delivery with Cash. */
    function syncPayForOrderType(){
      const cashBtn = root.querySelector('#co-payment .tg[data-pay="cash"]');
      if(!cashBtn) return;
      const blocked = orderType === "delivery";
      cashBtn.disabled = blocked;
      cashBtn.classList.toggle("tg-unavailable", blocked);
      cashBtn.title = blocked ? "Cash is available on pickup only." : "";
      const hint = cashBtn.querySelector("small");
      if(hint) hint.textContent = blocked ? "Pickup only" : "Pay when you collect";
      /* Move off a disabled method with a real click so dependent UI updates. */
      if(blocked && payment === "cash"){
        root.querySelector('#co-payment .tg[data-pay="gcash"]')?.click();
      }
    }

    // payment method reveals proof fields for GCash/Bank
    const proof = root.querySelector("#proof-block");
    /* One reference field per method (EbUI.splitRefField): GCash 13 digits, bank 6–20 letters or numbers. */
    const coRef = EbUI.splitRefField(root.querySelector("#co-ref"), () => payment,
      root.querySelector("#co-ref-field label"));
    root.querySelectorAll("#co-payment .tg").forEach(b=>{
      b.addEventListener("click", ()=>{
        root.querySelectorAll("#co-payment .tg").forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        payment = b.dataset.pay;
        /* GCash and bank each have their own reference field and rules. */
        coRef?.refresh();
        /* A Net term adds interest to the breakdown, so re-quote. */
        refreshQuote();
        /* Hide the proof upload for cash and credit terms. */
        proof.classList.toggle("hide", payment === "cash" || isCreditMethod(payment));
        const qrBox = root.querySelector("#co-pay-qr");
        if(qrBox) qrBox.innerHTML = (payment === "gcash" || payment === "bank") ? payQrHtml(payment) : "";
      });
    });

    /* Run once now, since the default Delivery + Cash would be rejected. */
    syncPayForOrderType();

    /* Upload the screenshot as soon as it is chosen; the order carries the returned path (proofPath). */
    let proofPath = null;
    const proofField = root.querySelector("#co-proof-field");
    const proofErr   = proofField.querySelector("[data-err]");
    const proofInput = root.querySelector("#co-proof");
    const proofDrop  = root.querySelector("#co-proof-drop");
    const proofCard  = root.querySelector("#co-proof-card");
    const proofPrev  = root.querySelector("#co-proof-preview");
    const proofName  = root.querySelector("#co-proof-name");
    const proofSize  = root.querySelector("#co-proof-size");

    /* Show upload errors in the field's own [data-err] span. */
    const proofFail  = msg => { proofErr.textContent = msg; proofField.classList.add("has-error"); };
    const proofClear = ()  => { proofErr.textContent = ""; proofField.classList.remove("has-error"); };

    /* Delete a removed or replaced screenshot via api/uploads/discard.php (fire and forget). */
    const discardProof = path => {
      if(!path) return;
      EbApi.post("uploads/discard.php", { path })
        .catch(err => console.warn("[checkout] could not discard", path, err.message));
    };

    const showDropzone = () => {
      proofCard.classList.add("hide");
      proofDrop.classList.remove("hide");
      proofPrev.removeAttribute("src");
      proofName.textContent = "";
      proofSize.textContent = "";
    };

    const showAttached = (fileName, bytes, src) => {
      proofPrev.src = src;
      proofName.textContent = fileName;
      proofSize.textContent = bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(bytes / 1024))} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      proofDrop.classList.add("hide");
      proofCard.classList.remove("hide");
    };

    /* Check type and size before uploading to save time (the server re-checks). */
    const acceptProof = async file => {
      proofClear();
      if(!file) return;

      if(!UPLOAD_ACCEPT[file.type]){
        proofFail("Upload a JPEG, PNG or WebP image.");
        proofInput.value = "";
        return;
      }
      if(file.size > UPLOAD_MAX_MB * 1024 * 1024){
        proofFail(`That image is too large. Keep it under ${UPLOAD_MAX_MB}MB.`);
        proofInput.value = "";
        return;
      }

      /* Discard the old file only after the new one uploads. */
      const previous = proofPath;
      proofPath = null;

      showDropzone();
      proofDrop.classList.add("is-busy");
      try {
        const data = await EbApi.upload(file, "references");
        proofPath = data.path;
        showAttached(file.name, data.bytes, imageUrl(data.path));
        discardProof(previous);
      } catch(err){
        /* Say plainly when the upload fails and leave proofPath empty so submit stops. */
        proofFail((err.fields && err.fields.file) || err.message);
        proofInput.value = "";
        showDropzone();
      } finally {
        proofDrop.classList.remove("is-busy");
      }
    };

    proofInput.addEventListener("change", () => acceptProof(proofInput.files[0]));

    /* Clear a field's error as soon as it is edited. */
    root.querySelectorAll(".field .control").forEach(el=>{
      el.addEventListener("input", ()=>{
        const f = el.closest(".field");
        if(!f.classList.contains("has-error")) return;
        f.classList.remove("has-error");
        f.querySelector("[data-err]").textContent = "";
      });
    });

    /* Drag-and-drop is extra; click and Enter still open the picker. */
    ["dragenter", "dragover"].forEach(ev =>
      proofDrop.addEventListener(ev, e => {
        e.preventDefault();
        proofDrop.classList.add("is-over");
      }));
    ["dragleave", "dragend"].forEach(ev =>
      proofDrop.addEventListener(ev, () => proofDrop.classList.remove("is-over")));
    proofDrop.addEventListener("drop", e => {
      e.preventDefault();
      proofDrop.classList.remove("is-over");
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if(file) acceptProof(file);
    });
    /* Stop a stray drop from navigating away from the checkout. */
    ["dragover", "drop"].forEach(ev =>
      root.addEventListener(ev, e => { if(!proofDrop.contains(e.target)) e.preventDefault(); }));

    proofCard.querySelector("[data-proof-replace]").addEventListener("click", () => proofInput.click());

    proofCard.querySelector("[data-proof-remove]").addEventListener("click", () => {
      const discarded = proofPath;
      proofPath = null;
      /* Clear the input so choosing the same file again still fires change. */
      proofInput.value = "";
      showDropzone();
      proofClear();
      discardProof(discarded);
    });

    /* Allow only one submit at a time. */
    let submitting = false;

    // place order
    root.querySelector("#checkout-form").addEventListener("submit", e=>{
      e.preventDefault();
      if(submitting) return;
      let ok = true;
      /* Mark the input itself with .has-error. */
      const fail = (sel,msg)=>{
        const f=root.querySelector(sel).closest(".field");
        f.querySelector("[data-err]").textContent=msg;
        f.classList.add("has-error");
        ok=false;
      };
      root.querySelectorAll("[data-err]").forEach(x=>x.textContent="");
      root.querySelectorAll(".field.has-error").forEach(f=>f.classList.remove("has-error"));

      const name = root.querySelector("#co-name").value.trim();
      const contact = root.querySelector("#co-contact").value.trim();
      if(!name) fail("#co-name","Please enter your name.");
      if(!/^[0-9 +\-]{7,}$/.test(contact)) fail("#co-contact","Enter a valid contact number.");
      /* Client-side address check matching Address::check (the server decides). */
      if(orderType==="delivery" && !addr.validate(true)) ok = false;
      /* Reference number and screenshot are required only for GCash and bank. */
      if(payment === "gcash" || payment === "bank"){
        const refVal = root.querySelector("#co-ref").value.trim();
        if(!refVal) fail("#co-ref","Reference number required for "+payLabel(payment)+".");
        else if(refFormatError(payment, refVal)) fail("#co-ref", refFormatError(payment, refVal));
        if(!proofPath){ fail("#co-proof","Attach a screenshot of your payment."); }
      }
      if(!ok){ unlockAll(); focusFirstError(root); return; }   /* an error they can't reach is no help */

      /* Place the order through api/shop/checkout.php, which writes everything in one transaction and returns the receipt figures. */
      submitting = true;
      const submitBtn = root.querySelector("#checkout-form [type=submit]");
      const restore = submitBtn ? (btn => { const l = btn.textContent, d = btn.disabled;
        btn.disabled = true; btn.classList.add("is-busy"); btn.textContent = "Placing order…";
        return () => { submitting = false; btn.disabled = d; btn.classList.remove("is-busy"); btn.textContent = l; }; })(submitBtn)
        : () => { submitting = false; };

      (async () => {
        let order;
        try {
          const { data } = await EbApi.post("shop/checkout.php", {
            items: state.cart.map(i => ({ id: i.id, qty: i.qty })),
            name, contact,
            /* No email is sent; the server uses the session's account. */
            /* Send address codes (not names), and nothing for pickup. */
            address: orderType === "delivery" ? addr.value() : null,
            notes: root.querySelector("#co-notes").value.trim(),
            order_type: orderType === "delivery" ? "delivery" : "pickup",
            /* Send the payment key as is (see PAY_METHODS_UI). */
            pay_method: payment,
            ref_num: root.querySelector("#co-ref")?.value.trim() || null,
            /* Send the uploaded proof's path. */
            proof_image: proofPath,
          });
          order = data;
        } catch (err) {
          /* Show server refusals on the form and keep the cart. */
          if (err.isValidation) {
            /* addr_* errors go to the picker; others go through the form's mapping. */
            addr.showErrors(err.fields);
            Object.entries(err.fields).filter(([f]) => !f.startsWith("addr_")).forEach(([f, msg]) => {
              /* Server field names whose input id differs. */
              const alias = { ref_num: "ref", proof_image: "proof" }[f];
              const el = (alias && root.querySelector(`#co-${alias}`))
                || root.querySelector(`#co-${f.replace("_","-")}`) || root.querySelector(`#co-${f}`);
              const box = el && el.closest(".field")?.querySelector("[data-err]");
              if (box) { box.textContent = msg; el.closest(".field").classList.add("has-error"); }
              else showToast(msg, "info");   /* never fail silently */
            });
            if (!Object.keys(err.fields).length) showToast(err.message, "info");
            else focusFirstError(root);
          } else {
            showToast(err.message, "info");
          }
          return;
        } finally { restore(); }

        /* Only clear the cart once the server has the order. */
        state.cart = [];
        updateCartBadge();

        /* Save to the profile only if asked, and only after the order succeeds. */
        if (root.querySelector("#co-save-profile")?.checked) {
          try {
            /* Save the address only when there is one (pickup has none). */
            await EbApi.post("shop/profile.php", orderType === "delivery"
              ? { contact: contact, address: addr.value() }
              : { contact: contact });
            showToast("Saved to your profile.", "success");
          } catch (err) {
            showToast("Order placed, but your profile could not be updated: " + err.message, "info");
          }
        }

        showReceipt({
          id: order.id,
          name: order.name, contact: order.contact,
          orderType: order.orderType, payment: payLabel(payment),
          /* Include the raw payment key so the invoice ticks Cash or Charge Sales. */
          payMethod: payment,
          /* Null unless the buyer is a retailer — see Orders::buyerTinSql(). */
          tin: order.tin || null,
          /* The stored VAT breakdown — the invoice prints it as the server decided it. */
          tax: order.tax || null,
          /* Credit details (scheme and database due date) come from the response, or null. */
          credit: order.credit || null,
          address: order.address, notes: root.querySelector("#co-notes").value.trim(),
          items: order.items.map(i => ({ ...getProduct(i.id), name: i.name, price: i.price, qty: i.qty })),
          total: order.total,
          placedAt: order.placedAt,
          statusMessage: order.message,
        });
      })();
    });
  }});
}

/* ===== RECEIPT (soft copy) ===== */
function showReceipt(order){
  /* Use the server's order number. */
  const id = order.id || txId();

  /* The same Sales Invoice the cashier prints (core/invoice.js). */
  const invoice = EbInvoice.fromOrder({
    id, type: "online", tin: order.tin, tax: order.tax, name: order.name, address: order.address, items: order.items,
    total: order.total, payMethod: order.payMethod,
    /* Pass a Date (not toISOString()) so early-morning orders show the right date. */
    placedAt: order.placedAt || new Date(),
  });
  EbInvoice.ensureStyles();

  const body = `
    <div class="receipt">
      <div class="check">${ICONS.check}</div>
      <h3 style="font-size:1.9rem">Order Placed!</h3>
      <p style="color:var(--text-muted)">Thank you, ${esc(order.name)}. Your sales invoice is below.</p>
      <div class="receipt-invoice">${EbInvoice.render(invoice)}</div>
      ${order.credit ? `
      <!-- A credit order commits the retailer to a date. Saying so is the
           difference between terms they agreed to and terms they find out
           about when the account goes overdue. The paper invoice has no place
           for it, so it sits outside the invoice rather than inside it. -->
      <div class="receipt-box">
        <div class="rb-credit">
          <div class="rb-row"><span>Payment terms</span><span><b>${esc(order.credit.scheme)}</b></span></div>
          <div class="rb-row"><span>Balance due</span><span><b>${peso(order.credit.balance)}</b></span></div>
          <div class="rb-row"><span>Due date</span><span><b>${EbFormat.fmtDate(order.credit.dueDate)}</b></span></div>
          <p class="rb-credit-note">This balance is now on your account. Track it under <a href="${escAttr(EbFormat.APP_BASE)}public/profile/my-payments.html">Payment Schemes</a>.</p>
        </div>
      </div>` : ""}
      <div class="receipt-actions">
        <button class="btn btn-ghost" id="receipt-print" type="button">Print invoice</button>
        <button class="btn btn-primary" id="receipt-done" type="button">Done</button>
      </div>
    </div>`;
  /* Clear the local cart copy; the server already emptied it with the order. */
  state.cart = [];
  updateCartBadge(); renderCart();
  openModal("Sales Invoice", body, {wide:true, onOpen:(root)=>{
    root.querySelector("#receipt-done").addEventListener("click", closeModal);
    root.querySelector("#receipt-print").addEventListener("click", ()=> EbInvoice.print(invoice));
  }});
  showToast("Order placed successfully!", "success");
}

/* ===== AUTH (login / register) ===== */
function pwToggle(){
  return `<button type="button" class="toggle-eye" data-eye aria-label="Show password">${ICONS.eye}</button>`;
}
/* Password rules for new passwords, mirroring Auth::passwordProblem() in api/core/Auth.php. */
const PW_RULES = [
  { id: "len",   label: "At least 8 characters",            test: v => v.length >= 8 },
  { id: "upper", label: "One uppercase letter (A–Z)",       test: v => /[A-Z]/.test(v) },
  { id: "lower", label: "One lowercase letter (a–z)",       test: v => /[a-z]/.test(v) },
  { id: "num",   label: "One number (0–9)",                 test: v => /[0-9]/.test(v) },
  { id: "sym",   label: "One symbol (e.g. ! @ # $ %)",      test: v => /[^A-Za-z0-9]/.test(v) },
];
/* Put the rule checklist under a new-password input and tick items as they are met; returns a function giving the first unmet rule (or null). */
function mountPwChecklist(input){
  if(!input) return () => null;
  const anchor = input.closest('.auth-input-group, .pw-row, .pw-wrap') || input;
  const ul = document.createElement('ul');
  ul.className = 'pw-rules';
  ul.setAttribute('aria-live', 'polite');
  ul.innerHTML = PW_RULES.map(r => `<li data-rule="${r.id}"><span class="pw-rule-ic" aria-hidden="true"></span>${r.label}</li>`).join('');
  anchor.insertAdjacentElement('afterend', ul);
  const paint = () => PW_RULES.forEach(r => ul.querySelector(`[data-rule="${r.id}"]`).classList.toggle('is-met', r.test(input.value)));
  input.addEventListener('input', paint);
  paint();
  return () => PW_RULES.find(r => !r.test(input.value)) || null;
}
function strengthScore(v){
  let s=0; if(v.length>=8)s++; if(/[A-Z]/.test(v))s++; if(/[0-9]/.test(v))s++; if(/[^A-Za-z0-9]/.test(v))s++; return s;
}
function wireEyeToggles(root){
  root.querySelectorAll("[data-eye]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const inp = btn.parentElement.querySelector("input");
      const show = inp.type==="password";
      inp.type = show ? "text" : "password";
      btn.innerHTML = show ? ICONS.eyeoff : ICONS.eye;
    });
  });
}

const _lockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

const _authArrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';

function openAuth(tab='login', hint=null){
  const hintHTML = (hint && typeof hint === 'string') ? `<div class="auth-cart-hint">${hint}</div>` : '';
  const eyeBtn = `<button type="button" class="auth-eye-btn" data-eye aria-label="Toggle password"><span data-eye-face>${ICONS.eye}</span></button>`;
  /* The brand logo, same image as the page header (assets/img/logo.webp). */
  const fishSVG = `<img class="auth-logo-img" src="${EbFormat.imageUrl("/assets/img/logo.webp")}" alt="" width="495" height="386">`;

  const body = `
  <div class="auth-split">

    <!-- ── LEFT BRAND PANEL ── -->
    <div class="auth-brand" aria-hidden="true">
      <div class="auth-orb auth-orb-1"></div>
      <div class="auth-orb auth-orb-2"></div>
      <div class="auth-orb auth-orb-3"></div>
      <div class="auth-brand-inner">
        <div class="auth-logo-row">
          ${fishSVG}
          <div>
            <span class="auth-brand-name">Elisha Bay</span>
            <span class="auth-brand-sub">Juris Bay Foods</span>
          </div>
        </div>
        <h2 class="auth-headline">"Every Mouthful<br>is <em>Delightful</em>."</h2>
        <p class="auth-tagline">Premium gourmet bangus &amp; bottled tuyo, crafted from the finest catch of Dagupan City, Pangasinan.</p>
        <ul class="auth-trust-list">
          <li><span class="auth-trust-dot"></span>FDA Registered &amp; Certified</li>
          <li><span class="auth-trust-dot"></span>All-Natural Ingredients</li>
          <li><span class="auth-trust-dot"></span>Sealed Fresh in Glass</li>
        </ul>
      </div>
    </div>

    <!-- ── RIGHT FORM PANEL ── -->
    <div class="auth-form-panel">
      ${hintHTML}

      <div class="auth-tabs" role="tablist">
        <button class="auth-tab ${tab==='login'?'active':''}"    role="tab" data-atab="login"    aria-selected="${tab==='login'}">Sign In</button>
        <button class="auth-tab ${tab==='register'?'active':''}" role="tab" data-atab="register" aria-selected="${tab==='register'}">Create Account</button>
        <span class="auth-tab-slide" aria-hidden="true"></span>
      </div>

      <!-- Login -->
      <div class="auth-panel ${tab==='login'?'active':''}" id="ap-login" role="tabpanel">
        <div class="auth-panel-head">
          <h3>Welcome back!</h3>
          <p>Sign in to track orders and check out faster.</p>
        </div>
        <form id="login-form" novalidate>
          <!-- The lockout notice. Empty and hidden until a 429 arrives; see
               startLockCountdown(). role="alert" so the refusal is announced
               rather than only drawn, and aria-live keeps the ticking number
               from being re-announced every second (polite + atomic would
               interrupt constantly, so only the initial message speaks). -->
          <div class="auth-lock" id="lg-lock" role="alert" hidden></div>
          <div class="auth-field">
            <label for="lg-email">Email Address *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${ICONS.mail}</span>
              <input class="auth-input" id="lg-email" type="email" placeholder="you@email.com" autocomplete="email"/>
            </div>
            <span class="field-error" data-err></span>
          </div>
          <div class="auth-field">
            <label for="lg-pass">Password *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${_lockIcon}</span>
              <input class="auth-input auth-input-pw" id="lg-pass" type="password" placeholder="••••••••" autocomplete="current-password"/>
              ${eyeBtn}
            </div>
            <span class="field-error" data-err></span>
          </div>
          <div class="auth-row">
            <label class="auth-remember"><input type="checkbox" id="lg-remember"> Remember me</label>
            <button type="button" class="auth-forgot" data-forgot>Forgot password?</button>
          </div>
          <button type="submit" class="auth-submit">Sign In ${_authArrow}</button>
        </form>
      </div>

      <!-- Register -->
      <div class="auth-panel ${tab==='register'?'active':''}" id="ap-register" role="tabpanel">
        <div class="auth-panel-head">
          <h3>Join the family</h3>
          <p>Create an account for faster ordering and delivery updates.</p>
        </div>
        <form id="reg-form" novalidate>
          <!-- First, middle (optional) and last name, stored separately (migrations 019, 039); the name shown
               everywhere uses only the middle initial: "Juan D. Dela Cruz". -->
          <div class="auth-2col">
            <div class="auth-field">
              <label for="rg-first">First Name *</label>
              <div class="auth-input-group">
                <span class="auth-input-icon" aria-hidden="true">${ICONS.user}</span>
                <input class="auth-input" id="rg-first" type="text" placeholder="Juan" autocomplete="given-name"/>
              </div>
              <span class="field-error" data-err></span>
            </div>
            <div class="auth-field">
              <label for="rg-middle">Middle Name <span class="auth-opt">(optional)</span></label>
              <div class="auth-input-group">
                <span class="auth-input-icon" aria-hidden="true">${ICONS.user}</span>
                <input class="auth-input" id="rg-middle" type="text" placeholder="Dizon" autocomplete="additional-name"/>
              </div>
              <span class="field-error" data-err></span>
            </div>
          </div>
          <div class="auth-field">
            <label for="rg-last">Last Name *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${ICONS.user}</span>
              <input class="auth-input" id="rg-last" type="text" placeholder="Dela Cruz" autocomplete="family-name"/>
            </div>
            <span class="field-error" data-err></span>
            <small class="auth-name-preview" id="rg-name-preview" hidden></small>
          </div>
          <div class="auth-field">
            <label for="rg-contact">Contact Number *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${ICONS.phone}</span>
              <input class="auth-input" id="rg-contact" type="tel" placeholder="09xx xxx xxxx" autocomplete="tel"/>
            </div>
            <span class="field-error" data-err></span>
          </div>
          <div class="auth-field">
            <label for="rg-email">Email Address *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${ICONS.mail}</span>
              <input class="auth-input" id="rg-email" type="email" placeholder="you@email.com" autocomplete="email"/>
            </div>
            <span class="field-error" data-err></span>
          </div>
          <!-- The address, through the shared picker. Region through barangay
               are required, as this form always required an address; street and
               ZIP are optional, as the old box ("Barangay, city, province")
               never asked for them. It used to post to register.php, which never
               read it — every address typed here was discarded. -->
          <fieldset class="auth-addr">
            <legend class="auth-addr-legend">Your address</legend>
            ${EbAddress.markup("rg", { variant: "auth", required: "location" })}
          </fieldset>
          <div class="auth-field">
            <label for="rg-pass">Password *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${_lockIcon}</span>
              <input class="auth-input auth-input-pw" id="rg-pass" type="password" placeholder="Create a strong password" autocomplete="new-password"/>
              ${eyeBtn}
            </div>
            <div class="auth-strength-wrap"><i id="rg-strength"></i></div>
            <span class="strength-label" id="rg-strength-lbl"></span>
            <!-- What the password needs (same rules as Auth::passwordProblem on the server); each item ticks as it is met. -->
            <ul class="pw-rules" id="rg-pw-rules" aria-live="polite">
              ${PW_RULES.map(r => `<li data-rule="${r.id}"><span class="pw-rule-ic" aria-hidden="true"></span>${r.label}</li>`).join("")}
            </ul>
            <span class="field-error" data-err></span>
          </div>
          <div class="auth-field">
            <label for="rg-confirm">Confirm Password *</label>
            <div class="auth-input-group">
              <span class="auth-input-icon" aria-hidden="true">${_lockIcon}</span>
              <input class="auth-input auth-input-pw" id="rg-confirm" type="password" placeholder="Re-enter password" autocomplete="new-password"/>
              ${eyeBtn}
            </div>
            <span class="field-error" data-err></span>
          </div>
          <!-- Age and Terms consent, required (shop/register.php checks agree_terms too); the link opens assets/js/public/terms.js. -->
          <div class="auth-field">
            <label class="tc-agree"><input type="checkbox" id="rg-terms"/><span>I am at least 18 years old (or have my parent or guardian's consent) and I agree to the <a href="#" data-terms="customer">Terms and Conditions</a>, including how my personal data is used.</span></label>
            <span class="field-error" data-err></span>
          </div>
          <button type="submit" class="auth-submit">Continue ${_authArrow}</button>
        </form>
      </div>

    </div><!-- /auth-form-panel -->
  </div><!-- /auth-split -->`;

  openModal('', body, { wide:true, onOpen:(root)=>{
    // Mark modal for CSS overrides (close btn colour, no title, zero body padding)
    root.closest('#modal')?.classList.add('is-auth');

    /* Mount the Create Account address picker when the modal opens. */
    const rgAddr = EbAddress.mount(root, "rg");
    /* Terms reader for the consent link (loaded only when the form opens). */
    import("./terms.js").then(m => m.wireTermsLinks(root)).catch(() => {});

    // forgot password — emailed code, then a new password (shop/password-reset.php)
    root.querySelector('[data-forgot]')?.addEventListener('click', ()=>showForgot(root));

    /* Tab switcher: just move the active class; the pill is positioned by CSS. */
    const tabBtns = root.querySelectorAll('.auth-tab');
    tabBtns.forEach(btn=>btn.addEventListener('click', ()=>{
      const t = btn.dataset.atab;
      tabBtns.forEach(b=>{ b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
      btn.classList.add('active'); btn.setAttribute('aria-selected','true');
      root.querySelectorAll('.auth-panel').forEach(p=>p.classList.remove('active'));
      root.querySelector(`#ap-${t}`)?.classList.add('active');
      setTimeout(()=>root.querySelector(`#ap-${t} input`)?.focus(), 60);
    }));

    /* ── Eye toggles ── */
    root.querySelectorAll('.auth-eye-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const inp  = btn.closest('.auth-input-group').querySelector('input');
        const face = btn.querySelector('[data-eye-face]');
        const show = inp.type==='password';
        inp.type = show ? 'text' : 'password';
        if(face) face.innerHTML = show ? ICONS.eyeoff : ICONS.eye;
      });
    });

    /* ── Password strength ── */
    const strengthColors = ['var(--out)','var(--crit)','var(--warn)','#6fb83a','var(--ok)'];
    const strengthLabels = ['Very weak','Weak','Fair','Good','Strong'];
    root.querySelector('#rg-pass')?.addEventListener('input', function(){
      const sc  = strengthScore(this.value);
      const bar = root.querySelector('#rg-strength');
      const lbl = root.querySelector('#rg-strength-lbl');
      bar.style.width      = (this.value ? (sc/4)*100 : 0) + '%';
      bar.style.background = strengthColors[sc];
      lbl.textContent  = this.value ? strengthLabels[sc] : '';
      lbl.style.color  = strengthColors[sc];
      const v = this.value;
      PW_RULES.forEach(r => root.querySelector(`#rg-pw-rules [data-rule="${r.id}"]`)?.classList.toggle("is-met", r.test(v)));
    });

    /* ── Login submit ── */
    root.querySelector('#login-form')?.addEventListener('submit', async e=>{
      e.preventDefault();
      let ok=true;
      root.querySelectorAll('#login-form [data-err]').forEach(x=>x.textContent='');
      const fail=(sel,msg)=>{ root.querySelector(sel).closest('.auth-field').querySelector('[data-err]').textContent=msg; ok=false; };
      /* A new submission clears any previous notice and its timer. */
      stopLockCountdown(root);
      const email = root.querySelector('#lg-email').value.trim();
      const pass  = root.querySelector('#lg-pass').value;
      /* Sign-in only checks that something sensible was entered; password length rules belong to Create Account, not here. */
      if(!email) fail('#lg-email','Enter your email address.');
      else if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('#lg-email','Enter a valid email address, like you@email.com.');
      if(!pass) fail('#lg-pass','Enter your password.');
      if(!ok) return;

      const btn = root.querySelector('#login-form [type=submit]');
      const label = btn ? btn.textContent : '';
      if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }

      /* Try staff sign-in first via api/auth/login.php; a 401 means not a staff account, so the customer path runs. */
      try {
        const user  = await EbSession.login(email, pass);
        const route = STAFF_ROUTES[user.role];
        if(route){
          window.location.href = route;
        } else {
          showToast(`Welcome, ${user.name}. (${user.role} dashboard coming soon.)`, "info");
        }
        return;
      } catch(err){
        if(err.code === 'FORBIDDEN'){
          /* A real staff account that may not sign in (archived or no role) gets a clear message. */
          fail('#lg-email', err.message);
          return;
        }
        if(err.isAuth && err.fields && err.fields.password){
          /* A staff account with a wrong password: say so here rather than trying the customer path. */
          fail('#lg-pass', err.fields.password);
          const pw = root.querySelector('#lg-pass'); pw.value = ''; pw.focus();
          return;
        }
        if(err.isRateLimited){
          /* Fall through to the customer path on a staff lockout too, since this staff probe is speculative (the portal's own sign-in treats 429 as final). */
        }
        if(err.code === 'NETWORK' || err.code === 'TIMEOUT'){
          showToast(err.message, "info");
          return;
        }
        /* 401 falls through to the customer path below. */
      } finally {
        /* Do not re-enable the button while a lockout countdown is running. */
        if(btn){ btn.textContent = label; if(!lockTimer) btn.disabled = false; }
      }

      /* Customer sign-in via api/shop/login.php (bcrypt, separate session key from staff). */
      if(btn){ btn.disabled = true; btn.textContent = 'Signing in...'; }
      try {
        const { data } = await EbApi.post("shop/login.php", { email, password: pass });
        EbApi.setCsrf(data.csrf);
        signIn(data.customer);
      } catch(err){
        if(err.isValidation){
          Object.entries(err.fields).forEach(([f,msg]) =>
            fail('#lg-' + (f === 'password' ? 'pass' : 'email'), msg));
        } else if(err.isRateLimited){
          startLockCountdown(root, err.retryAfter, err.message);
        } else if(err.isAuth && err.fields && err.fields.password){
          /* Registered email, wrong password: message under the password, which is cleared for the retry. */
          fail('#lg-pass', err.fields.password);
          const pw = root.querySelector('#lg-pass'); pw.value = ''; pw.focus();
        } else if(err.isAuth && err.fields && err.fields.email){
          /* Email not registered: message under the email, which stays selected for correcting. */
          fail('#lg-email', err.fields.email);
          root.querySelector('#lg-email').select();
        } else {
          /* Show the server's own message (archived account and similar). */
          fail('#lg-email', err.message);
        }
      } finally {
        /* Do not re-enable the button while a lockout countdown is running. */
        if(btn){ btn.textContent = label; if(!lockTimer) btn.disabled = false; }
      }
    });

    /* ── Register submit ── */
    root.querySelector('#reg-form')?.addEventListener('submit', async e=>{
      e.preventDefault();
      let ok=true;
      root.querySelectorAll('#reg-form [data-err]').forEach(x=>x.textContent='');
      const fail=(sel,msg)=>{ root.querySelector(sel).closest('.auth-field').querySelector('[data-err]').textContent=msg; ok=false; };
      const first   = properName(root.querySelector('#rg-first').value);
      const middle  = properName(root.querySelector('#rg-middle')?.value || "");
      const last    = properName(root.querySelector('#rg-last').value);
      const contact = root.querySelector('#rg-contact').value.trim();
      const email   = root.querySelector('#rg-email').value.trim();
      const pw      = root.querySelector('#rg-pass').value;
      const cf      = root.querySelector('#rg-confirm').value;
      if(!first)   fail('#rg-first','First name is required.');
      if(!last)    fail('#rg-last','Last name is required.');
      if(!/^[0-9 +\-]{7,}$/.test(contact)) fail('#rg-contact','Enter a valid contact number.');
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('#rg-email','Enter a valid email.');
      /* Region through barangay, as the server's Address::LOCATION requires. */
      if(!rgAddr || !rgAddr.validate("location")) ok = false;
      const missing = PW_RULES.find(r => !r.test(pw));
      if(missing) fail('#rg-pass', `Your password needs: ${missing.label.toLowerCase()}.`);
      if(cf!==pw)  fail('#rg-confirm','Passwords do not match.');
      const agreed = root.querySelector('#rg-terms').checked;
      if(!agreed)  fail('#rg-terms','Please confirm your age and agree to the Terms and Conditions to continue.');
      if(!ok) return;

      /* Create a real account (claiming a seeded record with the same email). */
      /* Step 1 of 2: the server validates and emails a code; the account is created after verification. */
      const submitBtn = root.querySelector('#reg-form .auth-submit');
      const label = submitBtn.innerHTML;
      submitBtn.disabled = true; submitBtn.textContent = "Sending code…";
      try {
        const { data } = await EbApi.post("shop/register.php", {
          first_name: first, middle_name: middle, last_name: last, email, password: pw, contact, address: rgAddr ? rgAddr.value() : null,
          agree_terms: agreed,
        });
        showSignupOtp(root, data);
      } catch(err){
        if(err.isValidation){
          /* addr_* errors belong to the picker. */
          rgAddr?.showErrors(err.fields);
          Object.entries(err.fields).filter(([f]) => !f.startsWith('addr_')).forEach(([f,msg]) =>
            fail('#rg-' + (f === 'password' ? 'pass' : f === 'first_name' || f === 'name' ? 'first' : f === 'last_name' ? 'last' : f === 'middle_name' ? 'middle' : f === 'agree_terms' ? 'terms' : f), msg));
        } else {
          fail('#rg-email', err.message);
        }
      } finally {
        submitBtn.disabled = false; submitBtn.innerHTML = label;
      }
    });

    setTimeout(()=>root.querySelector('.auth-panel.active input')?.focus(), 80);
  }});
}
function openLogin(hint=null)    { openAuth('login',    hint); }
function openRegister(hint=null) { openAuth('register', hint); }

/* The account whose data this page loaded (first signed-in customer seen). On account pages, signing in as a
   different customer reloads the page, so the previous account's orders, history and profile never stay on screen. */
let authPageAccount = null;
const AUTH_RELOAD_PAGES = /\/profile\/|become-partner\.html/;

/* One function builds state.auth from the whole customer object, so every sign-in path produces the same shape. */
function setAuthState(customer){
  const newId = customer ? (customer.id || null) : null;
  if(newId){
    if(authPageAccount && newId !== authPageAccount && AUTH_RELOAD_PAGES.test(location.pathname)){
      location.reload();
      return;
    }
    authPageAccount = newId;
  }
  state.auth = customer
    ? {
        loggedIn: true,
        name:   customer.name  || "",
        email:  customer.email || "",
        id:     customer.id    || null,
        /* status drives the Payment Schemes link and credit tiles (presentation; the server re-checks). */
        status: customer.status || null,
      }
    : { loggedIn:false, name:"", email:"", id:null, status:null };

  /* Announce auth changes (sign in and sign out) so account pages update without a reload. */
  try {
    window.dispatchEvent(new CustomEvent("eb:auth-changed", {
      detail: { loggedIn: state.auth.loggedIn, status: state.auth.status },
    }));
  } catch(_){}
}

/* simulate signed-in state — swap navbar Login for account menu */
/* Show a signed-in customer; state.auth is a cache of the server's answer. */
function signIn(customer){
  setAuthState(customer);
  const name = state.auth.name;
  try { localStorage.setItem("eb-name", name || ""); } catch(_){}
  closeModal();
  renderAccount();
  showToast(`Welcome, ${name}!`, "success");

  /* Load the saved cart first, then replay the add that was waiting on sign-in (never at the same time). */
  (async () => {
    await loadServerCart();

    if(pendingCartAdd){
      const { id: pendingId, qty } = pendingCartAdd;
      pendingCartAdd = null;
      await addToCart(pendingId, qty);
    }
  })();
}
async function signOut(){
  setAuthState(null);
  try { localStorage.removeItem("eb-name"); localStorage.removeItem("eb-auth"); } catch(_){}
  /* Also end the server session. */
  try { await EbApi.post("auth/logout.php", {}); } catch(_){}
  /* Clear the local cart on sign-out (the server copy stays with the account). */
  state.cart = [];
  updateCartBadge();
  renderCart();
  renderAccount();
  showToast("Signed out.", "info");
}

/* Signed out because the same account signed in on another device or browser (cookie left by api/core/Auth.php). */
function noticeSignedOutElsewhere(){
  if(!/(?:^|;\s*)eb_signed_out=elsewhere/.test(document.cookie)) return;
  document.cookie = "eb_signed_out=; Max-Age=0; path=/; SameSite=Lax";
  document.cookie = "eb_signed_out=; Max-Age=0; path=" + (location.pathname.split("/public/")[0] + "/") + "; SameSite=Lax";
  setTimeout(() => showToast("You were signed out because your account was signed in on another device or browser.", "info"), 400);
}

/* Ask the server who is signed in and update the cached state. */
async function bootstrapCustomer(){
  noticeSignedOutElsewhere();
  try {
    const { data } = await EbApi.get("shop/me.php");
    /* Use setAuthState() so both paths produce the same shape. */
    setAuthState(data.customer);
    EbApi.setCsrf(data.csrf);
    /* Cache only a display name for first paint, never id or email. */
    try { localStorage.setItem("eb-name", data.customer.name || ""); } catch(_){}
  } catch(err){
    /* Any error means signed out. */
    setAuthState(null);
    try { localStorage.removeItem("eb-name"); localStorage.removeItem("eb-auth"); } catch(_){}
  }
  renderAccount();

  /* Announce that the server answered (also set EB_AUTH_READY for late listeners). */
  window.EB_AUTH_READY = true;
  window.dispatchEvent(new CustomEvent("eb:auth-ready", { detail: { loggedIn: state.auth.loggedIn } }));

  /* Load the cart once the account is known. */
  if(state.auth.loggedIn) loadServerCart();
}

/* Resolve once the server has said who this is. */
function whenAuthReady(){
  if (window.EB_AUTH_READY) return Promise.resolve(state.auth.loggedIn);
  return new Promise(resolve => {
    window.addEventListener("eb:auth-ready", e => resolve(e.detail.loggedIn), { once: true });
    /* Fall back to signed out if the bootstrap never resolves. */
    setTimeout(() => resolve(state.auth.loggedIn), 20000);
  });
}

/* ===== CUSTOMER NOTIFICATIONS: the bell (api/shop/notifications.php) for signed-in customers, checked on load, when opened and every minute while visible ===== */
let _bellTimer = null;
let _bellData = { items: [], unread: 0 };

function renderBell(){
  const slot = $("#account-slot");
  if(!slot) return;
  let bell = $("#nav-bell");
  if(!state.auth.loggedIn){
    bell?.remove();
    clearInterval(_bellTimer); _bellTimer = null;
    return;
  }
  if(!bell){
    bell = document.createElement("div");
    bell.id = "nav-bell";
    bell.className = "nav-bell";
    bell.innerHTML = `
      <button class="icon-btn nav-bell-btn" id="nav-bell-btn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        <span class="nav-bell-badge" id="nav-bell-badge" hidden>0</span>
      </button>
      <div class="bell-pop" id="bell-pop" role="dialog" aria-label="Notifications">
        <div class="bell-head">
          <b>Notifications</b>
          <button type="button" class="bell-readall" id="bell-readall">Mark all read</button>
        </div>
        <div class="bell-list" id="bell-list">${window.EbUI ? EbUI.skeletonBlock(3) : ""}</div>
        <a class="bell-all" href="${EbFormat.imageUrl("/public/profile/history.html#notifications")}">View all in History</a>
      </div>`;
    slot.parentNode.insertBefore(bell, slot);

    const btn = $("#nav-bell-btn"), pop = $("#bell-pop");
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const o = pop.classList.toggle("open");
      btn.setAttribute("aria-expanded", o);
      if(o) loadBell();
    });
    pop.addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", () => { pop.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); });
    document.addEventListener("keydown", e => { if(e.key === "Escape") pop.classList.remove("open"); });
    $("#bell-readall").addEventListener("click", async () => {
      try { _bellData = (await EbApi.post("shop/notifications.php", { action: "read_all" })).data; drawBell(); } catch(_){}
    });
  }
  loadBell();
  if(!_bellTimer){
    _bellTimer = setInterval(() => { if(document.visibilityState === "visible") loadBell(); }, 60000);
  }
}

async function loadBell(){
  try {
    _bellData = (await EbApi.get("shop/notifications.php")).data;
    drawBell();
  } catch(err){
    if(err.isAuth){ clearInterval(_bellTimer); _bellTimer = null; }
  }
}

function bellAgo(ts, ageSeconds){
  /* Use the server's age for each row, not the browser clock. */
  const s = ageSeconds != null ? ageSeconds
          : (Date.now() - new Date(String(ts).replace(" ", "T")).getTime()) / 1000;
  if(s < 60) return "just now";
  if(s < 3600) return Math.floor(s / 60) + " min ago";
  if(s < 86400) return Math.floor(s / 3600) + " h ago";
  if(s < 604800) return Math.floor(s / 86400) + " d ago";
  return EbFormat.fmtDate(ts);
}

const BELL_ICON = {
  order:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  payment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  return:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
};

function drawBell(){
  const badge = $("#nav-bell-badge"), list = $("#bell-list");
  if(!badge || !list) return;
  const n = _bellData.unread || 0;
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? "9+" : String(n);
  $("#nav-bell-btn")?.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
  $("#bell-readall").hidden = n === 0;

  if(!_bellData.items.length){
    list.innerHTML = `<div class="bell-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <p>You're all caught up.</p><small>We'll let you know when your order moves.</small></div>`;
    return;
  }
  list.innerHTML = _bellData.items.map(it => `
    <button type="button" class="bell-item bell-${esc(it.type)}${it.read ? "" : " unread"}" data-id="${it.id}" data-link="${esc(it.link || "")}">
      <span class="bell-ic" aria-hidden="true">${BELL_ICON[it.type] || BELL_ICON.order}</span>
      <span class="bell-body">
        <b>${esc(it.title)}</b>
        <span>${esc(it.message)}</span>
        <small>${bellAgo(it.createdAt, it.ageSeconds)}</small>
      </span>
    </button>`).join("");
  list.querySelectorAll(".bell-item").forEach(el => el.addEventListener("click", async () => {
    if(el.classList.contains("unread")){
      try { _bellData = (await EbApi.post("shop/notifications.php", { action: "read", id: Number(el.dataset.id) })).data; } catch(_){}
    }
    const link = el.dataset.link;
    if(link) window.location.href = EbFormat.imageUrl("/public/" + link);
    else drawBell();
  }));
}

function renderAccount(){
  const slot = $("#account-slot");
  /* Preview mode has no account surface to render into. */
  if(!slot) return;
  renderBell();
  if(state.auth.loggedIn){
    const initials = state.auth.name.split(" ").map(s=>s[0]).slice(0,2).join("").toUpperCase();
    const firstName = state.auth.name.split(" ")[0];
    const chevSVG = '<svg class="nav-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    slot.innerHTML = `
      <div id="account-menu">
        <button class="nav-profile-btn" id="account-avatar" aria-label="Account menu" aria-haspopup="true" aria-expanded="false">
          <span class="nav-avatar">${initials}</span>
          <span class="nav-username">${firstName}</span>
          ${chevSVG}
        </button>
        <div class="account-pop" id="account-pop">
          <div class="ap-head"><b>${state.auth.name}</b><small style="color:var(--text-muted);display:block;margin-top:2px">Signed in</small></div>
          <button data-acc="dashboard">${icon("grid")} Dashboard</button>
          <button data-acc="orders">${icon("bag")} My Orders</button>
          <button data-acc="profile">${icon("user")} Profile</button>
          <button data-acc="logout">${icon("logout")} Sign out</button>
        </div>
      </div>`;
    const btn = $("#account-avatar"), pop = $("#account-pop");
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const o = pop.classList.toggle("open");
      btn.classList.toggle("open", o);
      btn.setAttribute("aria-expanded", o);
    });
    pop.querySelectorAll("[data-acc]").forEach(b=>b.addEventListener("click", ()=>{
      const a=b.dataset.acc; pop.classList.remove("open"); btn.classList.remove("open");
      if(a==="logout") signOut();
      else {
        /* Account links point to public/profile/, detected by whether the current file is directly inside a profile/ folder. */
        const inProfileDir = /\/profile\/[^/]*$/.test(window.location.pathname);
        const base  = inProfileDir ? '' : 'profile/';
        /* Dashboard is the account area's home page. */
        if(a==="dashboard") window.location.href = base + "dashboard.html";
        if(a==="orders")    window.location.href = base + "my-orders.html";
        if(a==="profile")   window.location.href = base + "profile.html";
      }
    }));
    document.addEventListener("click", ()=>{ pop.classList.remove("open"); btn.classList.remove("open"); });
  } else {
    slot.innerHTML = `<button class="nav-login-btn" id="login-btn">Login</button>`;
    $("#login-btn").addEventListener("click", ()=>openLogin());
  }
}

/* ===== THEME ===== */
function applyTheme(t){
  state.theme = t;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("eb-theme", t); } catch(_){}
}

/* Phone fields accept only digits, space, + - ( ) as typed, pasted or autofilled (matching the server's check), keeping the caret in place and skipping during IME composition. */
const PHONE_REJECT = /[^0-9 +\-()]/g;
function sanitizePhone(el){
  const v = el.value;
  const clean = v.replace(PHONE_REJECT, "");
  if(clean === v) return;
  const caret = el.selectionStart ?? v.length;
  const kept = v.slice(0, caret).replace(PHONE_REJECT, "").length;
  el.value = clean;
  try { el.setSelectionRange(kept, kept); } catch(_){}
}
function wirePhoneInputs(){
  const isTel = t => t instanceof HTMLInputElement && t.type === "tel";
  document.addEventListener("input", e=>{
    if(isTel(e.target) && !e.isComposing) sanitizePhone(e.target);
  });
  document.addEventListener("compositionend", e=>{
    if(isTel(e.target)) sanitizePhone(e.target);
  });
}

/* ===== Stepper delegation (cards and product detail) ===== */
function wireSteppers(){
  document.addEventListener("click", e=>{
    const btn = e.target.closest("[data-step]");
    if(!btn) return;
    const input = btn.closest(".stepper").querySelector("input");
    let v = parseInt(input.value||"1",10) + parseInt(btn.dataset.step,10);
    const max = parseInt(input.max||String(CART_MAX_QTY),10);
    v = Math.max(1, Math.min(v, max));
    input.value = v;
  });
  /* Typing a quantity: anything above what is available snaps to the available stock, with a note saying so. */
  document.addEventListener("input", e=>{
    const input = e.target.closest(".stepper input[type=number]");
    if(!input) return;
    const max = parseInt(input.max||String(CART_MAX_QTY),10);
    const n = parseInt(input.value, 10);
    if(Number.isFinite(n) && n > max){
      input.value = max;
      /* The popup's box allows 99 per add (add again for more); the cart's own box allows up to the stock. */
      const inCart = !!input.closest("[data-cart-stepper]");
      showToast(inCart ? `Only ${max} available.` : `You can add up to ${max} — that is all that is available.`, "info");
    }
  });
}

/* ===== Scroll helpers, smooth anchors, reveal, sticky nav, parallax ===== */
function scrollToId(sel){
  const el = $(sel); if(!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 64;
  window.scrollTo({top:y, behavior:"smooth"});
}

/* The shop is its own page (shop.html), resolved from the app root so it works from any depth. */
function shopUrl(){
  const base = (window.EbFormat && EbFormat.APP_BASE) || BASE_PATH || "/";
  return base + "public/shop.html";
}

/* Already on the shop page: scroll to the grid instead of reloading. */
function goToShop(){
  closeCart();
  if($("#product-grid")){ scrollToId("#product-grid"); return; }
  window.location.href = shopUrl();
}
/* ---- tubelight indicator ---- */
/* instant positions the indicator without sliding (on load, font load and resize). */
function moveNavIndicator(linkEl, instant){
  const ind = $("#nav-indicator");
  const nav = $("#navlinks");
  if(!ind || !nav || !linkEl) return;
  const cR = nav.getBoundingClientRect();
  const lR = linkEl.getBoundingClientRect();
  if(instant) ind.style.transition = "none";
  ind.style.left = (lR.left - cR.left - nav.clientLeft) + "px";
  ind.style.width = lR.width + "px";
  if(instant){ void ind.offsetWidth; ind.style.transition = ""; }
  $$(".nav-links a").forEach(a => a.classList.remove("active"));
  linkEl.classList.add("active");
}
function initNavIndicator(){
  // On dedicated pages, position the indicator on the .page-active link and skip scroll-spy.
  const pageActive = document.querySelector('.nav-links a.page-active');
  const settle = () => { const a = document.querySelector('.nav-links a.active, .nav-links a.page-active'); if(a) moveNavIndicator(a, true); };
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  window.addEventListener("resize", settle, {passive:true});
  if(pageActive){ moveNavIndicator(pageActive, true); return; }

  // Highlight the nav link for the section in view (hrefs must match).
  const sections = [
    {id:"home",    href:"index.html"},
    {id:"best",    href:"#best"},
    {id:"about",   href:"#about"},
    {id:"contact", href:"#contact"},
  ];
  // default to Home
  const firstLink = document.querySelector('.nav-links a[href="index.html"]')
                    || document.querySelector(".nav-links a");
  if(firstLink) moveNavIndicator(firstLink, true);

  // scroll-spy: pick the last section whose top is above 40% of viewport
  function updateActiveLink(){
    const trigger = window.scrollY + window.innerHeight * 0.4;
    let active = sections[0];
    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if(el && el.offsetTop <= trigger) active = s;
    });
    const link = document.querySelector('.nav-links a[href="'+active.href+'"]');
    if(link) moveNavIndicator(link);
  }
  window.addEventListener("scroll", updateActiveLink, {passive:true});
  updateActiveLink();
}

function wireSmoothScroll(){
  $$('a[href^="#"]').forEach(a=>{
    a.addEventListener("click", e=>{
      const id = a.getAttribute("href");
      if(id.length>1 && $(id)){
        e.preventDefault();
        scrollToId(id);
        $("#navlinks").classList.remove("open");
        // move tubelight to clicked nav link if it's in the nav
        if(a.closest("#navlinks")) moveNavIndicator(a);
      }
    });
  });
}
function wirePageLinks(){
  // Links to other pages: slide the indicator, animate out, then navigate.
  $$(".nav-links a").forEach(a => {
    const href = a.getAttribute("href");
    if(!href || href.startsWith("#")) return; // anchor links handled by wireSmoothScroll
    a.addEventListener("click", e => {
      e.preventDefault();
      moveNavIndicator(a);
      $("#navlinks")?.classList.remove("open");
      /* Already on that page: scroll to top instead of reloading. */
      const here = location.pathname.split("/").pop() || "index.html";
      if(href.split("#")[0] === here){ window.scrollTo({top:0, behavior:"smooth"}); return; }
      window.location.href = href;   /* no exit animation: it only delayed the load */
    });
  });
}
function wireReveal(){
  const els = $$(".reveal");
  if(!("IntersectionObserver" in window)){ els.forEach(el=>el.classList.add("in")); return; }
  const io = new IntersectionObserver((entries)=>{
    entries.forEach(en=>{ if(en.isIntersecting){ en.target.classList.add("in"); io.unobserve(en.target); } });
  }, {threshold:.12, rootMargin:"0px 0px -40px 0px"});
  els.forEach(el=>io.observe(el));
}
function wireStickyNav(){
  const nav=$("#nav");
  const onScroll=()=>nav.classList.toggle("scrolled", window.scrollY>40);
  onScroll(); window.addEventListener("scroll", onScroll, {passive:true});
}

function wireParallax(){
  // parallax removed — accordion replaces the old hero jar
}

/* ===== HERO ===== */
const HERO_PANELS = [
  { title:"Pesto Bangus",       tint:"#3f8f4f", bg:"linear-gradient(160deg,#2d6a3f,#1a4a2a)" },
  { title:"Adobo Bangus",       tint:"#5a3a22", bg:"linear-gradient(160deg,#6b4226,#3d2515)" },
  { title:"Asian Steak",        tint:"#7a4b2b", bg:"linear-gradient(160deg,#8a5a35,#4a2d18)" },
  { title:"Tuyo Delizioso",     tint:"#c98a2e", bg:"linear-gradient(160deg,#b87d28,#7a5218)" },
  { title:"Ba-yo Signature",    tint:"#b6702a", bg:"linear-gradient(160deg,#a06020,#5c3812)" },
];

/* Hero slider is a left-to-right queue: order[0] is in the panel, order[1] is the next-up tile nearest it, and an off-screen fourth tile enters from the left on each advance. */
/* Timings matching styles.css: the panel fade starts HERO_PANEL_LEAD_MS into the 0.7s slide so both finish together. */
const HERO_SLIDE_MS      = 700;
const HERO_PANEL_LEAD_MS = 150;
const HERO_CYCLE_MS      = 7000;

function renderHeroSlider(){
  const track  = $("#hs-track"),
        thumbs = $("#hero-thumbs"),
        slider = $("#hero-slider");
  if(!track || !thumbs) return;

  track.innerHTML = ""; thumbs.innerHTML = "";
  let order = HERO_PANELS.map((_, i) => i);
  let timer = null, busy = false;

  const rail = document.createElement("div");
  rail.className = "ht-rail";
  thumbs.appendChild(rail);

  function art(panel, first){
    /* panel.img is an app-root-relative path, resolved with imageUrl(). */
    const src = imageUrl(panel.img);
    return src
      /* The first slide is fetched first (it is the largest thing on screen); srcset lets phones use the 800px copy. */
      ? '<img src="'+src+'"' + (photoSrcset(panel.img) ? ' srcset="'+photoSrcset(panel.img)+'" sizes="(max-width: 960px) 100vw, 75vw"' : '') +
        ' fetchpriority="'+(first ? 'high' : 'low')+'" decoding="async" alt="'+panel.title+'" draggable="false">'
      : '<div class="hs-ph" style="position:absolute;inset:0;background:'+panel.bg+';display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px">' +
          '<span class="ph-icon" aria-hidden="true">'+ICONS.camera+'</span>' +
          '<span class="ph-label">'+panel.title+'</span>' +
        '</div>';
  }

  /* Panels are built once; only the .active class moves between them. */
  HERO_PANELS.forEach(function(panel, idx){
    const slide = document.createElement("div");
    slide.className = "hs-slide";
    slide.innerHTML = art(panel, idx === 0) + '<span class="hs-caption">'+panel.title+'</span>';
    /* Phones/tablets show the whole photo; a blurred copy fills the space beside it. */
    const im = slide.querySelector("img");
    if(im) slide.style.setProperty("--hs-bg", 'url("' + im.getAttribute("src").replace(/"/g, "%22") + '")');
    track.appendChild(slide);
  });
  const slides = $$(".hs-slide", track);

  /* Place the product-name ribbon just above the quote using offsetTop (unaffected by animations), re-measured after fonts load. */
  (function placeCaption(){
    const slider = track.closest(".hero-slider");
    const ov = slider && slider.querySelector(".hs-overlay");
    const tag = ov && ov.querySelector(".hero-tagline");
    if(!tag) return;
    const set = () => slider.style.setProperty("--cap-bottom",
      Math.max(0, slider.clientHeight - (ov.offsetTop + tag.offsetTop) + 14) + "px");
    if(window.ResizeObserver){ new ResizeObserver(set).observe(slider); new ResizeObserver(set).observe(ov); }
    window.addEventListener("resize", set);
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(set);
    set();
  })();


  /* order[0] is whatever belongs in the big panel. */
  function paintPanel(){
    slides.forEach((s,i)=> s.classList.toggle("active", i === order[0]));
  }

  /* Rebuild the rail at rest: incoming tile, then the queue with next-up nearest the panel. */
  function paintRail(){
    const n = order.length;
    rail.classList.remove("is-moving");
    rail.innerHTML = "";

    [4,3,2,1].forEach(function(depth, pos){
      const panel = HERO_PANELS[order[depth % n]];
      const tile  = document.createElement("button");
      tile.type = "button";
      tile.className = "hero-thumb" + (depth === 1 ? " next-up" : "");
      tile.setAttribute("aria-label",
        (depth === 1 ? "Up next: " : "Show ") + panel.title);
      tile.setAttribute("aria-hidden", pos === 0 ? "true" : "false");
      tile.tabIndex = pos === 0 ? -1 : 0;   /* the off-screen tile isn't reachable */
      const tileSrc = EbFormat.thumbUrl(panel.img, 400);   /* tiles are small */
      tile.innerHTML = tileSrc
        ? '<img src="'+tileSrc+'" alt="" draggable="false">'
        : '<span class="ht-ph" style="background:'+panel.bg+'"></span>';
      /* Clicking a tile pulls it to the head — `depth` advances away. */
      tile.addEventListener("click", function(){ advance(depth); restart(); });
      rail.appendChild(tile);
    });

    syncNotch();
  }

  function advance(n){
    if(busy) return;
    busy = true;
    n = n || 1;

    /* Rotate the queue, then run the tile slide and panel fade together. */
    for(let i = 0; i < n; i++) order.push(order.shift());

    rail.classList.add("is-moving");                       /* slide right */
    setTimeout(paintPanel, HERO_PANEL_LEAD_MS);            /* panel fades in */

    setTimeout(function(){
      paintRail();                                          /* snap back to rest */
      busy = false;
    }, HERO_SLIDE_MS);
  }

  function restart(){
    clearInterval(timer);
    timer = setInterval(function(){ advance(1); }, HERO_CYCLE_MS);
  }

  /* Size the panel's notch from the real tile box (none below 960px). */
  const NOTCH_RING = 12;
  function syncNotch(){
    if(!slider) return;
    const tiles = $$(".hero-thumb", rail);
    const tile  = tiles[tiles.length - 1];
    const clear = function(){
      slider.style.setProperty("--notch-w", "0px");
      slider.style.setProperty("--notch-h", "0px");
    };
    if(!tile) return clear();

    const p = slider.getBoundingClientRect();
    const t = tile.getBoundingClientRect();

    /* Only cut the notch when the tile actually overlaps the panel. */
    const intersects = t.right  > p.left + 1 && t.left < p.right &&
                       t.bottom > p.top  + 1 && t.top  < p.bottom;
    if(!intersects) return clear();

    slider.style.setProperty("--notch-x", (t.left   - p.left - NOTCH_RING) + "px");
    slider.style.setProperty("--notch-y", (t.top    - p.top  - NOTCH_RING) + "px");
    slider.style.setProperty("--notch-w", (t.width  + NOTCH_RING * 2) + "px");
    slider.style.setProperty("--notch-h", (t.height + NOTCH_RING * 2) + "px");
  }

  let notchTimer = null;
  window.addEventListener("resize", function(){
    clearTimeout(notchTimer);
    notchTimer = setTimeout(syncNotch, 120);
  });

  paintPanel();
  paintRail();
  restart();
  /* Fonts and the reveal animation can shift the strip after first paint. */
  setTimeout(syncNotch, 400);

  /* Pause while the visitor is reading the panel or choosing a tile. */
  [slider, thumbs].forEach(function(el){
    if(!el) return;
    el.addEventListener("mouseenter", ()=> clearInterval(timer));
    el.addEventListener("mouseleave", restart);
  });
}

/* The unused hero accordion was removed (its element never existed); the slider is the hero. */

/* ===== INIT ===== */

/* ===== LANDING CONTENT + PREVIEW MODE: content/get.php is the only source (the old localStorage bridge is gone) ===== */
window.EB_LANDING = null;

/* One-time cleanup of the retired eb-landing-content localStorage key. */
try { localStorage.removeItem("eb-landing-content"); } catch(_){}

/* Fetch the landing content from the database and apply it. */
async function fetchLandingContent(){
  try {
    const { data } = await EbApi.get("content/get.php");
    window.EB_LANDING = data;
    applyLandingContent();
    if (typeof renderFaqs === "function") renderFaqs();
    if (typeof renderHeroSlider === "function") renderHeroSlider();
    /* Re-render the carousel once landing content arrives (the two requests race). */
    if (typeof renderBestSellers === "function") renderBestSellers();
    return true;
  } catch(err){
    /* Log, do not show, a content load failure. */
    console.warn("[landing] content unavailable:", err.message);
    return false;
  }
}

/* Apply landing content to the page hooks before the render functions run. */
function applyLandingContent(){
  /* Use the content already in memory. */
  const c = window.EB_LANDING;
  if(!c) return;

  const setText = (sel, val) => {
    const el = $(sel);
    if(el && typeof val === "string" && val.trim()) el.textContent = val;
  };
  /* Hero text: the tagline in quotes with its highlighted word in italics, the line under it, and the two stats. */
  if(c.heroText){
    const h = c.heroText, esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[ch]));
    const tag = $("#lp-live-tagline");
    if(tag && h.tagline){
      let html = esc(h.tagline);
      if(h.highlight){
        const i = h.tagline.toLowerCase().indexOf(h.highlight.toLowerCase());
        if(i >= 0) html = esc(h.tagline.slice(0, i)) + "<em>" + esc(h.tagline.slice(i, i + h.highlight.length)) + "</em>" + esc(h.tagline.slice(i + h.highlight.length));
      }
      tag.innerHTML = "&ldquo;" + html + "&rdquo;";
    }
    const lead = $("#lp-live-lead");
    if(lead) lead.textContent = h.lead || "";
    [["#lp-live-stat1", h.stat1_value, h.stat1_label], ["#lp-live-stat2", h.stat2_value, h.stat2_label]].forEach(([sel, v, l]) => {
      const el = $(sel);
      if(!el) return;
      el.hidden = !(v || l);
      el.querySelector("b").textContent = v || "";
      el.querySelector("span").textContent = l || "";
    });
  }
  setText("#lp-live-about",   c.about);
  setText("#lp-live-vision",  c.vision);
  setText("#lp-live-mission", c.mission);

  if(c.contact){
    setText("#lp-live-address", c.contact.address);

    const phone = $("#lp-live-phone");
    if(phone && c.contact.phone){
      phone.textContent = c.contact.phone;
      phone.href = "tel:" + c.contact.phone.replace(/[^\d+]/g, "");
    }
    const mail = $("#lp-live-email");
    if(mail && c.contact.email){
      mail.textContent = c.contact.email;
      mail.href = "mailto:" + c.contact.email;
    }
    const fb = $("#lp-live-facebook");
    if(fb && c.contact.facebook){
      /* Only the Facebook link changes; the button keeps its label. */
      fb.href = /^https?:/.test(c.contact.facebook)
        ? c.contact.facebook : "https://" + c.contact.facebook;
    }
  }

  /* Replace the FAQ list as a whole so removed entries disappear. */
  if(Array.isArray(c.faqs) && c.faqs.length){
    FAQS = c.faqs.filter(f => f && f.q && f.a);
    FAQS_LOADED = true;
  }

  /* Hero slide photos (image, or legacy img). */
  /* Match slides by position, since the editor can rename them. */
  if(Array.isArray(c.hero)){
    c.hero.forEach(function(entry, i){
      const panel = HERO_PANELS[i];
      if(!entry || !panel) return;
      if(entry.title) panel.title = entry.title;
      const path = entry.image || entry.img || "";
      if(path) panel.img = path;
    });
  }

  /* A product's photo lives on the product (the old productImages branch was removed). */
}

/* Preview mode (?preview=1) for the admin's iframe: the page stays browsable but the account and cart controls are removed. */
/* The preview flag also rides on window.name so it survives navigation inside the iframe. */
const PREVIEW_NAME = "eb-preview";
function isPreviewMode(){
  try {
    if(new URLSearchParams(location.search).get("preview") === "1") return true;
    return window.name.split("|")[0] === PREVIEW_NAME && window.top !== window;
  } catch(_){ return false; }
}

/* Who is previewing (from the URL or sessionStorage), or "". */
function previewIdentity(){
  try {
    const q    = new URLSearchParams(location.search);
    const role = q.get("as"), who = q.get("who");
    if(role) return who ? who + " · " + role : role;
    const saved = window.name.split("|");
    if(saved[0] === PREVIEW_NAME && saved[1]) return decodeURIComponent(saved[1]);
  } catch(_){}
  try {
    const staff = JSON.parse(sessionStorage.getItem("eb-staff") || "null");
    if(staff && staff.role) return staff.name ? staff.name + " · " + staff.role : staff.role;
  } catch(_){}
  return "";
}

function applyPreviewMode(){
  if(!isPreviewMode()) return;
  document.documentElement.classList.add("eb-preview");
  try { window.name = PREVIEW_NAME + "|" + encodeURIComponent(previewIdentity()); } catch(_){}

  /* Remove the account and cart elements entirely. */
  ["#account-slot", "#cart-btn", "#cart-btn-mob"].forEach(function(sel){
    const el = $(sel);
    if(el) el.remove();
  });

  /* Also disable the auth entry points in case something tries to open them. */
  if(typeof openAuth === "function") openAuth = function(){};
  if(typeof openLogin === "function") openLogin = function(){};
  if(typeof openRegister === "function") openRegister = function(){};

  const chip = document.createElement("div");
  chip.className = "eb-preview-chip";
  chip.textContent = previewIdentity()
    ? "Preview — signed in as " + previewIdentity()
    : "Preview mode";
  document.body.appendChild(chip);
}

/* Load the live catalogue (failures are logged quietly; checkout re-prices on the server anyway). */
async function loadShopCatalog(){
  try {
    const { data } = await EbApi.get("shop/products.php");
    if (Array.isArray(data) && data.length) {
      PRODUCTS.length = 0;
      data.forEach(p => PRODUCTS.push(p));
    }
    return true;
  } catch (err) {
    console.warn("[shop] catalogue unavailable, showing cached copy:", err.message);
    return false;
  }
}

/* Category chips from the products' categories; a missing selected category falls back to All. */
function renderCatChips(){
  const el = $("#cat-chips");
  const cats = [...new Set(PRODUCTS.map(p => p.cat).filter(Boolean))];
  if(cats.length) CATEGORIES = ["All", ...cats];
  if(!CATEGORIES.includes(state.filter.category)) state.filter.category = "All";
  if(el) el.innerHTML = CATEGORIES.map(c =>
    `<button class="chip ${c === state.filter.category ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
}

function init(){
  /* Apply admin overrides first, since the renders below depend on them. */
  applyLandingContent();
  applyPreviewMode();

  /* The brand is the logo image in each page's header (assets/img/logo.webp). */

  // about jar — image placeholder with big-jar class styling
  const aboutJarEl = $("#about-jar");
  if(aboutJarEl){
    aboutJarEl.classList.add("about-map-card");
    aboutJarEl.innerHTML =
      '<iframe class="about-map" title="Elisha Bay location — Dagupan City, Pangasinan" ' +
        'src="https://maps.google.com/maps?q=148%20Brgy.%20Mangin%2C%20Dagupan%20City%2C%20Pangasinan&z=15&output=embed" ' +
        'loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>' +
      '<div class="about-map-tag">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
        '148 Brgy. Mangin, Dagupan City' +
      '</div>';
  }

  // hero accordion + hero slider
  renderHeroSlider();

  // tubelight nav indicator — defer until after first paint
  setTimeout(initNavIndicator, 0);

  // data-icon spans
  $$("[data-icon]").forEach(el=>{ el.innerHTML = ICONS[el.dataset.icon] || ""; });

  // category chips (from CATEGORIES, then from the loaded catalogue)
  renderCatChips();

  // render content
  renderBestSellers();
  renderProducts();

  /* Re-render once the real catalogue arrives. */
  loadShopCatalog().then(ok => {
    CATALOG_READY = true;
    renderCatChips(); renderBestSellers(); renderProducts();
  });

  /* Pick up an existing staff session so its CSRF token is available for checkout (anonymous visitors just get a 401). */
  if (window.EbSession) {
    EbSession.bootstrap().catch(() => {});
  }

  /* Reconcile the cached "logged in" flag with the server. */
  bootstrapCustomer();

  /* Pull the real landing content. */
  fetchLandingContent();
  renderCerts();
  renderFaqs();
  renderAccount();
  renderCart();
  updateCartBadge();
  if($("#year")) $("#year").textContent = new Date().getFullYear();

  /* ---- event wiring (delegated where possible) ---- */
  wireSteppers();
  wirePhoneInputs();
  wireSmoothScroll();
  wirePageLinks();
  wireReveal();
  wireStickyNav();
  wireParallax();

  // theme toggle
  /* #theme-btn opens the Light / Dark / System menu — assets/js/theme.js. */
  window.addEventListener("eb-theme-change", e => { state.theme = e.detail.theme; });

  // cart open/close (pill cart + mobile cart)
  $("#cart-btn")?.addEventListener("click", openCart);
  $("#cart-btn-mob")?.addEventListener("click", openCart);
  $("#cart-close")?.addEventListener("click", closeCart);
  $("#cart-scrim")?.addEventListener("click", closeCart);

  // modal close
  $("#modal-close")?.addEventListener("click", closeModal);
  wireBackdropClose($("#modal-scrim"), () => $("#modal"));
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape"){ closeModal(); closeCart(); $("#navlinks")?.classList.remove("open"); }
  });

  // login button (initial)
  $("#login-btn")?.addEventListener("click", openLogin);

  // search box (in shop sidebar only)
  $("#shop-search")?.addEventListener("input", e=>{ state.filter.search=e.target.value; renderProducts(); });

  // sort
  $("#sort-select")?.addEventListener("change", e=>{ state.filter.sort=e.target.value; renderProducts(); });

  // grid / sideways-scroll toggle (shop page only — both buttons are null elsewhere)
  wireShopView();

  // category chips
  $("#cat-chips")?.addEventListener("click", e=>{
    const chip=e.target.closest(".chip"); if(!chip) return;
    $$("#cat-chips .chip").forEach(c=>c.classList.remove("active"));
    chip.classList.add("active");
    state.filter.category=chip.dataset.cat;
    renderProducts();
  });

  // hamburger
  const ham=$("#hamburger");
  ham?.addEventListener("click", e=>{ e.stopPropagation(); $("#navlinks").classList.toggle("open"); });
  /* Menu scroll lock and aria-expanded follow the .open class. */
  const navEl = $("#navlinks");
  if(navEl && ham){
    new MutationObserver(()=>{
      const o = navEl.classList.contains("open");
      ham.setAttribute("aria-expanded", o);
      document.documentElement.classList.toggle("nav-menu-open", o);
    }).observe(navEl, { attributes: true, attributeFilter: ["class"] });
    /* A tap outside the open menu (and outside the header) closes it. */
    document.addEventListener("click", e=>{
      if(navEl.classList.contains("open") && !e.target.closest("#navlinks, #hamburger")) navEl.classList.remove("open");
    });
  }

  // delegated: add-to-cart, open detail (grid + best sellers)
  document.addEventListener("click", e=>{
    const add=e.target.closest("[data-add]");
    if(add){
      const card=add.closest(".product-card");
      const qty=parseInt(card?.querySelector(".stepper input")?.value || "1",10);
      addToCart(add.dataset.add, qty);
      return;
    }
    const detail=e.target.closest("[data-detail]");
    if(detail){ openProductDetail(detail.dataset.detail); }
  });
  // keyboard open detail on media
  document.addEventListener("keydown", e=>{
    if((e.key==="Enter"||e.key===" ") && e.target.matches("[data-detail].pc-media")){
      e.preventDefault(); openProductDetail(e.target.dataset.detail);
    }
  });

  // delegated: cart drawer stepper + remove
  $("#cart-body")?.addEventListener("click", e=>{
    const step=e.target.closest("[data-cstep]");
    if(step){
      const wrap=step.closest("[data-cart-stepper]"); const id=wrap.dataset.cartStepper;
      const input=wrap.querySelector("input");
      const next = parseInt(input.value||"1",10) + parseInt(step.dataset.cstep,10);
      /* Minus at one removes the line. */
      if(next < 1){ removeFromCart(id); return; }
      setQty(id, next);
      return;
    }
    const rm=e.target.closest("[data-remove]");
    if(rm){ removeFromCart(rm.dataset.remove); }
  });
  $("#cart-body")?.addEventListener("change", e=>{
    const input=e.target.closest("[data-cart-stepper] input");
    if(!input) return;
    const id  = input.closest("[data-cart-stepper]").dataset.cartStepper;
    const raw = input.value.trim();
    const n   = parseInt(raw, 10);
    /* Clearing the field or typing 0 also removes the line. */
    if(raw === "" || !Number.isFinite(n) || n < 1){ removeFromCart(id); return; }
    setQty(id, n);
  });

  /* The unused contact form handler was removed (no such form exists); partner applications use become-partner.html. */

  /* Invitation link from staff (api/core/CustomerInvite.php): open sign-up with the name and email filled in.
     Sign-up still verifies the email with a code, then attaches the password to the record staff created. */
  const inv = new URLSearchParams(location.search);
  if(inv.get("invite") === "1" && inv.get("email") && typeof openRegister === "function"){
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    const invName = (inv.get("name") || "").trim();
    openRegister(`Welcome${invName ? ", " + esc(invName.split(/\s+/)[0]) : ""}! Our team added you as a customer — create your password below to finish your account.`);
    setTimeout(() => {
      const email = document.getElementById("rg-email");
      if(email){ email.value = inv.get("email"); }
      const parts = invName.split(/\s+/).filter(Boolean);
      const first = document.getElementById("rg-first"), last = document.getElementById("rg-last");
      if(first && parts.length) first.value = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
      if(last && parts.length > 1) last.value = parts[parts.length - 1];
      document.getElementById(parts.length ? "rg-contact" : "rg-first")?.focus();
    }, 0);
    /* Drop the details from the address bar so a refresh or shared link does not reopen it. */
    history.replaceState(null, "", location.pathname);
  }
}

document.addEventListener("DOMContentLoaded", init);

/* ===== Extras: stats counter, parallax orbs, footer links ===== */

/* ── Animated stat counters ── */
/* animateCounter() was removed with its only caller. */

/* initCounters() was removed because #stats-bar does not exist. */

/* ── Parallax: hero orbs drift slightly on scroll ── */
(function initOrbParallax() {
  const orbs = document.querySelectorAll(".hero-canvas .orb");
  if (!orbs.length) return;

  const factors = [0.06, -0.04, 0.08, -0.05, 0.03];

  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const scrollY = window.scrollY;
      orbs.forEach((orb, i) => {
        const f = factors[i] ?? 0.05;
        orb.style.transform = `translateY(${scrollY * f}px)`;
      });
      ticking = false;
    });
  }, { passive: true });
})();

/* ── Footer link animated underline on keyboard focus ── */
document.querySelectorAll(".footer-links a").forEach(a => {
  a.addEventListener("focus", () => a.style.color = "var(--red)");
  a.addEventListener("blur",  () => a.style.color = "");
});
