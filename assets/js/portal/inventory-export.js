/* Inventory Report export (PDF and CSV), loaded on demand by engine.js: import("./inventory-export.js").
   The user picks the sales window the bands are measured over (Yesterday, Last 7 days, Last 30 days);
   the data is the same products/list.php the Inventory Report shows. Shares the printing and CSV helpers
   (and the report look) with the Sales Report export. */

import { SELLER, PDF_CSS, esc, money, printDocument, saveCsv } from "./sales-export.js";

const WINDOWS = [["yesterday", "Yesterday"], ["week", "Last 7 days"], ["month", "Last 30 days"]];
const LEVEL_ORDER = [["ok", "Safe"], ["warn", "Low"], ["crit", "Critical"], ["out", "Out of Stock"]];
const MOVE_ORDER  = [["fast", "Fast Moving"], ["slow", "Slow Moving"], ["non", "Non-Moving"]];

/* ---------------------------------------------------------------- picker */

/** Ask which sales window to measure over, then export as "pdf" or "csv". */
export function openInventoryExport(kind){
  const start = ["yesterday", "week", "month"].includes(adminState.stockWindow) ? adminState.stockWindow : "month";
  openModal({
    title: kind === "pdf" ? "Export Inventory Report (PDF)" : "Export Inventory Report (CSV)",
    body: `
      <p class="field-hint" style="margin:0 0 12px">Stock levels and movement are measured from completed sales over the period you choose. Stock on hand is always as of now.</p>
      <div class="sx-presets" role="radiogroup" aria-label="Measured over">
        ${WINDOWS.map(([k, l]) => `<button type="button" class="sx-preset${k === start ? " active" : ""}" data-iw="${k}" role="radio" aria-checked="${k === start}">${l}</button>`).join("")}
      </div>`,
    confirmLabel: kind === "pdf" ? "Export PDF" : "Export CSV",
    async onConfirm(){
      const win = $(".sx-preset.active")?.dataset.iw || "week";
      const btn = $("#modal-footer .btn-gold");
      const restore = EbUI.busy(btn, "Preparing…");
      try {
        const d = await loadReport(win);
        closeModal();
        if(kind === "pdf") printDocument(reportDocument(d)); else downloadCsv(d);
        toast(kind === "pdf" ? "Inventory report ready — choose “Save as PDF” in the print window." : "CSV exported.", "ok");
      } catch(e){
        toast(e.message, "err");
      } finally { restore(); }
    },
  });
  $$("[data-iw]").forEach(b => b.addEventListener("click", () => {
    $$("[data-iw]").forEach(x => { const on = x === b; x.classList.toggle("active", on); x.setAttribute("aria-checked", String(on)); });
  }));
}

/* Every product (all pages), measured over the chosen window. */
async function loadReport(win){
  const rows = [];
  let page = 1, meta = {};
  for(;;){
    const res = await EbApi.get("products/list.php", { page, limit: 200, status: "all", sort: "name", window: win });
    rows.push(...res.data);
    meta = res.meta || meta;
    if(!meta.pages || page >= meta.pages) break;
    page++;
  }
  const label = (WINDOWS.find(([k]) => k === win) || [win, win])[1];
  return { products: rows, model: meta.inventoryModel || {}, windowLabel: label, windowDays: meta.windowDays || null,
           preparedBy: adminState.currentUser?.name || "" };
}

/* Figures shared by the PDF and CSV. */
function summarize(d){
  const p = d.products;
  const count = (key, val) => p.filter(x => (x.inventory || {})[key] === val);
  const levels = LEVEL_ORDER.map(([k, l]) => { const g = count("level", k); return { key: k, label: l, products: g.length, units: g.reduce((n, x) => n + x.stock, 0) }; });
  const moves  = MOVE_ORDER.map(([k, l]) => { const g = count("movement", k); return { key: k, label: l, products: g.length, sold: g.reduce((n, x) => n + ((x.inventory || {}).windowUnits || 0), 0) }; });
  const restock = p.filter(x => ["warn", "crit", "out"].includes((x.inventory || {}).level))
    .sort((a, b) => ({ out: 0, crit: 1, warn: 2 })[a.inventory.level] - ({ out: 0, crit: 1, warn: 2 })[b.inventory.level] || a.stock - b.stock);
  const expiry = p.filter(x => (x.inventory || {}).expiryRisk);
  return {
    totalProducts: p.length,
    archived: p.filter(x => x.archived).length,
    units: p.reduce((n, x) => n + x.stock, 0),
    value: p.reduce((n, x) => n + x.stock * x.price, 0),
    soldInWindow: p.reduce((n, x) => n + ((x.inventory || {}).windowUnits || 0), 0),
    levels, moves, restock, expiry,
  };
}

