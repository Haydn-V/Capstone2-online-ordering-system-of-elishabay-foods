"use strict";

/* ===== INVENTORY MANAGEMENT + EXPIRATION MONITORING, using engine.js's PRODUCTS and BATCHES ===== */

/* Today according to the server (from api/batches/list.php), falling back to the browser date only before the first batch load. */
function invToday(){
  /* ymd() instead of toISOString(), which is UTC. */
  return adminState.serverToday || ymd(new Date());
}

/* Kept as a name because ~10 call sites use it as a default date value. */
Object.defineProperty(window, "INV_TODAY", { get: invToday, configurable: true });

/* Default expiry for a new lot: one year from today, for the operator to correct. */
function defaultExpiry(){
  const d = new Date(invToday() + "T00:00:00");
  d.setFullYear(d.getFullYear() + 1);
  return ymd(d);
}

function daysUntilExpiry(expiryDate){
  if(!expiryDate) return 0;
  const now = new Date(invToday()+"T00:00:00");
  const exp = new Date(expiryDate+"T00:00:00");
  return Math.floor((exp - now) / 86400000);
}

function expiryInfo(days){
  if(days < 0)    return { cls:"expiry-gone", chipCls:"badge-out",  label:"Expired",       level:"gone" };
  if(days < 30)   return { cls:"expiry-crit", chipCls:"badge-crit", label:`${days}d left`, level:"crit" };
  if(days < 90)   return { cls:"expiry-warn", chipCls:"badge-warn", label:`${days}d left`, level:"warn" };
  return                  { cls:"expiry-ok",   chipCls:"badge-ok",  label:`${days}d left`, level:"ok"   };
}

function getExpiringSoon(days=90){
  return BATCHES
    .filter(b => daysUntilExpiry(b.expiryDate) < days)
    .sort((a,b)=> daysUntilExpiry(a.expiryDate) - daysUntilExpiry(b.expiryDate));
}

/* ===== STOCK ADJUSTMENTS LOG ===== */
/* Filled from api/inventory/adjustments.php by loadInventoryData(). */
/* Filled from api/inventory/adjustments.php by loadInventoryData(); starts empty. */
let ADJUSTMENTS = [];

/* The audit trail comes only from api/audit/list.php (no fake rows are added here). */

/* ===== DATA MUTATIONS ===== */
/* ===== DATA MUTATIONS: stock, batch and audit are written by api/inventory/adjust.php in one transaction, then reloaded; these functions are async and return a boolean ===== */
/* Restock: lotCode is optional (blank lets Inventory::nextLotCode() assign one), an expiry date opens a new lot (without one it only tops up stock), and the server's payload is returned so the caller can show the code. */
async function restock(productId, qty, prodDate, expiryDate, lotCode){
  if(qty <= 0) return false;
  try {
    const body = { product_id: productId, qty, type: "restock",
                   reason: "Restocked via Inventory Management." };
    if(expiryDate){
      body.production_date = prodDate || invToday();
      body.expiry_date = expiryDate;
      /* Send the lot code only if the operator entered one. */
      if(lotCode) body.batch_code = lotCode;
    }
    const { data } = await EbApi.post("inventory/adjust.php", body);
    await refreshInventory();
    return data || true;
  } catch(err){
    /* Field errors go to the form, anything else to a toast; failures are always reported. */
    if(err.isValidation) throw err;
    toast(err.message, "err");
    return false;
  }
}

/* Bulk replenish sends one request per line so one failure does not lose the rest, then reports all failures together. */
async function replenish(entries){
  const failed = [];
  for(const e of entries){
    if(e.qty <= 0) continue;
    try {
      /* Each line opens its own lot with a server-assigned sequential code when dates are given. */
      const body = { product_id: e.productId, qty: e.qty, type: "restock",
                     reason: "Bulk replenishment via Inventory Management." };
      if(e.expiryDate){
        body.production_date = e.prodDate || invToday();
        body.expiry_date = e.expiryDate;
      }
      await EbApi.post("inventory/adjust.php", body);
    } catch(err){
      const p = getProduct(e.productId);
      failed.push(`${p ? p.name : e.productId}: ${err.message}`);
    }
  }
  await refreshInventory();
  if(failed.length){
    toast(`${failed.length} line(s) failed — ${failed[0]}`, "err");
    console.warn("[replenish] failures:", failed);
  }
  return failed.length === 0;
}

async function adjustStock({ productId, qty, type, reason, batch="" }){
  try {
    /* The server decides the stock direction from type. */
    await EbApi.post("inventory/adjust.php", {
      product_id: productId, qty: Math.abs(qty), type, reason, batch_code: batch || null,
    });
    await refreshInventory();
    return true;
  } catch(err){
    if(err.isValidation) throw err;
    toast(err.message, "err");
    return false;
  }
}

/* Reload products and batches after any stock movement. */
async function refreshInventory(){
  await loadCatalog();
  await loadInventoryData();
}

/* Archive/restore go through products/archive.php, which also writes the audit row. */
async function archiveInvProduct(productId){
  try {
    const { data } = await EbApi.post("products/archive.php", { id: productId, archived: true });
    await loadCatalog();
    if(data.notice) toast(data.notice, "warn");
    return true;
  } catch(err){ toast(err.message, "err"); return false; }
}

async function restoreInvProduct(productId){
  try {
    await EbApi.post("products/archive.php", { id: productId, archived: false });
    await loadCatalog();
    return true;
  } catch(err){ toast(err.message, "err"); return false; }
}

/* ===== MODULE: INVENTORY MANAGEMENT ===== */
/* preselect is the product id the Restock/Adjustment forms open on (passed by Stock Overview row buttons). */
function renderInventoryManage(tab="overview", preselect=null){
  /* Reset filters when the pill tab actually changes (not on re-render, and not when a one-shot intent was just applied). */
  const changingTab = adminState.invTab !== tab;
  adminState.invTab = tab;
  const carryingIntent = typeof navIntent === "function" && navIntent("level") !== undefined;
  if(changingTab && tab === "overview" && !carryingIntent){
    adminState.invOverviewLevel = "all";
    adminState.invOverviewQuery = "";
    adminState.stockOvwPager.page = 1;
  }

  /* Sync the sidebar highlight from the render (without navigate(), which would scroll to top) however the tab was reached. */
  syncNavHighlight("inventory-manage", tab);

  $$("#invmgmt-action-tabs .inv-action-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.tab===tab);
    btn.onclick = ()=> renderInventoryManage(btn.dataset.tab);
  });

  /* Clear the toolbar's controls before each tab rebuilds them, so form tabs show none. */
  const toolbarGroup = $("#mod-inventory-manage .view-toolbar .view-toolbar-filters");
  if(toolbarGroup) toolbarGroup.innerHTML = "";

  const container = $("#invmgmt-view-content");
  if(tab==="overview")  container.innerHTML = buildStockOverview();
  if(tab==="restock")   container.innerHTML = buildRestockForm(preselect);
  if(tab==="replenish") container.innerHTML = buildReplenishForm();
  if(tab==="adjust")    container.innerHTML = buildAdjustForm(preselect);
  if(tab==="adjlog")    container.innerHTML = buildAdjLog();
  if(tab==="archive")   container.innerHTML = buildArchiveView();

  wireInventoryManageView(tab, container);
}

