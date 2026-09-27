/* =================================================================
   ELISHA BAY — Single-file interactive landing page
   Architecture:
     CONFIG  -> brand-level source of truth (re-skin here)
     DATA    -> PRODUCTS / CATEGORIES / FAQS / CERTS (edit here to update UI)
     state   -> cart / theme / auth / filters (what a backend would plug into)
     render  -> factory functions build every card/row/line ONCE
     ui      -> generic modal / toast / drawer primitives
   ================================================================= */
"use strict";

/* ---------- CONFIG: brand source of truth ---------- */
const CONFIG = {
  brand: "Elisha Bay",
  company: "Juris Bay Foods, Inc.",
  motto: "Every Mouthful is Delightful",
  currency: "₱",
  address: "148 Brgy. Mangin, Dagupan City, Pangasinan",
  phone: "+63 900 000 0000",
  email: "hello@elishabay.ph",
  facebook: "facebook.com/ElishaBayPH",
  certifications: [
    { code: "DOST", label: "Dept. of Science & Technology" },
    { code: "DTI",  label: "Dept. of Trade & Industry" },
    { code: "FDA",  label: "Food & Drug Administration" },
    { code: "PEDAI",label: "Phil. Entrepreneurs & Dev. Assoc." },
  ],
};

/* ---------- STAFF ACCOUNTS — DELETED ----------
   This file held all five staff credentials in plaintext and is served to
   every visitor, so anyone who opened it could sign in as Super Admin. The
   login handler below now posts to api/auth/login.php, which verifies against
   bcrypt hashes in MySQL. Nothing on this page needs to know an account exists
   until the server says so.

   The array was also a maintenance trap: it had drifted out of sync with the
   portal's own copy (five accounts here, six there — the archived one was
   missing, so an account disabled in the portal could still sign in from this
   page). One source of truth removes the whole class of bug. */

/* Project root, derived from this script's own URL rather than hardcoded.
   The old routes were absolute (/StuffModule/AdminModule/admin.html) and
   404'd unless the project was served at the web root — which broke staff
   login the moment it moved into htdocs/elishabay/.

   Deriving from the page URL instead would not work: this file loads on
   both public/index.html and public/profile/*.html, which sit at different
   depths. The script's own path is the same from either. */
const BASE_PATH = (() => {
  const src = (document.currentScript && document.currentScript.src) || "";
  const marker = "assets/js/public/";
  const i = src.indexOf(marker);
  return i >= 0 ? src.slice(0, i) : "/";
})();

/* Route map: role → portal path. Portal folders are named for the role they
   accept; the receiving portal's checkSessionAuth() compares the role string
   verbatim, so these keys must match STAFF_ACCOUNTS exactly. */
const STAFF_ROUTES = {
  "Super Admin":         BASE_PATH + "portal/super-admin/",
  "Admin":               BASE_PATH + "portal/admin/",
  "Inventory Staff":     BASE_PATH + "portal/inventory/",
  "Cashier":             BASE_PATH + "portal/cashier/",
  "Online Orders Staff": BASE_PATH + "portal/orders/",
};

/* ---------- DATA: categories ---------- */
const CATEGORIES = ["All", "Deboned Bangus", "Bottled Gourmet Bangus"];

/* ---------- DATA: products (single source — edit one entry to update UI)
   tint = contents color used by the generated jar illustration.
   stock thresholds (non-overlapping): >100 ok | 11-100 low | 1-10 critical | 0 out
------------------------------------------------------------------- */
/* Filled from api/shop/products.php by loadShopCatalog() at startup. The
   literals below are scaffolding for the moment before that resolves, and are
   overwritten wholesale — what a visitor sees is the database.

   The public endpoint returns no stock counts, only a coarse availability
   band; exact inventory is operational detail that does not belong on a page
   anyone can open. */
/* Filled from api/shop/products.php by loadShopProducts(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let PRODUCTS = [];

/* ---------- FAQs ----------

   Empty by design (D14). These five questions used to be hardcoded here, and
   the same five live in the `faqs` table where the Landing Page editor writes
   them. Two copies of the same content, and the literal was what a visitor saw
   whenever content/get.php failed — including after an administrator had
   edited an answer. The stale text rendered exactly like the real thing, with
   nothing to indicate it was months out of date.

   A failed load now says so. An empty accordion that admits it is empty is
   more use to a visitor than a confident wrong answer about how long food
   keeps. */
let FAQS = [];
let FAQS_LOADED = false;

/* =================================================================
   APP STATE  (single object — backend plugs in here)
   ================================================================= */
/* The theme is set by assets/js/theme.js (loaded in <head>): Light, Dark, or
   System default. This only reads what it chose. */
const _savedTheme = document.documentElement.getAttribute("data-theme") || "light";

/* Deliberately NOT restored from localStorage.

   This used to read localStorage["eb-auth"] and, if the stored object said
   `loggedIn:true`, start the page in a signed-in state. localStorage is
   editable from the console, so that was a login: type the right JSON and the
   account menu appeared under any name. bootstrapCustomer() would eventually
   correct it against shop/me.php, but "eventually" is doing real work there —
   until that response landed the page believed it, and if the request failed
   for any reason other than 401 the stale value survived.

   The page now starts signed out and stays that way until the server says
   otherwise. The cost is a brief logged-out header on load for people who
   genuinely are signed in; the benefit is that the only thing that can produce
   a signed-in state is a verified password. */
const _savedAuth = { loggedIn:false, name:"", email:"", id:null, status:null };

const state = {
  theme: _savedTheme,
  cart: [],                        // [{id, qty}]
  auth: _savedAuth,
  filter: { search:"", category:"All", sort:"featured" },
};

/* =================================================================
   HELPERS
   ================================================================= */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const peso = n => CONFIG.currency + n.toLocaleString("en-PH");
const getProduct = id => PRODUCTS.find(p => p.id === id);
const txId = () => "EB-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random()*900+100);

/* Availability, from the public catalogue.

   api/shop/products.php now sends the exact `stock` alongside `inStock` and the
   `stockLevel` band — see that file's header for what publishing the number
   costs and how to narrow it to low-stock-only later. These read it, falling
   back to the band alone for the seeded rows rendered before the catalogue
   loads.

   WHAT THE CAP IS AND IS NOT. productMax() caps the quantity stepper at what is
   actually on the shelf, which stops the storefront from printing "Only 6 left"
   and then accepting 99 in the box beside it. It is a courtesy, not a control:
   api/shop/checkout.php re-reads stock inside its transaction and refuses the
   line with "We only have N of X left" regardless of what the browser allowed.
   The client shows the number; the server still owns it. */
const CART_MAX_QTY = 99;

/* The most of one product a shopper may put in the box.

   Falls back to CART_MAX_QTY when `stock` is absent — a cart line hydrated
   before the catalogue arrived, or a seeded row — because refusing to add
   anything is a worse answer to "we do not know yet" than deferring to the
   server, which does know. */
function productMax(p){
  const stock = p && typeof p.stock === "number" ? p.stock : null;
  if(stock === null) return CART_MAX_QTY;
  return Math.max(1, Math.min(CART_MAX_QTY, stock));
}

/* The stepper's own description of its cap. Every capped stepper carries it, so
   the limit is never silent, and it costs no space on a card. */
function qtyCapAttrs(p){
  const max = productMax(p);
  if(max >= CART_MAX_QTY) return `aria-label="Quantity"`;
  return `aria-label="Quantity, maximum ${max} available" title="Only ${max} in stock"`;
}

/* The VISIBLE line under the stepper, restricted to the scarcity bands.

   Every product with fewer than 99 jars is capped, but printing "Max 143" under
   a card whose pill already reads "In Stock · 143 available" is the same number
   twice, and reads as a warning about a product nothing is wrong with. The line
   earns its space only where a shopper might actually hit the cap, which is the
   same crit/warn bands Inventory::shopLabel() words as scarcity. Above that the
   cap still exists and is still announced — see qtyCapAttrs(). */
function qtyCapHint(p){
  const max = productMax(p);
  if(!p || typeof p.stock !== "number" || max >= CART_MAX_QTY) return "";
  if(p.stockLevel !== "crit" && p.stockLevel !== "warn") return "";
  return `<small class="qty-cap">Max ${max} — all we have left</small>`;
}

/* Mirrors api/uploads/image.php — UPLOAD_MAX_BYTES (8MB) and its $ACCEPTED
   map. Held here so the checkout's dropzone can name the real limit in its
   hint line and refuse an obviously wrong file before spending a round trip
   uploading it. The server re-checks both and reads the MIME from the file's
   own bytes rather than trusting file.type, which is the only check that
   counts; these two exist to save the shopper a wait, not to decide anything.
   If that file's constants change, change these. */
/* The payment methods, keyed by the string the API actually takes.

   THE KEY IS THE VALUE. `data-pay` on each tile holds `cash`/`gcash`/`bank`/
   `net30`/`net60`/`net90` — exactly what api/shop/checkout.php validates
   against Payments::methods() — so there is nothing to translate on the way
   out. What was there instead was:

       pay_method: payment === "Cash" ? "cash"
                 : (payment === "GCash" ? "gcash" : "bank")

   a chained ternary whose FINAL branch is "bank". Adding a Net 30 tile without
   noticing that line would have posted every credit order as a bank transfer:
   the right total, the wrong payment method, no receivable opened, and nothing
   anywhere saying so. The mapping is gone rather than extended, because the
   next person to add a method should not have to find it.

   `label` is for display only — the receipt, and the "reference number
   required for X" message. */
const PAY_METHODS_UI = {
  cash:  "Cash",
  gcash: "GCash",
  bank:  "Bank Transfer",
  net30: "Net 30",
  net60: "Net 60",
  net90: "Net 90",
};
const payLabel = key => PAY_METHODS_UI[key] || key;

/* Mirrors Payments::CREDIT in api/core/Payments.php — the same three terms and
   the same day counts. Spelled out here rather than derived from a response so
   the tiles render with the first paint; the server is what decides whether
   they are allowed, and refuses the key regardless of what was rendered.

   Labelled with what the term MEANS. "Net 30" is trade vocabulary; a first-time
   partner reads "Pay within 30 days" without having to be told. */
const CREDIT_METHODS = [
  { key: "net30", label: "Net 30", hint: "Pay within 30 days" },
  { key: "net60", label: "Net 60", hint: "Pay within 60 days" },
  { key: "net90", label: "Net 90", hint: "Pay within 90 days" },
];
const isCreditMethod = key => CREDIT_METHODS.some(m => m.key === key);

const UPLOAD_MAX_MB  = 8;
const UPLOAD_ACCEPT  = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };

/* Where a GCash or bank payment is SENT: the account name, number and QR code
   maintained in Landing Page Maintenance and served by content/get.php
   (window.EB_LANDING.payment). Used at checkout and on a retailer's Pay form.

   With nothing published it says so, rather than showing an empty frame that
   reads like a broken image. */
