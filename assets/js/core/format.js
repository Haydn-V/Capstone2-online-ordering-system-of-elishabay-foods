/* ============================================================
 FORMAT — display formatting, one implementation
 ------------------------------------------------------------
 These helpers existed twice: once in engine.js for the portal
 and once in site.js for the public pages, with small differences
 that had drifted (the public stockInfo returned {cls,label}, the
 portal's returned {cls,label,level}; the public one wrote the
 quantity into the label, the portal's did not).

 Published as EbFormat rather than as bare globals, because
 engine.js already defines `peso`, `escHtml`, `fmtDate` and
 friends at top level. Two files declaring the same top-level
 `const` is a SyntaxError that kills the entire script — the exact
 failure that made the pre-RBAC portal engines impossible to load
 side by side. engine.js now delegates to this file instead.
 ============================================================ */


const CURRENCY = "₱";

const escHtml = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const peso = n => CURRENCY + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 0 });

/* Two decimals, for money that must reconcile — receipts, refunds, totals. */
const pesoExact = n => CURRENCY + Number(n || 0).toLocaleString("en-PH", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

function fmtDate(str) {
  if (!str) return "—";
  /* A bare YYYY-MM-DD parses as UTC midnight, which in a UTC+8 timezone
     renders as the previous day. Forcing local midnight avoids the
     off-by-one. */
  const d = new Date(str + (String(str).length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(str) {
  if (!str) return "—";
  const [date, time] = String(str).split(" ");
  return fmtDate(date) + (time ? " " + time.slice(0, 5) : "");
}

const initials = name => String(name || "")
  .split(" ").filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();

/* ============================================================
   STOCK LEVEL AND MOVEMENT
   ------------------------------------------------------------
   Both are decided by the SERVER now, in api/core/Inventory.php, from
   measured sales velocity. Read that file for why — in short, a fixed
   piece count cannot tell a shortage from three years of cover, and
   `products.sold` is a lifetime counter that never decays, so given
   enough trading it classifies every product as fast moving.

   These functions no longer hold thresholds. They TRANSLATE what the
   server decided into a badge class, and fall back to a piece count
   only when handed a bare number.

   PASS THE PRODUCT, NOT THE COUNT. `stockInfo(p)` uses the measured
   band; `stockInfo(p.stock)` cannot, because a number carries no
   velocity. The numeric path exists for the screens that genuinely
   only have a quantity — a cart line, a batch quantity — and it is
   deliberately conservative rather than clever.
   ============================================================ */

const STOCK_BADGE = {
  out:  { cls: "badge-out",  label: "Out of Stock" },
  crit: { cls: "badge-crit", label: "Critical"     },
  warn: { cls: "badge-warn", label: "Low"          },
  ok:   { cls: "badge-ok",   label: "Safe"         },
};

const MOVE_BADGE = {
  fast: { cls: "badge-ok",    label: "Fast Moving" },
  slow: { cls: "badge-warn",  label: "Slow Moving" },
  non:  { cls: "badge-muted", label: "Non-Moving"  },
};

/* The floor from Inventory::DEFAULTS, and only the floor. Used when there is
   no server verdict to read. It is intentionally NOT the full model: guessing
   at velocity from a number nobody measured is how the old bands went wrong. */
const STOCK_FLOOR_CRITICAL = 10;

function stockInfo(input) {
  if (input && typeof input === "object") {
    const inv = input.inventory;
    if (inv && STOCK_BADGE[inv.level]) {
      return {
        ...STOCK_BADGE[inv.level],
        level:     inv.level,
        /* Carried through so a screen can explain the badge on hover rather
           than leaving the reader to reconcile "Critical" with a healthy
           looking number. */
        reason:    inv.levelReason || null,
        daysCover: inv.daysCover ?? null,
        perMonth:  inv.perMonth ?? null,
      };
    }
    return stockInfo(Number(input.stock) || 0);
  }

  const stock = Number(input) || 0;
  if (stock <= 0)                            return { ...STOCK_BADGE.out,  level: "out",  reason: null, daysCover: null, perMonth: null };
  if (stock <= STOCK_FLOOR_CRITICAL)         return { ...STOCK_BADGE.crit, level: "crit", reason: null, daysCover: null, perMonth: null };
  if (stock <= STOCK_FLOOR_CRITICAL * 3)     return { ...STOCK_BADGE.warn, level: "warn", reason: null, daysCover: null, perMonth: null };
  return                                            { ...STOCK_BADGE.ok,   level: "ok",   reason: null, daysCover: null, perMonth: null };
}

function movementType(input) {
  if (input && typeof input === "object") {
    const inv = input.inventory;
    if (inv && MOVE_BADGE[inv.movement]) {
      return { ...MOVE_BADGE[inv.movement], movement: inv.movement, perMonth: inv.perMonth ?? null };
    }
    return { ...MOVE_BADGE.non, movement: "non", perMonth: null };
  }
  /* A bare number reaching here is the retired lifetime-total call. There is
     no honest rate to derive from it, so it reports unknown rather than
     resurrecting the thresholds this change removed. */
  return { cls: "badge-muted", label: "—", movement: null, perMonth: null };
}

/* The canonical payment keys the database stores. Never return undefined —
   it used to render as the literal word "undefined" in the payment column. */
const PAY_METHODS = {
  cash: "Cash", gcash: "GCash", bank: "Bank Transfer",
  net30: "Net 30", net60: "Net 60", net90: "Net 90",
};
/* An unrecognised key falls through to the key ITSELF on purpose: a method
   added to the database before this map knows about it should read "paymaya"
   rather than a dash that hides it.
   The two strings below are the exception. They are what a missing value looks
   like after it has been through string interpolation somewhere upstream, and
   passing them through prints the word "undefined" in the Method column —
   which is how this column read for a whole release once already. A value that
   stringified from nothing is missing, not a new payment method. */
const payMethodLabel = m =>
  PAY_METHODS[m] || (m && m !== "undefined" && m !== "null" ? m : "—");

const STATUS_LABELS = {
  pending: "Pending", accepted: "Accepted", shipping: "Shipping",
  delivered: "Delivered", completed: "Completed",
  "on-hold": "On Hold", cancelled: "Cancelled",
};
const statusLabel = s => STATUS_LABELS[s] || s || "—";


/* ============================================================
   IMAGES — one resolver for the whole system (decision I6)
   ------------------------------------------------------------
   No screen builds an image src inline any more. Every one of them
   calls imageUrl().

   WHY THIS EXISTS
   ---------------
   Three separate "the image doesn't show" defects had three separate
   causes that were really one cause: nothing owned the question "given
   a record, what goes in the src?". The storefront read `p.img` while
   the API sent `image`; the landing editor read `slide.img` from a
   column nothing wrote; the POS read `p.image` and worked, which is
   what made the whole thing look like three unrelated bugs instead of
   one missing function.

   WHAT A STORED VALUE LOOKS LIKE
   ------------------------------
   api/uploads/image.php returns, and the database stores, an
   APPLICATION-root-relative path:

       /uploads/products/ab12….webp

   Not "uploads/…" and not "../uploads/…". A relative path resolves
   against whatever page is asking, which is exactly why staff screens
   at /portal/admin/ found images that customer screens at /public/
   could not. And not "/elishabay/uploads/…" either: the install prefix
   is config, not data, so it is prepended here rather than baked into
   every row.
   ============================================================ */

/* Project root, derived from this module's own URL — the same derivation
   api.js uses. Deliberately not imported from api.js: format.js is a leaf
   of the module graph and should stay one. */
const APP_BASE = (() => {
  const src = import.meta.url;
  const i = src.indexOf("assets/js/core/");
  return i >= 0 ? src.slice(0, i) : "/";
})();

/* Rendered whenever an image is absent or fails to load. A defined mark, never
   a broken-image icon and never an empty box. Inline SVG so it costs no
   request and cannot itself 404. `currentColor` is not available inside a data
   URI, so the grey is fixed — chosen to sit acceptably on both themes. */
const IMAGE_PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
      '<rect width="64" height="64" fill="#e7e3dc"/>' +
      '<g fill="none" stroke="#a9a094" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M50 44a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V26a2 2 0 0 1 2-2h6l2.5-4h15L42 24h6a2 2 0 0 1 2 2z"/>' +
        '<circle cx="32" cy="35" r="7"/>' +
      "</g>" +
    "</svg>"
  );

/**
 * Resolve anything image-shaped to a usable src.
 *
 * Accepts a record ({image} or the legacy {img}) or a bare string, so a caller
 * can pass the row it already has without knowing which endpoint produced it.
 * Returns "" when there is no image — callers branch on that to render their
 * own placeholder markup, and the delegated fallback below covers the case
 * where a path exists but the file has gone.
 */
function imageUrl(input) {
  let raw = input;
  if (input && typeof input === "object") {
    /* `image` is what every endpoint sends after Phase 3. `img` is the
       storefront's historical spelling and is read for one release so a
       half-migrated screen degrades to a placeholder rather than to
       `src="undefined"`. */
    raw = input.image ?? input.img ?? "";
  }
  if (typeof raw !== "string" || raw === "") return "";

  const v = raw.trim();
  if (v === "") return "";

  /* Data URLs: the pre-pipeline storage format, and what a local preview
     produces before a save. Passed through untouched. */
  if (v.startsWith("data:")) return v;

  /* Already absolute — an external CDN, or a full URL somebody stored. */
  if (/^https?:\/\//i.test(v) || v.startsWith("//")) return v;

  /* The canonical form: application-root-relative. */
  if (v.startsWith("/")) return APP_BASE + v.slice(1);

  /* Anything else is a bare relative path from before this existed. Resolved
     against the application root rather than the page, because resolving
     against the page is the original bug. */
  return APP_BASE + v.replace(/^\.\//, "");
}

/**
 * Swap any image that fails to load for the placeholder.
 *
 * One delegated capture-phase listener rather than an `onerror` attribute on
 * every tag: the attribute is an inline handler, which this project rules out,
 * and half the img tags in the portal are built inside template strings where
 * nobody would remember to add it. Installed once from core/index.js.
 *
 * The `error` event does not bubble, hence capture.
 */
function installImageFallback(doc) {
  const d = doc || document;
  if (d.__ebImageFallback) return;
  d.__ebImageFallback = true;

  d.addEventListener(
    "error",
    ev => {
      const el = ev.target;
      if (!el || el.tagName !== "IMG") return;
      /* Guard against a placeholder that itself fails, which would loop. */
      if (el.dataset.ebPlaceheld === "1") return;
      el.dataset.ebPlaceheld = "1";
      el.src = IMAGE_PLACEHOLDER;
    },
    true
  );
}

export const EbFormat = {
  CURRENCY, escHtml, peso, pesoExact,
  fmtDate, fmtDateTime, initials,
  stockInfo, movementType,
  payMethodLabel, statusLabel,
  PAY_METHODS, STATUS_LABELS,
  imageUrl, installImageFallback, IMAGE_PLACEHOLDER, APP_BASE,
};