/* Stock Overview rows from the API, with the level filter applied in the query. */
function fillStockOverview(){
  return EbPaginate.list(
    "stock-ovw",
    adminState.stockOvwPager,
    () => document.getElementById("invmgmt-overview-tbody"),
    (page, limit) => EbApi.get("products/list.php", {
      page, limit, status: "all", sort: "name",
      search: adminState.invOverviewQuery || null,
      level: adminState.invOverviewLevel === "all" ? null : adminState.invOverviewLevel,
      /* The Level filter uses the bands measured over the selected window (see STOCK_WINDOWS). */
      window: stockWindowParam(),
    }),
    p => {
      const si = stockInfo(p);
      const batches = BATCHES.filter(b=>b.productId===p.id).length;
      return `<tr class="${p.archived?"archived":""}">
      <td class="td-name">${escHtml(p.name)}${p.archived?` <span class="badge badge-muted" style="font-size:.6rem">archived</span>`:""}</td>
      <td class="muted" style="font-size:.82rem">${escHtml(p.cat)}</td>
      <td><strong>${p.stock}</strong></td>
      <td><span class="badge ${si.cls}">${si.label}</span></td>
      <td>${batches} batch(es)</td>
      <td>
        ${!p.archived ? `<div class="td-actions">
          <button class="btn btn-gold btn-sm" data-quick-restock="${p.id}">Restock</button>
          <button class="btn btn-ghost btn-sm" data-quick-adjust="${p.id}">Adjust</button>
        </div>` : `<span class="muted" style="font-size:.78rem">Archived</span>`}
      </td>
    </tr>`;
    },
    {
      colspan: 6,
      empty: { title: "No products match filters", hint: "Adjust the search or level filter." },
      after: (rows, meta) => {
        document.querySelectorAll("#invmgmt-overview-tbody [data-quick-restock]").forEach(btn=>{
          btn.addEventListener("click", ()=> renderInventoryManage("restock", btn.dataset.quickRestock));
        });
        document.querySelectorAll("#invmgmt-overview-tbody [data-quick-adjust]").forEach(btn=>{
          btn.addEventListener("click", ()=> renderInventoryManage("adjust", btn.dataset.quickAdjust));
        });
        paintStockWindowNote("#ovw-window-note", meta);
      },
    }
  );
}

function buildStockOverview(){
  const q  = adminState.invOverviewQuery;
  const lv = adminState.invOverviewLevel;
  /* Shell only; fillStockOverview() draws the rows. */
  const rows = "";

/* Search, level and per-page go in the pill row above. */
  mountToolbarControl("inventory-manage", "overview-filters", `
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="search" id="search-invmgmt-overview" placeholder="Search products…" aria-label="Search stock" value="${escHtml(q)}"/>
      </div>
      <select class="filter-select" id="filter-invmgmt-overview-level" aria-label="Filter stock level">
        <option value="all" ${lv==="all"?"selected":""}>All Levels</option>
        <option value="ok" ${lv==="ok"?"selected":""}>Safe</option>
        <option value="warn" ${lv==="warn"?"selected":""}>Low</option>
        <option value="crit" ${lv==="crit"?"selected":""}>Critical</option>
        <option value="out" ${lv==="out"?"selected":""}>Out of Stock</option>
      </select>
      <select class="filter-select" id="filter-ovw-window" aria-label="Sales window the stock bands are measured over">
        ${stockWindowOptions()}
      </select>
      <select class="filter-select" id="stock-ovw-page-size" aria-label="Rows per page">
        <option value="10">10 per page</option>
        <option value="25">25 per page</option>
        <option value="50">50 per page</option>
      </select>`);

  return `  <div class="table-wrap viewport-bound"><table class="data-table" id="invmgmt-overview-table">
    <thead><tr><th>Product</th><th>Category</th><th>Stock</th><th>Level</th><th>Batches</th><th>Actions</th></tr></thead>
    <tbody id="invmgmt-overview-tbody">${rows}</tbody>
  </table></div>
  <div class="table-toolbar" style="margin-top:14px">
    <span class="muted" id="stock-ovw-showing" style="font-size:.82rem"></span>
    <span class="muted" id="ovw-window-note" style="font-size:.78rem;margin-left:12px"></span>
    <div class="pagination" id="stock-ovw-pagination" style="margin-left:auto"></div>
  </div>`;
}

/* ===== RESTOCK INSIGHT: recent daily sales chart, rate and suggested quantity beside the restock form, from completed orders already loaded ===== */

/* Basis options: last week, or yesterday (the last complete day). */
const RESTOCK_BASES = {
  week:      { days: 7, label: "Last 7 days",  phrase: "in the last 7 days" },
  yesterday: { days: 1, label: "Yesterday",    phrase: "yesterday" },
};

/* Two weeks of bars. */
const RESTOCK_CHART_DAYS = 14;

/* Units per day for one product, oldest first, with zeroes for days without sales. */
function salesByDay(productId, days){
  const series = [];
  const slotOf = {};
  for(let i = days - 1; i >= 0; i--){
    slotOf[dAgo(i)] = series.length;
    series.push({ date: dAgo(i), units: 0 });
  }
  /* Server figures (api/inventory/daily-sales.php) when loaded: every completed order, for any inventory role. */
  const daily = adminState.dailySales && adminState.dailySales[productId];
  if(adminState.dailySales){
    if(daily) series.forEach(s=>{ s.units = +daily[s.date] || 0; });
    return series;
  }
  ORDERS.forEach(o=>{
    if(o.status !== "completed") return;
    const slot = slotOf[o.date];
    if(slot === undefined) return;
    (o.items || []).forEach(it=>{
      if(it.id === productId) series[slot].units += (+it.qty || 0);
    });
  });
  return series;
}

/* Suggested quantity: sales rate x (twice the restock lead time from settings) minus current stock. */
function restockAdvice(product, basisKey){
  const basis  = RESTOCK_BASES[basisKey] || RESTOCK_BASES.week;
  const chart  = salesByDay(product.id, RESTOCK_CHART_DAYS);
  /* The basis is the end of the same series the chart draws, so highlighted bars are what was counted. */
  const window = basis.days === 1
    ? chart.slice(chart.length - 2, chart.length - 1)
    : chart.slice(chart.length - basis.days);

  const units      = window.reduce((n, d)=> n + d.units, 0);
  const perDay     = units / basis.days;
  const lead       = (product.inventory && product.inventory.lowDays) || 14;
  const targetDays = lead * 2;
  const target     = Math.ceil(perDay * targetDays);
  const cover      = perDay > 0 ? Math.round(product.stock / perDay) : null;

  return {
    basis, chart, window, units, perDay, lead, targetDays, target, cover,
    from: window.length ? window[0].date : null,
    to:   window.length ? window[window.length - 1].date : null,
    recommended: Math.max(0, target - product.stock),
  };
}

