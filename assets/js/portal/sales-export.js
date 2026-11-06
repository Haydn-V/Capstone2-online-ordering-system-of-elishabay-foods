/* Sales Report export (PDF and CSV), loaded on demand by engine.js: import("./sales-export.js").
   A range picker (presets + From/To) feeds api/reports/sales-export.php; the PDF is printed from a hidden
   iframe like the Sales Invoice, A4 with table headers repeated on every page; the CSV is a download. */

export const SELLER = {
  name:    "Elisha Bay",
  owner:   "Juris Bay Foods, Inc.",
  address: "148 Brgy. Mangin, Dagupan City, Pangasinan",
  contact: "Tel. +63 917 000 0000",
  tin:     "VAT Reg. TIN 627-925-453-00000",
};

const PRESETS = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["month", "This month"],
  ["lastmonth", "Last month"], ["year", "This year"], ["lastyear", "Last year"],
];

const STATUS_NOW = {
  pending: "Pending", "on-hold": "On hold", accepted: "Accepted", shipping: "Shipping",
  delivered: "Delivered", completed: "Completed", cancelled: "Cancelled",
};

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const money = n => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDay = d => new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const rangeLabel = r => `${fmtDay(r.from)} - ${fmtDay(r.to)}`;


/* ---------------------------------------------------------------- expenses (net income) */

/* The expense categories in print order, and the column-mapping rules: a copy of api/core/ExpenseImport.php
   (HEADER_WORDS, TOTAL_WORDS, CATEGORY_WORDS, money(), apply()). Keep both lists the same. */
export const EXPENSE_RULES = {
  categories: [
    ["materials", "Raw materials & packaging"],
    ["salaries",  "Salaries & wages"],
    ["utilities", "Utilities & rent"],
    ["delivery",  "Delivery & courier"],
    ["other",     "Other expenses"],
  ],
  headerWords: {
    amount:      ["amount", "total", "cost", "expense", "expenses", "halaga", "debit", "value", "php", "₱",
                  "net amount", "total cost", "amount paid"],
    description: ["description", "particulars", "item", "details", "expense", "purpose", "remarks", "payee",
                  "paid to", "name"],
    category:    ["category", "type", "account", "classification", "kind", "uri"],
    date:        ["date", "petsa", "day", "txn date"],
    exclude:     ["qty", "quantity", "pcs", "unit", "units", "no", "#", "ref", "reference", "or no",
                  "invoice no", "receipt", "date", "percent", "%"],
  },
  totalWords: ["total", "subtotal", "sub total", "grand total", "kabuuan", "sum", "balance forward",
               "carried forward", "beginning balance"],
  categoryWords: {
    materials: ["bangus", "fish", "milkfish", "tuyo", "oil", "olive", "garlic", "vinegar", "suka", "spice",
                "ingredient", "bottle", "jar", "lid", "cap", "label", "sticker", "packaging", "box", "carton",
                "plastic", "raw", "material", "materials"],
    salaries:  ["salary", "salaries", "wage", "wages", "sweldo", "sahod", "payroll", "allowance", "13th", "sss",
                "philhealth", "pag ibig", "pagibig", "overtime", "ot"],
    utilities: ["meralco", "electric", "electricity", "kuryente", "water", "tubig", "maynilad", "rent", "upa",
                "internet", "pldt", "globe", "converge", "lpg", "gas", "phone", "load", "utility", "utilities"],
    delivery:  ["lbc", "courier", "shipping", "delivery", "freight", "jnt", "j&t", "lalamove", "grab",
                "transport", "fare", "toll", "fuel", "diesel", "gasoline"],
  },
};

