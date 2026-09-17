import { EbFormat } from "./format.js";

/* ============================================================
   SALES INVOICE — one renderer for every receipt the system shows
   ------------------------------------------------------------
   Laid out to match the client's own pre-printed BIR Sales Invoice
   booklet, line for line: the seller block, SALES INVOICE with its
   number, Cash/Charge Sales, Date, the SOLD TO box, the four-column
   item table, the VAT breakdown in two stacks, and the cashier's
   signature line.

   ONE FILE, FOUR CALLERS. The POS receipt, Receipt Generation, the
   storefront's order confirmation and My Orders all render through
   render() below. They used to be four hand-written layouts that had
   already drifted apart — two different spellings of the address, one
   of them pricing past orders at today's price.

   WHAT IS DELIBERATELY NOT COPIED FROM THE PAPER
   ----------------------------------------------
   The printer's block at the foot of each booklet page ("CACAI
   PRINTING PRESS", the BIR Authority to Print / OCN, the Printers
   Accreditation No., the serial range 2501–5000). Those certify that
   the PAPER was printed under that authority. Reproducing them on a
   page this system prints would present every printout as a genuine
   booklet page, and a number from that serial range would collide
   with the real booklet. For the same reason the invoice number is
   the order's own id, never a continuation of the booklet's series.

   PRINTING
   --------
   print() renders the invoice alone into a hidden iframe sized to the
   booklet page and prints that. window.print() on the page — what the
   receipts used before — printed the whole portal behind the modal:
   sidebar, theme background and all.
   ============================================================ */

/* The seller, exactly as the booklet prints it. One place to change it. */
const SELLER = {
  name:    "ELISHA BAY",
  owner:   "JURIS BAY FOODS, INC.",
  tin:     "627-925-453-00000",
  address: "148 Mangin, Dagupan City, Pangasinan",
};

/* Philippine VAT. The seller is VAT-registered (VAT REG. TIN above) and
   shelf prices are VAT-inclusive, which is what the booklet's
   "Total Sales (VAT Inclusive)" line assumes. */
const VAT_RATE = 0.12;

/* The booklet's item rows — six, measured off the client's page. Fewer
   items still draw six ruled rows, so a one-line sale looks like the paper
   rather than a stub; more items simply add rows. */
const MIN_ITEM_ROWS = 6;

/* Charge Sales is a sale on terms. Everything paid at the time — cash,
   GCash, bank transfer — is Cash Sales in BIR terms: "cash" means paid
   now, not paid in notes and coins. */
const CHARGE_METHODS = new Set(["net30", "net60", "net90"]);