/* Inline SVG bar chart with theme colours and a <title> per bar. */
function salesChartSvg(advice){
  const inBasis = new Set(advice.window.map(d=>d.date));
  const peak    = Math.max(1, ...advice.chart.map(d=>d.units));
  const W = 240, H = 64, GAP = 2;
  const bw = (W - GAP * (advice.chart.length - 1)) / advice.chart.length;

  const bars = advice.chart.map(function(d, i){
    /* At least 2px for any non-zero day so one sale is visible. */
    const h = d.units === 0 ? 0 : Math.max(2, (d.units / peak) * (H - 8));
    const x = i * (bw + GAP);
    const cls = inBasis.has(d.date) ? "rs-bar is-on" : "rs-bar";
    return `<rect class="${cls}" x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}"
                  width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"
             ><title>${escHtml(fmtDate(d.date))} — ${d.units} unit${d.units === 1 ? "" : "s"}</title></rect>`;
  }).join("");

  return `<div class="rs-chart">
    <div class="rs-chart-peak"><span>${peak.toLocaleString()}</span> peak day</div>
    <svg viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Daily units sold over the last ${advice.chart.length} days. Peak ${peak}.">
      <line class="rs-axis" x1="0" y1="${H}" x2="${W}" y2="${H}"/>
      ${bars}
    </svg>
    <div class="rs-chart-axis">
      <span>${escHtml(fmtDate(advice.chart[0].date))}</span>
      <span>Today</span>
    </div>
  </div>`;
}

/* Rebuild the whole panel when the product or basis changes. */
function buildRestockInsight(product, basisKey){
  if(!product){
    return `<div class="panel rs-insight" id="rs-insight">
      <div class="panel-header"><span class="panel-title">Recent sales</span></div>
      <p class="muted" style="font-size:.84rem">Choose a product to see how fast it has been selling.</p>
    </div>`;
  }

  const a    = restockAdvice(product, basisKey);
  const rate = a.perDay >= 10 ? Math.round(a.perDay) : Math.round(a.perDay * 10) / 10;

  /* Each outcome explains its reasoning. */
  let verdict;
  if(a.units === 0){
    verdict = `<div class="rs-advice is-none">
      <div class="rs-advice-lead">No sales to go on</div>
      <p>Nothing was sold ${escHtml(a.basis.phrase)}. Try the wider basis, or decide from the ${a.chart.length}-day chart above.</p>
    </div>`;
  } else if(a.recommended === 0){
    verdict = `<div class="rs-advice is-ok">
      <div class="rs-advice-lead">No restock needed</div>
      <p><strong>${product.stock.toLocaleString()}</strong> in stock is about
         <strong>${a.cover}</strong> day${a.cover === 1 ? "" : "s"} at ${rate}/day —
         past the ${a.targetDays}-day target.</p>
    </div>`;
  } else {
    verdict = `<div class="rs-advice">
      <div class="rs-advice-lead">Suggested quantity</div>
      <div class="rs-advice-num">${a.recommended.toLocaleString()}</div>
      <p>${rate}/day × ${a.targetDays} days = ${a.target.toLocaleString()},
         less ${product.stock.toLocaleString()} in stock.
         The ${a.targetDays} days are the ${a.lead}-day restock lead time twice over:
         once for the wait, once so the shelf is not empty when it lands.</p>
      <button type="button" class="btn btn-ghost btn-sm" id="rs-use-suggested">Use ${a.recommended.toLocaleString()}</button>
    </div>`;
  }

  return `<div class="panel rs-insight" id="rs-insight">
    <div class="panel-header">
      <span class="panel-title">Recent sales</span>
      <div class="rs-basis" role="group" aria-label="What the suggestion is based on">
        ${Object.entries(RESTOCK_BASES).map(([key, b])=>
          `<button type="button" class="rs-basis-btn${b === a.basis ? " active" : ""}"
                   data-basis="${key}" aria-pressed="${b === a.basis}">${escHtml(b.label)}</button>`
        ).join("")}
      </div>
    </div>
    <div class="rs-headline">
      <strong>${a.units.toLocaleString()}</strong> unit${a.units === 1 ? "" : "s"} ${escHtml(a.basis.phrase)}
      <span class="muted">· about ${rate}/day · completed orders</span>
    </div>
    ${salesChartSvg(a)}
    ${verdict}
  </div>`;
}

/* wireRestockInsight binds the product select once per render; wireInsightControls re-binds the panel's own controls after each repaint (avoids stacking listeners). */
function wireRestockInsight(container){
  const sel = container.querySelector("#rs-product");
  if(sel && !sel.dataset.insightWired){
    sel.dataset.insightWired = "1";
    sel.addEventListener("change", ()=> repaintRestockInsight(container));
  }
  wireInsightControls(container);
}

function repaintRestockInsight(container){
  const host = container.querySelector("#rs-insight");
  const sel  = container.querySelector("#rs-product");
  if(!host || !sel) return;
  host.outerHTML = buildRestockInsight(getProduct(sel.value), adminState.restockBasis);
  wireInsightControls(container);
}

function wireInsightControls(container){
  container.querySelectorAll(".rs-basis-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      adminState.restockBasis = btn.dataset.basis;
      repaintRestockInsight(container);
    });
  });

  /* Fills the field without submitting. */
  container.querySelector("#rs-use-suggested")?.addEventListener("click", ()=>{
    const sel = container.querySelector("#rs-product");
    const qty = container.querySelector("#rs-qty");
    const p   = sel && getProduct(sel.value);
    if(!p || !qty) return;
    qty.value = restockAdvice(p, adminState.restockBasis).recommended;
    qty.focus();
  });
}

function buildRestockForm(preselect=null){
  const active = PRODUCTS.filter(p=>!p.archived);
  const opts = active.map(p=>`<option value="${p.id}"${p.id===preselect?" selected":""}>${escHtml(p.name)} (${p.stock} in stock)</option>`).join("");
  /* The panel follows the product the select opens on, including a preselect. */
  const shown = (preselect && active.find(p=>p.id===preselect)) || active[0] || null;
  return `<div class="restock-layout">
  <div class="panel">
    <div class="panel-header"><span class="panel-title">Restock a Product</span></div>
    <form id="restock-form" novalidate>
      <div class="field"><label>Product</label>
        <select class="control" id="rs-product">${opts}</select>
      </div>
      <div class="field"><label>Quantity to Add</label>
        <input class="control" type="number" id="rs-qty" min="1" value="50" placeholder="e.g. 50"/>
        <span class="field-error" id="rs-qty-err"></span>
      </div>
      <!-- Prefilled, still editable. The value is the server's suggestion —
           the next code in sequence (Inventory::nextLotCode), carried on the
           batch list's meta — rather than the random 3-digit number this used
           to hold, which collided against a UNIQUE column and surfaced as a
           rejected form with no explanation.

           Editable because a lot code sometimes has to match something printed
           off-system: a supplier's own code, or a run already labelled by hand.
           Cleared to blank, the server assigns one anyway, so emptying the
           field is a valid choice rather than an error. -->
      <div class="field"><label>Lot Code</label>
        <input class="control" id="rs-batch" placeholder="Leave blank to assign automatically"
               value="${escHtml(adminState.nextLotCode || "")}"/>
        <span class="field-error" id="rs-batch-err"></span>
      </div>
      <!-- Production date: today or up to one month back. Expiry is automatic: production date + 1 year for
           bottled, + 6 months for deboned (api/core/Inventory.php sets it; this field only shows it). -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label>Production Date</label>
          <input class="control" type="date" id="rs-prod" value="${INV_TODAY}" min="${prodDateMin()}" max="${lotToday()}"/>
          <span class="field-error" id="rs-prod-err" data-error-for="production_date"></span>
        </div>
        <div class="field"><label>Expiry Date <span class="muted" style="font-weight:400">(automatic)</span></label>
          <input class="control lot-auto-date" type="date" id="rs-expiry" value="${autoExpiry(shown ? shown.id : "", INV_TODAY)}" disabled/>
        </div>
      </div>
      <span class="field-hint" id="rs-expiry-hint" style="display:block;margin:-6px 0 14px"></span>
      <button type="submit" class="btn btn-gold">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        Restock
      </button>
    </form>
  </div>
  ${buildRestockInsight(shown, adminState.restockBasis)}
</div>`;
}