const round2 = n => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
const reEsc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lowercase, punctuation as spaces (₱ % # & kept), single spaces (ExpenseImport::normalize). */
export function xNormalize(s){
  return String(s ?? "").toLowerCase()
    .replace(/[₱%#]/g, m => ` ${m} `)
    .replace(/[^\p{L}\p{N}₱%#&]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}
function xHasPhrase(text, phrase, plural = false){
  const p = reEsc(xNormalize(phrase));
  return p !== "" && new RegExp(`(?:^| )${p}${plural ? "(?:e?s)?" : ""}(?= |$)`, "u").test(text);
}
const xHasAny = (text, list, plural = false) => list.some(p => xHasPhrase(text, p, plural));

/** Money from a cell, or null (ExpenseImport::money). */
export function xMoney(v){
  if(typeof v === "number") return Number.isFinite(v) ? round2(v) : null;
  if(typeof v !== "string") return null;
  let s = v.trim();
  if(s === "" || ["-", "—", "n/a"].includes(s.toLowerCase())) return null;
  let neg = false;
  const m = s.match(/^\((.*)\)$/u);
  if(m){ neg = true; s = m[1].trim(); }
  if(s.startsWith("-")){ neg = !neg; s = s.slice(1).trim(); }
  s = s.replace(/^(₱|php|p)\s*/iu, "").replace(/ /g, "");
  if(s.startsWith("-")){ neg = !neg; s = s.slice(1); }
  if(!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return round2(neg ? -n : n);
}

/** The category with the most keyword hits (ties to the earlier one), or null (ExpenseImport::guessCategory). */
export function xGuessCategory(text){
  const t = xNormalize(text);
  if(!t) return null;
  let best = null, hits = 0;
  for(const [cat, words] of Object.entries(EXPENSE_RULES.categoryWords)){
    const h = words.filter(w => xHasPhrase(t, w, true)).length;
    if(h > hits){ best = cat; hits = h; }
  }
  return best;
}

const xEmpty  = row => row.every(v => v === "" || v === null || v === undefined);
const xIsText = v => typeof v === "string" && v !== "" && xMoney(v) === null && !/^\d{4}-\d{2}-\d{2}$/.test(v);

/** Counted rows, skipped rows and category totals for a mapping (ExpenseImport::apply). headerRow is 1-based or null. */
export function xApply(grid, headerRow, mapping){
  const header = headerRow == null ? null : headerRow - 1;
  const { amount: a = null, description: d = null, category: k = null } = mapping;
  const rows = [], skipped = [];
  const totals = Object.fromEntries(EXPENSE_RULES.categories.map(([c]) => [c, 0]));
  const finish = () => {
    for(const c in totals) totals[c] = round2(totals[c]);
    totals.all = round2(Object.values(totals).reduce((t, v) => t + v, 0));
    return { rows, skipped, totals };
  };
  /* Category per column: every amount under a category column counts toward that column's category. */
  if(Array.isArray(mapping.columns) && mapping.columns.length){
    const head = header !== null ? grid[header] || [] : [];
    grid.forEach((row, i) => {
      if((header !== null && i <= header) || xEmpty(row)) return;
      const firstText = row.find(v => xIsText(v)) || "";
      if(xHasAny(xNormalize(firstText), EXPENSE_RULES.totalWords)){ skipped.push({ row: i + 1, reason: "total row", text: firstText }); return; }
      let found = 0;
      mapping.columns.forEach(c => {
        const amt = xMoney(row[c] ?? "");
        if(amt === null) return;
        const label = String(head[c] ?? "").trim();
        const category = xGuessCategory(label) ?? "other";
        rows.push({ row: i + 1, description: label, amount: amt, category, skip: null });
        totals[category] += amt;
        found++;
      });
      if(!found) skipped.push({ row: i + 1, reason: "no amount", text: firstText });
    });
    return finish();
  }
  grid.forEach((row, i) => {
    if((header !== null && i <= header) || xEmpty(row)) return;
    const firstText = row.find((v, c) => c !== a && xIsText(v)) || "";
    const desc  = d !== null ? String(row[d] ?? "").trim() : firstText;
    const label = desc || firstText;
    if(xHasAny(xNormalize(desc), EXPENSE_RULES.totalWords) || xHasAny(xNormalize(firstText), EXPENSE_RULES.totalWords)){
      skipped.push({ row: i + 1, reason: "total row", text: label }); return;
    }
    const amt = a !== null ? xMoney(row[a] ?? "") : null;
    if(amt === null){ skipped.push({ row: i + 1, reason: "no amount", text: label }); return; }
    let category = null;
    if(k !== null && String(row[k] ?? "").trim() !== "") category = xGuessCategory(String(row[k]));
    category = category ?? xGuessCategory(desc) ?? "other";
    rows.push({ row: i + 1, description: desc, amount: amt, category, skip: null });
    totals[category] += amt;
  });
  for(const c in totals) totals[c] = round2(totals[c]);
  totals.all = round2(Object.values(totals).reduce((t, v) => t + v, 0));
  return { rows, skipped, totals };
}

const colLetter = i => { let s = "", n = i + 1; while(n > 0){ const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/* ---------------------------------------------------------------- picker */

/** Ask for the period, then export as "pdf" or "csv". */
export function openSalesExport(kind){
  const cur = getDateRange(adminState.salesRange || "month");
  /* Expenses and net income only for reports.financial (api/reports/net-income.php checks it too). */
  const financial = EbRbac.can("reports.financial");
  openModal({
    title: kind === "pdf" ? "Export Sales Report (PDF)" : "Export Sales Report (CSV)",
    large: financial,
    body: `
      <p class="field-hint" style="margin:0 0 12px">Choose the period to include. Pick a quick range or set the dates yourself.</p>
      <div class="sx-presets" role="group" aria-label="Quick ranges">
        ${PRESETS.map(([k, l]) => `<button type="button" class="sx-preset" data-sx="${k}">${l}</button>`).join("")}
      </div>
      <div class="sx-dates">
        <div class="field"><label for="sx-from">From</label><input class="control" type="date" id="sx-from" value="${cur.start}"/></div>
        <div class="field"><label for="sx-to">To</label><input class="control" type="date" id="sx-to" value="${cur.end}"/></div>
      </div>
      <span class="field-error" id="sx-err"></span>
      ${financial ? expensesSectionHtml() : ""}`,
    confirmLabel: kind === "pdf" ? "Export PDF" : "Export CSV",
    async onConfirm(){
      const from = $("#sx-from").value, to = $("#sx-to").value;
      const err = $("#sx-err");
      err.textContent = "";
      if(!from || !to){ err.textContent = "Choose both dates."; return; }
      if(from > to){ err.textContent = "The From date is after the To date."; return; }
      /* Any expense filled in adds the income statement, which the server works out (net-income.php). */
      const expenses = financial ? readExpenses() : null;
      if(expenses && expenses.bad){ $("#sx-exp-err").textContent = expenses.bad; return; }
      const btn = $("#modal-footer .btn-gold");
      const restore = EbUI.busy(btn, "Preparing…");
      try {
        const { data } = await EbApi.get("reports/sales-export.php", { from, to });
        if(expenses && expenses.used){
          try {
            const res = await EbApi.post("reports/net-income.php", { from, to, expenses: expenses.values, source: expenseSource });
            data.income = res.data;
          } catch(e){
            /* "expenses.<key>" errors point at their input. */
            Object.keys(e.fields || {}).forEach(k => { const m = k.match(/^expenses\.(\w+)$/); if(m) $(`#sx-exp-${m[1]}`)?.classList.add("is-invalid"); });
            $("#sx-exp-err").textContent = e.message;
            return;
          }
        }
        closeModal();
        if(kind === "pdf") printPdf(data); else downloadCsv(data);
        toast(kind === "pdf" ? "Sales report ready — choose “Save as PDF” in the print window." : "CSV exported.", "ok");
      } catch(e){
        err.textContent = e.message;
      } finally { restore(); }
    },
  });

  /* Presets fill the dates (from the server's own calendar, like the report tabs) and stay highlighted until a date is edited. */
  const mark = key => $$(".sx-preset").forEach(b => b.classList.toggle("active", b.dataset.sx === key));
  const setVal = (id, v) => { const el = $(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  $$(".sx-preset").forEach(b => b.addEventListener("click", () => {
    const r = getDateRange(b.dataset.sx);
    setVal("#sx-from", r.start); setVal("#sx-to", r.end);
    mark(b.dataset.sx);
  }));
  ["#sx-from", "#sx-to"].forEach(id => $(id).addEventListener("change", e => { if(e.isTrusted) mark(null); }));
  const now = PRESETS.find(([k]) => { const r = getDateRange(k); return r.start === cur.start && r.end === cur.end; });
  mark(now ? now[0] : null);
  if(financial) wireExpenses();
}

/* ---------------------------------------------------------------- expenses section */

/* Where the expense figures came from, sent with the net income request: typed, or a file's totals. */
let expenseSource = { type: "typed" };

function expensesSectionHtml(){
  expenseSource = { type: "typed" };
  return `
    <section class="sx-exp" aria-labelledby="sx-exp-title">
      <div class="sx-exp-head">
        <h4 id="sx-exp-title">Expenses <span>(optional, for net income)</span></h4>
        <p class="field-hint">Leave empty to export sales only.</p>
      </div>
      <div class="sx-exp-grid">
        ${EXPENSE_RULES.categories.map(([key, label]) => `
          <div class="field">
            <label for="sx-exp-${key}">${label}</label>
            <div class="sx-peso"><span aria-hidden="true">₱</span>
              <input class="control" id="sx-exp-${key}" data-exp="${key}" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"/></div>
          </div>`).join("")}
      </div>
      <div class="sx-exp-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="sx-exp-file-btn">Fill from a file</button>
        <input type="file" id="sx-exp-file" accept=".xlsx,.xls,.csv,.ods" hidden/>
        <button type="button" class="sx-link" id="sx-exp-template">Download template</button>
        <span class="sx-exp-source" id="sx-exp-source"></span>
      </div>
      <span class="field-error" id="sx-exp-err" role="alert"></span>
      <div class="sx-imp" id="sx-imp" hidden></div>
    </section>`;
}

function wireExpenses(){
  const fileInput = $("#sx-exp-file");
  let imp = null;   /* { file, data, grid, sheet, headerRow, mapping } while the preview is open */

  $("#sx-exp-file-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if(f) parse(f, null);
  });
  $("#sx-exp-template").addEventListener("click", () => saveCsv([
    ["Date", "Description", "Category", "Amount"],
    ["2026-10-01", "Milkfish 50kg", "Raw materials", "7500.00"],
    ["2026-10-05", "Staff salaries", "Salaries", "18000.00"],
    ["2026-10-10", "LBC shipments", "Delivery", "1250.00"],
  ], "expenses-template.csv"));
  $$("[data-exp]").forEach(i => {
    i.addEventListener("input", () => {
      /* Amounts only: digits and commas, one decimal point, at most 2 decimals; anything else is dropped as typed. */
      const at = i.selectionStart, before = i.value;
      let v = before.replace(/[^\d.,]/g, "");
      const dot = v.indexOf(".");
      if(dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/[.,]/g, "").slice(0, 2);
      if(v !== before){
        i.value = v;
        const pos = Math.max(0, (at ?? v.length) - (before.length - v.length));
        i.setSelectionRange(pos, pos);
      }
      i.classList.remove("is-invalid");
      $("#sx-exp-err").textContent = "";
      if(!expenseInputsUsed()) setSource({ type: "typed" });
    });
    /* Tidy to 1,250.00 when leaving the box; an empty box stays empty. */
    i.addEventListener("blur", () => {
      const n = xMoney(i.value);
      if(i.value.trim() !== "" && n !== null) i.value = n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });
  });

  async function parse(file, sheet){
    const err = $("#sx-exp-err");
    err.textContent = "";
    const restore = EbUI.busy($("#sx-exp-file-btn"), "Reading…");
    try {
      const form = new FormData();
      form.append("file", file);
      if(sheet !== null) form.append("sheet", String(sheet));
      const data = await EbApi.postForm("reports/expenses-parse.php", form);
      imp = { file, data, grid: data.grid, sheet: data.sheet, headerRow: data.headerRow, mapping: { ...data.mapping } };
      drawPreview();
      /* The preview opens below the buttons; bring it into view so "Use these totals" is not missed. */
      $("#sx-imp").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch(e){
      err.textContent = (e.fields && e.fields.file) || e.message;
      if(sheet === null) closePreview();
    } finally { restore(); }
  }

  function closePreview(){
    imp = null;
    const box = $("#sx-imp");
    box.hidden = true;
    box.innerHTML = "";
  }

  /* Labels for the current header row: the header cell, or "Column X". */
  function labels(){
    const width = imp.grid.reduce((w, r) => Math.max(w, r.length), 0);
    const head = imp.headerRow ? imp.grid[imp.headerRow - 1] || [] : [];
    return Array.from({ length: width }, (_, c) => {
      const h = head[c];
      return { index: c, letter: colLetter(c), label: h !== undefined && h !== "" ? String(h) : `Column ${colLetter(c)}` };
    });
  }

  /* The server's confidence only holds while the mapping is the one it suggested. */
  const sameAsServer = () => imp.headerRow === imp.data.headerRow && imp.mapping.amount === imp.data.mapping.amount;

  function drawPreview(){
    const box  = $("#sx-imp");
    const cols = labels();
    const res  = xApply(imp.grid, imp.headerRow, imp.mapping);
    /* Category-per-column files have no single amount column; the column list stands in for it. */
    const wide = Array.isArray(imp.mapping.columns) && imp.mapping.columns.length > 0;
    const a    = wide ? -1 : imp.mapping.amount;
    const sheetName = imp.data.sheets[imp.sheet] || "";
    const conf = a === null ? "none" : (sameAsServer() ? imp.data.confidence : "high");

    const reasons = {};
    res.skipped.forEach(x => { reasons[x.reason] = (reasons[x.reason] || 0) + 1; });
    const reasonText = Object.entries(reasons).map(([r, n]) => r === "total row"
      ? `${n} total row${n === 1 ? "" : "s"}` : `${n} with no amount`).join(", ");
    const colText = c => `${colLetter(c)} (${esc(cols[c] ? cols[c].label : "")})`;

    const summary = a === null
      ? `<strong>${esc(imp.data.message || "We couldn't find any amounts in this file. Pick the amount column below.")}</strong>`
      : wide
      ? `Found <strong>${res.rows.length}</strong> amount${res.rows.length === 1 ? "" : "s"} in sheet “${esc(sheetName)}”, one column per category (${imp.mapping.columns.map(c => esc(cols[c] ? cols[c].label : colLetter(c))).join(", ")}), total <strong>${money(res.totals.all)}</strong>.`
        + (res.skipped.length ? ` Skipped ${res.skipped.length} row${res.skipped.length === 1 ? "" : "s"} (${reasonText}).` : "")
        + ` <span class="sx-imp-warn">Please check the categories below.</span>`
      : `Found <strong>${res.rows.length}</strong> expense row${res.rows.length === 1 ? "" : "s"} in sheet “${esc(sheetName)}”, amount column ${colText(a)}, total <strong>${money(res.totals.all)}</strong>.`
        + (res.skipped.length ? ` Skipped ${res.skipped.length} row${res.skipped.length === 1 ? "" : "s"} (${reasonText}).` : "")
        + (conf === "check" ? ` <span class="sx-imp-warn">Please check the amount column.</span>` : "");

    const opt = (v, text, sel) => `<option value="${v}"${sel ? " selected" : ""}>${esc(text)}</option>`;
    const colOpts = (cur, noneText) => (noneText ? opt("", noneText, cur === null) : "")
      + cols.map(c => opt(c.index, `${c.letter} — ${c.label}`, cur === c.index)).join("");
    const headOpts = opt("", "No header row", imp.headerRow === null)
      + imp.grid.slice(0, 15).map((r, i) => r.some(v => v !== "")
          ? opt(i + 1, `Row ${i + 1}: ${r.filter(v => v !== "").slice(0, 3).join(" | ").slice(0, 48)}`, imp.headerRow === i + 1) : "").join("");
    const catName  = Object.fromEntries(EXPENSE_RULES.categories);
    const negative = EXPENSE_RULES.categories.filter(([k]) => res.totals[k] < 0);

    box.hidden = false;
    box.innerHTML = `
      <div class="sx-imp-head">
        <div class="sx-imp-file">${esc(imp.data.fileName)}</div>
        <p class="sx-imp-summary${a === null ? " is-none" : ""}">${summary}</p>
      </div>
      <div class="sx-imp-map${a === null ? " needs-amount" : ""}">
        <div class="field"><label for="sx-map-sheet">Sheet</label><select class="control" id="sx-map-sheet">${imp.data.sheets.map((n, i) => opt(i, n, i === imp.sheet)).join("")}</select></div>
        <div class="field"><label for="sx-map-header">Header row</label><select class="control" id="sx-map-header">${headOpts}</select></div>
        <div class="field sx-map-amount"><label for="sx-map-amount">Amount column</label><select class="control" id="sx-map-amount">${wide ? opt("wide", "One column per category", true) : ""}${a === null ? opt("", "Choose the amount column", true) : ""}${colOpts(wide ? null : a, null)}</select></div>
        ${wide ? "" : `<div class="field"><label for="sx-map-desc">Description column</label><select class="control" id="sx-map-desc">${colOpts(imp.mapping.description, "None")}</select></div>
        <div class="field"><label for="sx-map-cat">Category column</label><select class="control" id="sx-map-cat">${colOpts(imp.mapping.category, "None")}</select></div>`}
      </div>
      ${a === null ? "" : `
      <div class="sx-imp-totals">
        ${EXPENSE_RULES.categories.map(([k, l]) => `<div class="sx-imp-total${res.totals[k] < 0 ? " is-neg" : ""}"><span>${l}</span><b>${money(res.totals[k])}</b></div>`).join("")}
      </div>
      ${negative.length ? `<p class="sx-imp-warn">${negative.map(([, l]) => l).join(", ")} ${negative.length === 1 ? "is" : "are"} below zero after corrections. Expenses can't be negative, so ${negative.length === 1 ? "it is" : "they are"} filled in as 0.</p>` : ""}
      <div class="sx-imp-table">
        <table class="data-table"><thead><tr><th>Row</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr></thead>
          <tbody>${res.rows.slice(0, 50).map(r => `<tr><td class="mono">${r.row}</td><td>${esc(r.description || "—")}</td><td>${esc(catName[r.category])}</td><td class="num">${money(r.amount)}</td></tr>`).join("")
            || `<tr><td colspan="4" class="muted">No expense rows with this mapping.</td></tr>`}</tbody></table>
        ${res.rows.length > 50 ? `<p class="field-hint">Showing the first 50 of ${res.rows.length} rows; the totals include every row.</p>` : ""}
      </div>`}
      ${res.skipped.length ? `<details class="sx-imp-skipped"><summary>Skipped rows (${res.skipped.length})</summary>
        <ul>${res.skipped.map(x => `<li><span class="mono">Row ${x.row}</span> ${esc(x.text || "—")} <em>${esc(x.reason)}</em></li>`).join("")}</ul></details>` : ""}
      <div class="sx-imp-actions">
        <button type="button" class="btn btn-gold btn-sm" id="sx-imp-use"${a === null || !res.rows.length ? " disabled" : ""}>Use these totals</button>
        <button type="button" class="btn btn-ghost btn-sm" id="sx-imp-cancel">Cancel</button>
      </div>`;

    /* A sheet change asks the server again; the other choices re-map the grid already here. */
    const num = v => v === "" ? null : Number(v);
    $("#sx-map-sheet").addEventListener("change", e => parse(imp.file, Number(e.target.value)));
    $("#sx-map-header").addEventListener("change", e => { imp.headerRow = num(e.target.value); drawPreview(); });
    $("#sx-map-amount").addEventListener("change", e => {
      /* Picking one amount column leaves the category-per-column reading; "One column per category" goes back to it. */
      if(e.target.value === "wide") imp.mapping = { ...imp.data.mapping };
      else imp.mapping = { ...imp.mapping, columns: null, amount: num(e.target.value) };
      drawPreview();
    });
    $("#sx-map-desc")?.addEventListener("change", e => { imp.mapping.description = num(e.target.value); drawPreview(); });
    $("#sx-map-cat")?.addEventListener("change", e => { imp.mapping.category = num(e.target.value); drawPreview(); });
    $("#sx-imp-cancel").addEventListener("click", closePreview);
    $("#sx-imp-use").addEventListener("click", () => {
      EXPENSE_RULES.categories.forEach(([k]) => {
        const v = Math.max(0, res.totals[k]);
        $(`#sx-exp-${k}`).value = v ? v.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
      });
      setSource({ type: "file", fileName: imp.data.fileName, rowCount: res.rows.length });
      closePreview();
      $("#sx-exp-materials").focus();
    });
  }
}

function setSource(src){
  expenseSource = src;
  const el = $("#sx-exp-source");
  if(el) el.textContent = src.type === "file"
    ? `From ${src.fileName} (${src.rowCount} row${src.rowCount === 1 ? "" : "s"}). You can still edit the amounts.` : "";
}

/** The five expense inputs as numbers: { values, used, bad }; bad is a message when one is not an amount of 0 or more. */
function readExpenses(){
  const values = {};
  let used = false, bad = null;
  $$("[data-exp]").forEach(i => {
    i.classList.remove("is-invalid");
    const raw = i.value.trim();
    if(raw === "") return;
    const v = xMoney(raw);
    if(v === null || v < 0){ i.classList.add("is-invalid"); bad = "Enter each expense as an amount of 0 or more, like 1250 or 1,250.00."; return; }
    values[i.dataset.exp] = v;
    used = true;
  });
  return { values, used, bad };
}

function expenseInputsUsed(){
  return $$("[data-exp]").some(i => i.value.trim() !== "");
}

/* ---------------------------------------------------------------- PDF */

export const PDF_CSS = `
@page{ size:A4 portrait; margin:14mm 14mm 16mm; }
*{ box-sizing:border-box; }
html,body{ margin:0; background:#fff; color:#1f1f1f; font:12px/1.45 "Segoe UI",system-ui,-apple-system,Arial,sans-serif; }
h1,h2{ font-family:Georgia,"Times New Roman",serif; color:#141414; }
.sr-head{ text-align:center; }
.sr-head h1{ margin:0; font-size:26px; }
.sr-owner{ margin-top:2px; font-size:12px; font-weight:600; letter-spacing:.04em; }
.sr-addr{ margin-top:4px; font-size:11px; color:#555; }
.sr-title{ margin:14px 0 0; font:600 16px/1.3 "Segoe UI",system-ui,sans-serif; }
.sr-rule{ border:0; border-top:1px solid #cfcfcf; margin:14px 0; }
.sr-meta{ display:flex; justify-content:space-between; font-size:11.5px; color:#555; }
.sr-cards{ display:grid; grid-template-columns:1fr 1fr; gap:6px 24px; margin:16px 0 10px; padding:0 10px; break-inside:avoid; }
.sr-card{ padding:10px 0; }
.sr-card span{ display:block; font-size:9.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:#666; }
.sr-card b{ display:block; margin:5px 0 3px; font-size:17px; font-weight:700; color:#141414; }
.sr-card small{ font-size:10.5px; color:#666; }
.sr-note{ font-size:10.5px; color:#555; margin:4px 0 0; }
h2{ font-size:16px; margin:22px 0 8px; break-after:avoid; }
table{ width:100%; border-collapse:collapse; }
thead{ display:table-header-group; }
tr{ break-inside:avoid; page-break-inside:avoid; }
th{ text-align:left; font-size:9.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:#333; padding:9px 10px; border-bottom:1px solid #d9d9d9; }
td{ padding:9px 10px; border-bottom:1px solid #e6e6e6; vertical-align:top; }
.num{ text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
tr.total td{ font-weight:700; border-top:2px solid #1f1f1f; border-bottom:1px solid #d9d9d9; }
tr.sub td{ color:#666; }
.ref{ font-weight:600; white-space:nowrap; }
.muted{ color:#666; }
.empty{ color:#555; margin:4px 0 0; }
.sr-foot{ margin-top:22px; font-size:10px; color:#777; text-align:center; }
.sr-income{ break-inside:avoid; }
.sr-income-note{ font-size:10.5px; color:#555; margin:6px 0 0; }
`;

const enteredText = inc => `Expenses entered by ${inc.enteredBy} on ${fmtDay(inc.enteredAt)}. Source: ${inc.source.text}.`;

/** The Income Summary block: the server's lines, expenses indented, totals after a rule. */
function incomeHtml(inc){
  /* Styled like "Money received": "Less" lines carry a minus (−₱40,500.00), the expense breakdown is grey sub-rows
     (like the GCash line), totals are bold after the heavy rule, and a negative total reads ₱-27,160.00. */
  const rows = inc.lines.map(l => {
    const cls = l.kind === "total" ? "total" : l.indent ? "sub" : "";
    const amount = l.kind === "less" ? `−${money(l.amount)}` : money(l.amount);
    return `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(l.label)}</td><td class="num">${amount}</td></tr>`;
  });
  /* Same table as "Money received": full width, header row, heavy rule above totals. */
  return `<h2>Income Summary</h2>
    <div class="sr-income">${table([["Item"], ["Amount", 1]], rows)}</div>
    <p class="sr-income-note">${esc(enteredText(inc))} Gross sales is the Total sales above; output VAT and retailer discounts are what those orders stored.</p>`;
}

function table(head, rows, opts = {}){
  const th = head.map(([label, num]) => `<th${num ? ' class="num"' : ""}>${label}</th>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody>${opts.foot || ""}</table>`;
}

function reportHtml(d){
  const s = d.summary, r = d.received;
  const printed = new Date();
  const printedText = printed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    + " · " + printed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const card = (label, value, sub) => `<div class="sr-card"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;

  const moneyRows = [
    `<tr><td>Walk-in sales (paid in full)</td><td class="num">${money(r.walkin)}</td></tr>`,
    `<tr><td>Online orders paid (GCash, bank transfer, cash on pickup)</td><td class="num">${money(r.online)}</td></tr>`,
    `<tr><td>Net 30 / 60 / 90 payments collected</td><td class="num">${money(r.net)}</td></tr>`,
    ...(r.refunds ? [
      `<tr><td>Total received before refunds</td><td class="num">${money(r.gross ?? r.total + r.refunds)}</td></tr>`,
      `<tr><td>Less: refunds paid out</td><td class="num">−${money(r.refunds)}</td></tr>`] : []),
    `<tr class="total"><td>${r.refunds ? "Net received" : "Total received"}</td><td class="num">${money(r.total)}</td></tr>`,
    ...r.byMethod.map(m => `<tr class="sub"><td>${esc(m.method)}</td><td class="num">${money(m.amount)}</td></tr>`),
  ];

  const dayTotals = d.byDay.reduce((t, x) => ({ w: t.w + x.walkin, o: t.o + x.online }), { w: 0, o: 0 });
  const days = d.byDay.length
    ? table([["Date"], ["Walk-in", 1], ["Online", 1], ["Total", 1]],
        d.byDay.map(x => `<tr><td>${fmtDay(x.date)}</td><td class="num">${money(x.walkin)}</td><td class="num">${money(x.online)}</td><td class="num">${money(x.total)}</td></tr>`),
        { foot: `<tbody><tr class="total"><td>Total</td><td class="num">${money(dayTotals.w)}</td><td class="num">${money(dayTotals.o)}</td><td class="num">${money(dayTotals.w + dayTotals.o)}</td></tr></tbody>` })
    : `<p class="empty">No sales in this period.</p>`;

  const top = d.top.length
    ? table([["#"], ["Product"], ["Sold", 1], ["Sales", 1]],
        d.top.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td class="num">${p.units}</td><td class="num">${money(p.sales)}</td></tr>`))
    : `<p class="empty">No products sold in this period.</p>`;

  const walkin = d.walkin.length
    ? table([["Ref"], ["Customer"], ["Date"], ["Payment"], ["Total", 1]],
        d.walkin.map(o => `<tr><td class="ref">${esc(o.ref)}</td><td>${esc(o.customer)}</td><td>${fmtDay(o.date)}</td><td>${esc(o.method)}</td><td class="num">${money(o.total)}</td></tr>`))
    : `<p class="empty">No walk-in sales in this period.</p>`;

  const online = d.online.length
    ? table([["Ref"], ["Customer"], ["Status now"], ["Date"], ["Total", 1], ["Paid", 1], ["Balance", 1]],
        d.online.map(o => `<tr><td class="ref">${esc(o.ref)}</td><td>${esc(o.customer)}</td><td>${esc(STATUS_NOW[o.status] || o.status)}</td><td>${fmtDay(o.date)}</td><td class="num">${money(o.total)}</td><td class="num">${money(o.paid)}</td><td class="num">${money(o.balance)}</td></tr>`))
    : `<p class="empty">No online orders in this period.</p>`;

  return `
    <header class="sr-head">
      <h1>${SELLER.name}</h1>
      <div class="sr-owner">${SELLER.owner}</div>
      <div class="sr-addr">${SELLER.address} · ${SELLER.contact} · ${SELLER.tin}</div>
      <div class="sr-title">Sales Report · ${rangeLabel(d.range)}</div>
    </header>
    <hr class="sr-rule"/>
    <div class="sr-meta"><span>Prepared by ${esc(d.preparedBy || "—")}</span><span>Printed ${printedText}</span></div>
    <div class="sr-cards">
      ${card("Total sales", money(s.sales), `${s.walkinCount} walk-in · ${s.onlineCount} online`)}
      ${card("Money received", money(s.received), "Paid in this period")}
      ${card("Still to collect", money(s.toCollect), `${s.toCollectCount} Net account${s.toCollectCount === 1 ? "" : "s"}, as of today`)}
      ${card("Items sold", s.units.toLocaleString(), `${s.walkinUnits} walk-in · ${s.onlineUnits} online`)}
    </div>
    ${d.income ? incomeHtml(d.income) : ""}
    <p class="sr-note">A sale counts on the order date: paid orders once completed, Net 30 / 60 / 90 orders once accepted. Pending, on-hold and cancelled orders are not included.</p>
    <h2>Money received</h2>${table([["Source"], ["Amount", 1]], moneyRows)}
    <h2>Sales by day</h2>${days}
    <h2>Top selling products</h2>${top}
    <h2>Walk-in sales</h2>${walkin}
    <h2>Online orders</h2>${online}
    <div class="sr-foot">${SELLER.name} · ${SELLER.owner} — system-generated report</div>`;
}

/** The full printable document for a report (used by printPdf). */
export function reportDocument(d){
  const title = `Sales Report ${d.range.from} to ${d.range.to} - ${SELLER.name}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PDF_CSS}</style></head><body>${reportHtml(d)}</body></html>`;
}

function printPdf(d){
  printDocument(reportDocument(d));
}

/** Print a full HTML document from a hidden iframe (popups get blocked); the browser's dialog offers Save as PDF. */
export function printDocument(docHtml){
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  frame.srcdoc = docHtml;
  let done = false;
  const cleanup = () => { if(done) return; done = true; setTimeout(() => frame.remove(), 500); };
  frame.onload = () => {
    const w = frame.contentWindow;
    w.addEventListener("afterprint", cleanup);
    w.focus();
    w.print();
    setTimeout(cleanup, 60000);
  };
  document.body.appendChild(frame);
}

/* ---------------------------------------------------------------- CSV */

function downloadCsv(d){
  const s = d.summary, r = d.received;
  const rows = [];
  const add = (...cells) => rows.push(cells);
  const n = v => Number(v || 0).toFixed(2);

  add(`${SELLER.name} — ${SELLER.owner}`);
  add(`${SELLER.address}`);
  add(`Sales Report`, rangeLabel(d.range));
  add(`Prepared by`, d.preparedBy || "");
  add(`Printed`, new Date().toLocaleString("en-US"));
  add();
  add("Summary");
  add("Total sales", n(s.sales), `${s.walkinCount} walk-in · ${s.onlineCount} online`);
  add("Money received", n(s.received), "Paid in this period");
  add("Still to collect", n(s.toCollect), `${s.toCollectCount} Net accounts, as of today`);
  add("Items sold", s.units, `${s.walkinUnits} walk-in · ${s.onlineUnits} online`);
  add();
  if(d.income){
    add("INCOME SUMMARY");
    add("Line", "Amount");
    d.income.lines.forEach(l => add((l.indent ? "    " : "") + l.label, n(l.amount)));
    add(enteredText(d.income));
    add();
  }
  add("Money received");
  add("Source", "Amount");
  add("Walk-in sales (paid in full)", n(r.walkin));
  add("Online orders paid", n(r.online));
  add("Net 30/60/90 payments collected", n(r.net));
  if(r.refunds){
    add("Total received before refunds", n(r.gross ?? r.total + r.refunds));
    add("Less: refunds paid out", n(-r.refunds));
  }
  add(r.refunds ? "Net received" : "Total received", n(r.total));
  r.byMethod.forEach(m => add(m.method, n(m.amount)));
  add();
  add("Sales by day");
  add("Date", "Walk-in", "Online", "Total");
  d.byDay.forEach(x => add(x.date, n(x.walkin), n(x.online), n(x.total)));
  add("Total", n(d.byDay.reduce((t, x) => t + x.walkin, 0)), n(d.byDay.reduce((t, x) => t + x.online, 0)), n(s.sales));
  add();
  add("Top selling products");
  add("#", "Product", "Sold", "Sales");
  d.top.forEach((p, i) => add(i + 1, p.name, p.units, n(p.sales)));
  add();
  add("Walk-in sales");
  add("Ref", "Customer", "Date", "Payment", "Total");
  d.walkin.forEach(o => add(o.ref, o.customer, String(o.date).slice(0, 10), o.method, n(o.total)));
  add();
  add("Online orders");
  add("Ref", "Customer", "Status now", "Date", "Total", "Paid", "Balance");
  d.online.forEach(o => add(o.ref, o.customer, STATUS_NOW[o.status] || o.status, String(o.date).slice(0, 10), n(o.total), n(o.paid), n(o.balance)));

  saveCsv(rows, `sales-report_${d.range.from}_to_${d.range.to}.csv`);
}

/** Download rows (arrays of cells) as a UTF-8 CSV with a BOM, so Excel opens the ₱ sign correctly. */
export function saveCsv(rows, filename){
  const cell = v => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = "\uFEFF" + rows.map(r => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
