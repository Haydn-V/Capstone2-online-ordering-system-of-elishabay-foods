import { EbFormat } from "./format.js";

/* Sales Invoice: one renderer for every receipt, laid out like the client's BIR booklet (without the printer's accreditation block or serial range, so it never poses as a booklet page), printed alone via a hidden iframe. */

/* Seller details as printed on the booklet. */
const SELLER = {
  name:    "ELISHA BAY",
  owner:   "JURIS BAY FOODS, INC.",
  tin:     "627-925-453-00000",
  address: "148 Mangin, Dagupan City, Pangasinan",
};

/* Philippine VAT: the seller is VAT-registered and shelf prices include VAT. */
const VAT_RATE = 0.12;

/* Always draw at least six item rows, like the booklet. */
const MIN_ITEM_ROWS = 6;

/* Charge Sales means a credit sale; anything paid now (cash, GCash, bank) is Cash Sales. */
const CHARGE_METHODS = new Set(["net30", "net60", "net90"]);

const esc = s => EbFormat.escHtml(s == null ? "" : s);
const r2  = n => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
const num = n => r2(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Format a date like "September 16, 2026", pinning bare dates to local midnight. */
function longDate(value){
  if(!value) return "";
  /* Format Date objects in local time, never via toISOString(). */
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

/** VAT breakdown for a VAT-inclusive total, with VAT as the remainder so the figures always add up. */
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

/** Invoice figures: use the breakdown stored with the order (migration 014) when present, falling back to 12% VAT on everything. */
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
      shipping:      r2(t.shippingFee || 0),
      /* Interest for buying on Net terms (Payments::applyInterest). */
      interest:      r2(t.termInterest || 0),
      interestRate:  t.termInterestRate,
      due:           r2(t.amountDue),
    };
  }
  const f = figures(inv.total, inv.withholding);
  return { ...f, lessVat: f.vat, addVat: f.vat, scPwdDiscount: 0 };
}

/** Convert any order shape (portal row, POS response, storefront response, My Orders card) into invoice data, using the price at purchase. */
function fromOrder(o){
  const items = (o.items || []).map(i => {
    const qty  = Number(i.qty) || 0;
    const unit = Number(i.price) || 0;
    return { description: i.name || i.id || "", qty, unit, amount: r2(qty * unit) };
  });
  const total = o.total != null ? Number(o.total) : items.reduce((n, i) => n + i.amount, 0);
  /* The stored breakdown plus Senior/PWD details when applicable. */
  const tax   = o.tax || null;
  const scPwd = (tax && tax.scPwd) || null;
  return {
    number:  o.id || "",
    date:    o.datetime || o.date || o.placedAt || "",
    charge:  CHARGE_METHODS.has(o.payMethod),
    /* Which box to tick: cash, gcash or bank. */
    method:  String(o.payMethod || "").toLowerCase(),
    tax,
    scPwd,
    soldTo: {
      /* On a Senior/PWD sale, print the name from their ID. */
      name:    (scPwd && scPwd.name) || o.customerName || o.customer || o.name || "",
      /* Retailer's BIR TIN (sent only for retailers); blank for regular customers. */
      tin:     o.tin || "",
      /* Business address prints only for online orders and walk-in deliveries; unknown types are treated as online. */
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

/** The invoice markup, scoped under .eb-invoice. */
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
  /* Six item rows even on Senior/PWD invoices; their extra lines are squeezed to fit one page. */
  const minRows = MIN_ITEM_ROWS;
  const blanks = Array.from({ length: Math.max(0, minRows - inv.items.length) }, () => `
      <tr class="ebi-item"><td>&nbsp;</td><td></td><td></td><td></td></tr>`).join("");

  /* Two stacks under the items: VAT analysis on the left, totals on the right. */
  const leftStack = [["<i>Prices already include VAT.</i>", ""]];
  /* VATable Sales + VAT = total so the column adds straight down; exempt, SC/PWD and withholding lines appear only when they apply. */
  const right = [
    ["VATable Sales", num(f.vatable)],
    ["VAT (12%)",     num(f.vat)],
    ...(f.vatExempt > 0 ? [["VAT-Exempt Sales", num(f.vatExempt)]] : []),
    ...(f.scPwdDiscount > 0 || sc ? [[`Less: ${scShort || "SC/PWD"} Discount`, num(f.scPwdDiscount)]] : []),
    /* Estimated delivery fee, added on top of the goods outside the VAT analysis. */
    ...(f.shipping > 0 ? [["Add: Delivery Fee", num(f.shipping)]] : []),
    ...(f.withholding > 0 ? [["Less: Retailer Discount", num(f.withholding)]] : []),
    ...(f.interest > 0 ? [[`Add: Interest (${+f.interestRate}%)`, num(f.interest)]] : []),
    ["TOTAL AMOUNT DUE", `${EbFormat.CURRENCY}${num(f.due)}`],
  ];
  const left = right.map((_, k) => leftStack[k] || ["", ""]);
  /* TOTAL AMOUNT DUE spans the empty left cell so it fits when phones lack Arial Narrow. */
  const summaryRows = right.map(([label, value], k) => {
    const due = k === right.length - 1 && !left[k][0] && !left[k][1];
    return `
      <tr class="ebi-sum${k === right.length - 1 ? " ebi-due" : ""}">
        ${due ? "" : `<td class="ebi-left"><span>${left[k][0]}</span><span class="ebi-num">${left[k][1]}</span></td>`}
        <td colspan="${due ? 3 : 2}" class="ebi-right">${label}</td>
        <td class="ebi-num">${value}</td>
      </tr>`;
  }).join("");

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
      <span class="ebi-check">${box(inv.method === "cash")} CASH</span>
      <span class="ebi-check">${box(inv.method === "gcash")} GCASH</span>
      <span class="ebi-check">${box(inv.method.startsWith("bank"))} BANK TRANSFER</span>
      ${inv.charge ? `<span class="ebi-check">${box(true)} CHARGE (${esc(inv.method.replace("net", "NET "))})</span>` : ""}
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

/* Invoice styles: black on white in every theme, matching the booklet's fonts. */
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
.eb-invoice .ebi-types{ display:flex; gap:10px; font-size:12.5px; white-space:nowrap; flex-wrap:wrap; }
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

/** Print the invoice alone via a hidden iframe (popups get blocked). */
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
    /* Remove the iframe later even if afterprint never fires. */
    setTimeout(cleanup, 60000);
  };
  document.body.appendChild(frame);
}

export const EbInvoice = { SELLER, VAT_RATE, figures, fromOrder, render, print, ensureStyles, CSS };