function buildReplenishForm(){
  const active = PRODUCTS.filter(p=>!p.archived);
  const rows = active.map(p=>`<tr>
    <td class="check-col"><input type="checkbox" class="rep-check" data-pid="${p.id}"/></td>
    <td class="td-name">${escHtml(p.name)}</td>
    <td><span class="badge ${stockInfo(p).cls}">${p.stock}</span></td>
    <td><input type="number" class="qty-input rep-qty" data-pid="${p.id}" value="0" min="0" aria-label="Qty for ${escHtml(p.name)}"/></td>
  </tr>`).join("");
  return `<div class="panel">
    <div class="panel-header">
      <span class="panel-title">Replenish Multiple Products</span>
      <button class="btn btn-gold" id="rep-submit-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
        Apply Replenishment
      </button>
    </div>
    <!-- The dates are shared across every checked line, and the lot code is
         not asked for at all.

         Shared because a bulk replenishment is ONE event — a production run or
         a delivery arriving together. Per-row dates would be more precise and
         would also be fifteen pairs of date pickers to fill in for a form
         whose entire purpose is doing several products at once.

         No lot code column: each checked line opens its OWN lot, and the code
         for it is assigned by inventory/adjust.php. Fifteen codes is exactly
         the case nobody should be typing, and the previous column could not be
         used successfully at all — this form sent no expiry date, which the
         server requires to open a lot, so every code entered here returned 422.

         Leave both dates blank to top up existing stock without opening lots,
         which is the older behaviour and still valid. -->
    <p style="font-size:.84rem;color:var(--text-muted);margin-bottom:14px">Check products, enter a quantity per line, then click Apply. The dates below apply to every line — each product opens its own lot, with a code assigned by the system. <strong>Clear the production date to top up existing stock without opening lots.</strong></p>
    <!-- Shared dates on the left, one quantity for every checked product (or all when none is checked) on the right. -->
    <div class="rep-top">
      <div class="rep-group">
        <div class="field"><label for="rep-prod">Production Date</label>
          <input class="control" type="date" id="rep-prod" value="${INV_TODAY}" min="${prodDateMin()}" max="${lotToday()}"/>
          <span class="field-error" id="rep-expiry-err"></span>
        </div>
        <div class="field"><label>Expiry Date</label>
          <div class="lot-auto-note">Automatic per product: production date + <strong>1 year</strong> for bottled, + <strong>6 months</strong> for deboned.</div>
        </div>
      </div>
      <span class="rep-divider" aria-hidden="true"></span>
      <div class="field rep-bulk">
        <label for="rep-qty-all">Same quantity for all <span class="rep-count" id="rep-selected-count">0 selected</span></label>
        <div class="rep-bulk-row">
          <input class="control" type="number" id="rep-qty-all" min="1" placeholder="e.g. 50" inputmode="numeric"/>
          <button type="button" class="btn btn-ghost" id="rep-qty-all-btn">Apply to all</button>
        </div>
      </div>
    </div>
    <div class="table-wrap"><table class="replenish-table">
      <thead><tr><th class="check-col"><input type="checkbox" id="rep-check-all" aria-label="Select all products"/></th><th>Product</th><th>Current Stock</th><th>Add Qty</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function buildAdjustForm(preselect=null){
  /* The lot picker is filled from the selected product. */
  const opts = PRODUCTS.filter(p=>!p.archived).map(p=>`<option value="${p.id}"${p.id===preselect?" selected":""}>${escHtml(p.name)}</option>`).join("");
  /* Adjustment form plus a preview of the result (stock before/after and lots), built from data already in memory, as a check before destroying stock. */
  return `<div class="adj-split">
    <div class="panel adj-form-col">
    <div class="panel-header"><span class="panel-title">Stock Adjustment</span></div>
    <p style="font-size:.84rem;color:var(--text-muted);margin-bottom:18px">Record disposal (expiry/damage/defects) or returns. Each adjustment is logged in the audit trail.</p>
    <form id="adjust-form" novalidate>
      <div class="field"><label>Adjustment Type</label>
        <div class="adj-type-row">
          <button type="button" class="adj-type-btn active disposal" id="adj-type-disposal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Disposal
          </button>
          <button type="button" class="adj-type-btn return" id="adj-type-return">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.97"/></svg>
            Return
          </button>
        </div>
        <input type="hidden" id="adj-type" value="disposal"/>
      </div>
      <div class="field"><label>Product</label>
        <select class="control" id="adj-product">${opts}</select>
      </div>
      <div class="field"><label>Quantity</label>
        <input class="control" type="number" id="adj-qty" min="1" value="1" placeholder="e.g. 5"/>
        <span class="field-error" id="adj-qty-err"></span>
      </div>
      <div class="field"><label>Lot Code</label>
        <select class="control" id="adj-batch"></select>
        <span class="field-error" id="adj-batch-err"></span>
        <span class="field-hint" id="adj-batch-hint" style="font-size:.76rem;color:var(--text-muted)"></span>
      </div>
      <div class="field"><label>Reason</label>
        <textarea class="control" id="adj-reason" rows="3" placeholder="e.g. Expired product past due date, damage detected during QA…"></textarea>
        <span class="field-error" id="adj-reason-err"></span>
      </div>
      <button type="submit" class="btn btn-red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Submit Adjustment
      </button>
    </form>
    </div>

    <aside class="panel adj-preview-col" id="adj-preview" aria-live="polite">
      <div class="panel-header"><span class="panel-title">What this affects</span></div>
      <div id="adj-preview-body"></div>
    </aside>
  </div>`;
}

/* Units a lot can still take back: it never holds more than it started with (api/inventory/adjust.php checks too). */
function lotRoom(b){ return b.totalQty ? Math.max(0, b.totalQty - b.remainingQty) : 0; }

/* The preview column is derived only, with no state or request. */
function paintAdjustPreview(container){
  const body = container.querySelector("#adj-preview-body");
  if(!body) return;

  const pid  = container.querySelector("#adj-product")?.value;
  const type = container.querySelector("#adj-type")?.value || "disposal";
  const qty  = Math.max(0, +container.querySelector("#adj-qty")?.value || 0);
  const lot  = container.querySelector("#adj-batch")?.value || "";
  const p    = getProduct(pid);

  if(!p){ body.innerHTML = `<div class="alert-empty"><strong>No product selected</strong></div>`; return; }

  const si    = stockInfo(p);
  /* Disposal subtracts and return adds (shown here, decided by the server). */
  const after = type === "disposal" ? p.stock - qty : p.stock + qty;
  const selLot  = BATCHES.find(b => b.lotCode === lot && b.productId === pid);
  /* A return can't fill a lot past its total; a disposal can't take a lot below zero. */
  const lotOver = !!selLot && (type === "return" ? qty > lotRoom(selLot) : qty > selLot.remainingQty);
  const over  = (type === "disposal" && qty > p.stock) || lotOver;

  const lots = BATCHES
    .filter(b => b.productId === pid)
    .filter(b => type === "disposal" ? b.remainingQty > 0 : lotRoom(b) > 0)
    .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = lots.map(b => {
    const isSel = b.lotCode === lot;
    const left  = !isSel ? b.remainingQty
                : type === "disposal" ? Math.max(0, b.remainingQty - qty) : b.remainingQty + qty;
    /* How full each lot is and how soon it expires. */
    const pct   = b.totalQty ? Math.max(0, Math.min(100, Math.round(left / b.totalQty * 100))) : 0;
    const days  = b.expiryDate ? Math.round((new Date(b.expiryDate + "T00:00:00") - today) / 864e5) : null;
    const tone  = days == null ? "" : days < 0 ? "is-expired" : days <= 30 ? "is-soon" : days <= 90 ? "is-near" : "is-ok";
    const when  = days == null ? "" : days < 0 ? `expired ${-days}d ago` : days === 0 ? "today" : `in ${days}d`;
    return `<tr class="adj-lot-row${isSel ? " is-selected" : ""}" data-lot="${escHtml(b.lotCode)}" tabindex="0" role="button"
               aria-pressed="${isSel}" title="${isSel ? "Selected lot" : "Use this lot"}">
      <td class="mono">${escHtml(b.lotCode)}${isSel ? ` <span class="badge badge-warn">selected</span>` : ""}</td>
      <td class="num-cell">
        <div class="adj-lot-qty">${isSel && qty
          ? `<span class="adj-lot-was">${b.remainingQty}</span><span class="adj-lot-arrow" aria-hidden="true">→</span><b>${left}</b>`
          : `<b>${b.remainingQty}</b>`}${b.totalQty ? `<span class="adj-lot-of">/ ${b.totalQty}</span>` : ""}</div>
        ${b.totalQty ? `<div class="adj-lot-bar"><i style="width:${pct}%"></i></div>` : ""}
      </td>
      <td class="num-cell">
        <div class="adj-lot-date">${escHtml(fmtDate(b.expiryDate))}</div>
        ${when ? `<span class="adj-lot-when ${tone}">${when}</span>` : ""}
      </td>
    </tr>`;
  }).join("");

  /* Facts for the decision: days of cover, speed, and whether the earliest lot expires before selling. */
  const inv   = p.inventory || {};
  const risk  = inv.expiryRisk;

  const IC = {
    move:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></svg>',
    lots:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5z"/><path d="m3 16 9 5 9-5M3 12l9 5 9-5"/></svg>',
  };
  const moveTone = /fast/i.test(inv.movementLabel || "") ? "is-good" : /slow|dead|no/i.test(inv.movementLabel || "") ? "is-warn" : "";
  const facts = [
    { ic: IC.move, tone: moveTone, k: "Movement", v: inv.movementLabel || "—",
      hint: inv.perMonth != null ? `About ${inv.perMonth} a month.` : "" },
    { ic: IC.lots, k: "Lots on record", v: String(lots.length), hint: "" },
  ].map(f => `<div class="adj-prev-fact ${f.tone || ""}"${f.hint ? ` title="${escHtml(f.hint)}"` : ""}>
      <span class="adj-prev-fact-ic" aria-hidden="true">${f.ic}</span>
      <div><span>${f.k}</span><b>${escHtml(f.v)}</b></div>
    </div>`).join("");

  body.innerHTML = `
    <div class="adj-prev-product">
      <div class="adj-prev-id">
        <div class="adj-prev-cat">${escHtml(p.cat || "")}</div>
        <h4 class="adj-prev-name">${escHtml(p.name)}</h4>
      </div>
      <span class="badge ${si.cls}"${si.reason ? ` title="${escHtml(si.reason)}"` : ""}>${escHtml(si.label)}</span>
    </div>

    <div class="adj-prev-figures ${type === "disposal" ? "is-out" : "is-in"}">
      <div class="adj-prev-fig">
        <span>On hand now</span>
        <b>${p.stock.toLocaleString()}</b>
      </div>
      <div class="adj-prev-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </div>
      <div class="adj-prev-fig ${over ? "is-bad" : ""}">
        <span>After this ${type === "disposal" ? "disposal" : "return"}</span>
        <b>${over ? "—" : Math.max(0, after).toLocaleString()}</b>
      </div>
      ${qty && !over ? `<span class="adj-prev-delta">${type === "disposal" ? "−" : "+"}${qty.toLocaleString()} unit${qty === 1 ? "" : "s"}</span>` : ""}
    </div>

    ${lotOver && type === "disposal" ? `<div class="adj-prev-warn">
      Lot ${escHtml(selLot.lotCode)} holds only ${selLot.remainingQty.toLocaleString()}, so no more than that can be
      disposed from it. Lower the quantity or pick another lot.
    </div>` : lotOver ? `<div class="adj-prev-warn">
      Lot ${escHtml(selLot.lotCode)} started with ${selLot.totalQty.toLocaleString()} and holds ${selLot.remainingQty.toLocaleString()},
      so only ${lotRoom(selLot).toLocaleString()} more can be returned to it. Lower the quantity or pick another lot.
    </div>` : over ? `<div class="adj-prev-warn">
      That is more than the ${p.stock.toLocaleString()} on hand. The server refuses an
      adjustment it cannot take out of stock, so lower the quantity before submitting.
    </div>` : ""}

    <div class="adj-prev-facts">${facts}</div>

    ${risk && risk.atRisk ? `<div class="adj-prev-risk">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span>${escHtml(risk.note)}</span>
    </div>` : ""}

    <section class="adj-prev-lots">
      <header class="adj-prev-lots-head">
        <span>Lots</span>
        <span class="adj-prev-lots-count">${lots.length
          ? `${lots.length} on record${type === "disposal" ? " · soonest expiry first" : ""} · click a lot to use it`
          : "none on record"}</span>
      </header>
      <div class="adj-prev-lots-box">
        ${lots.length ? `<div class="adj-prev-lots-body"><table class="data-table adj-lot-table">
          <thead><tr><th>Lot</th><th class="num">Remaining</th><th class="num">Expires</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : `<div class="adj-prev-lots-body"><div class="alert-empty">
          <strong>Nothing to adjust against</strong>
          Register a lot for this product in Batch Tracking first.
        </div></div>`}
      </div>
    </section>`;

  /* Clicking a lot row selects it in the form's Lot dropdown. */
  const pick = tr => {
    const sel = container.querySelector("#adj-batch");
    if(!sel || sel.value === tr.dataset.lot) return;
    if(![...sel.options].some(o => o.value === tr.dataset.lot)) return;
    sel.value = tr.dataset.lot;
    if(window.EbSelect) EbSelect.sync(sel);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  body.querySelectorAll("tr.adj-lot-row").forEach(tr => {
    tr.addEventListener("click", () => pick(tr));
    tr.addEventListener("keydown", e => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); pick(tr); } });
  });
}

