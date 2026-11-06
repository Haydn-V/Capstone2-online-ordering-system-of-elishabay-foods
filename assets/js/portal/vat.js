"use strict";

/* ===== VAT MAINTENANCE (Super Admin only, enforced by api/vat/*): VAT rate, exempt products, retailer discounts and the period summary; changes apply only to future sales ===== */

const VAT_TABS = [
  { id: "rules",       label: "Rules" },
  { id: "products",    label: "Product Tax Types" },
  { id: "withholding", label: "Retailer Discount" },
  { id: "summary",     label: "VAT Summary" },
];

const vatState = { tab: "rules", data: null, from: null, to: null };

/* Always two decimals for tax figures. */
const vatMoney = n => EbFormat.pesoExact(n);

/* Show settings as typed ("12", not "12.00"). */
function vatNum(n){
  const v = Number(n);
  return Number.isFinite(v) ? String(+v.toFixed(2)) : "";
}

function vatRenderTabs(){
  const el = $("#vat-tabs");
  if(!el) return;
  el.innerHTML = VAT_TABS.map(t =>
    `<button class="tab-btn${vatState.tab === t.id ? " active" : ""}" role="tab"
       aria-selected="${vatState.tab === t.id}" data-vat-tab="${t.id}">${escHtml(t.label)}</button>`
  ).join("");
  el.querySelectorAll("[data-vat-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      vatState.tab = btn.dataset.vatTab;
      renderVat();
    });
  });
}

/* Live figure beside the tabs, cleared on each render. */
function vatSetMeta(text){
  const el = $("#vat-tab-meta");
  if(el) el.textContent = text || "";
}

async function renderVat(){
  const content = $("#vat-content");
  if(!content) return;
  vatRenderTabs();
  vatSetMeta("");
  const headActions = $("#vat-head-actions");
  if(headActions) headActions.innerHTML = "";

  if(!hasPerm("vat.manage")){
    content.innerHTML = `<div class="alert-empty"><strong>Super Admin only</strong>VAT Maintenance can only be opened by the Super Admin.</div>`;
    return;
  }

  if(vatState.tab === "summary"){ vatRenderSummary(); return; }

  content.innerHTML = EbUI.skeletonBlock(7);
  try {
    const { data } = await EbApi.get("vat/get.php");
    vatState.data = data;
  } catch(err){
    content.innerHTML = `<div class="state-cell state-error"><strong>Could not load VAT settings.</strong><br><small>${escHtml(err.message)}</small></div>`;
    return;
  }
  if(vatState.tab === "rules")         vatRenderRules();
  else if(vatState.tab === "products") vatRenderProducts();
  else                                 vatRenderWithholding();
}

/* ------------------------------------------------------------------ Rules */
/* A number field with its unit (% or ₱) drawn inside the box. */
function vatInput(id, value, unit, attrs, { prefix = false } = {}){
  return `<div class="vat-input${prefix ? " is-prefix" : ""}">
    <input class="control" type="number"${id ? ` id="${id}"` : ""} value="${value}" ${attrs}/>
    <span class="vat-unit" aria-hidden="true">${unit}</span>
  </div>`;
}
/* The portal's on/off switch in a full-width strip (same as the POS). */
function vatSwitch(id, checked, label, hint){
  return `<label class="vat-check pos-check vat-switch">
    <span class="switch">
      <input type="checkbox" role="switch" id="${id}" ${checked ? "checked" : ""}/>
      <span class="switch-track"><span class="switch-thumb"></span></span>
    </span>
    <span class="vat-switch-text"><b>${label}</b>${hint ? `<small>${hint}</small>` : ""}</span>
  </label>`;
}

