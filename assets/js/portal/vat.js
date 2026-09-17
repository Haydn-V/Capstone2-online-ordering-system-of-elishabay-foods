"use strict";

/* ============================================================
   VAT MAINTENANCE — Super Admin only
   ------------------------------------------------------------
   Everything that decides what a Sales Invoice says about tax, in one
   place: the VAT rate, which products are VAT-exempt, the senior
   citizen / PWD discount rules, which retailers withhold tax, and the
   period summary a VAT return is built from.

   WHO CAN SEE IT. vat.manage is a SYSTEM_ONLY permission
   (api/core/Rbac.php). Super Admin holds it; the Roles & Permissions
   screen shows it locked for every other role and the server refuses
   to grant it. Every endpoint behind this screen (api/vat/*) checks the
   permission AND the system role. Hiding this module from the sidebar
   is presentation; those checks are the control.

   WHAT A CHANGE HERE DOES. It applies to sales made after it is saved.
   Every order stores the breakdown it was sold with (migration 014),
   so no invoice already issued changes — which is also why none of the
   tax arithmetic lives in this file. It lives in api/core/Tax.php, run
   at the moment of sale.
   ============================================================ */

const VAT_TABS = [
  { id: "rules",       label: "Rules" },
  { id: "products",    label: "Product Tax Types" },
  { id: "withholding", label: "Withholding Agents" },
  { id: "summary",     label: "VAT Summary" },
];

const vatState = { tab: "rules", data: null, from: null, to: null };

/* Always two decimals. peso() drops the centavos on a round amount, and tax
   figures are the ones that have to reconcile to the centavo. */
const vatMoney = n => EbFormat.pesoExact(n);

/* A setting read back from the server as a plain number for an input:
   "12" rather than "12.00", so the field shows what was typed. */
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