/* Adjustment log is server-paged; fillAdjLog() fills the empty tbody. */
function buildAdjLog(){
  /* Rows-per-page lives in the pill row, not in a strip of its own. */
  mountToolbarControl("inventory-manage", "page-size", `
    <select class="filter-select" id="adj-log-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  return `<div class="table-wrap viewport-bound"><table class="data-table">
    <thead><tr><th>Date</th><th>Product</th><th>Type</th><th>Qty</th><th>Reason</th><th>Lot</th></tr></thead>
    <tbody id="adj-log-tbody"></tbody>
  </table></div>
  <div class="table-toolbar" style="margin-top:14px">
    <span class="muted" id="adj-log-showing" style="font-size:.82rem"></span>
    <div class="pagination" id="adj-log-pagination" style="margin-left:auto"></div>
  </div>`;
}

function fillAdjLog(){
  return EbPaginate.list(
    "adj-log",
    adminState.adjLogPager,
    () => document.getElementById("adj-log-tbody"),
    (page, limit) => EbApi.get("inventory/adjustments.php", { page, limit }),
    a => `<tr>
      <td class="muted" style="font-size:.82rem">${fmtDate(a.date)}</td>
      <td class="td-name">${escHtml(a.productName)}</td>
      <td><span class="adj-type-tag ${a.type==="disposal"?"adj-disposal":a.type==="return"?"adj-return":"adj-restock"}">${a.type}</span></td>
      <td style="font-weight:700;color:${a.qty<0?"var(--out)":"var(--ok)"}">${a.qty>0?"+":""}${a.qty}</td>
      <td style="font-size:.82rem">${escHtml(a.reason)}</td>
      <td class="muted" style="font-size:.78rem">${escHtml(a.batch||"—")}</td>
    </tr>`,
    { colspan: 6, empty: { title: "No adjustments recorded", hint: "Disposals and returns appear here." } }
  );
}

/* Archive rows from the API, filled by fillArchiveView(). */
function fillArchiveView(){
  return EbPaginate.list(
    "archive",
    adminState.archivePager,
    () => document.getElementById("archive-tbody"),
    (page, limit) => EbApi.get("products/list.php", { page, limit, status: "all", sort: "name" }),
    p => `<tr class="${p.archived?"archived":""}">
    <td class="td-name">${escHtml(p.name)}</td>
    <td class="muted">${escHtml(p.cat)}</td>
    <td><strong>${p.stock}</strong></td>
    <td><span class="badge ${p.archived?"badge-muted":"badge-ok"}">${p.archived?"Archived":"Active"}</span></td>
    <td>${!EbRbac.canAny("products.manage","inventory.manage") ? `<span class="muted" style="font-size:.82rem">View only</span>`
      : !p.archived?`<button class="btn btn-ghost-danger btn-sm" data-archive-prod="${p.id}">Archive</button>`:
      `<button class="btn btn-ok btn-sm" data-restore-prod="${p.id}">Restore</button>`}
    </td>
  </tr>`,
    {
      colspan: 5,
      empty: { title: "No products", hint: "Products appear here once added." },
      after: () => wireArchiveActions(),
    }
  );
}

/* Wire archive/restore buttons after each page of rows. */
function wireArchiveActions(){
  document.querySelectorAll("#archive-tbody [data-archive-prod]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const p = getProduct(btn.dataset.archiveProd);
      if(!p) return;
      openModal({
        title:"Archive Product",
        body:`<p>Archive <strong>${escHtml(p.name)}</strong>? It will be hidden from the shop but kept on record.</p>`,
        confirmLabel:"Archive", confirmClass:"btn-ghost-danger",
        onConfirm: async ()=>{
          if(await archiveInvProduct(p.id)){
            closeModal(); toast(`${p.name} archived.`,"warn");
            renderInventoryManage("archive");
          }
        }
      });
    });
  });
  document.querySelectorAll("#archive-tbody [data-restore-prod]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const p = getProduct(btn.dataset.restoreProd);
      if(!p) return;
      if(await restoreInvProduct(p.id)){
        toast(`${p.name} restored.`,"ok");
        renderInventoryManage("archive");
      }
    });
  });
}

function buildArchiveView(){
  /* Rows-per-page lives in the pill row, not in a strip of its own. */
  mountToolbarControl("inventory-manage", "page-size", `
    <select class="filter-select" id="archive-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  return `<div class="table-wrap viewport-bound"><table class="data-table">
    <thead><tr><th>Product</th><th>Category</th><th>Stock</th><th>Status</th><th>Action</th></tr></thead>
    <tbody id="archive-tbody"></tbody>
  </table></div>
  <div class="table-toolbar" style="margin-top:14px">
    <span class="muted" id="archive-showing" style="font-size:.82rem"></span>
    <div class="pagination" id="archive-pagination" style="margin-left:auto"></div>
  </div>`;
}

function wireInventoryManageView(tab, container){
  if(tab==="overview"){
    const rerender = ()=> renderInventoryManage("overview");
    /* These controls now live in the pill row, so look them up globally, not inside the container. */
    const filterSearch = $("#search-invmgmt-overview");
    const filterLevel  = $("#filter-invmgmt-overview-level");
    filterSearch?.addEventListener("input", ()=>{
      adminState.invOverviewQuery = filterSearch.value.toLowerCase();
      adminState.stockOvwPager.page = 1;
      rerender();
    });
    filterLevel?.addEventListener("change", ()=>{
      adminState.invOverviewLevel = filterLevel.value;
      adminState.stockOvwPager.page = 1;
      rerender();
    });
    /* Same window control as the Inventory Report, sharing its session state. */
    const filterWindow = $("#filter-ovw-window");
    filterWindow?.addEventListener("change", ()=>{
      adminState.stockWindow = filterWindow.value;
      adminState.stockOvwPager.page = 1;
      rerender();
    });
    /* Restore focus after each rebuild so typing feels continuous. */
    if(adminState.invOverviewQuery && filterSearch){
      filterSearch.focus();
      filterSearch.setSelectionRange(filterSearch.value.length, filterSearch.value.length);
    }
    container.querySelectorAll("[data-quick-restock]").forEach(btn=>{
      btn.addEventListener("click", ()=> renderInventoryManage("restock", btn.dataset.quickRestock));
    });
    container.querySelectorAll("[data-quick-adjust]").forEach(btn=>{
      btn.addEventListener("click", ()=> renderInventoryManage("adjust", btn.dataset.quickAdjust));
    });

    fillStockOverview();
  }

  if(tab==="restock"){
    wireRestockInsight(container);
    const syncExp = wireLotDates(container.querySelector("#rs-prod"), container.querySelector("#rs-expiry"),
      container.querySelector("#rs-expiry-hint"), ()=> container.querySelector("#rs-product").value);
    container.querySelector("#rs-product")?.addEventListener("change", syncExp);
    container.querySelector("#restock-form")?.addEventListener("submit", async e=>{
      e.preventDefault();
      const form      = e.target;
      const productId = container.querySelector("#rs-product").value;
      const qty       = +container.querySelector("#rs-qty").value;
      const lot       = container.querySelector("#rs-batch").value.trim();
      const prodDate  = container.querySelector("#rs-prod").value;
      const expiry    = prodDate ? autoExpiry(productId, prodDate) : "";
      container.querySelector("#rs-qty-err").textContent = "";
      container.querySelector("#rs-prod-err").textContent = "";
      if(qty < 1){ container.querySelector("#rs-qty-err").textContent="Enter valid quantity."; return; }
      const prodBad = prodDateProblem(prodDate);
      if(prodBad){ container.querySelector("#rs-prod-err").textContent = prodBad; return; }

      /* Disable while the request runs to prevent double posts. */
      const restore = EbUI.busy(form.querySelector("[type=submit]"), "Restocking…");
      try {
        const res = await restock(productId, qty, prodDate, expiry, lot);
        if(res){
          /* Read the new stock from the reloaded catalogue. */
          const p = getProduct(productId);
          /* Show the opened lot code so the operator can label the carton. */
          const lot = res && res.lotCode ? ` Lot ${res.lotCode} opened.` : "";
          toast(`Restocked ${p.name} +${qty} units. New stock: ${p.stock}.${lot}`, "ok");
          /* Stay on the product just restocked. */
          renderInventoryManage("restock", productId);
        }
      } catch(err){
        if(err.isValidation) EbUI.showFieldErrors(form, err.fields);
        else toast(err.message, "err");
      } finally { restore(); }
    });
  }

  if(tab==="replenish"){
    /* Select all, a running count, and one quantity applied to every checked row. */
    const checks   = [...container.querySelectorAll(".rep-check")];
    const allBox   = container.querySelector("#rep-check-all");
    const countEl  = container.querySelector("#rep-selected-count");
    const applyBtn = container.querySelector("#rep-qty-all-btn");
    const syncSelection = ()=>{
      const n = checks.filter(c=>c.checked).length;
      if(allBox){ allBox.checked = n > 0 && n === checks.length; allBox.indeterminate = n > 0 && n < checks.length; }
      if(countEl) countEl.textContent = `${n} selected`;
      if(applyBtn) applyBtn.textContent = n ? "Apply to selected" : "Apply to all";
    };
    allBox?.addEventListener("change", ()=>{ checks.forEach(c=>{ c.checked = allBox.checked; }); syncSelection(); });
    checks.forEach(c=>c.addEventListener("change", syncSelection));
    /* Typing a quantity on a row checks it, so the row is not silently skipped. */
    container.querySelectorAll(".rep-qty").forEach(inp=>inp.addEventListener("input", ()=>{
      const cb = container.querySelector(`.rep-check[data-pid="${inp.dataset.pid}"]`);
      if(cb && +inp.value > 0 && !cb.checked){ cb.checked = true; syncSelection(); }
    }));
    applyBtn?.addEventListener("click", ()=>{
      const qty = Math.floor(+container.querySelector("#rep-qty-all")?.value || 0);
      if(qty < 1){ toast("Enter a quantity of at least 1.", "warn"); return; }
      let targets = checks.filter(c=>c.checked);
      if(!targets.length){ targets = checks; targets.forEach(c=>{ c.checked = true; }); }
      targets.forEach(c=>{ const q = container.querySelector(`.rep-qty[data-pid="${c.dataset.pid}"]`); if(q) q.value = qty; });
      syncSelection();
      toast(`Set ${qty} for ${targets.length} product${targets.length === 1 ? "" : "s"}.`, "ok");
    });
    syncSelection();

    container.querySelector("#rep-submit-btn")?.addEventListener("click", async (e)=>{
      const entries = [];
      /* Shared dates for every line; a blank expiry means top up without opening lots. */
      const prodDate   = container.querySelector("#rep-prod")?.value || "";
      const expErr     = container.querySelector("#rep-expiry-err");
      if(expErr) expErr.textContent = "";
      const prodBad = prodDateProblem(prodDate);
      if(prodBad){ if(expErr) expErr.textContent = prodBad; return; }
      container.querySelectorAll(".rep-check:checked").forEach(cb=>{
        const pid  = cb.dataset.pid;
        const qty  = +container.querySelector(`.rep-qty[data-pid="${pid}"]`)?.value||0;
        /* Each line's expiry follows its own category; the server sets the same value. */
        if(qty > 0) entries.push({ productId:pid, qty, prodDate, expiryDate: prodDate ? autoExpiry(pid, prodDate) : "" });
      });
      if(!entries.length){ toast("No products selected or all quantities are 0.", "warn"); return; }
      const restore = EbUI.busy(e.currentTarget, "Replenishing…");
      try {
        /* Report success only if every line worked. */
        if(await replenish(entries)){
          toast(`Replenished ${entries.length} product(s).`, "ok");
        }
        renderInventoryManage("replenish");
      } finally { restore(); }
    });
  }

  if(tab==="adjust"){
    const typeDisposalBtn = container.querySelector("#adj-type-disposal");
    const typeReturnBtn   = container.querySelector("#adj-type-return");
    const typeHidden      = container.querySelector("#adj-type");

    /* Lot picker built from the loaded BATCHES, so the operator chooses from real lots. */
    const batchSel  = container.querySelector("#adj-batch");
    const batchHint = container.querySelector("#adj-batch-hint");

    function paintLots(){
      const pid  = container.querySelector("#adj-product").value;
      const type = typeHidden.value;
      const p    = getProduct(pid);

      /* Disposal lists lots with stock; returns list lots below what they started with (a lot never goes above its total). */
      const lots = BATCHES
        .filter(b => b.productId === pid)
        .filter(b => type === "disposal" ? b.remainingQty > 0 : lotRoom(b) > 0)
        .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));

      if(!lots.length){
        batchSel.innerHTML = `<option value="">No lots recorded for this product</option>`;
        batchSel.disabled = true;
        batchHint.textContent = type === "disposal"
          ? `No lot of ${p?.name || "this product"} has stock left to discard. Register one in Batch Tracking.`
          : `No lot of ${p?.name || "this product"} has room — every lot already holds what it started with.`;
        return;
      }

      batchSel.disabled = false;
      /* Show expiry for disposals only. */
      batchSel.innerHTML = lots.map(b => {
        const left = type === "disposal" ? `${b.remainingQty} left` : `${b.remainingQty} of ${b.totalQty} · up to ${lotRoom(b)} more`;
        const exp  = type === "disposal" ? ` · expires ${fmtDate(b.expiryDate)}` : "";
        return `<option value="${escHtml(b.lotCode)}">${escHtml(b.lotCode)} — ${left}${exp}</option>`;
      }).join("");
      batchHint.textContent = lots.length === 1
        ? "One lot on record for this product."
        : `${lots.length} lots, soonest expiry first.`;
    }

    /* The preview follows product, type, quantity and lot changes. */
    const repaint = () => { paintLots(); paintAdjustPreview(container); };

    container.querySelector("#adj-product")?.addEventListener("change", repaint);
    container.querySelector("#adj-qty")?.addEventListener("input", () => paintAdjustPreview(container));
    container.querySelector("#adj-batch")?.addEventListener("change", () => paintAdjustPreview(container));

    typeDisposalBtn?.addEventListener("click", ()=>{
      typeHidden.value="disposal";
      typeDisposalBtn.classList.add("active","disposal"); typeDisposalBtn.classList.remove("return");
      typeReturnBtn.classList.remove("active","return");
      container.querySelector("[type='submit']").className="btn btn-red";
      repaint();
    });
    typeReturnBtn?.addEventListener("click", ()=>{
      typeHidden.value="return";
      typeReturnBtn.classList.add("active","return"); typeReturnBtn.classList.remove("disposal");
      typeDisposalBtn.classList.remove("active","disposal");
      container.querySelector("[type='submit']").className="btn btn-ok";
      repaint();
    });

    repaint();
    container.querySelector("#adjust-form")?.addEventListener("submit", async e=>{
      e.preventDefault();
      const productId = container.querySelector("#adj-product").value;
      const qty       = +container.querySelector("#adj-qty").value;
      const type      = container.querySelector("#adj-type").value;
      const reason    = container.querySelector("#adj-reason").value.trim();
      const batch     = container.querySelector("#adj-batch").value.trim();
      container.querySelector("#adj-qty-err").textContent="";
      container.querySelector("#adj-reason-err").textContent="";
      container.querySelector("#adj-batch-err").textContent="";
      if(qty<1){ container.querySelector("#adj-qty-err").textContent="Enter valid quantity."; return; }
      if(!reason){ container.querySelector("#adj-reason-err").textContent="Reason is required."; return; }
      /* A lot never holds more than it started with (the server checks too). */
      const lotB = BATCHES.find(b => b.lotCode === batch && b.productId === productId);
      if(type === "disposal" && lotB && qty > lotB.remainingQty){
        container.querySelector("#adj-qty-err").textContent =
          `Lot ${lotB.lotCode} holds only ${lotB.remainingQty} — you can't dispose more than that.`;
        return;
      }
      if(type === "return" && lotB && qty > lotRoom(lotB)){
        container.querySelector("#adj-qty-err").textContent = lotRoom(lotB)
          ? `Lot ${lotB.lotCode} can take back only ${lotRoom(lotB)} more (${lotB.remainingQty} of ${lotB.totalQty}).`
          : `Lot ${lotB.lotCode} is already full (${lotB.remainingQty} of ${lotB.totalQty}).`;
        return;
      }
      /* Quick check for a product with no lots (the server enforces it too). */
      if(!batch){
        container.querySelector("#adj-batch-err").textContent =
          "Select a lot. If none is listed, register one in Batch Tracking first.";
        return;
      }
      const form = container.querySelector("#adjust-form");
      const restore = EbUI.busy(form.querySelector("[type=submit]"), "Recording…");
      try {
        if(await adjustStock({ productId, qty, type, reason, batch })){
          const p = getProduct(productId);
          toast(`Adjustment recorded: ${type} of ${qty} unit(s) from ${p.name}.`, type==="disposal"?"warn":"ok");
          form.reset();
          container.querySelector("#adj-type").value="disposal";
          typeDisposalBtn.classList.add("active","disposal");
          typeReturnBtn.classList.remove("active");
          renderInventoryManage("adjust", productId);
        }
      } catch(err){
        if(err.isValidation) EbUI.showFieldErrors(form, err.fields);
        else toast(err.message, "err");
      } finally { restore(); }
    });
  }

  if(tab==="archive"){
    /* Archive buttons are wired in fillArchiveView's after hook, once rows exist. */
    fillArchiveView();
  }

  if(tab==="adjlog"){
    /* EbPaginate wires its own controls, replacing the old client-side Paginate. */
    fillAdjLog();
  }
}

