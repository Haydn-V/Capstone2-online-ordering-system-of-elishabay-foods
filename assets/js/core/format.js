/* Display formatting helpers shared by portal and storefront, published as EbFormat (engine.js already has top-level names like peso and escHtml). */


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
  /* Force local midnight so a bare date does not show as the previous day. */
  const d = new Date(str + (String(str).length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

/* Estimated arrival window, "Oct 29 – Oct 31, 2026" (one date when both ends match; "" when unknown). */
function etaRange(from, to) {
  if (!from) return "";
  const d = s => new Date(s + "T00:00:00");
  const a = d(from), b = d(to || from);
  if (isNaN(a) || isNaN(b)) return "";
  const md = x => x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (+a === +b) return `${md(a)}, ${a.getFullYear()}`;
  return a.getFullYear() === b.getFullYear()
    ? `${md(a)} – ${md(b)}, ${b.getFullYear()}`
    : `${md(a)}, ${a.getFullYear()} – ${md(b)}, ${b.getFullYear()}`;
}

function fmtDateTime(str) {
  if (!str) return "—";
  const [date, time] = String(str).split(" ");
  return fmtDate(date) + (time ? " " + time.slice(0, 5) : "");
}

const initials = name => String(name || "")
  .split(" ").filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();

/* Stock level and movement are decided by the server (api/core/Inventory.php); these functions only turn that into a badge, so pass the product, not just the count. */

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

/* The fallback floor from Inventory::DEFAULTS, used only when there is no server verdict. */
const STOCK_FLOOR_CRITICAL = 10;

function stockInfo(input) {
  if (input && typeof input === "object") {
    const inv = input.inventory;
    if (inv && STOCK_BADGE[inv.level]) {
      return {
        ...STOCK_BADGE[inv.level],
        level:     inv.level,
        /* Carry the reason so screens can explain the badge on hover. */
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
  /* A bare number has no sales rate, so movement is reported as unknown. */
  return { cls: "badge-muted", label: "—", movement: null, perMonth: null };
}

/* Payment method labels; never return undefined. */
const PAY_METHODS = {
  cash: "Cash", gcash: "GCash", bank: "Bank Transfer",
  net30: "Net 30", net60: "Net 60", net90: "Net 90",
};
/* Unknown keys show as themselves, except "undefined"/"null", which mean missing. */
const payMethodLabel = m =>
  PAY_METHODS[m] || (m && m !== "undefined" && m !== "null" ? m : "—");

const STATUS_LABELS = {
  pending: "Pending", accepted: "Accepted", shipping: "Shipping",
  delivered: "Delivered", completed: "Completed",
  "on-hold": "On Hold", cancelled: "Cancelled",
};
const statusLabel = s => STATUS_LABELS[s] || s || "—";


/* imageUrl() is the one resolver for every image src; stored paths are app-root-relative (/uploads/...), with the install prefix added here. */

/* Project root from this module's URL (same as api.js, not imported so this stays a leaf module). */
const APP_BASE = (() => {
  const src = import.meta.url;
  const i = src.indexOf("assets/js/core/");
  return i >= 0 ? src.slice(0, i) : "/";
})();

/* Inline SVG placeholder for missing or broken images. */
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

/** Turn a record ({image} or legacy {img}) or a string into a usable src, or "" when there is no image. */
function imageUrl(input) {
  let raw = input;
  if (input && typeof input === "object") {
    /* image is current; img is the old storefront name, still accepted for now. */
    raw = input.image ?? input.img ?? "";
  }
  if (typeof raw !== "string" || raw === "") return "";

  const v = raw.trim();
  if (v === "") return "";

  /* Data URLs pass through unchanged. */
  if (v.startsWith("data:")) return v;

  /* Already absolute — an external CDN, or a full URL somebody stored. */
  if (/^https?:\/\//i.test(v) || v.startsWith("//")) return v;

  /* The canonical form: application-root-relative. */
  if (v.startsWith("/")) return APP_BASE + v.slice(1);

  /* Old relative paths are resolved against the app root, not the page. */
  return APP_BASE + v.replace(/^\.\//, "");
}

/** A smaller copy of an uploaded product or landing photo (api/uploads/thumb.php, width 400 or 800); anything else returns imageUrl() unchanged. */
function thumbUrl(input, width) {
  const full = imageUrl(input);
  const m = full.match(/\/uploads\/((?:products|content)\/[0-9a-f]{32}\.webp)$/);
  if (!m) return full;
  return APP_BASE + "api/uploads/thumb.php?f=" + m[1] + "&w=" + width;
}

/** One capture-phase error listener (installed from core/index.js) swaps broken images for the placeholder, instead of inline onerror attributes. */
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
  fmtDate, fmtDateTime, etaRange, initials,
  stockInfo, movementType,
  payMethodLabel, statusLabel,
  PAY_METHODS, STATUS_LABELS,
  imageUrl, thumbUrl, installImageFallback, IMAGE_PLACEHOLDER, APP_BASE,
};