const esc = s => EbFormat.escHtml(s == null ? "" : s);
const r2  = n => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
const num = n => r2(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* "2026-09-16", "2026-09-16 13:06:27" or an ISO string, as "September 16, 2026".
   A bare date is pinned to local midnight — parsed as UTC it renders as the
   previous day in Manila. */
function longDate(value){
  if(!value) return "";
  /* A Date is formatted as it stands, in local time — never round-tripped
     through toISOString(), which is UTC and a day early before 8am here. */
  if(value instanceof Date){
    return isNaN(value) ? "" : value.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
  }
  let s = String(value).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00";
  else if(/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(" ", "T");
  const d = new Date(s);
  if(isNaN(d)) return String(value);
  return d.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * The VAT breakdown for a VAT-inclusive total.
 *
 * VAT is worked out as the REMAINDER, not as total × 12/112 rounded on its
 * own. Rounding both halves separately can leave VATable Sales + VAT a
 * centavo away from the total, which on a tax document is the one kind of
 * error nobody forgives.
 */
function figures(total, withholding = 0){
  const gross   = r2(total);
  const vatable = r2(gross / (1 + VAT_RATE));
  const vat     = r2(gross - vatable);
  const wht     = r2(withholding);
  return {
    totalSales: gross,
    vatable,
    vat,
    zeroRated:  0,
    vatExempt:  0,
    netOfVat:   vatable,
    withholding: wht,
    due:        r2(gross - wht),
  };
}

/**
 * The figures an invoice prints.
 *
 * STORED, WHENEVER THE ORDER HAS THEM. Since migration 014 every order carries
 * the breakdown api/core/Tax.php decided at the moment of sale — VAT-exempt
 * lines, the senior/PWD discount and withholding tax included — and the
 * invoice prints exactly those figures. A rule changed later in VAT
 * Maintenance cannot move them, which is the point.
 *
 * figures() above is only the fallback for an order object with no stored
 * breakdown: everything VATable at 12%, as the invoice always assumed before.
 */
function breakdown(inv){
  const t = inv.tax;
  if(t && t.grossTotal != null){
    return {
      totalSales:    r2(t.grossTotal),
      lessVat:       r2(t.lessVat),
      netOfVat:      r2(t.netOfVat),
      scPwdDiscount: r2(t.scPwdDiscount),
      addVat:        r2(t.vatAmount),
      vatable:       r2(t.vatableSales),
      vat:           r2(t.vatAmount),
      zeroRated:     0,
      vatExempt:     r2(t.vatExemptSales),
      withholding:   r2(t.withholdingTax),
      due:           r2(t.amountDue),
    };
  }
  const f = figures(inv.total, inv.withholding);
  return { ...f, lessVat: f.vat, addVat: f.vat, scPwdDiscount: 0 };
}

/**
 * Any order shape the system has into invoice data.
 *
 * Four callers, four shapes: an ORDERS row in the portal, the POS checkout
 * response, the storefront's checkout response and a My Orders card. The
 * names differ (customer / customerName / name, datetime / date / placedAt);
 * the meaning does not, so the translation lives here once.
 *
 * Line amounts use the price AT PURCHASE carried on each line. Re-pricing a
 * past order at today's shelf price — which Receipt Generation used to do —
 * rewrites what the customer was charged.
 */
function fromOrder(o){
  const items = (o.items || []).map(i => {
    const qty  = Number(i.qty) || 0;
    const unit = Number(i.price) || 0;
    return { description: i.name || i.id || "", qty, unit, amount: r2(qty * unit) };
  });
  const total = o.total != null ? Number(o.total) : items.reduce((n, i) => n + i.amount, 0);
  /* The stored breakdown (see breakdown()), and the senior/PWD details it
     carries when the sale was one. */
  const tax   = o.tax || null;
  const scPwd = (tax && tax.scPwd) || null;
  return {
    number:  o.id || "",
    date:    o.datetime || o.date || o.placedAt || "",
    charge:  CHARGE_METHODS.has(o.payMethod),
    tax,
    scPwd,
    soldTo: {
      /* On a senior/PWD sale the name is the one on their ID: the BIR requires
         the discount holder's own name on the invoice, and the POS name field
         usually still reads "Walk-In Customer". */
      name:    (scPwd && scPwd.name) || o.customerName || o.customer || o.name || "",
      /* A retailer's own BIR TIN, as they entered it on their partner
         application — the servers send it only for retailers
         (Orders::buyerTinSql). A regular customer's line stays blank. */
      tin:     o.tin || "",
      /* BUSINESS ADDRESS IS FOR ORDERS THAT TRAVEL. An online order carries
         the address it ships to or was placed from. A walk-in sale happens at
         the counter, so its line stays blank — unless it was rung up as a
         DELIVERY, which is the only time a walk-in has an address at all (the
         POS asks for one only then). An order whose type is unknown is
         treated as online rather than silently losing its address. */
      address: (o.type === "walk-in" && o.orderType !== "delivery") ? "" : (o.address || ""),
    },
    items,
    total,
    withholding: Number(o.withholding) || 0,
    cashier: o.cashier || "",
  };
}

function box(checked){
  return `<span class="ebi-box" aria-hidden="true">${checked ? "&#10003;" : ""}</span>`;
}

/** The invoice as markup. Scoped under .eb-invoice; see CSS below. */
function render(inv){
  const f  = breakdown(inv);
  const sc = inv.scPwd;
  const scShort = sc ? (sc.type === "pwd" ? "PWD" : "SC") : "";

  const itemRows = inv.items.map(i => `
      <tr class="ebi-item">
        <td>${esc(i.description)}</td>
        <td class="ebi-num">${esc(i.qty)}</td>
        <td class="ebi-num">${num(i.unit)}</td>
        <td class="ebi-num">${num(i.amount)}</td>
      </tr>`).join("");
  /* Six ruled rows on every invoice, senior/PWD included. That invoice's extra
     lines are made to fit instead of eating the item rows: the ID shares the
     TIN row and the signatures sit closer. Measured against the 5.5 × 8.5in
     page with six items, taking rows away instead still spilled onto a second
     sheet. */
  const minRows = MIN_ITEM_ROWS;
  const blanks = Array.from({ length: Math.max(0, minRows - inv.items.length) }, () => `
      <tr class="ebi-item"><td>&nbsp;</td><td></td><td></td><td></td></tr>`).join("");

  /* The two stacks under the items, as the booklet has them: the VAT
     analysis on the left under the description column, the reconciliation
     to the amount due on the right across Quantity and Unit Cost. */
  const leftStack = [
    ["VATable Sales",    num(f.vatable)],
    ["VAT",              num(f.vat)],
    ["Zero-Rated Sales", num(f.zeroRated)],
    ["VAT-Exempt Sales", num(f.vatExempt)],
  ];
  /* "Less: VAT" is the VAT inside the shelf prices; "Add: VAT" is the VAT
     charged. They are the same figure on an ordinary sale and differ only when
     a discount or an exemption sits between them — which is why the booklet
     prints both. The discount line appears only on a senior/PWD sale, where
     the BIR requires it. */
  const right = [
    ["Total Sales(VAT Inclusive)", num(f.totalSales)],
    ["Less: VAT",                  num(f.lessVat)],
    ["Amount: Net of VAT",         num(f.netOfVat)],
    ...(f.scPwdDiscount > 0 || sc ? [[`Less: ${scShort || "SC/PWD"} Discount`, num(f.scPwdDiscount)]] : []),
    ["Add: VAT",                   num(f.addVat)],
    ["Less: Withholding Tax",      num(f.withholding)],
    ["TOTAL AMOUNT DUE",           `${EbFormat.CURRENCY}${num(f.due)}`],
  ];
  const left = right.map((_, k) => leftStack[k] || ["", ""]);
  const summaryRows = right.map(([label, value], k) => `
      <tr class="ebi-sum${k === right.length - 1 ? " ebi-due" : ""}">
        <td class="ebi-left"><span>${left[k][0]}</span><span class="ebi-num">${left[k][1]}</span></td>
        <td colspan="2" class="ebi-right">${label}</td>
        <td class="ebi-num">${value}</td>
      </tr>`).join("");

  return `<div class="eb-invoice">
  <header class="ebi-seller">
    <div class="ebi-seller-name">${esc(SELLER.name)}</div>
    <div class="ebi-seller-line">Owned &amp; Operated by: <b>${esc(SELLER.owner)}</b></div>
    <div class="ebi-seller-line">VAT REG. TIN: ${esc(SELLER.tin)}</div>
    <div class="ebi-seller-line">${esc(SELLER.address)}</div>
  </header>

  <div class="ebi-titlebar">
    <div class="ebi-title">SALES<br>INVOICE</div>
    <div class="ebi-number">${esc(inv.number)}</div>
  </div>

  <div class="ebi-typebar">
    <div class="ebi-types">
      <span class="ebi-check">${box(!inv.charge)} CASH SALES</span>
      <span class="ebi-check">${box(inv.charge)} CHARGE SALES</span>
    </div>
    <div class="ebi-date">Date: <span class="ebi-fill">${esc(longDate(inv.date))}</span></div>
  </div>

  <section class="ebi-soldto">
    <div class="ebi-soldto-head">SOLD TO:</div>
    <div class="ebi-field"><span class="ebi-label">Registered Name :</span><span class="ebi-value">${esc(inv.soldTo.name)}</span></div>
    <div class="ebi-field"><span class="ebi-label">TIN:</span><span class="ebi-value">${esc(inv.soldTo.tin)}</span>${sc ? `<span class="ebi-label">${scShort} ID No.:</span><span class="ebi-value">${esc(sc.id)}</span>` : ""}</div>
    <div class="ebi-field"><span class="ebi-label">Business Address:</span><span class="ebi-value">${esc(inv.soldTo.address)}</span></div>
  </section>

  <table class="ebi-table">
    <colgroup><col class="ebi-c-desc"><col class="ebi-c-qty"><col class="ebi-c-unit"><col class="ebi-c-amt"></colgroup>
    <thead>
      <tr>
        <th>Item Description / Nature of Service</th>
        <th>Quantity</th>
        <th class="ebi-th-unit">Unit Cost/<br>Price</th>
        <th>Amount</th>
      </tr>
    </thead>
    <tbody>${itemRows}${blanks}${summaryRows}
    </tbody>
  </table>

  <div class="ebi-signs${sc ? " has-holder" : ""}">${sc ? `
    <div class="ebi-sign">
      <div class="ebi-sign-name">${esc(sc.name)}</div>
      <div class="ebi-sign-label">Signature of ${sc.type === "pwd" ? "PWD" : "Senior Citizen"}</div>
    </div>` : ""}
    <div class="ebi-sign">
      <div class="ebi-sign-name">${esc(inv.cashier)}</div>
      <div class="ebi-sign-label">Cashier/Authorized Representative</div>
    </div>
  </div>
</div>`;
}

/* Styles. A document, not a themed panel: black on white in every theme,
   because it is what gets printed and what a BIR examiner would read.
   Condensed sans for the form, a serif for the signature label and a red
   numbering-machine face for the invoice number — as on the booklet. */
const CSS = `
.eb-invoice{
  --ebi-ink:#111; --ebi-rule:#222; --ebi-red:#c8102e;
  box-sizing:border-box; width:100%; max-width:5.2in; margin:0 auto;
  padding:18px 20px 22px; background:#fff; color:var(--ebi-ink);
  font-family:"Arial Narrow","Roboto Condensed","Helvetica Neue",Arial,sans-serif;
  font-stretch:condensed; font-size:12px; line-height:1.25; text-align:left;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.eb-invoice *{ box-sizing:border-box; }
.eb-invoice .ebi-seller{ text-align:center; margin-bottom:10px; }
.eb-invoice .ebi-seller-name{ font-size:20px; font-weight:800; letter-spacing:.06em; }
.eb-invoice .ebi-seller-line{ font-size:13.5px; }
.eb-invoice .ebi-titlebar{ display:flex; justify-content:space-between; align-items:flex-end; gap:12px; }
.eb-invoice .ebi-title{ font-size:26px; font-weight:800; line-height:.95; letter-spacing:.01em; }
.eb-invoice .ebi-number{
  color:var(--ebi-red); font-family:"OCR B","OCR-B","Courier New",Courier,monospace;
  font-size:19px; letter-spacing:.12em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:62%;
}
.eb-invoice .ebi-typebar{ display:flex; justify-content:space-between; align-items:flex-end; gap:12px; margin:10px 0 8px; }
.eb-invoice .ebi-types{ display:flex; gap:14px; font-size:14px; white-space:nowrap; }
.eb-invoice .ebi-check{ display:inline-flex; align-items:center; gap:5px; }
.eb-invoice .ebi-box{
  display:inline-flex; align-items:center; justify-content:center;
  width:15px; height:15px; border:1.4px solid var(--ebi-rule); font-size:12px; font-weight:800; line-height:1;
}
.eb-invoice .ebi-date{ display:flex; align-items:flex-end; gap:4px; font-size:14px; flex:1; justify-content:flex-end; }
.eb-invoice .ebi-fill{ display:inline-block; min-width:1.9in; border-bottom:1px solid var(--ebi-rule); padding:0 2px; text-align:center; }
/* Taller than it needs to be for three typed lines, on purpose: the
   booklet's box is sized for handwriting, about 1.3in deep, and a shorter
   box is the first thing that makes a printout look unlike the paper. */
.eb-invoice .ebi-soldto{ border:1.6px solid var(--ebi-rule); padding:6px 9px 8px; margin-bottom:8px; }
.eb-invoice .ebi-soldto-head{ font-weight:800; font-size:14px; min-height:28px; }
.eb-invoice .ebi-field{ display:flex; gap:6px; font-size:14px; min-height:28px; align-items:center; }
.eb-invoice .ebi-label{ white-space:nowrap; }
.eb-invoice .ebi-value{ flex:1; font-weight:600; word-break:break-word; }
.eb-invoice .ebi-table{ width:100%; border-collapse:collapse; table-layout:fixed; border:1.6px solid var(--ebi-rule); }
.eb-invoice .ebi-c-desc{ width:49%; } .eb-invoice .ebi-c-qty{ width:14.5%; }
.eb-invoice .ebi-c-unit{ width:15.5%; } .eb-invoice .ebi-c-amt{ width:21%; }
/* Row heights from the booklet: about 0.28in an item row, 0.32in the header. */
.eb-invoice .ebi-table th{
  border:1px solid var(--ebi-rule); padding:4px 4px; height:31px; font-size:12px; font-weight:800;
  text-align:center; vertical-align:middle; line-height:1.05;
}
.eb-invoice .ebi-table td{ border:1px solid var(--ebi-rule); padding:2px 6px; height:27px; font-size:13px; vertical-align:middle; }
.eb-invoice .ebi-table tr{ break-inside:avoid; page-break-inside:avoid; }
.eb-invoice .ebi-item td:first-child{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.eb-invoice .ebi-num{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.eb-invoice .ebi-sum .ebi-left{ display:table-cell; }
.eb-invoice .ebi-sum .ebi-left span:first-child{ float:left; }
.eb-invoice .ebi-sum .ebi-left .ebi-num{ float:right; }
.eb-invoice .ebi-sum .ebi-right{ text-align:right; padding-right:6px; }
/* nowrap: at 15px bold the label only just fits its cell, and a wrapped
   TOTAL AMOUNT DUE doubles the row height and can push the invoice onto a
   second sheet. */
.eb-invoice .ebi-due .ebi-right{ font-weight:800; font-size:15px; letter-spacing:.01em; white-space:nowrap; }
.eb-invoice .ebi-due td:last-child{ font-weight:800; font-size:14px; }
.eb-invoice .ebi-signs{ display:flex; justify-content:flex-end; gap:14px; margin-top:40px; break-inside:avoid; }
.eb-invoice .ebi-signs.has-holder{ justify-content:space-between; margin-top:24px; }
.eb-invoice .ebi-sign{ display:flex; flex-direction:column; align-items:flex-end; }
.eb-invoice .ebi-signs.has-holder .ebi-sign-name,
.eb-invoice .ebi-signs.has-holder .ebi-sign-label{ min-width:2.2in; }
.eb-invoice .ebi-sign-name{ min-width:2.6in; text-align:center; font-size:12px; min-height:15px; }
.eb-invoice .ebi-sign-label{
  min-width:2.6in; text-align:center; border-top:1.2px solid var(--ebi-rule); padding-top:2px;
  font-family:"Times New Roman",Times,Georgia,serif; font-size:14px;
}
`;

/* The booklet page: roughly half a short bond sheet. */
const PAGE_CSS = `
@page{ size:5.5in 8.5in; margin:.25in; }
html,body{ margin:0; padding:0; background:#fff; }
.eb-invoice{ max-width:none; padding:0; }
`;

/** Install the on-screen styles once per document. */
function ensureStyles(doc = document){
  if(doc.getElementById("eb-invoice-css")) return;
  const style = doc.createElement("style");
  style.id = "eb-invoice-css";
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/**
 * Print the invoice on its own page.
 *
 * A hidden iframe rather than a popup window: popups are blocked unless they
 * open inside the click, and a print that silently does nothing is the worst
 * outcome for a cashier with a customer waiting.
 */
function print(inv){
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  const title = `Sales Invoice ${inv.number || ""}`.trim();
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
    + `<style>${CSS}${PAGE_CSS}</style></head><body>${render(inv)}</body></html>`;

  let done = false;
  const cleanup = () => { if(done) return; done = true; setTimeout(() => frame.remove(), 500); };
  frame.onload = () => {
    const w = frame.contentWindow;
    w.addEventListener("afterprint", cleanup);
    w.focus();
    w.print();
    /* Some browsers never fire afterprint for an iframe; do not leave it
       behind for the rest of the session. */
    setTimeout(cleanup, 60000);
  };
  document.body.appendChild(frame);
}

export const EbInvoice = { SELLER, VAT_RATE, figures, fromOrder, render, print, ensureStyles, CSS };