/* ===== MODULE: EXPIRATION MONITORING ===== */
/* Expiration Monitoring is server-paged, with days_to_expiry, search, status and sort all handled by the server across every batch. */
function renderExpiry(){
  const status = $("#filter-expiry-status")?.value || "all";
  const sort   = $("#filter-expiry-sort")?.value || "soonest";

  EbPaginate.list(
    "expiry",
    adminState.expiryPager,
    () => $("#expiry-tbody"),
    (page, limit) => EbApi.get("batches/list.php", {
      page, limit,
      search: $("#search-expiry")?.value || null,
      level: status,
      sort: sort === "product" ? "product" : sort === "latest" ? "latest" : "expiry",
    }),
    b => {
      const days = b.daysToExpiry;
      const ei = expiryInfo(days);
      const prod = getProduct(b.productId);
      return `<tr>
    <td class="mono">${escHtml(b.lotCode)}</td>
    <td class="td-name">${escHtml(b.productName || prod?.name || b.productId)}</td>
    <td class="muted" style="font-size:.82rem">${escHtml(prod?.cat || "")}</td>
    <td class="muted">${fmtDate(b.prodDate)}</td>
    <td class="${days<90?"":"muted"}">${fmtDate(b.expiryDate)}</td>
    <td>
      <span class="days-chip badge ${ei.chipCls}">${days<0?"EXPIRED":days+"d"}</span>
    </td>
    <td><strong>${b.remainingQty}</strong></td>
    <td><span class="badge ${ei.chipCls}">${days<0?"Expired":days<30?"Critical":days<90?"Warning":"Safe"}</span></td>
    <td><div class="td-actions">
      ${days<90&&b.remainingQty>0?`<button class="btn btn-ghost-danger btn-sm" data-dispose-batch="${b.id}" data-pid="${b.productId}" data-code="${escHtml(b.lotCode)}" data-qty="${b.remainingQty}">Dispose</button>`:""}
      <button class="btn btn-ghost btn-sm" data-adjust-link>Adjust</button>
    </div></td>
  </tr>`;
    },
    {
      colspan: 9,
      empty: { title: "No batches match filters", hint: "Adjust the search or status filter." },
      after: wireExpiryActions,
    }
  );

}