async function renderVat(){
  const content = $("#vat-content");
  if(!content) return;
  vatRenderTabs();

  if(!hasPerm("vat.manage")){
    content.innerHTML = `<div class="alert-empty"><strong>Super Admin only</strong>VAT Maintenance can only be opened by the Super Admin.</div>`;
    return;
  }

  if(vatState.tab === "summary"){ vatRenderSummary(); return; }

  content.innerHTML = `<div class="state-cell"><span class="spinner" aria-hidden="true"></span> Loading…</div>`;
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
function vatRenderRules(){
  const r = vatState.data.rules;
  $("#vat-content").innerHTML = `
    <div class="vat-grid">
      <div class="panel">
        <div class="panel-header"><span class="panel-title">Value-added tax</span></div>
        <div class="field">
          <label for="vat-rate">VAT rate (%)</label>
          <input class="control" type="number" id="vat-rate" min="0" max="50" step="0.01" value="${vatNum(r.vatRate)}"/>
          <span class="field-hint">Charged on VATable products. Shelf prices include it.</span>
          <span class="field-error" data-vat-err="vatRate"></span>
        </div>
        <div class="field">
          <label for="vat-wht-default">Default withholding rate (%)</label>
          <input class="control" type="number" id="vat-wht-default" min="0" max="50" step="0.01" value="${vatNum(r.withholdingDefaultRate)}"/>
          <span class="field-hint">Filled in when you register a new withholding agent. Each agent keeps its own rate.</span>
          <span class="field-error" data-vat-err="withholdingDefaultRate"></span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><span class="panel-title">Senior citizens &amp; PWD</span></div>
        <label class="vat-check">
          <input type="checkbox" id="vat-sc-enabled" ${r.scPwdEnabled ? "checked" : ""}/>
          <span>Offer senior citizen and PWD discounts at the POS</span>
        </label>
        <div class="field">
          <label for="vat-sc-rate">Discount (%)</label>
          <input class="control" type="number" id="vat-sc-rate" min="0" max="100" step="0.01" value="${vatNum(r.scPwdDiscountRate)}"/>
          <span class="field-hint">Taken off the amount net of VAT.</span>
          <span class="field-error" data-vat-err="scPwdDiscountRate"></span>
        </div>
        <label class="vat-check">
          <input type="checkbox" id="vat-sc-exempt" ${r.scPwdVatExempt ? "checked" : ""}/>
          <span>Discounted sales are VAT-exempt</span>
        </label>
        <span class="field-hint vat-check-hint">On: no VAT on the sale (RA 9994 / RA 10754). Off: VAT is charged on the discounted amount.</span>
        <div class="field">
          <label for="vat-sc-cap">Weekly discount limit per ID (₱)</label>
          <input class="control" type="number" id="vat-sc-cap" min="0" step="0.01" value="${vatNum(r.scPwdWeeklyCap)}"/>
          <span class="field-hint">The most discount one ID can receive Monday to Sunday. 0 means no limit.</span>
          <span class="field-error" data-vat-err="scPwdWeeklyCap"></span>
        </div>
      </div>
    </div>

    <p class="vat-note">
      <strong>Changes apply to sales made after you save.</strong>
      Invoices already issued keep the figures they were printed with.
      Confirm these rules with the business's accountant — which senior/PWD rule applies to grocery goods, in particular.
    </p>
    <button class="btn btn-gold" id="vat-save-rules">Save rules</button>`;

  $("#vat-save-rules").addEventListener("click", async (e) => {
    $$("[data-vat-err]").forEach(el => { el.textContent = ""; });
    const restore = EbUI.busy(e.currentTarget, "Saving…");
    try {
      const { data } = await EbApi.post("vat/save.php", {
        section: "rules",
        rules: {
          vatRate:                $("#vat-rate").value,
          withholdingDefaultRate: $("#vat-wht-default").value,
          scPwdEnabled:           $("#vat-sc-enabled").checked,
          scPwdDiscountRate:      $("#vat-sc-rate").value,
          scPwdVatExempt:         $("#vat-sc-exempt").checked,
          scPwdWeeklyCap:         $("#vat-sc-cap").value,
        },
      });
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
  $("#vat-content").innerHTML = `
    <p class="vat-note">
      A <strong>VAT-exempt</strong> product's shelf price has no VAT in it, and its sales print under
      VAT-Exempt Sales on the invoice. A change applies to sales from now on.
      <span class="muted">${exempt} of ${rows.length} product${rows.length === 1 ? "" : "s"} exempt.</span>
    </p>
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

/* ------------------------------------------------------------ Withholding */
function vatRenderWithholding(){
  const { retailers, rules } = vatState.data;
  const agents = retailers.filter(c => c.withholdingRate !== null).length;
  $("#vat-content").innerHTML = `
    <p class="vat-note">
      A <strong>withholding agent</strong> keeps part of what it pays — the rate below, on the amount net of VAT —
      and remits it to the BIR for the business, then hands over <strong>BIR Form 2307</strong>. The sale total is
      unchanged; the invoice shows it under Less: Withholding Tax, and the cash due is less. Only current retailers
      are listed. <span class="muted">${agents} withholding agent${agents === 1 ? "" : "s"}.</span>
    </p>
    ${retailers.length ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Retailer</th><th>BIR TIN</th><th style="width:190px">Withholds</th><th style="width:130px">Rate (%)</th><th style="width:110px"></th></tr></thead>
      <tbody>${retailers.map(c => {
        const on = c.withholdingRate !== null;
        return `<tr data-vat-agent="${escHtml(c.id)}">
          <td class="td-name">${escHtml(c.name)}<div class="muted" style="font-size:.75rem">${escHtml(c.email || "")}</div></td>
          <td class="mono-sm">${c.tin ? escHtml(c.tin) : `<span class="muted">—</span>`}</td>
          <td><label class="vat-check vat-check-inline"><input type="checkbox" data-vat-on ${on ? "checked" : ""}/><span>Withholding agent</span></label></td>
          <td><input class="control" type="number" min="0.01" max="50" step="0.01" data-vat-rate
                     value="${on ? vatNum(c.withholdingRate) : vatNum(rules.withholdingDefaultRate)}" ${on ? "" : "disabled"}
                     aria-label="Withholding rate for ${escHtml(c.name)}"/></td>
          <td><button class="btn btn-ghost btn-sm" data-vat-save-agent>Save</button></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>` : `<div class="alert-empty"><strong>No retailers yet</strong>Approved retail partners appear here.</div>`}`;

  $$("[data-vat-agent]").forEach(row => {
    const on   = row.querySelector("[data-vat-on]");
    const rate = row.querySelector("[data-vat-rate]");
    on.addEventListener("change", () => { rate.disabled = !on.checked; });
    row.querySelector("[data-vat-save-agent]").addEventListener("click", async (e) => {
      const restore = EbUI.busy(e.currentTarget, "Saving…");
      const customer = retailers.find(c => c.id === row.dataset.vatAgent);
      try {
        const { data } = await EbApi.post("vat/save.php", {
          section: "withholding",
          customer_id: row.dataset.vatAgent,
          rate: on.checked ? rate.value : null,
        });
        if(customer) customer.withholdingRate = data.withholdingRate;
        toast(data.withholdingRate === null
          ? `${customer ? customer.name : "Retailer"} no longer withholds tax.`
          : `${customer ? customer.name : "Retailer"} withholds ${vatNum(data.withholdingRate)}%.`, "ok");
      } catch(err){
        toast(err.message, "err");
      } finally { restore(); }
    });
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
    <div id="vat-summary-body"><div class="state-cell"><span class="spinner" aria-hidden="true"></span> Loading…</div></div>`;

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
  body.innerHTML = `<div class="state-cell"><span class="spinner" aria-hidden="true"></span> Loading…</div>`;
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
      ${card("Senior Citizen Discounts", vatMoney(data.scPwd.senior.discount), `${data.scPwd.senior.count} sale${data.scPwd.senior.count === 1 ? "" : "s"}`)}
      ${card("PWD Discounts", vatMoney(data.scPwd.pwd.discount), `${data.scPwd.pwd.count} sale${data.scPwd.pwd.count === 1 ? "" : "s"}`)}
      ${card("Tax Withheld by Buyers", vatMoney(t.withholdingTax), `${t.withholdingCount} sale${t.withholdingCount === 1 ? "" : "s"} · collect BIR Form 2307`)}
      ${card("Invoices", t.invoices.toLocaleString(), `${vatMoney(t.totalSales)} total sales`)}
    </div>
    <p class="vat-note">
      Every order not cancelled, dated by its invoice. That differs from the Sales Report on purpose: VAT is owed
      when a sale is invoiced, even on Net terms that have not been paid yet, while revenue waits for the money.
    </p>
    ${data.months.length ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Month</th><th class="num">Invoices</th><th class="num">VATable Sales</th><th class="num">Output VAT</th>
        <th class="num">VAT-Exempt</th><th class="num">SC/PWD Discounts</th><th class="num">Withheld</th><th class="num">Total Sales</th></tr></thead>
      <tbody>${data.months.map(m => `<tr>
        <td>${escHtml(new Date(m.month + "-01T00:00:00").toLocaleDateString("en-PH", { year: "numeric", month: "long" }))}</td>
        <td class="num-cell">${m.invoices}</td>
        <td class="num-cell">${vatMoney(m.vatableSales)}</td>
        <td class="num-cell"><strong>${vatMoney(m.outputVat)}</strong></td>
        <td class="num-cell">${vatMoney(m.vatExemptSales)}</td>
        <td class="num-cell">${vatMoney(m.scPwdDiscount)}</td>
        <td class="num-cell">${vatMoney(m.withholdingTax)}</td>
        <td class="num-cell">${vatMoney(m.totalSales)}</td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<div class="alert-empty"><strong>No invoices in this period</strong>Choose a different range.</div>`}`;
}