function vatRenderRules(){
  const r = vatState.data.rules;
  const icPct  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`;
  $("#vat-content").innerHTML = `
    <div class="vat-rules">
      <div class="vat-grid vat-grid-single">
        <section class="panel vat-card">
          <header class="vat-card-head">
            <span class="vat-card-ic" aria-hidden="true">${icPct}</span>
            <div><h3 class="panel-title">Value-added tax</h3><p class="vat-card-sub">Rates used on every Sales Invoice.</p></div>
          </header>
          <div class="vat-card-body">
            <div class="vat-row">
            <div class="field">
              <label for="vat-rate">VAT rate</label>
              ${vatInput("vat-rate", vatNum(r.vatRate), "%", 'min="0" max="50" step="0.01"')}
              <span class="field-hint">Charged on VATable products. Shelf prices already include it.</span>
              <span class="field-error" data-vat-err="vatRate"></span>
            </div>
            <div class="field">
              <label for="vat-wht-default">Default retailer discount</label>
              ${vatInput("vat-wht-default", vatNum(r.withholdingDefaultRate), "%", 'min="0" max="50" step="0.01"')}
              <span class="field-hint">Pre-filled when you turn on the discount for a retailer. Each retailer keeps its own rate.</span>
              <span class="field-error" data-vat-err="withholdingDefaultRate"></span>
            </div>
            </div>
          </div>
        </section>
      </div>

      <div class="vat-savebar" id="vat-savebar">
        <span class="vat-savebar-note" id="vat-savebar-note">Changes apply to sales made after saving. Issued invoices never change.</span>
        <button class="btn btn-gold" id="vat-save-rules">Save rules</button>
      </div>
    </div>`;

  /* The bar shows unsaved changes. */
  const bar = $("#vat-savebar"), note = $("#vat-savebar-note"), idle = note.textContent;
  const markDirty = () => { bar.classList.add("is-dirty"); note.textContent = "You have unsaved changes."; };
  const markClean = () => { bar.classList.remove("is-dirty"); note.textContent = idle; };
  $$("#vat-content .vat-rules input").forEach(el => el.addEventListener(el.type === "checkbox" ? "change" : "input", markDirty));

  $("#vat-save-rules").addEventListener("click", async (e) => {
    $$("[data-vat-err]").forEach(el => { el.textContent = ""; });
    const restore = EbUI.busy(e.currentTarget, "Saving…");
    try {
      const { data } = await EbApi.post("vat/save.php", {
        section: "rules",
        rules: {
          vatRate:                $("#vat-rate").value,
          withholdingDefaultRate: $("#vat-wht-default").value,
        },
      });
      markClean();
      toast(data.changed && data.changed.length
        ? `VAT rules saved: ${data.changed.length} change${data.changed.length === 1 ? "" : "s"}.`
        : "Nothing changed.", "ok");
    } catch(err){
      if(err.isValidation){
        Object.entries(err.fields).forEach(([k, msg]) => {
          const el = $(`[data-vat-err="${k}"]`);
          if(el) el.textContent = msg;
        });
      }
      toast(err.message, "err");
    } finally { restore(); }
  });
}

/* --------------------------------------------------------------- Products */
function vatRenderProducts(){
  const rows = vatState.data.products;
  const exempt = rows.filter(p => p.taxType === "exempt").length;
  /* Live figure beside the tab. */
  vatSetMeta(`${exempt} of ${rows.length} product${rows.length === 1 ? "" : "s"} exempt`);
  $("#vat-content").innerHTML = `
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Product</th><th>Category</th><th class="num">Shelf Price</th><th style="width:190px">Tax Type</th></tr></thead>
      <tbody>${rows.map(p => `
        <tr class="${p.archived ? "archived" : ""}">
          <td class="td-name">${escHtml(p.name)}${p.archived ? ` <span class="badge badge-muted" style="font-size:.6rem">archived</span>` : ""}</td>
          <td class="muted">${escHtml(p.category)}</td>
          <td class="num-cell">${vatMoney(p.price)}</td>
          <td>
            <select class="control" data-vat-product="${escHtml(p.id)}" aria-label="Tax type for ${escHtml(p.name)}">
              <option value="vatable"${p.taxType === "vatable" ? " selected" : ""}>VATable</option>
              <option value="exempt"${p.taxType === "exempt" ? " selected" : ""}>VAT-exempt</option>
            </select>
          </td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;

  $$("[data-vat-product]").forEach(sel => {
    sel.addEventListener("change", async () => {
      const product = vatState.data.products.find(p => p.id === sel.dataset.vatProduct);
      const before = product ? product.taxType : "vatable";
      try {
        await EbApi.post("vat/save.php", { section: "product", product_id: sel.dataset.vatProduct, tax_type: sel.value });
        if(product) product.taxType = sel.value;
        toast(`${product ? product.name : "Product"} is now ${sel.value === "exempt" ? "VAT-exempt" : "VATable"}.`, "ok");
      } catch(err){
        /* Put the control back to what is actually stored. */
        sel.value = before;
        if(window.EbSelect) EbSelect.sync(sel);
        toast(err.message, "err");
      }
    });
  });
}

/* ------------------------------------------------------- Retailer discount */
/* Stored as withholding_agents (the rate taken off a retailer's sale); one switch turns it on/off for everyone and one Save applies every change. */
function vatRenderWithholding(){
  const { retailers, rules } = vatState.data;
  const countMeta = () => {
    const n = retailers.filter(c => c.withholdingRate !== null).length;
    vatSetMeta(`${n} retailer${n === 1 ? "" : "s"} with discount`);
  };
  countMeta();
  const initials = n => String(n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const allOn = retailers.length > 0 && retailers.every(c => c.withholdingRate !== null);
  $("#vat-content").innerHTML = `
    ${retailers.length ? `<div class="vat-rules">
      ${vatSwitch("vat-disc-all", allOn, "Retailer discount for all retailers", "Turns the discount on or off for every retailer below. Press Save changes to apply.")}
      <div class="vat-disc-min">
        <span class="vat-disc-min-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg></span>
        <div class="vat-disc-min-text">
          <label for="vat-disc-min">Minimum items per order</label>
          <small id="vat-disc-min-hint">Retailers get their discount only when an order has at least this many items. 0 = no minimum.</small>
          <span class="field-error" data-vat-err="withholdingMinQty"></span>
        </div>
        <div class="vat-disc-min-field">
          <input class="control" type="number" id="vat-disc-min" value="${rules.withholdingMinQty || 0}" min="0" max="100000" step="1" inputmode="numeric" aria-describedby="vat-disc-min-hint"/>
          <span class="vat-disc-min-unit" aria-hidden="true">items</span>
        </div>
      </div>
      <div class="table-wrap vat-agents"><table class="data-table">
      <thead><tr><th>Retailer</th><th>BIR TIN</th><th style="width:230px">Retailer discount</th><th style="width:150px">Rate</th></tr></thead>
      <tbody>${retailers.map(c => {
        const on = c.withholdingRate !== null;
        return `<tr data-vat-agent="${escHtml(c.id)}" class="${on ? "is-agent" : ""}">
          <td><div class="vat-who">
            <span class="vat-avatar" aria-hidden="true">${escHtml(initials(c.name))}</span>
            <div><div class="td-name">${escHtml(c.name)}</div><div class="vat-email">${escHtml(c.email || "")}</div></div>
          </div></td>
          <td>${c.tin ? `<span class="vat-tin">${escHtml(c.tin)}</span>` : `<span class="muted">No TIN</span>`}</td>
          <td><label class="vat-agent-toggle">
            <span class="switch"><input type="checkbox" role="switch" data-vat-on ${on ? "checked" : ""} aria-label="Retailer discount for ${escHtml(c.name)}"/>
              <span class="switch-track"><span class="switch-thumb"></span></span></span>
            <span class="vat-agent-state" data-vat-state>${on ? "On" : "Off"}</span>
          </label></td>
          <td>${vatInput("", on ? vatNum(c.withholdingRate) : vatNum(rules.withholdingDefaultRate), "%",
                `min="0.01" max="50" step="0.01" data-vat-rate ${on ? "" : "disabled"} aria-label="Discount rate for ${escHtml(c.name)}"`)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    </div>` : `<div class="alert-empty"><strong>No retailers yet</strong>Approved retail partners appear here.</div>`}`;
  if(!retailers.length) return;
  $("#vat-head-actions").innerHTML = `<button class="btn btn-gold" id="vat-disc-save" disabled>Save changes</button>`;

  const rows = $$("[data-vat-agent]");
  const master = $("#vat-disc-all");
  /* Save lights up only once something has changed. */
  const saveBtn = $("#vat-disc-save");
  const markDirty = () => { saveBtn.disabled = false; };
  const markClean = () => { saveBtn.disabled = true; };
  const paintRow = (row, on) => {
    row.querySelector("[data-vat-rate]").disabled = !on;
    row.querySelector("[data-vat-state]").textContent = on ? "On" : "Off";
    row.classList.toggle("is-agent", on);
  };
  const syncMaster = () => { master.checked = rows.every(r => r.querySelector("[data-vat-on]").checked); };

  master.addEventListener("change", () => {
    rows.forEach(row => { row.querySelector("[data-vat-on]").checked = master.checked; paintRow(row, master.checked); });
    markDirty();
  });
  rows.forEach(row => {
    const on = row.querySelector("[data-vat-on]");
    on.addEventListener("change", () => { paintRow(row, on.checked); syncMaster(); markDirty(); });
    row.querySelector("[data-vat-rate]").addEventListener("input", markDirty);
  });
  $("#vat-disc-min").addEventListener("input", markDirty);

  /* One Save for the whole table: only rows that differ from what is stored are sent. */
  $("#vat-disc-save").addEventListener("click", async (e) => {
    const changed = rows.map(row => {
      const c = retailers.find(x => x.id === row.dataset.vatAgent);
      const on = row.querySelector("[data-vat-on]").checked;
      const rate = row.querySelector("[data-vat-rate]").value;
      const was = c.withholdingRate;
      const same = on ? (was !== null && +rate === +was) : was === null;
      return same ? null : { c, rate: on ? rate : null };
    }).filter(Boolean);
    const minEl = $("#vat-disc-min");
    const minChanged = String(+minEl.value) !== String(+(rules.withholdingMinQty || 0));
    if(!changed.length && !minChanged){ markClean(); toast("Nothing changed.", "ok"); return; }
    const restore = EbUI.busy(e.currentTarget, "Saving…");
    let saved = 0;
    const failed = [];
    $$('[data-vat-err="withholdingMinQty"]').forEach(el => { el.textContent = ""; });
    if(minChanged){
      try {
        await EbApi.post("vat/save.php", { section: "rules", rules: { withholdingMinQty: minEl.value } });
        rules.withholdingMinQty = +minEl.value;
        saved++;
      } catch(err){
        const msg = (err.fields && err.fields.withholdingMinQty) || err.message;
        const el = $('[data-vat-err="withholdingMinQty"]'); if(el) el.textContent = msg;
        failed.push(`Minimum items: ${msg}`);
      }
    }
    for(const { c, rate } of changed){
      try {
        const { data } = await EbApi.post("vat/save.php", { section: "withholding", customer_id: c.id, rate });
        c.withholdingRate = data.withholdingRate;
        saved++;
      } catch(err){
        failed.push(`${c.name}: ${err.message}`);
      }
    }
    restore();
    saveBtn.disabled = false;
    countMeta();
    if(failed.length){
      toast(`Saved ${saved} of ${changed.length + (minChanged ? 1 : 0)}. ${failed[0]}`, "err");
    } else {
      markClean();
      toast(`Retailer discount saved: ${saved} change${saved === 1 ? "" : "s"}.`, "ok");
    }
  });
}

/* ---------------------------------------------------------------- Summary */
function vatRenderSummary(){
  const today = dAgo(0);
  vatState.from = vatState.from || today.slice(0, 8) + "01";
  vatState.to   = vatState.to   || today;

  $("#vat-content").innerHTML = `
    <div class="vat-summary-bar">
      <div class="field"><label for="vat-from">From</label><input class="control" type="date" id="vat-from" value="${vatState.from}"/></div>
      <div class="field"><label for="vat-to">To</label><input class="control" type="date" id="vat-to" value="${vatState.to}"/></div>
      <button class="btn btn-gold" id="vat-summary-go">Show</button>
    </div>
    <div id="vat-summary-body">${EbUI.skeletonBlock(7)}</div>`;

  $("#vat-summary-go").addEventListener("click", () => {
    vatState.from = $("#vat-from").value;
    vatState.to   = $("#vat-to").value;
    vatLoadSummary();
  });
  vatLoadSummary();
}

async function vatLoadSummary(){
  const body = $("#vat-summary-body");
  if(!body) return;
  if(vatState.from && vatState.to && vatState.from > vatState.to){
    body.innerHTML = `<div class="state-cell state-error"><strong>Check the dates.</strong><br><small>The start date is after the end date.</small></div>`;
    return;
  }
  body.innerHTML = EbUI.skeletonBlock(7);
  let data;
  try {
    ({ data } = await EbApi.get("vat/summary.php", { from: vatState.from, to: vatState.to }));
  } catch(err){
    body.innerHTML = `<div class="state-cell state-error"><strong>Could not load the summary.</strong><br><small>${escHtml(err.message)}</small></div>`;
    return;
  }
  const t = data.totals;
  const card = (label, value, sub) => `<div class="sales-sum-card">
      <div class="sales-sum-label">${label}</div>
      <div class="sales-sum-val">${value}</div>${sub ? `<div class="muted" style="font-size:.74rem;margin-top:2px">${sub}</div>` : ""}
    </div>`;

  body.innerHTML = `
    <div class="sales-summary vat-summary-cards">
      ${card("VATable Sales", vatMoney(t.vatableSales), "net of VAT")}
      ${card("Output VAT", vatMoney(t.outputVat), "VAT charged on invoices")}
      ${card("VAT-Exempt Sales", vatMoney(t.vatExemptSales))}
      ${card("Zero-Rated Sales", vatMoney(0), "export sales — not handled")}
      ${card("Retailer Discounts", vatMoney(t.withholdingTax), `${t.withholdingCount} sale${t.withholdingCount === 1 ? "" : "s"}`)}
      ${card("Invoices", t.invoices.toLocaleString(), `${vatMoney(t.totalSales)} total sales`)}
    </div>
    ${data.months.length ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Month</th><th class="num">Invoices</th><th class="num">VATable Sales</th><th class="num">Output VAT</th>
        <th class="num">VAT-Exempt</th><th class="num">Retailer Discount</th><th class="num">Total Sales</th></tr></thead>
      <tbody>${data.months.map(m => `<tr>
        <td>${escHtml(new Date(m.month + "-01T00:00:00").toLocaleDateString("en-PH", { year: "numeric", month: "long" }))}</td>
        <td class="num-cell">${m.invoices}</td>
        <td class="num-cell">${vatMoney(m.vatableSales)}</td>
        <td class="num-cell"><strong>${vatMoney(m.outputVat)}</strong></td>
        <td class="num-cell">${vatMoney(m.vatExemptSales)}</td>
        <td class="num-cell">${vatMoney(m.withholdingTax)}</td>
        <td class="num-cell">${vatMoney(m.totalSales)}</td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<div class="alert-empty"><strong>No invoices in this period</strong>Choose a different range.</div>`}`;
}