/* Row actions for the expiry table, wired after each page is drawn. */
function wireExpiryActions(){
  const tbody = $("#expiry-tbody");
  tbody.querySelectorAll("[data-adjust-link]").forEach(btn=>{
    btn.addEventListener("click", ()=> navigate("inventory-manage","adjust"));
  });

  tbody.querySelectorAll("[data-dispose-batch]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const batchId = btn.dataset.disposeBatch;
      const code = btn.dataset.code;
      const pid  = btn.dataset.pid;
      const qty  = +btn.dataset.qty;
      const p    = getProduct(pid);
      openModal({
        title:"Dispose Batch",
        body:`<p>Dispose <strong>${qty}</strong> unit(s) from lot <strong>${escHtml(code)}</strong> of <strong>${escHtml(p?.name||pid)}</strong>?</p>
              <div class="field" style="margin-top:14px"><label>Reason</label>
              <textarea class="control" id="dispose-reason" rows="2" placeholder="e.g. Expired — past use-by date"></textarea>
              <span class="field-error" id="dispose-reason-err"></span></div>`,
        confirmLabel:"Dispose", confirmClass:"btn-ghost-danger",
        onConfirm: async ()=>{
          const reason = $("#dispose-reason").value.trim();
          if(!reason){ $("#dispose-reason-err").textContent="Reason required."; return; }
          /* No local stock edits; adjustStock() reloads from the API. */
          if(await adjustStock({ productId:pid, qty, type:"disposal", reason, batch:code })){
            closeModal();
            toast(`Disposed ${qty} unit(s) from ${code}.`,"warn");
            renderExpiry();
          }
        }
      });
    });
  });

  const se = $("#search-expiry"), fs = $("#filter-expiry-status"), so = $("#filter-expiry-sort");
  const resetAndRender = ()=>{ adminState.expiryPager.page = 1; renderExpiry(); };
  if(se && !se.dataset.wired){ se.dataset.wired="1"; se.addEventListener("input",  resetAndRender); }
  if(fs && !fs.dataset.wired){ fs.dataset.wired="1"; fs.addEventListener("change", resetAndRender); }
  if(so && !so.dataset.wired){ so.dataset.wired="1"; so.addEventListener("change", resetAndRender); }
}