/* The automatic rules, worded like the on-screen legend. */
function thresholds(m){
  const low = +m.lowDays || 14, crit = +m.criticalDays || 7, min = +m.minUnits || 5;
  const avg = +m.averageUnits || 0;
  return {
    levels: `Safe (${low}+ days of stock) · Low (under ${low} days) · Critical (under ${crit} days, or ${min} units or fewer) · Out of Stock (0)`,
    moves: `Fast Moving (${avg > 0 ? `${Math.ceil(avg).toLocaleString("en-PH")}+ sold, the store average` : "at or above the store average"}) · Slow Moving (sold, below average) · Non-Moving (none sold)`,
  };
}

const levelLabel = x => (x.inventory || {}).levelLabel || "—";
const moveLabel  = x => (x.inventory || {}).movementLabel || "—";

/* ---------------------------------------------------------------- PDF */

function table(head, rows, foot = ""){
  const th = head.map(([label, num]) => `<th${num ? ' class="num"' : ""}>${label}</th>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody>${foot}</table>`;
}

export function reportDocument(d){
  const s = summarize(d), t = thresholds(d.model);
  const printed = new Date();
  const printedText = printed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    + " · " + printed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const card = (label, value, sub) => `<div class="sr-card"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
  const lv = Object.fromEntries(s.levels.map(x => [x.key, x.products]));

  const levelsTbl = table([["Stock level"], ["Products", 1], ["Units on hand", 1]],
    s.levels.map(x => `<tr><td>${x.label}</td><td class="num">${x.products}</td><td class="num">${x.units.toLocaleString()}</td></tr>`),
    `<tbody><tr class="total"><td>Total</td><td class="num">${s.totalProducts}</td><td class="num">${s.units.toLocaleString()}</td></tr></tbody>`);

  const movesTbl = table([["Movement"], ["Products", 1], [`Sold (${esc(d.windowLabel.toLowerCase())})`, 1]],
    s.moves.map(x => `<tr><td>${x.label}</td><td class="num">${x.products}</td><td class="num">${x.sold.toLocaleString()}</td></tr>`),
    `<tbody><tr class="total"><td>Total</td><td class="num">${s.totalProducts}</td><td class="num">${s.soldInWindow.toLocaleString()}</td></tr></tbody>`);

  const restock = s.restock.length
    ? table([["Product"], ["Stock", 1], ["Level"], ["Why"], ["Days of cover", 1]],
        s.restock.map(x => `<tr><td class="ref">${esc(x.name)}</td><td class="num">${x.stock}</td><td>${levelLabel(x)}</td><td class="muted">${esc(x.inventory.levelReason || "")}</td><td class="num">${x.inventory.daysCover ?? "—"}</td></tr>`))
    : `<p class="empty">No products need restocking.</p>`;

  const expiry = s.expiry.length
    ? table([["Product"], ["Lot"], ["Expiry"], ["Units", 1], ["Note"]],
        s.expiry.map(x => { const r = x.inventory.expiryRisk; return `<tr><td class="ref">${esc(x.name)}</td><td>${esc(r.lot || "")}</td><td>${esc(r.expiry || "")}</td><td class="num">${r.qty ?? ""}</td><td class="muted">${esc(r.note || "")}</td></tr>`; }))
    : `<p class="empty">No lots at risk of expiring before they sell.</p>`;

  const all = table([["Product"], ["Category"], ["Stock", 1], ["Level"], ["Movement"], ["Sold", 1], ["Price", 1], ["Total sold", 1]],
    d.products.map(x => `<tr><td class="ref">${esc(x.name)}${x.archived ? ' <span class="muted">(archived)</span>' : ""}</td><td>${esc(x.cat || "")}</td><td class="num">${x.stock}</td><td>${levelLabel(x)}</td><td>${moveLabel(x)}</td><td class="num">${((x.inventory || {}).windowUnits || 0).toLocaleString()}</td><td class="num">${money(x.price)}</td><td class="num">${(x.sold || 0).toLocaleString()}</td></tr>`));

  const title = `Inventory Report ${printed.toISOString().slice(0, 10)} - ${SELLER.name}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PDF_CSS}</style></head><body>
    <header class="sr-head">
      <h1>${SELLER.name}</h1>
      <div class="sr-owner">${SELLER.owner}</div>
      <div class="sr-addr">${SELLER.address} · ${SELLER.contact} · ${SELLER.tin}</div>
      <div class="sr-title">Inventory Report · Measured: ${esc(d.windowLabel)}</div>
    </header>
    <hr class="sr-rule"/>
    <div class="sr-meta"><span>Prepared by ${esc(d.preparedBy || "—")}</span><span>Printed ${printedText}</span></div>
    <div class="sr-cards">
      ${card("Products", s.totalProducts.toLocaleString(), `${s.archived} archived`)}
      ${card("Units on hand", s.units.toLocaleString(), "As of printing")}
      ${card("Need restocking", (lv.warn + lv.crit + lv.out).toLocaleString(), `${lv.warn} low · ${lv.crit} critical · ${lv.out} out of stock`)}
      ${card("Stock value", money(s.value), "At current selling prices")}
    </div>
    <p class="sr-note">Stock levels: ${t.levels}. Movement: ${t.moves}. Movement and sold figures are measured over ${esc(d.windowLabel.toLowerCase())}, from completed orders; Total sold is lifetime.</p>
    <h2>Stock levels</h2>${levelsTbl}
    <h2>Stock movement</h2>${movesTbl}
    <h2>Needs restocking</h2>${restock}
    <h2>Expiry risk</h2>${expiry}
    <h2>All products</h2>${all}
    <div class="sr-foot">${SELLER.name} · ${SELLER.owner} — system-generated report</div>
  </body></html>`;
}

/* ---------------------------------------------------------------- CSV */

function downloadCsv(d){
  const s = summarize(d), t = thresholds(d.model);
  const rows = [];
  const add = (...cells) => rows.push(cells);
  const lv = Object.fromEntries(s.levels.map(x => [x.key, x.products]));

  add(`${SELLER.name} — ${SELLER.owner}`);
  add(SELLER.address);
  add("Inventory Report", `Measured: ${d.windowLabel}`);
  add("Prepared by", d.preparedBy || "");
  add("Printed", new Date().toLocaleString("en-US"));
  add();
  add("Summary");
  add("Products", s.totalProducts, `${s.archived} archived`);
  add("Units on hand", s.units);
  add("Need restocking", lv.warn + lv.crit + lv.out, `${lv.warn} low · ${lv.crit} critical · ${lv.out} out of stock`);
  add("Stock value", s.value.toFixed(2), "At current selling prices");
  add("Stock level bands", t.levels);
  add("Movement bands", t.moves);
  add();
  add("Stock levels");
  add("Stock level", "Products", "Units on hand");
  s.levels.forEach(x => add(x.label, x.products, x.units));
  add("Total", s.totalProducts, s.units);
  add();
  add("Stock movement");
  add("Movement", "Products", `Sold (${d.windowLabel})`);
  s.moves.forEach(x => add(x.label, x.products, x.sold));
  add("Total", s.totalProducts, s.soldInWindow);
  add();
  add("Needs restocking");
  add("Product", "Stock", "Level", "Why", "Days of cover");
  s.restock.forEach(x => add(x.name, x.stock, levelLabel(x), x.inventory.levelReason || "", x.inventory.daysCover ?? ""));
  add();
  add("Expiry risk");
  add("Product", "Lot", "Expiry", "Units", "Note");
  s.expiry.forEach(x => { const r = x.inventory.expiryRisk; add(x.name, r.lot || "", r.expiry || "", r.qty ?? "", r.note || ""); });
  add();
  add("All products");
  add("Product", "Category", "Stock", "Level", "Movement", `Sold (${d.windowLabel})`, "Price", "Total sold", "Archived");
  d.products.forEach(x => add(x.name, x.cat || "", x.stock, levelLabel(x), moveLabel(x), (x.inventory || {}).windowUnits || 0, Number(x.price).toFixed(2), x.sold || 0, x.archived ? "Yes" : "No"));

  saveCsv(rows, `inventory-report_${new Date().toISOString().slice(0, 10)}_${d.windowLabel.toLowerCase().replace(/\s+/g, "-")}.csv`);
}