function payQrHtml(method){
  const pay = (window.EB_LANDING && window.EB_LANDING.payment) || {};
  const a = pay[method] || {};
  const title = method === "bank" ? "Bank Transfer" : "GCash";
  const rows = [];
  if(method === "bank" && a.bank) rows.push(`<div class="pay-qr-row"><span>Bank</span><b>${esc(a.bank)}</b></div>`);
  if(a.name)   rows.push(`<div class="pay-qr-row"><span>Account name</span><b>${esc(a.name)}</b></div>`);
  if(a.number) rows.push(`<div class="pay-qr-row"><span>${method === "bank" ? "Account number" : "GCash number"}</span><b class="pay-qr-mono">${esc(a.number)}</b></div>`);
  if(!a.qr && !rows.length){
    return `<div class="pay-qr pay-qr-empty">Our ${title} details are not published yet. Contact us for where to send your payment.</div>`;
  }
  /* THE CODE OPENS FULL SIZE IN A NEW TAB.

     A QR has to be big enough for a camera to lock onto, and how big that is
     depends on the screen it is being scanned off and how far away the phone
     is — not on anything this layout can know. So the inline code is as large
     as the card allows, and the image itself is a link to the original upload:
     the browser's own image view scales it to the whole screen, zooms, and
     saves, which is also the only way someone reading this ON their phone can
     scan it at all (they cannot point that phone at its own screen).

     A link and not a modal, deliberately: the checkout IS a modal, and opening
     another over it would replace it and take everything typed so far with it.
     rel="noopener" because target="_blank" without it hands the new tab a
     reference back to this one. */
  /* THE WORDS ARE ABOVE AND BELOW THE CODE, NOT BESIDE IT.

     They used to share a row with it, which cost the code more than half the
     card's width for a heading and two lines of text — and the code is the one
     thing here that has to survive being photographed. Stacked, it gets the
     full width of the card. The account name and number stay ABOVE it, because
     they are what a person checks against their app before sending money, and
     the instruction goes below, where it is read after the code is scanned. */
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

/* ---------- Image resolver, shared with the portal (decision I6) ----------
   site.js is a classic script; EbFormat is published as a global by
   assets/js/core/index.js. Declared as a function, not a const arrow, because
   the seed-array .map() blocks near the top of this file run at parse time and
   a const would still be in its temporal dead zone. */
function imageUrl(rec){ return EbFormat.imageUrl(rec); }

/* Escape anything from the database before it goes into markup.

   THIS FILE HAD NO ESCAPER AND 31 innerHTML ASSIGNMENTS.

   The portal escapes properly — engine.js makes 107 escHtml() calls against 29
   innerHTML, orders.js 66 against 23. The storefront is the half that never got
   one, and the result was a stored XSS reachable by any account holding
   products.manage or landing.manage: a product description saved through the
   normal Product Maintenance form executed as script for every anonymous
   visitor to the shop. Reproduced before this fix, with an <img onerror> that
   set a global; the payload ran.

   ESCAPED AT RENDER, NOT SANITISED AT WRITE. Stripping tags when the
   administrator saves silently destroys their copy — an ampersand in a product
   name is not an attack — and it only protects the rows written after the
   sanitiser was added. Escaping at the point of output is lossless, reversible,
   and covers every row that already exists.

   `esc` for element text, `escAttr` for attribute values. They do the same
   thing — EbFormat.escHtml covers & < > " — and are named apart so a reader can
   see which context each call site is in. */
function esc(v){ return EbFormat.escHtml(v == null ? "" : v); }
function escAttr(v){ return esc(v); }

/* ---------- Image holder ----------
   FOUR arguments. The fourth is the photo, and omitting it is not a smaller
   call — it is the placeholder branch, unconditionally.

   The product card passed it. renderCart() and openProductDetail() did not, so
   `img` was "" and the cart line and the detail modal showed the camera mark
   for every product, including the ones with a photo uploaded. Same function,
   same data, two call sites that had drifted from the third.

   (A product with no photo still shows the placeholder here, and that is
   correct: api/shop/products.php sends `image` => image_url, imageUrl()
   resolves it, and a row with no image_url has nothing to show. That is a
   Product Maintenance upload, not a defect in this file.) */
function jarSVG(tint, label, cls="jar", img=""){
  /* Real photo when the admin has uploaded one, placeholder otherwise. `img`
     has already been through imageUrl() by the time it arrives here. */
  /* `label` is a product name from the database and lands in three attributes;
     `img` is a path from imageUrl(). Both escaped. */
  const L = escAttr(label);
  if(img){
    return `<div class="img-holder has-photo" aria-label="${L}" title="${L}">
      <img src="${escAttr(img)}" alt="${L}" loading="lazy" draggable="false">
    </div>`;
  }
  const camIcon = ICONS.camera || '';
  return `<div class="img-holder" aria-label="${L}" title="${L}">
    <span class="ph-icon" aria-hidden="true">${camIcon}</span>
    <span class="ph-label">Product Photo</span>
  </div>`;
}

/* ===================================================================
   STAR RATING — AND THE HONEST ZERO
   -------------------------------------------------------------------
   THE COUNT IS NOT OPTIONAL. Every product used to be seeded with a
   rating between 4.5 and 4.9 that nothing had ever written from
   evidence, so a product nobody had rated advertised "4.9" beside its
   name. products.rating is now derived from published reviews
   (Reviews::recompute) and is 0.00 when there are none.

   Which makes rendering it blindly WORSE than before, not better: five
   empty stars and "0.0" reads as a product people rated badly. So a
   product with no reviews gets no stars at all — it gets a sentence
   saying so. That is the honest thing to show, and it is the reason
   reviewCount travels with rating from api/shop/products.php.

   `count` is deliberately a required argument rather than one that
   defaults to something. A call site that forgets it throws here, in
   development, instead of quietly resurrecting the old lie.
   =================================================================== */
function starRating(r, count){
  const n = Number(count);
  if(!Number.isFinite(n)){
    throw new TypeError("starRating(rating, count): count is required — see the note above.");
  }
  if(n <= 0){
    /* Not "0.0", not five hollow stars. Nobody has said anything yet. */
    return '<span class="stars stars-none">No ratings yet</span>';
  }
  const label = `Rated ${r.toFixed(1)} out of 5, from ${n} review${n === 1 ? "" : "s"}`;
  let html = `<span class="stars" aria-label="${label}">`;
  for(let i=1;i<=5;i++){
    if(r >= i)        html += ICONS.star;
    else if(r >= i-.5)html += ICONS.starhalf;
    else              html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>';
  }
  /* The number of reviews sits beside the average because the average
     alone cannot be judged: one five-star review and forty are the same
     "5.0" and are not the same claim. aria-hidden because the label
     above already says all of it, in a sentence. */
  html += `<span class="rv">${r.toFixed(1)}</span><span class="rc" aria-hidden="true">(${n})</span></span>`;
  return html;
}

/* The photo card's floating rating badge — one star, not five, because five
   small stars stop being legible at the size a badge sitting on top of a
   photo can spare. Same honest-zero rule as starRating() above (a product
   with no reviews gets no badge, not an empty one), written separately
   rather than reused because starRating()'s five-star row is a different
   shape of answer to the same question, built for the space .pc-meta has
   rather than the space this has. */
function ratingBadge(p){
  const n = Number(p.reviewCount);
  if(!Number.isFinite(n) || n <= 0) return "";
  const label = `Rated ${p.rating.toFixed(1)} out of 5, from ${n} review${n === 1 ? "" : "s"}`;
  return `<span class="pc-rating-badge" aria-label="${label}">${icon("star")}<b>${p.rating.toFixed(1)}</b><span aria-hidden="true">(${n})</span></span>`;
}

/* =================================================================
   RENDER: product card factory (used by Shop + Best Sellers)
   -----------------------------------------------------------------
   THE MEDIA LINE BELOW WAS DEFECT 3.2.

   api/shop/products.php sends the photo as "image". This function read
   p.img, which is undefined for every product, so every card took the
   placeholder branch — while the POS tiles, which read "image", showed
   the photo perfectly well. That asymmetry is what made it look like a
   staff-versus-customer problem rather than what it was: one endpoint
   and one renderer spelling the same field two ways, with 1.8MB of
   base64 downloaded and discarded on every page load.

   It goes through imageUrl() now, which accepts either key and resolves
   the stored path against the application root, so neither half of the
   mistake can return.
   ================================================================= */
/* PHOTO-FIRST CARD — the request's reference image, built from what the
   catalogue actually has rather than the fields the reference happened to
   show. Four of its pieces have no product underneath them here: a
   favorite/heart toggle (no wishlist feature exists), a spice-level tag, a
   "serves N" count, and a delivery-time estimate. Rather than invent values
   for those — which is how this codebase ended up with a seeded 4.9-star
   rating nobody had earned, see starRating() above — this keeps the
   reference's LAYOUT (a full-bleed photo carrying the name, price and
   rating; a compact bar below it for status and the buy action) and fills
   it with what is real: category, price, rating (honest-zero, never
   fabricated), units sold, stock status, Add to cart.

   STOCK STATUS LIVES ON THE PHOTO, "N sold" LIVES IN THE BAR — the reverse
   of the first version. Stock labels are server text of very different
   lengths ("Out of Stock" against "In Stock · 160 available", see
   Inventory::shopLabel()), and the bar is flow layout: whichever card in a
   row got the longer label wrapped its bar onto two lines and grew taller
   than its neighbours, which is the "some cards have more space at the
   bottom" a shopper actually reported. "N sold" never has that problem — it
   is always a number and a word. Swapping them moves the unpredictable
   string onto the overlay, which is position:absolute inside a fixed
   aspect-ratio photo, so wrapping there costs nothing: the photo's height
   does not depend on what is drawn over it, only the bar's height did.

   NO qtyCapHint() HERE EITHER, for the same complaint from a second
   direction. It used to print "Max 9 — all we have left" under the Add
   button on scarce products, and Inventory::shopLabel() ALWAYS folds the
   count into the label itself once stock is low enough to trigger the hint
   ("Only 9 left", "Low stock · 6 left") — so the hint was never telling a
   shopper the count, just repeating the one .stock-pill already showed, the
   exact "same number twice" its own original comment said to avoid. It also
   only appeared on SOME cards, which is a second content-driven height in a
   grid row: a shop grid stretches every card in a row to match the tallest
   one (CSS Grid's default align-items), so the one scarce product in a row
   grew and everything beside it grew an equal, empty amount to match — the
   dead space under an ordinary card's Add button that prompted this fix.
   Dropping the hint removes a real duplicate and the one piece of the card
   whose presence depended on the PRODUCT rather than the LAYOUT. The modal's
   own copy (openProductDetail(), further down) is untouched: one card in a
   dialog has no row of neighbours to stretch, so it was never the bug here —
   though it is worth knowing the same redundancy exists there too.

   THE STEPPER IS GONE. The reference has no quantity picker on the card —
   its Add button is a single action — and every other card on this site
   let a shopper choose a quantity before adding. Rather than silently drop
   that ability, it moved: the card's Add button adds one (the delegated
   handler already falls back to qty=1 when no stepper is found, see the
   click listener below), and openProductDetail()'s modal still carries its
   own stepper for anyone who wants more than one before checking out. A
   description one line down is a design compromise, not a config the two
   surfaces disagree on. */
function createProductCard(p, {ribbon=false}={}){
  const s = stockInfo(p);
  const out = !productAvailable(p);
  const el = document.createElement("article");
  el.className = "card product-card";
  el.dataset.id = p.id;
  el.innerHTML = `
    <div class="pc-media" data-detail="${escAttr(p.id)}" role="button" tabindex="0" aria-label="View ${escAttr(p.name)} details">
      ${jarSVG(p.tint, p.name, 'jar', imageUrl(p))}
      <div class="pc-scrim" aria-hidden="true"></div>
      ${ribbon && p.best ? `<span class="ribbon">${icon("star")} Best Seller</span>` : ""}
      <div class="pc-overlay">
        <div class="pc-overlay-top">
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

/* The shop's sort options, as one table rather than a switch.

   WHY A TABLE. Top 5 and Top 10 are a comparator PLUS a cap, and a switch
   returning only a comparator has nowhere to put the cap — which is how a
   "top 5" ends up implemented as a slice somewhere else in the function,
   separated from the ranking it is supposed to be the top of.

   `featured` and `best-selling` are deliberately different orders. `featured`
   is the administrator's shelf: the products flagged is_best first, units sold
   only as a tie-break. `best-selling` is the unedited ranking, and it is what
   Top 5 and Top 10 are the top of — otherwise "Top 5" would mean "the five
   flagged products, or fewer", which is a curation, not a ranking.

   Mirrors the $sortMap in api/shop/products.php. The grid does not use that
   map today (see renderProducts below), but the endpoint offers the same keys
   so a future server-paged grid can send `sort` straight through. */
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

/* render the shop grid honoring filter/search/sort

   THE GRID IS NOT SERVER-PAGED. loadShopCatalog() fetches api/shop/products.php
   once, with no page or limit parameter, into PRODUCTS; every filter, sort and
   search below runs over that array. So the Top 5 / Top 10 cap belongs HERE and
   only here — there is no page two for a client-side slice to contradict, and
   pushing the cap to the endpoint would cap the catalogue the search box and
   the category chips are filtering, not the list the shopper is looking at.

   That last point is the whole of "Top 5 within a category". The cap is applied
   AFTER the category and search filters, so Top 5 of Deboned Bangus is the five
   best-selling Deboned Bangus — not the global five with the non-matching ones
   removed, which would show two cards under a heading promising five. */
function renderProducts(){
  const grid = $("#product-grid");
  if(!grid) return;
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

  /* Say WHY the list is short. "Showing 5 products" beside a category holding
     nine reads as a broken filter; naming the cap and the total it was taken
     from does not.

     THIS FUNCTION OWNS THE LINE OUTRIGHT, IN BOTH CASES. The first version
     wrote the capped wording and merely cleared the flag when the cap came
     off, leaving the previous sentence on screen and trusting shop.html's
     MutationObserver to correct it. Observer callbacks are a microtask late,
     so switching from Top 5 to Best Selling showed "the top 5 best sellers of
     15" over a grid of fifteen until the next tick — and any render that
     mutated nothing would never have corrected it at all. Writing both
     sentences here means the line is never momentarily false. The `owned`
     flag stays set from now on, so the DOM-counting fallback (which cannot
     know the pre-cap total) permanently defers. */
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

/* Grid ⇄ row toggle for the shop's product list — a per-viewer convenience
   the adviser asked for on top of the normal page scroll, not a replacement
   for it: nothing here touches how the PAGE scrolls, only how the product
   list itself does once the shopper opts into "row".

   The class lives on #product-grid, which renderProducts() empties and
   refills on every filter/sort/search but never replaces, so a chosen view
   survives a re-render without this function needing to run again. */
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

  /* THIS is the "sideways scroll wheel" the request asked for. An ordinary
     mouse wheel only ever reports a vertical delta — a trackpad or a wheel
     with a tilt function can already pan sideways on its own, but a plain
     wheel cannot, and without this a "sideways-scrolling" row would do
     nothing for the shopper who asked for it. It only fires in row mode:
     in grid mode the same wheel event is left alone and the page scrolls
     normally, which is the "do not remove the normal scrolling" half of the
     request. Guarded by deltaX so a gesture that IS already horizontal
     (trackpad, tilt-wheel) is not doubled. */
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
  /* The admin's Landing Page module writes a chosen list; fall back to the
     `best` flag when nothing has been saved yet. */
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

  /* Wheel geometry. WHEEL_STEP is the angle between neighbouring cards on
     the rim; everything else follows from it because the pivot lives far
     below the stage (see --wheel-origin in styles.css). Index 0 is the
     centre card, 1 its neighbours, 2 the pair clipped at the edges. */
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

      /* wrap-around: a card jumping from one end of the arc to the other
         must snap rather than tween straight back through the centre */
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
      slide.style.cursor = abs === 0 ? "auto" : "pointer";
    });
    dots.forEach(function(d, i){ d.classList.toggle("active", i === current); });
  }

  /* rapid clicking switches to a short transition so cards don't
     pile up mid-flight on the 2.5s glide */
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
    /* Give the visitor the full dwell time after they choose a card, instead
       of letting the already-running timer fire moments later. Stay paused if
       the pointer is still on the carousel. */
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

  /* Track hover explicitly: navPaint() restarts the countdown after a manual
     choice, and without this flag an arrow click would resume autoplay even
     though the pointer is still resting on the carousel. */
  var hovering = false;
  track.addEventListener("mouseenter", function(){ hovering = true;  pause();  });
  track.addEventListener("mouseleave", function(){ hovering = false; resume(); });

  paint();
  resume();
}

/* =================================================================
   RENDER: certifications, FAQ, trust badges
   ================================================================= */
function renderCerts(){
  const make = c => `<div class="cert"><span class="ring">${esc(c.code)}</span><small>${esc(c.label)}</small></div>`;
  const aboutCerts = $("#about-certs");
  if(aboutCerts) aboutCerts.innerHTML = CONFIG.certifications.map(make).join("");
  /* #trust-badges removed — the element does not exist in any HTML file.
     #about-certs and #foot-certs below are real and stay. */
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
    /* D14: an error state, never invented rows. Distinguishes "still loading"
       from "we could not reach the server" — a visitor can act on the second
       by trying again, and can act on neither if both look the same. */
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

/* =================================================================
   UI PRIMITIVE: TOAST
   ================================================================= */
function showToast(msg, type="success", opts={}){
  /* Two separate faults were fixed here.

     1. `msg` went in as innerHTML. Callers compose it from database values —
        `${p.name} added to cart` is the obvious one — so a product name
        containing markup executed. The icon is ours and stays as markup; the
        message is data and is escaped.

     2. `wrap.appendChild(t)` ran with no null check. #toast-wrap does not exist
        on profile.html or my-orders.html — both declare #toast-root — so EVERY
        toast on the two customer account pages threw
        "Cannot read properties of null (reading 'appendChild')" and the
        customer was told nothing at all: not "Address saved", not "Password
        changed", not any error. The saves themselves worked, which is what made
        it invisible.

     Both container ids are accepted, and a page with neither degrades to the
     console instead of throwing — the same thing EbUI.toast() in
     assets/js/core/ui.js has always done. That this file's twin lacked the
     guard is the duplicate-implementation drift catalogued in REMEDIATION.md.

     TWIN: EbUI.toast() in assets/js/core/ui.js serves the portal. It is a
     different markup contract on purpose — #toast-container, types ok/err/warn,
     a flat bordered card with no icon well — and its glyphs are already sized
     by portal.css. Behaviour is what has to stay in step between the two, not
     structure. Change one, read the other. */
  const wrap = $("#toast-wrap") || $("#toast-root");
  if(!wrap){ console.log(`[${type}] ${msg}`); return; }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  /* The non-success marker is an EMPTY well, filled by CSS with a dot.

     It used to be ICONS.cart, and that was wrong twice over. Geometrically:
     ICONS.check draws `M20 6 9 17l-5-5`, inset well inside its 24x24 box, so
     it sits happily in a 22px circle. ICONS.cart starts at `M1 1`, runs out to
     x=23 and puts its two wheels down at cy=21 — corner to corner, so in the
     same circle it touches the edge and reads bottom-left heavy. Semantically:
     a shopping trolley says nothing at all on "Signed out." or on an upload
     failure, which are two of the messages that carried it.

     A dot carries no false meaning and cannot be off-centre. The check stays
     for success, where it means something. */
  t.innerHTML = `<span class="ic">${type==="success"?ICONS.check:""}</span><span class="toast-msg">${esc(msg)}</span>`;

  let timer = null;
  const dismiss = () => {
    if(timer){ clearTimeout(timer); timer = null; }
    t.classList.add("out");
    setTimeout(()=>t.remove(), 320);
  };

  /* An optional action, so a destructive change can be offered back instead of
     asked about first. Removing a cart line used to be the only way to empty
     it and there was no way to take it back; a confirm() would have been the
     obvious fix and is the wrong one — nothing else on this storefront uses a
     browser dialog, and a prompt in front of every removal taxes the ninety
     per cent of removals that were meant. Undo taxes the ten per cent that
     were not.

     The window is longer than a plain toast's: an undo the reader has not
     finished reading is not an undo. */
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

/* =================================================================
   UI PRIMITIVE: MODAL  (serves product detail, login, register, checkout, receipt)
   ================================================================= */
let lastFocus = null;
function openModal(title, bodyHTML, {wide=false, onOpen}={}){
  /* EVERY NODE IS OPTIONAL, AND THAT IS THE POINT.

     This opened with `$("#modal-title").textContent = title` and nothing else.
     The four pages under public/profile/ had no #modal-title, so that first
     line threw TypeError and the function died before opening anything — SIGN
     IN on the signed-out guard and Proceed to Checkout in the cart drawer both
     read as dead buttons on those pages, while working on index.html and
     shop.html, which have the element.

     The markup is fixed as well (all five copies now carry the full shell), so
     this guard should never fire again. It stays because the last identical
     bug — #toast-wrap vs #toast-root, see showToast() — was also "fixed in the
     markup", and the markup drifted again. A missing SCRIM is the one thing
     worth refusing over: without it there is no dialog to show and pretending
     otherwise would lock the page scroll with nothing on screen. */
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
  $("#modal")?.classList.toggle("wide", wide);
  scrim.classList.add("open");
  document.body.style.overflow = "hidden";
  $("#modal")?.classList.remove("is-auth");   /* auth's onOpen adds it back */
  if(onOpen) onOpen(body);
  const f = body.querySelector("input,select,textarea,button");
  if(f) setTimeout(()=>f.focus(), 60);
}
/* ── Sign-up STEP 2: email verification ─────────────────────────
   Shown in place of the Create Account form once shop/register.php has
   emailed a code. The account is created only by register-verify.php,
   after the code matches. "Edit details" goes back to the (still filled)
   form; nothing was saved, so there is nothing to undo. */
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

function closeModal(){
  /* Guarded for the same reason openModal() is. This one could be reached on a
     page with no modal at all — the Escape handler calls it unconditionally on
     every keydown — and an unguarded scrim lookup would throw on every press of
     Escape rather than only when something tried to open. */
  $("#modal-scrim")?.classList.remove("open");
  document.body.style.overflow = "";
  /* Drop the auth look only after the fade-out. Removing it at once turned
     the dark two-panel login into the plain white modal mid-fade — the
     "white pop" on clicking outside. Skipped if something reopened. */
  setTimeout(() => {
    if(!$("#modal-scrim")?.classList.contains("open")) $("#modal")?.classList.remove("is-auth");
  }, 400);
  if(lastFocus) lastFocus.focus();
}

/* =================================================================
   CART logic
   ================================================================= */
/* PRODUCTS, not units.

   This was `reduce((n,i)=>n+i.qty, 0)`, so two products at quantity 2 gave 4:
   the header badge said 4 and the drawer said "Subtotal (4 items)" when two
   things had been added. "Items" is the ambiguous word that let it pass — it
   reads as either, so neither number looked wrong.

   One definition, used by the badge, by the drawer label and by
   api/shop/cart.php's `count`, so the badge cannot disagree with itself
   depending on whether the cart came from the server or from local state.
   The label says "products" rather than "items" so the number names itself.

   The unit total is not computed anywhere any more. Nothing wanted it: the
   old cartCount() had exactly these two callers. If the header badge is later
   meant to show units, it is one helper and one call site. */
const cartLineCount = () => state.cart.length;
/* Guarded on the product. Every line used to be dereferenced straight through
   getProduct(), which is a lookup into PRODUCTS — a list loaded asynchronously
   from shop/products.php. Once the cart arrives from the server it can arrive
   BEFORE that list does, and `getProduct(id).price` on undefined throws and
   takes the whole drawer with it. mergeCartProducts() below means this should
   never fire; it is here because "should never" is not a guarantee. */
const cartSubtotal = () => state.cart.reduce((s,i)=>{
  const p = getProduct(i.id);
  return s + (p ? p.price * i.qty : 0);
}, 0);

let pendingCartAdd = null; // item queued while user logs in

/* =================================================================
   CART PERSISTENCE — the cart is on the account, not in the tab
   -----------------------------------------------------------------
   state.cart was `cart: []` and nothing else. A reload emptied it, signing out
   emptied it, and a second device never saw it — so the badge rendering 0 was
   not a badge defect, there genuinely was nothing there.

   NOT localStorage, and the reason is already written down in this file: read
   the comment above _savedAuth. The signed-in flag used to be restored from
   localStorage, which made typing the right JSON into the console a login.
   That flag is deliberately not restored any more. A cart in localStorage is
   the same mistake one size down — per-browser rather than per-account, so it
   misses the device change that is most of the point, and shared by everyone
   who uses the machine.

   db/migrations/007-persistent-cart.sql, api/shop/cart.php and
   api/shop/cart-save.php are the other three quarters of this.
   ================================================================= */

/* Write one line through to the server.

   The UI has already been updated and redrawn by the time this runs — a
   stepper that waits for a round trip before moving is a stepper that feels
   broken on a slow connection. What this owns is the failure: `rollback` puts
   state.cart back the way it was, and the shopper is told, rather than being
   left with a drawer that disagrees with the database.

   Signed out is not a failure. addToCart() refuses before this point, so the
   only way to be here without a session is a stale tab; there is nowhere to
   save to and nothing to say about it. */
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

/* Fold the product fields the cart endpoint sends into PRODUCTS.

   shop/cart.php joins each line to its product and returns name, price, image
   and tint alongside the quantity, so the drawer can be drawn from the cart
   response alone. Without this the drawer would depend on loadShopCatalog()
   having already resolved — two independent requests, and renderCart() would
   be correct or blank depending on which won.

   Existing entries are not overwritten: the catalogue row is richer (it has
   the long description, the nutrition line and the rating the product detail
   modal needs) and this one is a subset of it. */
function mergeCartProducts(items){
  (items || []).forEach(it => {
    if(getProduct(it.id)) return;
    PRODUCTS.push({
      id: it.id, name: it.name, price: it.price, image: it.image,
      tint: it.tint, cat: it.cat, desc: "", long: "", nutri: "",
      /* reviewCount 0 alongside rating 0 — starRating() requires it, and a
         cart-derived stub genuinely knows nothing about this product's
         reviews. "No ratings yet" is the correct thing for it to say. */
      rating: 0, reviewCount: 0, sold: 0, best: false,
      inStock: it.inStock, stock: it.stock,
      stockLevel: it.stockLevel, stockLabel: it.stockLabel,
    });
  });
}

/* Load the signed-in customer's cart and render it.

   Returns the server's payload so a caller can act on the count — signIn()
   uses it for the "items waiting" reminder — or null when there is no session
   or the request failed. A failed load leaves state.cart alone rather than
   emptying it: "the request did not come back" says nothing about what is in
   the cart, and rendering zero would read as "we lost it". */
async function loadServerCart(){
  if(!state.auth.loggedIn) return null;
  try {
    const { data } = await EbApi.get("shop/cart.php");
    mergeCartProducts(data.items);
    state.cart = data.items.map(i => ({ id: i.id, qty: i.qty }));
    updateCartBadge();
    renderCart();

    /* The server reconciles a saved cart against the current catalogue —
       archived products dropped, quantities clamped to stock — and reports
       what it changed. Saying so is the entire point of reporting it; a cart
       that quietly loses a line is worse than the stale line was. */
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
  /* Refused against what is on the shelf, not a flat 99, now that the card has
     told the shopper the number. The server still re-checks at checkout — this
     only spares them a failure they could already see coming. */
  const max = productMax(p);
  if(newQty > max){
    showToast(max < CART_MAX_QTY
      ? `Only ${max} of ${p.name} left`
      : `Maximum ${CART_MAX_QTY} per item`, "info");
    return;
  }
  if(line) line.qty = newQty; else state.cart.push({id, qty});
  updateCartBadge(true);
  renderCart();
  showToast(`${p.name} added to cart`, "success");
  /* Screen first, server second. If the write is refused — the product went
     out of stock between the page loading and this click — the line goes back
     to what it was and the shopper is told why. */
  await saveCartLine(id, newQty, () => {
    if(prevQty > 0){ const l = state.cart.find(i=>i.id===id); if(l) l.qty = prevQty; }
    else state.cart = state.cart.filter(i=>i.id!==id);
  });
}
/* Several lines at once (Reorder). One badge/drawer refresh and no per-line
   toast; the caller says what happened. Each line is capped at the shelf,
   and a line the server refuses is rolled back like addToCart's. */
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
  /* The floor stays at 1. This clamp is what protects the typed number input,
     where 0 is not a quantity — "remove this line" is a decision made by the
     minus button and the change handler, which know the difference. */
  qty = Math.max(1, Math.min(qty, productMax(getProduct(id))));
  const line = state.cart.find(i=>i.id===id);
  if(!line) return;
  const prevQty = line.qty;
  if(prevQty === qty) return;
  line.qty = qty;
  updateCartBadge(); renderCart();
  saveCartLine(id, qty, () => { const l = state.cart.find(i=>i.id===id); if(l) l.qty = prevQty; });
}
/* Removal is immediate and reversible.

   The line goes now — no dialog standing between the shopper and the thing
   they just asked for — and the toast carries the way back. The index is kept
   as well as the line so an undo puts it back WHERE it was rather than at the
   bottom of the drawer, which reads as a different cart. */
function removeFromCart(id){
  const idx = state.cart.findIndex(i => i.id === id);
  if(idx < 0) return;
  const [line] = state.cart.splice(idx, 1);
  const p = getProduct(id);
  updateCartBadge(); renderCart();
  showToast(`${p ? p.name : "Item"} removed from your cart`, "info", {
    action: { label: "Undo", onClick: () => restoreCartLine(idx, line) },
  });
  /* qty 0 is the delete. If the delete is refused the line comes back, and
     `false` stops that restore posting a write of its own — the row was never
     removed server-side, so there is nothing to put back there. */
  saveCartLine(id, 0, () => restoreCartLine(idx, line, false));
}

function restoreCartLine(idx, line, persist=true){
  /* The shopper may have added the same product again while the toast was up.
     Putting the old line back on top of the new one would silently overwrite
     whatever quantity they just chose. */
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
      <div class="thumb">${jarSVG(p.tint, p.name, 'jar', imageUrl(p))}</div>
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

/* =================================================================
   LOCKOUT COUNTDOWN
   -----------------------------------------------------------------
   WHY A COUNTDOWN AND NOT JUST A MESSAGE

   A lockout used to arrive as "Email or password is incorrect", which
   sent people back to retype a password that was already right. It now
   says it is a lockout and how long it lasts — but a static "try again
   in 10 minutes" still leaves somebody watching a clock and guessing
   whether the wait has elapsed. The number ticks so they can see it.

   IT ALSO DISABLES THE BUTTON. A form that accepts a submission it
   knows will be refused is teaching people that the message is
   advisory. Re-enabled the moment the wait reaches zero.

   The server is still the authority: this only mirrors `retryAfter`
   from the 429. Reloading the page clears the countdown, and the next
   attempt is refused again with a fresh number.
   ================================================================= */
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

  /* No number to count. Show what the server said and leave the form
     usable — refusing to accept input on a wait we cannot measure would
     strand the person entirely. */
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

/* =================================================================
   PRODUCT REVIEWS — the read-only list under the product detail
   -----------------------------------------------------------------
   NO STAR INPUT HERE, DELIBERATELY. The only place a rating can be
   written is My Orders, on a line of an order that reached `completed`
   (renderOrderReviewControl below). A star input on the product page
   would have to be disabled for almost everyone who saw it, and a
   control that is usually refused teaches people to ignore controls.
   The path from purchase to review runs through the order, which is
   also the evidence api/shop/review-save.php checks.

   "Verified purchase" is rendered on EVERY row without checking a
   field, because it is true of every row by construction — the table
   requires an order id and the endpoint derives it. A flag would imply
   some rows are unverified, which would be false and, worse, would be
   something a future bug could make true without anyone noticing.
   ================================================================= */
function reviewStars(n){
  let html = `<span class="stars" aria-label="${n} out of 5">`;
  for(let i=1;i<=5;i++){
    html += i <= n ? ICONS.star
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>';
  }
  return html + "</span>";
}

/* The 1-5 histogram. An average alone cannot be judged: twenty fives and
   four ones averages the same 4.2 as twenty-four fours, and they are not
   the same product. The bar is aria-hidden because the row already reads
   as "5 stars, 12 reviews" — a bar announced twice is noise. */
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

    /* THE ZERO CASE IS A SENTENCE, NOT AN EMPTY LIST. A heading with
       nothing under it reads as a page that failed to load. */
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

    /* The customer's OWN review, at whatever status. Somebody whose review
       is held needs to be told that rather than left to conclude it
       vanished, and a rejection is shown with the reason a moderator was
       required to give — a refusal with no stated cause is
       indistinguishable from censorship. */
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
    /* The product detail is still useful without the reviews, so this
       reports and stops rather than taking the modal down with it. */
    host.innerHTML = `<h4 class="pd-rev-title">Reviews</h4>
      <p class="pd-rev-empty">Reviews could not be loaded just now.</p>`;
    console.warn("[reviews]", err);
  }
}

/* =================================================================
   PRODUCT DETAIL modal
   ================================================================= */
function openProductDetail(id){
  const p = getProduct(id);
  const s = stockInfo(p);
  const out = !productAvailable(p);
  const body = `
    <div class="pd-grid">
      <div class="pd-media">${jarSVG(p.tint, p.name, 'jar', imageUrl(p))} ${p.best?`<span class="ribbon">${icon("star")} Best Seller</span>`:""}</div>
      <div class="pd-info">
        <span class="pc-cat">${esc(p.cat)}</span>
        <div class="pc-meta" style="margin:8px 0">${starRating(p.rating, p.reviewCount)} <span>· ${p.sold.toLocaleString()} sold</span></div>
        <p class="pd-desc">${p.long}</p>
        <div class="pd-nutri"><b>Nutrition:</b> ${p.nutri}</div>
        <span class="stock-pill ${s.cls}">${s.label}</span>
        <div class="pd-price">${peso(p.price)}</div>
        <div class="pd-actions">
          ${out?"":`<div class="stepper" data-stepper>
            <button type="button" data-step="-1" aria-label="Decrease quantity">${ICONS.minus}</button>
            <input type="number" value="1" min="1" max="${productMax(p)}" ${qtyCapAttrs(p)} />
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
      addToCart(e.currentTarget.dataset.addDetail, qty);
      closeModal(); openCart();
    });
    /* Not awaited: the detail is complete and usable without it, and blocking
       the modal on a second request would make every product feel slow. */
    loadProductReviews(p.id, root);
  }});
}

/* =================================================================
   CHECKOUT  (Delivery/Pickup · Cash/GCash/Bank · proof-of-payment mock)
   ================================================================= */
/* "Edit" switch for a checkout section. Signed-in only: a guest has no saved
   profile to lock, so their fields are always open. */
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

  /* Credit terms are a retail-partner facility. Rendered from
     state.auth.status, which is what shop/me.php and shop/login.php report —
     presentation only. api/shop/checkout.php re-derives the status from the
     customers row inside the request and validates pay_method against
     Payments::methods($isRetailer), so a hand-crafted `net30` from a regular
     customer is refused there. A hidden tile stops nobody; that check does. */
  const isRetailer = state.auth.status === "retailer";
  /* Three columns, not "Name x 2". The old line said what was bought and what
     it cost in total, and left the shopper to divide one by the other to check
     the unit price — which is the number they actually remember from the shop
     page. */
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
          <div class="li tot"><span class="li-name">Total</span><span class="li-qty">${cartLineCount()} ${cartLineCount()===1?"product":"products"}</span><span class="li-amt">${peso(sub)}</span></div>
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
          <div class="field"><label for="co-name">Full Name *</label><input class="control" id="co-name" type="text" placeholder="Juan dela Cruz" value="${escAttr(state.auth.loggedIn?state.auth.name:"")}"><span class="field-error" data-err></span></div>
          <div class="field"><label for="co-contact">Contact Number *</label><input class="control" id="co-contact" type="tel" placeholder="09xx xxx xxxx"><span class="field-error" data-err></span></div>
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
          <div class="field"><label for="co-ref">Reference Number *</label><input class="control" id="co-ref" type="text" placeholder="e.g. 1234 5678 90"><span class="field-error" data-err></span></div>
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
        <div class="co-foot-total"><span>Total</span><b>${peso(sub)}</b></div>
        <button type="submit" class="btn btn-primary co-submit">Place Order</button>
      </div>
    </form>`;

  openModal("Checkout", body, {wide:true, onOpen:(root)=>{
    /* `payment` now holds the API key, not a display string. */
    let orderType = "delivery", payment = "cash";

    /* WITHHOLDING TAX. A retailer registered as a withholding agent (VAT
       Maintenance) pays the total LESS the tax it keeps for the BIR, so it
       needs to be told the amount to actually transfer — send the full total
       and Payment Verification sees a screenshot that does not match. The
       figure is the server's (shop/quote.php runs the same Tax::compute() the
       checkout does); nobody else is asked, so a regular shopper's checkout
       makes no extra request. */
    if (isRetailer) {
      EbApi.post("shop/quote.php", { items: state.cart.map(i => ({ id: i.id, qty: i.qty })) })
        .then(({ data }) => {
          const t = data.tax, note = root.querySelector("#co-tax-note");
          if (!note || !(t.withholdingTax > 0)) return;
          note.innerHTML = `<div class="li"><span class="li-name">Less: withholding tax (${+t.withholdingRate}%)</span>`
            + `<span class="li-qty">you remit to the BIR</span><span class="li-amt">− ${EbFormat.pesoExact(t.withholdingTax)}</span></div>`
            + `<div class="li tot"><span class="li-name">Amount to pay</span><span class="li-qty">send BIR Form 2307</span>`
            + `<span class="li-amt">${EbFormat.pesoExact(t.amountDue)}</span></div>`;
          note.hidden = false;
        })
        .catch(() => { /* The checkout computes it anyway; the note is a courtesy. */ });
    }
    const addrField = root.querySelector("#address-field");
    /* The picker's behaviour: cascade, loading, cache, prefill, errors. One
       controller for the four dropdowns and two typed fields. */
    const addr = EbAddress.mount(root, "co");

    /* ---- PREFILL (decision I9) ---------------------------------------
       A SUGGESTION, NOT AN OVERRIDE.

       Rules, in the order they matter:
         1. Identity comes from the SESSION. shop/profile.php takes no
            customer id and no email; there is nothing to pass and nothing to
            forge (D6, D7).
         2. Only EMPTY fields are filled. The request is asynchronous, and a
            shopper who starts typing their number before it lands must not
            have it overwritten mid-keystroke — which is exactly what a naive
            `el.value = data.contact` would do.
         3. Every prefilled field stays editable. Nothing is disabled or
            readonly.
         4. Editing a prefilled field does NOT write back to the profile.
            The checkbox does, and only if ticked. A checkout is often placed
            for somebody else — a gift, an office delivery — and silently
            rewriting the saved address because a customer typed a one-off
            one is a bug that only shows up weeks later.

       EMPTY CASES, all real and all handled:
         - not signed in         no request is made
         - no saved address      the address box is left empty and usable;
                                 nothing announces a missing address
         - partial address       whatever exists is joined and used
         - request fails         logged, form untouched. A shopper cannot act
                                 on "profile service unavailable" */
    const prefilled = { contact: false, address: false };

    /* EDIT SWITCHES. Signed in: address and details open locked (inert) on the
       saved profile; the switch unlocks them. The save-to-profile box only
       shows while something is unlocked — nothing locked can have changed. */
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
          /* The marker is a hint about where the value came from, so it goes
             the moment the customer makes it theirs. */
          el.addEventListener("input", () => el.classList.remove("is-prefilled"), { once: true });
          return true;
        };

        prefilled.contact = fillIfEmpty("#co-contact", profile.contact);
        /* The address goes through the picker's own prefill, which keeps every
           rule above: it fills only what is still empty, walks the dropdowns in
           order waiting for each list, stops the moment the shopper touches any
           of them, disables nothing, and writes nothing back. */
        prefilled.address = await addr.prefill(profile.address);
        if (!root.querySelector("#co-name").value.trim() && profile.name) {
          root.querySelector("#co-name").value = profile.name;
        }

        /* An incomplete saved profile can't be ordered with locked — open
           whichever part is missing something. */
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
      });
    });

    /* CASH IS A PICKUP-ONLY METHOD.

       It is money handed over at the counter. On a delivery there is no
       counter — the goods travel to the customer and the payment does not
       travel back, so a refusal at the door leaves the shop holding both the
       loss and the return trip. api/shop/checkout.php refuses the combination
       outright; this keeps the form from offering it in the first place.

       DISABLED RATHER THAN REMOVED. A tile that vanishes when Delivery is
       picked reads as a glitch, and a customer who wanted to pay cash learns
       nothing. Greyed out with its hint rewritten to "Pickup only" answers the
       question where it is asked.

       The default state needs this too: the form opens on Delivery AND Cash,
       which is now a combination the server would reject — so this runs once
       at wiring time, not only on change. */
    function syncPayForOrderType(){
      const cashBtn = root.querySelector('#co-payment .tg[data-pay="cash"]');
      if(!cashBtn) return;
      const blocked = orderType === "delivery";
      cashBtn.disabled = blocked;
      cashBtn.classList.toggle("tg-unavailable", blocked);
      cashBtn.title = blocked ? "Cash is available on pickup only." : "";
      const hint = cashBtn.querySelector("small");
      if(hint) hint.textContent = blocked ? "Pickup only" : "Pay when you collect";
      /* Moved, not just disabled: leaving `payment` on a method the server will
         reject sends the customer to a validation error they cannot see the
         cause of. Done with a real click so the proof block and the QR follow
         the same path they would for any other choice. */
      if(blocked && payment === "cash"){
        root.querySelector('#co-payment .tg[data-pay="gcash"]')?.click();
      }
    }

    // payment method reveals proof fields for GCash/Bank
    const proof = root.querySelector("#proof-block");
    root.querySelectorAll("#co-payment .tg").forEach(b=>{
      b.addEventListener("click", ()=>{
        root.querySelectorAll("#co-payment .tg").forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        payment = b.dataset.pay;
        /* Hidden for cash and for every credit term. A Net-30 order has nothing
           to screenshot — nothing has been paid yet — and asking for proof of a
           payment that is not due for a month is how a retailer concludes the
           form is broken. */
        proof.classList.toggle("hide", payment === "cash" || isCreditMethod(payment));
        const qrBox = root.querySelector("#co-pay-qr");
        if(qrBox) qrBox.innerHTML = (payment === "gcash" || payment === "bank") ? payQrHtml(payment) : "";
      });
    });

    /* RUN ONCE NOW, not only on change. The form opens on Delivery with Cash
       already active — the markup ships both as the default — which is the one
       combination the server refuses. Without this line the customer can open
       checkout, touch nothing, and be rejected on submit for a choice the form
       made for them. */
    syncPayForOrderType();

    /* The screenshot is uploaded the moment it is chosen, and the ORDER
       carries the path the server gives back. Uploading at submit time would
       mean a checkout that fails halfway with the order already priced.

       `proofPath` is the only thing that counts as "attached". The old boolean
       could be true with no file anywhere. */
    let proofPath = null;
    const proofField = root.querySelector("#co-proof-field");
    const proofErr   = proofField.querySelector("[data-err]");
    const proofInput = root.querySelector("#co-proof");
    const proofDrop  = root.querySelector("#co-proof-drop");
    const proofCard  = root.querySelector("#co-proof-card");
    const proofPrev  = root.querySelector("#co-proof-preview");
    const proofName  = root.querySelector("#co-proof-name");
    const proofSize  = root.querySelector("#co-proof-size");

    /* Errors go in the field's own [data-err] span, styled by .field-error like
       every other field on this form. They used to be written into a div whose
       colour was set from JavaScript with `style.color = "var(--danger, …)"` —
       a token that does not exist in this stylesheet, so the fallback literal
       was what actually rendered, in one theme's worth of red on both themes.
       The duplicate showToast() is gone too: a message shown twice in two
       places is not twice as clear. */
    const proofFail  = msg => { proofErr.textContent = msg; proofField.classList.add("has-error"); };
    const proofClear = ()  => { proofErr.textContent = ""; proofField.classList.remove("has-error"); };

    /* Delete a screenshot that was uploaded and then removed or replaced.

       EbApi.upload() writes the file on pick, so without this every discarded
       attempt would sit in uploads/references/ for ever with no row pointing
       at it. api/uploads/discard.php authorises on the list of paths the
       upload endpoint issued to this session, so nothing here has to be
       trusted with a filename.

       Fire and forget: a failed cleanup leaves an orphan, which is where we
       were before, and is not worth interrupting a checkout over. */
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

    /* Type and size are checked here BEFORE the request goes out, so an
       obviously wrong file is refused instantly instead of after a round trip
       that uploads it first. This is not the gate — api/uploads/image.php
       re-checks both, reads the MIME from the file's own bytes rather than
       trusting file.type, and is the only opinion that counts. This one just
       saves the shopper the wait. Both numbers mirror that file. */
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

      /* Whatever is attached now is being replaced, so it is discarded — but
         only once the new one is safely on the server. Discarding first would
         mean a failed upload that has already thrown away the good file. */
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
        /* A silent failure at checkout is worse than a refusal — the shopper
           would place the order believing the proof went with it, and staff
           would have nothing to verify. Said plainly in the field, and
           proofPath is left null so the submit check below stops them. */
        proofFail((err.fields && err.fields.file) || err.message);
        proofInput.value = "";
        showDropzone();
      } finally {
        proofDrop.classList.remove("is-busy");
      }
    };

    proofInput.addEventListener("change", () => acceptProof(proofInput.files[0]));

    /* An error clears when the shopper does something about it, not only on the
       next submit. A field still outlined in red after it has been corrected
       teaches people to ignore the outline. */
    root.querySelectorAll(".field .control").forEach(el=>{
      el.addEventListener("input", ()=>{
        const f = el.closest(".field");
        if(!f.classList.contains("has-error")) return;
        f.classList.remove("has-error");
        f.querySelector("[data-err]").textContent = "";
      });
    });

    /* Drag-and-drop is an ADDITION. The label still opens the picker on click
       and on Enter, because a drop target that is the only way in excludes
       anyone using a keyboard or a phone. */
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
    /* Without this the browser navigates away to the dropped file if the drop
       lands anywhere in the modal but the zone — losing the whole checkout. */
    ["dragover", "drop"].forEach(ev =>
      root.addEventListener(ev, e => { if(!proofDrop.contains(e.target)) e.preventDefault(); }));

    proofCard.querySelector("[data-proof-replace]").addEventListener("click", () => proofInput.click());

    proofCard.querySelector("[data-proof-remove]").addEventListener("click", () => {
      const discarded = proofPath;
      proofPath = null;
      /* Clearing .value matters. Without it, picking the SAME file again fires
         no change event — the input's value has not changed — and the shopper
         is stuck looking at an empty zone that will not accept the file they
         want. */
      proofInput.value = "";
      showDropzone();
      proofClear();
      discardProof(discarded);
    });

    /* One in-flight submit at a time.

       The button is disabled below once validation passes, which already
       stopped a second click — but only from that moment, and only from the
       button. A flag on the closure covers the gap before the disable and the
       Enter-key path through the form, and costs one boolean. Placing an order
       twice is not a defect anyone gets to shrug at. */
    let submitting = false;

    // place order
    root.querySelector("#checkout-form").addEventListener("submit", e=>{
      e.preventDefault();
      if(submitting) return;
      let ok = true;
      /* .has-error puts the state on the input as well as the message under
         it. A red sentence below a field that looks exactly like every other
         field makes the reader hunt for which one it belongs to. */
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
      /* The same rules Address::check applies, run here so an unfinished
         address is flagged without a round trip. The server decides. */
      if(orderType==="delivery" && !addr.validate(true)) ok = false;
      /* Reference number and screenshot are demanded only by the two transfer
         methods — the same pair api/shop/checkout.php checks. Written as an
         explicit membership test rather than `payment !== "cash"`, because
         that form is what would have started demanding a screenshot for Net 30
         the moment the tile was added. */
      if(payment === "gcash" || payment === "bank"){
        if(!root.querySelector("#co-ref").value.trim()) fail("#co-ref","Reference number required for "+payLabel(payment)+".");
        if(!proofPath){ fail("#co-proof","Attach a screenshot of your payment."); }
      }
      if(!ok){ unlockAll(); return; }   /* an error they can't reach is no help */

      /* THE ORDER IS NOW ACTUALLY PLACED.

         This used to call showReceipt() with a locally-built object and stop.
         The customer saw "Order Placed!", and nothing reached the staff portal —
         no queue entry, no payment to verify, no record anywhere. The receipt
         was the entire flow.

         api/shop/checkout.php writes the order, its line items and a staff
         notification in one transaction, prices every line from the database,
         and returns the figures the receipt prints. */
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
            /* No `email`. D6: the order is placed for the signed-in customer and
               the server takes the address from the session. Sending one now
               gets the request refused outright rather than silently ignored,
               which is the point — a client that believes it can name the buyer
               should be told it cannot. */
            /* Codes, not names — the server looks the names up itself. Nothing
               for a pickup, which stores no address. */
            address: orderType === "delivery" ? addr.value() : null,
            notes: root.querySelector("#co-notes").value.trim(),
            order_type: orderType === "delivery" ? "delivery" : "pickup",
            /* Straight through. See PAY_METHODS_UI for what used to be here
               and why a chained ternary ending in "bank" had to go. */
            pay_method: payment,
            ref_num: root.querySelector("#co-ref")?.value.trim() || null,
            /* A path, not the image. The file is already on the server. */
            proof_image: proofPath,
          });
          order = data;
        } catch (err) {
          /* Out of stock, an unavailable product, a bad field — all shown
             against the form, with the cart left intact so the shopper can
             adjust rather than losing everything. */
          if (err.isValidation) {
            /* addr_* keys belong to the picker, which marks and focuses its own
               field; everything else goes through the form's mapping below. */
            addr.showErrors(err.fields);
            Object.entries(err.fields).filter(([f]) => !f.startsWith("addr_")).forEach(([f, msg]) => {
              const el = root.querySelector(`#co-${f.replace("_","-")}`) || root.querySelector(`#co-${f}`);
              const box = el && el.closest(".field")?.querySelector("[data-err]");
              if (box) box.textContent = msg;
            });
            if (!Object.keys(err.fields).length) showToast(err.message, "info");
          } else {
            showToast(err.message, "info");
          }
          return;
        } finally { restore(); }

        /* Only clear the cart once the server has the order. */
        state.cart = [];
        updateCartBadge();

        /* Save back to the profile ONLY if the customer asked (I9).
           After the order, never before: the order is what the shopper came
           for, and a profile-save failure must not cost them the checkout.
           Failure is reported and does not touch the receipt. */
        if (root.querySelector("#co-save-profile")?.checked) {
          try {
            /* The address only when there was one — a pickup has none to save,
               and posting an empty one would CLEAR the saved address. */
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
          /* The raw key as well as the label: the invoice ticks CASH SALES or
             CHARGE SALES from it, and a label is not something to branch on. */
          payMethod: payment,
          /* Null unless the buyer is a retailer — see Orders::buyerTinSql(). */
          tin: order.tin || null,
          /* The stored VAT breakdown — the invoice prints it as the server decided it. */
          tax: order.tax || null,
          /* Null unless the server opened a receivable. The scheme and the due
             date come from the RESPONSE, not from the tile that was clicked:
             the due date is computed by the database, and printing a date the
             browser worked out from its own clock is how a receipt and a
             statement come to disagree by a day. */
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

/* =================================================================
   RECEIPT (soft-copy)
   ================================================================= */
function showReceipt(order){
  /* Use the order number the server assigned. txId() minted a random local id
     that matched nothing in the database — a customer quoting it to staff would
     have been quoting a number nobody could look up. The fallback covers only
     the case where this is somehow called without a placed order. */
  const id = order.id || txId();

  /* THE SAME SALES INVOICE THE CASHIER PRINTS — assets/js/core/invoice.js.
     A customer holding a different-looking document from the one on the
     counter is a customer asking which one is real. */
  const invoice = EbInvoice.fromOrder({
    id, type: "online", tin: order.tin, tax: order.tax, name: order.name, address: order.address, items: order.items,
    total: order.total, payMethod: order.payMethod,
    /* A Date, not toISOString(): that formats in UTC, so an order confirmed
       before 8am in Manila would print yesterday's date on the invoice. */
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
  /* Local copy only. api/shop/checkout.php deletes the customer's cart_items
     rows inside the same transaction that writes the order, so the server is
     already empty by the time this runs — and a checkout that failed did not
     touch the cart at all. This line just brings the drawer into line with
     what the database already says. */
  state.cart = [];
  updateCartBadge(); renderCart();
  openModal("Sales Invoice", body, {wide:true, onOpen:(root)=>{
    root.querySelector("#receipt-done").addEventListener("click", closeModal);
    root.querySelector("#receipt-print").addEventListener("click", ()=> EbInvoice.print(invoice));
  }});
  showToast("Order placed successfully!", "success");
}

/* =================================================================
   AUTH (login / register) — UI-only mock
   ================================================================= */
function pwToggle(){
  return `<button type="button" class="toggle-eye" data-eye aria-label="Show password">${ICONS.eye}</button>`;
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
          <!-- First + last name, stored separately (migration 019). -->
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
              <label for="rg-last">Last Name *</label>
              <div class="auth-input-group">
                <span class="auth-input-icon" aria-hidden="true">${ICONS.user}</span>
                <input class="auth-input" id="rg-last" type="text" placeholder="dela Cruz" autocomplete="family-name"/>
              </div>
              <span class="field-error" data-err></span>
            </div>
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
              <input class="auth-input auth-input-pw" id="rg-pass" type="password" placeholder="At least 8 characters" autocomplete="new-password"/>
              ${eyeBtn}
            </div>
            <div class="auth-strength-wrap"><i id="rg-strength"></i></div>
            <span class="strength-label" id="rg-strength-lbl"></span>
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
          <button type="submit" class="auth-submit">Continue ${_authArrow}</button>
        </form>
      </div>

    </div><!-- /auth-form-panel -->
  </div><!-- /auth-split -->`;

  openModal('', body, { wide:true, onOpen:(root)=>{
    // Mark modal for CSS overrides (close btn colour, no title, zero body padding)
    root.closest('#modal')?.classList.add('is-auth');

    /* The Create Account tab's address picker. Mounted when the modal opens,
       not when the tab is shown, so its region list is already there by the
       time somebody switches tabs. */
    const rgAddr = EbAddress.mount(root, "rg");

    // forgot password — no backend yet, point to Facebook
    root.querySelector('[data-forgot]')?.addEventListener('click', ()=>{
      showToast('Message us on Facebook to reset your password.', 'success');
    });

    /* ── Pill tab switcher ──
       The pill itself is NOT moved from here any more. It used to be measured
       with getBoundingClientRect() and written into left/width on the next
       animation frame, which read the modal's opening `scale(.96)` as if it
       were layout and left the pill 4% short of the tab — or, on a frame
       before the modal had any layout, collapsed it into the corner. It is
       positioned in CSS off `.auth-tab.active` now (see .auth-tab-slide in
       styles.css), so the only thing this has to do is move the class. */
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
    });

    /* ── Login submit ── */
    root.querySelector('#login-form')?.addEventListener('submit', async e=>{
      e.preventDefault();
      let ok=true;
      root.querySelectorAll('#login-form [data-err]').forEach(x=>x.textContent='');
      const fail=(sel,msg)=>{ root.querySelector(sel).closest('.auth-field').querySelector('[data-err]').textContent=msg; ok=false; };
      /* A new submission supersedes any notice from the last one, and clears
         its timer — two intervals ticking over one element would race. */
      stopLockCountdown(root);
      const email = root.querySelector('#lg-email').value.trim();
      const pass  = root.querySelector('#lg-pass').value;
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('#lg-email','Enter a valid email.');
      if(pass.length<6) fail('#lg-pass','Password too short.');
      if(!ok) return;

      const btn = root.querySelector('#login-form [type=submit]');
      const label = btn ? btn.textContent : '';
      if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }

      /* Staff sign-in is the server's decision now.

         This used to search a STAFF_ACCOUNTS array holding every staff
         password in plaintext — in a file served to every visitor — and then
         hand the matched account to the portal through sessionStorage, which
         the portal trusted. Both halves are gone: credentials are checked
         against bcrypt hashes in MySQL, and identity rides in an httponly
         cookie this page cannot read.

         A 401 means "not a staff account", so the customer path runs instead,
         preserving the old order of precedence. */
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
          /* A genuine staff account that may not sign in — archived, or no
             role assigned. Saying so beats quietly logging them in as a
             customer. */
          fail('#lg-email', err.message);
          return;
        }
        if(err.isRateLimited){
          /* FALL THROUGH, do not stop here.

             This probe is speculative: the storefront tries the staff endpoint
             on every sign-in so a staff member can enter from the public site.
             For a customer's address it therefore fails every single time, and
             those failures fill the STAFF bucket for that email. Returning here
             would mean four storefront attempts lock a shopper out of the shop
             on a portal counter, for an account they do not have.

             The staff lock is still real and still enforced — the portal's own
             sign-in page calls auth/login.php directly and treats 429 as final.
             Here it only means "this is not a staff route", so the customer
             path runs and reports its own state. */
        }
        if(err.code === 'NETWORK' || err.code === 'TIMEOUT'){
          showToast(err.message, "info");
          return;
        }
        /* 401 falls through to the customer path below. */
      } finally {
        /* NOT while a lockout is counting down. This `finally` runs after the
           catch, so an unconditional re-enable undoes the disable
           startLockCountdown just applied and hands back a button whose next
           press is guaranteed to be refused. The countdown re-enables it
           itself when the wait reaches zero. */
        if(btn){ btn.textContent = label; if(!lockTimer) btn.disabled = false; }
      }

      /* Customer login — checked against the customers table.

         This used to be a mock: it took the local part of whatever email was
         typed, title-cased it, and called that a signed-in customer. Any
         address with a six-character password got an account menu bearing that
         name. Nothing was verified and no record was consulted.

         api/shop/login.php verifies the password against the bcrypt hash on
         the customer row and puts the customer id in its own session key --
         separate from the staff key, so a shopper can never satisfy a
         permission check. shop/my-orders.php reads that key and takes no id
         parameter, which is why the mock could not actually reach anyone
         else's orders; it just claimed a name it had not earned.

         The staff attempt above ran first and fell through on 401, so the
         order of precedence is unchanged. */
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
        } else {
          /* THE SERVER'S OWN WORDS, not a copy of them.

             This used to hardcode "Email or password is incorrect." and throw
             away err.message. That is how the advice added in
             Auth::attemptCustomer — "if you have not set a password for this
             email yet, use Sign Up" — would have been written on the server
             and never shown to anyone. It is also how the two could drift
             apart without either looking wrong on its own.

             Still one message for a wrong password, an unknown email and a
             record with no password: distinguishing them would tell a stranger
             which addresses are registered here. The server decides the
             wording; this renders it. */
          fail('#lg-email', err.message);
        }
      } finally {
        /* NOT while a lockout is counting down. This `finally` runs after the
           catch, so an unconditional re-enable undoes the disable
           startLockCountdown just applied and hands back a button whose next
           press is guaranteed to be refused. The countdown re-enables it
           itself when the wait reaches zero. */
        if(btn){ btn.textContent = label; if(!lockTimer) btn.disabled = false; }
      }
    });

    /* ── Register submit ── */
    root.querySelector('#reg-form')?.addEventListener('submit', async e=>{
      e.preventDefault();
      let ok=true;
      root.querySelectorAll('#reg-form [data-err]').forEach(x=>x.textContent='');
      const fail=(sel,msg)=>{ root.querySelector(sel).closest('.auth-field').querySelector('[data-err]').textContent=msg; ok=false; };
      const first   = root.querySelector('#rg-first').value.trim();
      const last    = root.querySelector('#rg-last').value.trim();
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
      if(pw.length<8) fail('#rg-pass','Use at least 8 characters.');
      if(cf!==pw)  fail('#rg-confirm','Passwords do not match.');
      if(!ok) return;

      /* Creates a real account. This used to call signIn(name) and nothing
         else — no record was written, so there was nothing to sign back into
         and the "account" vanished when localStorage was cleared.

         An email matching a seeded customer claims that record instead of
         creating a duplicate, so their existing order history follows them. */
      /* STEP 1 of 2: the server validates and emails a code. No account exists
         until the code is confirmed (showSignupOtp → shop/register-verify.php). */
      const submitBtn = root.querySelector('#reg-form .auth-submit');
      const label = submitBtn.innerHTML;
      submitBtn.disabled = true; submitBtn.textContent = "Sending code…";
      try {
        const { data } = await EbApi.post("shop/register.php", {
          first_name: first, last_name: last, email, password: pw, contact, address: rgAddr ? rgAddr.value() : null,
        });
        showSignupOtp(root, data);
      } catch(err){
        if(err.isValidation){
          /* addr_* keys are the picker's; it marks its own fields. Handing them
             to fail() would look for an #rg-addr_region that does not exist
             and throw inside the error handler. */
          rgAddr?.showErrors(err.fields);
          Object.entries(err.fields).filter(([f]) => !f.startsWith('addr_')).forEach(([f,msg]) =>
            fail('#rg-' + (f === 'password' ? 'pass' : f === 'first_name' || f === 'name' ? 'first' : f === 'last_name' ? 'last' : f), msg));
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

/* ONE place that builds state.auth, because there were two and they disagreed.

   bootstrapCustomer() built it with five keys including `status`; signIn() took
   three positional strings and built it with four, so `status` was `undefined`
   for the entire session of anyone who signed in through the modal. Reload the
   page and the restore path filled it in — which is why the Payment Schemes
   link on the profile looked intermittent rather than broken, and why it was a
   shape problem rather than a logic problem.

   Building it in a function means a new field is added once. Taking the whole
   customer object rather than a fourth positional argument means adding one
   does not change any call site's argument order — three positional strings
   was already one too many to read at a glance. */
function setAuthState(customer){
  state.auth = customer
    ? {
        loggedIn: true,
        name:   customer.name  || "",
        email:  customer.email || "",
        id:     customer.id    || null,
        /* Drives the Payment Schemes link on the profile pages and the credit
           tiles at checkout. Presentation in both cases: shop/my-payments.php
           and shop/checkout.php each re-derive it from the database. */
        status: customer.status || null,
      }
    : { loggedIn:false, name:"", email:"", id:null, status:null };

  /* Announce it. The three account pages gate their whole content on "is this
     person signed in?", and each ran that check exactly once, on window load,
     against whenAuthReady().

     That is correct for a page opened while already signed in and wrong for
     the case those pages actually offer: the guard panel has a Sign In button
     that opens the modal. Signing in through it left the page still showing
     "Sign in to view this" over content the visitor was now entitled to, until
     they reloaded. eb:auth-ready fires once per page load and had already
     fired, so nothing was listening for the thing that had just happened.

     Fired from here rather than from signIn(), so signing OUT is announced on
     the same channel — the reverse case put a signed-out visitor in front of
     somebody else's order history until they navigated away. */
  try {
    window.dispatchEvent(new CustomEvent("eb:auth-changed", {
      detail: { loggedIn: state.auth.loggedIn, status: state.auth.status },
    }));
  } catch(_){}
}

/* simulate signed-in state — swap navbar Login for account menu */
/* Reflect a signed-in customer in the UI.

   `state.auth` is now a cache of what the server said, not the source of truth.
   It used to BE the account: localStorage["eb-auth"] held a display name, and
   "logged in" meant that string existed — no password, no record, nothing
   linking an order to a person. The email is kept alongside so checkout can
   attach the order to the right customer.

   Takes the `customer` object the endpoint returned, whole. It used to take
   (name, email, id) as three strings — see setAuthState() above for why that
   is what dropped `status` on the floor. */
function signIn(customer){
  setAuthState(customer);
  const name = state.auth.name;
  try { localStorage.setItem("eb-name", name || ""); } catch(_){}
  closeModal();
  renderAccount();
  showToast(`Welcome, ${name}!`, "success");

  /* The account's saved cart, then the add that was waiting on this sign-in —
     in that order, and never at the same time.

     pendingCartAdd is replayed AFTER the load, not before it and not
     alongside it. addToCart() merges into whatever line already exists, so
     replaying first would have the load land on top of it and the item the
     shopper explicitly asked for would silently vanish; running both at once
     is two writes racing for the same cart_items row.

     There is deliberately NO "you have N items waiting" toast. The badge
     already says so, on every page, without stacking a second notification on
     top of the welcome. The load itself stays — it is what puts the number on
     the badge and the lines in the drawer. */
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
  /* End the server session too — clearing local state alone would leave the
     cookie valid, and the next page load would sign straight back in. */
  try { await EbApi.post("auth/logout.php", {}); } catch(_){}
  /* Clear the local copy and redraw the drawer with it — leaving the lines on
     screen after the session ends shows the next person at this machine what
     the last one was buying.

     The SERVER rows stay. The cart belongs to the account and surviving a
     sign-out is the whole point of storing it there; signing out is not
     "empty my cart", and treating it as such would make the feature useless
     to anyone who shares a computer. */
  state.cart = [];
  updateCartBadge();
  renderCart();
  renderAccount();
  showToast("Signed out.", "info");
}

/* Ask the server who is signed in, and reconcile the cached copy with it.

   A localStorage flag that says "logged in" while the server disagrees is worse
   than no flag: the page renders an account menu, then every action fails. */
async function bootstrapCustomer(){
  try {
    const { data } = await EbApi.get("shop/me.php");
    /* Through setAuthState(), so this and signIn() cannot produce two
       different shapes again — which is exactly what they did, and why a
       retailer who signed in through the modal never saw the Payment Schemes
       link until they reloaded. */
    setAuthState(data.customer);
    EbApi.setCsrf(data.csrf);
    /* D8: a display name for first paint, and nothing else. The id and email
       used to be cached here too — that is identity, and identity in
       localStorage is precisely what this project already got wrong: a
       hand-edited entry rendered a signed-in navbar. Nothing reads this back
       as truth; it exists so the header does not flicker. */
    try { localStorage.setItem("eb-name", data.customer.name || ""); } catch(_){}
  } catch(err){
    /* D8: any error renders as signed out — a 500, a timeout or a response we
       cannot parse says nothing about who this is, and "nobody" is the only
       safe reading of nothing. Clearing only on 401 left the previous value in
       place, which was safe purely because the initialiser is signed-out. That
       is a guarantee living in a distant line rather than here. */
    setAuthState(null);
    try { localStorage.removeItem("eb-name"); localStorage.removeItem("eb-auth"); } catch(_){}
  }
  renderAccount();

  /* Announce that the server has answered.

     Pages that gate their content on "is this person signed in?" cannot read
     state.auth at window.load — bootstrapCustomer() is asynchronous and has
     usually not resolved yet, so the flag is still its fail-closed initial
     `false` (D8). public/profile/profile.html sampled it exactly once and
     showed a signed-in customer the "please sign in" panel with the whole
     profile hidden: the page was correctly wired and displayed the wrong
     answer, which is the hardest kind of bug to see in a screenshot.

     `EB_AUTH_READY` is set as well as dispatched, so a listener attached after
     this has already run is not left waiting for an event that will never come
     again. */
  window.EB_AUTH_READY = true;
  window.dispatchEvent(new CustomEvent("eb:auth-ready", { detail: { loggedIn: state.auth.loggedIn } }));

  /* The cart is on the account, so it cannot be fetched until the server has
     said which account this is. init() renders an empty drawer and a zero
     badge before this resolves — correct for the moment it runs, since nobody
     is signed in yet as far as the page knows — and loadServerCart() redraws
     both the moment there is something real to draw. */
  if(state.auth.loggedIn) loadServerCart();
}

/* Resolve once the server has said who this is. Pages awaiting an answer use
   this rather than guessing from a flag that is only eventually correct. */
function whenAuthReady(){
  if (window.EB_AUTH_READY) return Promise.resolve(state.auth.loggedIn);
  return new Promise(resolve => {
    window.addEventListener("eb:auth-ready", e => resolve(e.detail.loggedIn), { once: true });
    /* A bootstrap that never resolves — the request hung past its timeout and
       the catch somehow did not run — must not leave the page blank for ever.
       Falling back to signed-out matches D8. */
    setTimeout(() => resolve(state.auth.loggedIn), 20000);
  });
}

/* =================================================================
   CUSTOMER NOTIFICATIONS — the bell (api/shop/notifications.php)
   -----------------------------------------------------------------
   Only while a customer is signed in. Staff change an order's status,
   verify a payment or move a return along → a row lands in the
   customer's feed (api/core/CustomerNotify.php) → the badge counts it.
   Checked on load, when the panel opens, and every minute while the
   tab is visible.
   ================================================================= */
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
        <div class="bell-list" id="bell-list"><div class="bell-empty">Loading…</div></div>
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
  /* The server's own age for the row — never the browser clock against a
     timestamp written in the database's timezone. */
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
  /* Preview mode removes the account surface entirely, so there is
     nothing to render into. */
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
        /* THE DIRECTORY IS `profile/`, NOT `MyProfile/`.

           These three lines pointed at a folder that does not exist in this
           project — a leftover from the layout before the restructure, when
           public/MyProfile/ was the account area. Clicking My Orders or Profile
           in the account menu gave Apache's 404 from every page on the site:

               /elishabay/public/MyProfile/my-orders.html

           Broken twice over, in fact. `inSub` tested the path for '/MyProfile/',
           which never matched anything either — so from within the account area
           itself the base stayed '' and the link resolved to
           public/profile/MyProfile/my-orders.html, a second 404.

           The test is now anchored: it asks whether the CURRENT FILE sits
           directly inside a profile/ directory, rather than whether the string
           appears anywhere in the path. */
        const inProfileDir = /\/profile\/[^/]*$/.test(window.location.pathname);
        const base  = inProfileDir ? '' : 'profile/';
        /* Dashboard is the account area's front door — the summary the other
           three pages are drilldowns from. */
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

/* =================================================================
   THEME
   ================================================================= */
function applyTheme(t){
  state.theme = t;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("eb-theme", t); } catch(_){}
}

/* =================================================================
   PHONE FIELDS TAKE A PHONE NUMBER
   -----------------------------------------------------------------
   Every contact-number field on the storefront is type="tel" — the
   registration form, the retailer application, checkout, the profile
   page — and type="tel" only changes the phone keypad; a desktop
   keyboard could still type "adasdas" into it. The server already
   refused that (register.php, b2b/apply.php and checkout.php all check
   /^[0-9 +\-()]{7,..}$/), but only after the shopper filled in the rest
   of a long form and pressed submit.

   This drops anything outside that SAME character set as it is typed,
   pasted or autofilled — digits, space, + - ( ) — so the field cannot
   hold a value the server is going to throw back. One delegated
   listener rather than one per form, because the register and checkout
   fields are built by JS after load and would otherwise need wiring
   wherever they are rendered.

   The caret is put back where the shopper was typing: a filter that
   jumps the cursor to the end on every rejected key is worse than no
   filter when someone is correcting the middle of a number. Skipped
   mid-composition, because rewriting the value under an IME breaks
   the composition; it runs again when composition ends. */
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

/* =================================================================
   Generic stepper delegation (cards + product detail)
   ================================================================= */
function wireSteppers(){
  document.addEventListener("click", e=>{
    const btn = e.target.closest("[data-step]");
    if(!btn) return;
    const input = btn.closest(".stepper").querySelector("input");
    let v = parseInt(input.value||"1",10) + parseInt(btn.dataset.step,10);
    const max = parseInt(input.max||"99",10);
    v = Math.max(1, Math.min(v, max));
    input.value = v;
  });
}

/* =================================================================
   Scroll helpers / smooth anchors / reveal / sticky nav / parallax
   ================================================================= */
function scrollToId(sel){
  const el = $(sel); if(!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 64;
  window.scrollTo({top:y, behavior:"smooth"});
}

/* The shop is a PAGE, not an anchor on this one.

   Every control that wanted to reach the shop called scrollToId("#shop"), and
   no element with id="shop" has ever existed anywhere in this project. The
   shop is public/shop.html, which index.html reaches with <a href="shop.html">.
   scrollToId() opens with `const el = $(sel); if(!el) return;`, so those
   clicks did nothing at all — no navigation, no error, no clue.

   The URL is resolved against the APPLICATION ROOT rather than the current
   directory. The cart drawer is on seven pages at two different depths
   (public/*.html and public/profile/*.html), so a bare "shop.html" would 404
   from My Orders. EbFormat.APP_BASE is derived from the core module's own URL
   for exactly this purpose; BASE_PATH at the top of this file is the same
   derivation from this script's URL and is the fallback if the bridge has not
   run. */
function shopUrl(){
  const base = (window.EbFormat && EbFormat.APP_BASE) || BASE_PATH || "/";
  return base + "public/shop.html";
}

/* Reaching the shop from anywhere. On the shop page itself, reloading it to
   land where you already are is worse than useless — scroll the grid into
   view instead. #product-grid exists only on shop.html, which makes it the
   test for "am I already there". */
function goToShop(){
  closeCart();
  if($("#product-grid")){ scrollToId("#product-grid"); return; }
  window.location.href = shopUrl();
}
/* ---- tubelight indicator ---- */
/* `instant` places it with no slide — used on page load, when the fonts land
   and on resize. Animating those made the underline bounce in from the left
   edge on every page change. */
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
  // On dedicated pages (shop.html etc.), a .page-active link is already marked —
  // just position the indicator there and skip scroll-spy.
  const pageActive = document.querySelector('.nav-links a.page-active');
  const settle = () => { const a = document.querySelector('.nav-links a.active, .nav-links a.page-active'); if(a) moveNavIndicator(a, true); };
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  window.addEventListener("resize", settle, {passive:true});
  if(pageActive){ moveNavIndicator(pageActive, true); return; }

  // find which section is in view and highlight the matching link
  // hrefs must match the actual <a href="..."> values in the nav
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
  // Nav links that navigate to a separate page (not anchor scrolls).
  // Slide indicator + animate page out, then navigate.
  $$(".nav-links a").forEach(a => {
    const href = a.getAttribute("href");
    if(!href || href.startsWith("#")) return; // anchor links handled by wireSmoothScroll
    a.addEventListener("click", e => {
      e.preventDefault();
      moveNavIndicator(a);
      $("#navlinks")?.classList.remove("open");
      /* Already on that page (Home on the landing, Shop on the shop): scroll to
         the top instead of reloading the whole site. */
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

/* =================================================================
   HERO ACCORDION  (interactive image accordion)
   ================================================================= */
const HERO_PANELS = [
  { title:"Pesto Bangus",       tint:"#3f8f4f", bg:"linear-gradient(160deg,#2d6a3f,#1a4a2a)" },
  { title:"Adobo Bangus",       tint:"#5a3a22", bg:"linear-gradient(160deg,#6b4226,#3d2515)" },
  { title:"Asian Steak",        tint:"#7a4b2b", bg:"linear-gradient(160deg,#8a5a35,#4a2d18)" },
  { title:"Tuyo Delizioso",     tint:"#c98a2e", bg:"linear-gradient(160deg,#b87d28,#7a5218)" },
  { title:"Ba-yo Signature",    tint:"#b6702a", bg:"linear-gradient(160deg,#a06020,#5c3812)" },
];

/* ---- hero slider (right side of hero) ----
   A FIFO queue that runs left-to-right toward the panel.

   `order` holds product indices. order[0] is in the big panel and
   order[1] is "next up" — the rightmost tile, sitting against the
   panel edge. Reading the strip left to right you get order[3],
   order[2], order[1], i.e. furthest-away first.

   Advancing slides the whole rail one tile to the right: the rightmost
   tile travels into the panel, everything shifts along, and a new tile
   enters from the left. The rail carries a fourth tile (order[4]) off
   the left edge for exactly that purpose, and rests one tile-width to
   the left so that tile is hidden until it is needed.

   Placeholder gradients stand in until real photos exist: add
   img:"path/to/photo.jpg" to a HERO_PANELS entry and the panel and its
   tile both switch to the photo automatically. */
/* Timings, all in sync with styles.css:
     HERO_SLIDE_MS   .ht-rail.is-moving  transform  .7s
     HERO_PANEL_MS   .hs-slide           opacity    .55s
   The panel swap is kicked off HERO_PANEL_LEAD_MS into the slide so the
   two finish together: 150 + 550 = 700. Previously the panel only began
   fading after the slide had fully finished and then took .8s of its own,
   which read as the big image lagging well behind the tile. */
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

  function art(panel){
    /* imageUrl(): panel.img is an application-root-relative path from
       content/get.php now, not a data URL, and this page sits one level down
       from the project root. */
    const src = imageUrl(panel.img);
    return src
      ? '<img src="'+src+'" alt="'+panel.title+'" draggable="false">'
      : '<div class="hs-ph" style="position:absolute;inset:0;background:'+panel.bg+';display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px">' +
          '<span class="ph-icon" aria-hidden="true">'+ICONS.camera+'</span>' +
          '<span class="ph-label">'+panel.title+'</span>' +
        '</div>';
  }

  /* Panels are built once; only the .active class moves between them. */
  HERO_PANELS.forEach(function(panel){
    const slide = document.createElement("div");
    slide.className = "hs-slide";
    slide.innerHTML = art(panel) + '<span class="hs-caption">'+panel.title+'</span>';
    track.appendChild(slide);
  });
  const slides = $$(".hs-slide", track);

  /* order[0] is whatever belongs in the big panel. */
  function paintPanel(){
    slides.forEach((s,i)=> s.classList.toggle("active", i === order[0]));
  }

  /* Rebuild the rail at rest. Left to right: incoming, then the queue
     with "next up" last, nearest the panel. */
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
      const tileSrc = imageUrl(panel.img);
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

    /* Rotate the queue up front, then run the tile slide and the panel
       cross-fade together. The rail keeps showing the pre-rotation tiles
       until it is rebuilt at the end, so the two stay visually in step. */
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

  /* Cut the panel's notch to match the tile that overlaps it.

     The strip is flex-sized, so only the browser knows the tile's real box —
     measure it and hand the numbers to the mask in styles.css. NOTCH_RING is
     the gap left between tile and cut. Below 960px the grid is one column and
     the strip sits above the panel rather than over it, so the notch
     collapses to nothing. */
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

    /* Only cut where the tile genuinely sits over the panel. Checking the
       horizontal axis alone is not enough: in the single-column layout the
       strip spans the same x range as the panel but sits well above it, which
       would punch a hole into empty artwork. */
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

/* renderHeroAccordion() was here — 34 lines building a hover-and-click image
   accordion for the hero.

   Removed because #hero-accordion does not exist in any HTML file in this
   project, and never has as far as the code shows. Line two of the function was
   `const wrap = $("#hero-accordion"); if(!wrap) return;` — so it returned
   immediately, every time, and rendered 0 panels. Verified on the live page
   before removal: `document.querySelectorAll('.acc-panel').length === 0`.

   The hero the site ACTUALLY shows is the slider — renderHeroSlider(), four
   thumbnails, working — which is a different component and is untouched. The
   accordion was a second, unused one.

   Deleted on the owner's instruction after the two were distinguished. If an
   accordion hero is wanted later it is a design decision, not a restoration. */

/* =================================================================
   INIT
   ================================================================= */

/* =================================================================
   LANDING CONTENT  +  PREVIEW MODE
   -----------------------------------------------------------------
   THE localStorage BRIDGE IS GONE.

   It worked like this: the Super Admin's Landing Page module wrote
   localStorage["eb-landing-content"], and this page read it back and
   patched itself. Same origin, so it functioned — inside one browser.
   An edit made by an administrator was invisible to every actual
   visitor, which is the only audience the screen has.

   It was later demoted to "a first-paint cache, not the source of
   truth", which was better and still wrong in one specific way that
   produced defect 3.3: hero images were never sent to the server at
   all, so the cache was the ONLY place they existed. The admin saw
   the photo in the preview iframe because the preview ran in the same
   browser and read the same key. Log out and it was gone.

   Both ends are removed. content/get.php is the only source. The cost
   is that the hero photos appear a beat after first paint instead of
   instantly; the benefit is that what the administrator sees in the
   preview is what a visitor in Manila sees.
   ================================================================= */
window.EB_LANDING = null;

/* One-time cleanup of the retired key.

   Removing the code that WROTE localStorage["eb-landing-content"] does not
   remove what it already wrote. Every browser that ever opened the admin still
   holds that blob — up to several megabytes of it, because hero photos used to
   be base64'd into it — and it will sit there indefinitely with nothing left
   that can read or clear it.

   Deleting data the user did not ask us to delete deserves a sentence of
   justification: this key was written by this application, is dead in this
   version, and is not a user document. */
try { localStorage.removeItem("eb-landing-content"); } catch(_){}

/* Fetch the landing content from the database and apply it. */
async function fetchLandingContent(){
  try {
    const { data } = await EbApi.get("content/get.php");
    window.EB_LANDING = data;
    applyLandingContent();
    if (typeof renderFaqs === "function") renderFaqs();
    if (typeof renderHeroSlider === "function") renderHeroSlider();
    /* The carousel too. init() renders it once BEFORE this request resolves,
       when EB_LANDING is still null — so it falls back to the `best` flag and
       shows those three products. Without this line the administrator's chosen
       list never reached the storefront: saving five products still produced
       exactly three cards, and they were the wrong three.

       loadShopCatalog() re-renders on its own completion, which covers the
       opposite order (catalogue after content). Both callers are needed because
       the two requests race, and renderBestSellers() reads PRODUCTS and
       EB_LANDING at call time, so running it twice is correct, not wasteful. */
    if (typeof renderBestSellers === "function") renderBestSellers();
    return true;
  } catch(err){
    /* The page still renders its shipped copy; a visitor cannot act on
       "content service unavailable", so this is logged, not shown. */
    console.warn("[landing] content unavailable:", err.message);
    return false;
  }
}

/* Patch the DOM hooks the page already ships with (#lp-live-*). Called
   before the render functions so FAQ/hero/product overrides land first. */
function applyLandingContent(){
  /* Uses whatever is already in memory, falling back to the cache only if
     nothing has been loaded yet.

     This used to call loadLandingContent() unconditionally, which re-read
     localStorage — so the fresh copy fetchLandingContent() had just taken from
     the API was immediately replaced by the cached one. It happened to work
     because the cache is written a line earlier, but a failed write (quota
     exceeded, private browsing) would have silently applied stale content over
     fresh, and the symptom would be an administrator's edit not appearing with
     no error anywhere. */
  const c = window.EB_LANDING;
  if(!c) return;

  const setText = (sel, val) => {
    const el = $(sel);
    if(el && typeof val === "string" && val.trim()) el.textContent = val;
  };
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
      fb.textContent = c.contact.facebook;
      fb.href = /^https?:/.test(c.contact.facebook)
        ? c.contact.facebook : "https://" + c.contact.facebook;
    }
  }

  /* FAQ list — replaced wholesale, so removing an entry in the admin
     actually removes it here. renderFaqs() reads FAQS afterwards. */
  if(Array.isArray(c.faqs) && c.faqs.length){
    FAQS = c.faqs.filter(f => f && f.q && f.a);
    FAQS_LOADED = true;
  }

  /* Hero slide photos, matched to HERO_PANELS by title.
     `image` is the current key; `img` is read too so a cached older response
     still resolves. Both are paths — imageUrl() turns them into a src. */
  if(Array.isArray(c.hero)){
    c.hero.forEach(function(entry){
      if(!entry) return;
      const path = entry.image || entry.img || "";
      if(!path) return;
      const panel = HERO_PANELS.find(p => p.title === entry.title);
      if(panel) panel.img = path;
    });
  }

  /* The `productImages` branch that used to sit here is gone.

     It read c.productImages[p.id] and assigned p.img. content/get.php has never
     returned a `productImages` key and no table backs one — the Landing Page
     editor had a per-product photo picker writing to an in-memory object with
     no endpoint, no column and no reader. Two halves of a feature that were
     never joined, and the only thing that ever set p.img on this page.

     A product has ONE photo and it lives on the product, set in Product
     Maintenance and served by shop/products.php as `image`. */
}

/* -----------------------------------------------------------------
   PREVIEW MODE  (?preview=1)

   The admin's "View Live Page" opens this page in an iframe. Without
   this the visitor login modal was reachable from inside the admin,
   so a Super Admin could sign in as a customer over and over without
   ever leaving their own session.

   Preview keeps the page fully browsable — only the account surface
   is removed, so edits can still be checked in context.
   ----------------------------------------------------------------- */
/* The flag also rides on window.name, which survives navigation inside the
   iframe — clicking Shop or the logo loads a page without ?preview=1, and
   that used to bring back the login button and cart. */
const PREVIEW_NAME = "eb-preview";
function isPreviewMode(){
  try {
    if(new URLSearchParams(location.search).get("preview") === "1") return true;
    return window.name.split("|")[0] === PREVIEW_NAME && window.top !== window;
  } catch(_){ return false; }
}

/* Who is looking at this preview. The admin passes it on the URL; the
   sessionStorage hand-off is a fallback for a preview opened some other
   way. Returns "" rather than guessing, so the badge degrades to a plain
   "Preview mode" instead of naming the wrong person. */
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

  /* Remove the account/cart surface entirely rather than hiding it, so
     nothing can be clicked or tabbed to. */
  ["#account-slot", "#cart-btn", "#cart-btn-mob"].forEach(function(sel){
    const el = $(sel);
    if(el) el.remove();
  });

  /* Belt and braces: neutralise the auth entry points in case another
     code path (a CTA, a deep link) tries to open them. */
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

/* Load the live catalogue. Failure is deliberately quiet on the storefront:
   a shopper cannot act on "the API is down", and the seeded copy still renders
   a browsable page. It is logged, and the checkout endpoint re-prices
   everything from the database anyway, so a stale price here cannot become a
   wrong charge. */
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

function init(){
  /* Admin overrides first: they replace FAQS, hero photos and the
     featured product list that the render calls below depend on. */
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

  // category chips (from CATEGORIES)
  const catChipsEl = $("#cat-chips");
  if(catChipsEl) catChipsEl.innerHTML = CATEGORIES.map((c,i)=>`<button class="chip ${i===0?"active":""}" data-cat="${c}">${c}</button>`).join("");

  // render content
  renderBestSellers();
  renderProducts();

  /* Re-render once the real catalogue lands. Rendering twice is cheap and
     avoids holding the whole page back on one request. */
  loadShopCatalog().then(ok => {
    if (ok) { renderBestSellers(); renderProducts(); }
  });

  /* Pick up a staff session if one exists.

     Nothing on the storefront needs an identity — but CSRF protection applies
     to any request made WITH a session, and a staff member who is signed into
     the portal and then browses the shop in the same browser has one. Without
     this, their checkout was refused 403 while an anonymous shopper's went
     through: the more privileged visitor was the only one who could not buy
     anything. Bootstrapping here fetches the token so the request carries it.

     Anonymous visitors get a 401 from me.php, which bootstrap() treats as the
     ordinary "not signed in" case and swallows. */
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
  $("#modal-scrim")?.addEventListener("click", e=>{ if(e.target===$("#modal-scrim")) closeModal(); });
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
  ham?.addEventListener("click", ()=>{ const o=$("#navlinks").classList.toggle("open"); ham.setAttribute("aria-expanded",o); });

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
      /* Minus at one means "I do not want this". setQty() clamps the floor to
         1 — correctly, because that clamp is what protects the typed number
         input, where 0 is not a quantity — so asking it for 0 put the line
         straight back and the button looked broken. The decision belongs
         here, where the intent is known, not in the clamp. */
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
    /* Cleared, or typed down to zero, is the same instruction the minus button
       gives at one. Snapping back to 1 answered a question nobody asked. */
    if(raw === "" || !Number.isFinite(n) || n < 1){ removeFromCart(id); return; }
    setQty(id, n);
  });

  /* A #contact-form submit handler was here, reading #cf-name, #cf-email and
     #cf-msg. None of those four elements has ever existed in any HTML file in
     this project — the optional chaining meant it silently bound to nothing.

     Its own comment said "JS validation only — no real submit": it called
     form.reset() and showed "Message sent — we'll get back to you!" while
     sending nothing anywhere. Had the markup existed, it would have lied to
     every customer who used it.

     Removed on the owner's instruction, once it was established that this was
     NOT the partner-registration feature. That is a separate page —
     public/become-partner.html — which now genuinely submits, via
     api/b2b/apply.php, and emails the applicant. The Contact section on the
     landing page stays as it is: address, phone and email, no form. */
}

document.addEventListener("DOMContentLoaded", init);

/* =================================================================
   V2 ENHANCEMENTS — Stats counter, parallax orbs, footer links
   ================================================================= */

/* ── Animated stat counters ── */
/* animateCounter() was here. Its only caller was initCounters(), removed just
   below for a #stats-bar that does not exist. */

/* initCounters() was here — an IntersectionObserver that animated .stat-num
   counters when #stats-bar scrolled into view.

   Removed: #stats-bar exists in no HTML file, so the observer was never
   attached and no counter ever animated. animateCounter() above is its only
   caller and goes with it. */

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
