"use strict";

/* ============================================================
   INVENTORY MANAGEMENT + EXPIRATION MONITORING
   Ported from the former InventoryModule/inventory.js into the unified
   Super Admin portal. Reads/writes the canonical PRODUCTS and
   BATCHES arrays from engine.js (QA-rich batch schema) instead
   of maintaining a second, simpler batch dataset.
   ============================================================ */

/* Today, according to the server.

   Was: const INV_TODAY = "2026-06-17" — a date frozen in this file. Every
   "days left" chip, expiry warning and restock date default in the UI was
   measured from a clock that had stopped, so the figures drifted further from
   reality every day the project sat.

   api/batches/list.php reports its own CURDATE() in the response meta, which
   loadInventoryData() records. Falling back to the browser's date is a
   compromise (it trusts a clock the user can change) but it is strictly better
   than a constant, and it only applies before the first batch load. */
function invToday(){
  /* ymd() and not toISOString(): the latter is UTC, which in UTC+8 names
     yesterday for the first eight hours of every day. */
  return adminState.serverToday || ymd(new Date());
}

/* Kept as a name because ~10 call sites use it as a default date value. */
Object.defineProperty(window, "INV_TODAY", { get: invToday, configurable: true });

/* A default expiry for a lot being opened: one year out from today.
   The restock form had `value="2027-06-17"` written into it — the same frozen
   clock the comment above describes, surviving in the one field where a wrong
   date is not cosmetic but becomes a batch record. A year is a placeholder the
   operator is expected to correct, not a claim about shelf life; it is simply
   never in the past, which the constant eventually would have been. */
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

/* ============================================================
   STOCK ADJUSTMENTS LOG (seed data, folded from the former InventoryModule)
   ============================================================ */
/* Filled from api/inventory/adjustments.php by loadInventoryData(). */
/* Filled from api/inventory/adjustments.php by loadInventoryData(). Empty until then.
   Held mock rows until Phase 6. They were overwritten on every load, so
   they changed nothing at runtime — but a load that failed left the screen
   showing invented data that looked real. Empty is the honest starting
   state: a failed load now shows an empty table and its error toast. */
let ADJUSTMENTS = [];

/* Five mock disposal/return rows used to be pushed onto AUDIT_LOG here, at
   parse time. They are gone. The audit trail comes from api/audit/list.php via
   loadAdminData(), and appending invented rows to it meant the Audit Log showed
   five events that never happened — and showed them to roles whose own audit
   query would not have returned them. */

/* ============================================================
   DATA MUTATIONS
   ============================================================ */
/* ============================================================
   DATA MUTATIONS — all of these now go to the server.

   They used to add to p.stock and unshift a row onto an in-memory
   array, which looked identical on screen and survived exactly
   until the next refresh. Stock, the batch row and the audit entry
   are now written by api/inventory/adjust.php inside one
   transaction, and the local arrays are reloaded from the database
   afterwards rather than being guessed at.

   Each returns a boolean so existing callers keep working, but they
   are async now — callers must await them.
   ============================================================ */
/* `lotCode` is OPTIONAL and is a suggestion the operator may have edited. The
   form prefills it with the server's next code, so leaving it alone and
   clearing it both end up at the same place — passing nothing here makes
   Inventory::nextLotCode() assign one at save time.

   Callers used to pass "JBF-"+Date.now() when the field was blank, which is
   not a lot code, it is a timestamp wearing one. A blank field now means
   "assign it", which is why an empty string is never forwarded.

   THE EXPIRY DATE is what decides whether a lot is opened at all. With one,
   this restock records a new production run; without one it tops up stock
   already on the shelf and writes no batch row — still a legitimate restock.

   Returns the server's payload on success (truthy, so `if (await restock(…))`
   still reads correctly) so the caller can report the assigned code. */
async function restock(productId, qty, prodDate, expiryDate, lotCode){
  if(qty <= 0) return false;
  try {
    const body = { product_id: productId, qty, type: "restock",
                   reason: "Restocked via Inventory Management." };
    if(expiryDate){
      body.production_date = prodDate || invToday();
      body.expiry_date = expiryDate;
      /* Only when the operator actually supplied one. An empty field is not
         an empty lot code — it means "assign it", and sending "" would make
         the server validate a blank string instead of generating. */
      if(lotCode) body.batch_code = lotCode;
    }
    const { data } = await EbApi.post("inventory/adjust.php", body);
    await refreshInventory();
    return data || true;
  } catch(err){
    /* Field errors get shown against the form by the caller; anything else is
       a toast. Either way it is reported — a failed write that looks like a
       success is the worst outcome here. */
    if(err.isValidation) throw err;
    toast(err.message, "err");
    return false;
  }
}

/* Bulk replenishment. Sent one request per line rather than as a batch
   endpoint: each line is independently valid or not, and a single failure
   should not silently discard the rest. Failures are collected and reported
   together so the operator sees exactly which lines did not land. */
async function replenish(entries){
  const failed = [];
  for(const e of entries){
    if(e.qty <= 0) continue;
    try {
      /* No batch_code: each line opens its own lot and the server assigns the
         code, so fifteen of them never have to be typed or kept distinct by
         hand. Sending the dates is what opens the lot at all; without them
         this stays a plain top-up.

         One request per line means nextLotCode() runs per line and sees the
         lot the previous line just created, so the codes come out sequential
         and unique without the client doing arithmetic on them. */
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
    /* The sign is the server's decision, from `type`. This used to be computed
       here and applied to p.stock directly, which meant the browser decided
       whether stock went up or down. */
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

/* Re-read products and batches after any stock movement, so what is on screen
   is what is in the database rather than what the browser predicted. */
async function refreshInventory(){
  await loadCatalog();
  await loadInventoryData();
}

/* Archive and restore now go through products/archive.php, which refuses a
   double-archive, reports remaining stock, and writes the audit row itself.
   These used to flip p.archived in memory — the product reappeared on the next
   reload as if nothing had happened. */
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

/* ============================================================
   MODULE: INVENTORY MANAGEMENT
   ============================================================ */
function renderInventoryManage(tab="overview"){
  adminState.invTab = tab;

  /* THE REPORTED BUG. This screen switched its panel and never told the
     sidebar, so clicking Restock in the sidebar and then Replenish (Bulk) in
     the pill row left the highlight on Restock. The pill keys and the sidebar's
     data-tab values are already the same six strings, so nothing needs mapping.

     Called from the render rather than from the pill handler below on purpose:
     it then applies however the tab was reached — a pill, a sidebar click
     through navigate(), or one of the in-panel jumps ("Restock" on an overview
     row, "Archive" after archiving a product) that also change the tab and had
     the same silent disagreement.

     Deliberately NOT navigate("inventory-manage", tab) — navigate() scrolls
     #main-content to the top and closes the mobile sidebar, which is right when
     you are moving to another screen and wrong when you are switching tabs on
     the screen already in front of you: it would throw away your scroll
     position mid-form. syncNavHighlight() is the part that was missing; the
     rest of navigate() is not wanted here. (engine.js and inventory.js are
     classic scripts over the same globals, so this needs no wiring.) */
  syncNavHighlight("inventory-manage", tab);

  $$("#invmgmt-action-tabs .inv-action-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.tab===tab);
    btn.onclick = ()=> renderInventoryManage(btn.dataset.tab);
  });

  const container = $("#invmgmt-view-content");
  if(tab==="overview")  container.innerHTML = buildStockOverview();
  if(tab==="restock")   container.innerHTML = buildRestockForm();
  if(tab==="replenish") container.innerHTML = buildReplenishForm();
  if(tab==="adjust")    container.innerHTML = buildAdjustForm();
  if(tab==="adjlog")    container.innerHTML = buildAdjLog();
  if(tab==="archive")   container.innerHTML = buildArchiveView();

  wireInventoryManageView(tab, container);
}

/* Stock overview rows, from the API. The level filter is applied in the query
   rather than to a page, so "show me everything critical" means everything. */
function fillStockOverview(){
  return EbPaginate.list(
    "stock-ovw",
    adminState.stockOvwPager,
    () => document.getElementById("invmgmt-overview-tbody"),
    (page, limit) => EbApi.get("products/list.php", {
      page, limit, status: "all", sort: "name",
      search: adminState.invOverviewQuery || null,
      level: adminState.invOverviewLevel === "all" ? null : adminState.invOverviewLevel,
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
      after: () => {
        document.querySelectorAll("#invmgmt-overview-tbody [data-quick-restock]").forEach(btn=>{
          btn.addEventListener("click", ()=> renderInventoryManage("restock"));
        });
        document.querySelectorAll("#invmgmt-overview-tbody [data-quick-adjust]").forEach(btn=>{
          btn.addEventListener("click", ()=> renderInventoryManage("adjust"));
        });
      },
    }
  );
}

function buildStockOverview(){
  const q  = adminState.invOverviewQuery;
  const lv = adminState.invOverviewLevel;
  /* Shell only — fillStockOverview() draws the rows from the API after this
     markup is injected. */
  const rows = "";

  return `<div class="table-toolbar">
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
    <select class="filter-select" id="stock-ovw-page-size" aria-label="Rows per page">
      <option value="10">10 per page</option>
      <option value="25">25 per page</option>
      <option value="50">50 per page</option>
    </select>
  </div>
  <div class="table-wrap viewport-bound"><table class="data-table" id="invmgmt-overview-table">
    <thead><tr><th>Product</th><th>Category</th><th>Stock</th><th>Level</th><th>Batches</th><th>Actions</th></tr></thead>
    <tbody id="invmgmt-overview-tbody">${rows}</tbody>
  </table></div>
  <div class="table-toolbar" style="margin-top:14px">
    <span class="muted" id="stock-ovw-showing" style="font-size:.82rem"></span>
    <div class="pagination" id="stock-ovw-pagination" style="margin-left:auto"></div>
  </div>`;
}

function buildRestockForm(){
  const opts = PRODUCTS.filter(p=>!p.archived).map(p=>`<option value="${p.id}">${escHtml(p.name)} (${p.stock} in stock)</option>`).join("");
  return `<div class="panel" style="max-width:560px">
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
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label>Production Date</label>
          <input class="control" type="date" id="rs-prod" value="${INV_TODAY}"/>
        </div>
        <div class="field"><label>Expiry Date</label>
          <input class="control" type="date" id="rs-expiry" value="${defaultExpiry()}"/>
        </div>
      </div>
      <button type="submit" class="btn btn-gold">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        Restock
      </button>
    </form>
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
    <p style="font-size:.84rem;color:var(--text-muted);margin-bottom:14px">Check products, enter a quantity per line, then click Apply. The dates below apply to every line — each product opens its own lot, with a code assigned by the system. <strong>Leave the dates blank to top up existing stock without opening lots.</strong></p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:420px;margin-bottom:16px">
      <div class="field"><label>Production Date</label>
        <input class="control" type="date" id="rep-prod" value="${INV_TODAY}"/>
      </div>
      <div class="field"><label>Expiry Date</label>
        <input class="control" type="date" id="rep-expiry" value="${defaultExpiry()}"/>
        <span class="field-error" id="rep-expiry-err"></span>
      </div>
    </div>
    <div class="table-wrap"><table class="replenish-table">
      <thead><tr><th class="check-col"></th><th>Product</th><th>Current Stock</th><th>Add Qty</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function buildAdjustForm(){
  const opts = PRODUCTS.filter(p=>!p.archived).map(p=>`<option value="${p.id}">${escHtml(p.name)}</option>`).join("");
  return `<div class="panel" style="max-width:560px">
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
  </div>`;
}

/* Adjustment log — server-paged.

   Returns the table shell with an empty tbody; fillAdjLog() populates it after
   injection. The rows used to be baked into this string from a client-side
   slice of ADJUSTMENTS, which meant holding every stock movement ever recorded
   in memory to show ten of them. */
function buildAdjLog(){
  return `<div class="table-toolbar" style="justify-content:flex-end">
    <select class="filter-select" id="adj-log-page-size" aria-label="Rows per page">
      <option value="10">10 per page</option>
      <option value="25">25 per page</option>
      <option value="50">50 per page</option>
    </select>
  </div>
  <div class="table-wrap viewport-bound"><table class="data-table">
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

/* Archive rows, from the API. fillArchiveView() populates the shell below. */
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

/* Archive/restore buttons. Called after each page of rows is drawn. */
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
  return `<div class="table-toolbar" style="justify-content:flex-end">
    <select class="filter-select" id="archive-page-size" aria-label="Rows per page">
      <option value="10">10 per page</option>
      <option value="25">25 per page</option>
      <option value="50">50 per page</option>
    </select>
  </div>
  <div class="table-wrap viewport-bound"><table class="data-table">
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
    const filterSearch = container.querySelector("#search-invmgmt-overview");
    const filterLevel  = container.querySelector("#filter-invmgmt-overview-level");
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
    /* focus was lost anyway on every rebuild under the old show/hide
       approach too (attribute wasn't preserved) — re-focusing here just
       makes typing feel continuous now that a real re-render happens
       on each keystroke. */
    if(adminState.invOverviewQuery && filterSearch){
      filterSearch.focus();
      filterSearch.setSelectionRange(filterSearch.value.length, filterSearch.value.length);
    }
    container.querySelectorAll("[data-quick-restock]").forEach(btn=>{
      btn.addEventListener("click", ()=> renderInventoryManage("restock"));
    });
    container.querySelectorAll("[data-quick-adjust]").forEach(btn=>{
      btn.addEventListener("click", ()=> renderInventoryManage("adjust"));
    });

    fillStockOverview();
  }

  if(tab==="restock"){
    container.querySelector("#restock-form")?.addEventListener("submit", async e=>{
      e.preventDefault();
      const form      = e.target;
      const productId = container.querySelector("#rs-product").value;
      const qty       = +container.querySelector("#rs-qty").value;
      const lot       = container.querySelector("#rs-batch").value.trim();
      const prodDate  = container.querySelector("#rs-prod").value;
      const expiry    = container.querySelector("#rs-expiry").value;
      container.querySelector("#rs-qty-err").textContent = "";
      if(qty < 1){ container.querySelector("#rs-qty-err").textContent="Enter valid quantity."; return; }

      /* Disabled while in flight — this posts a stock movement, and a double
         click used to mean two of them. */
      const restore = EbUI.busy(form.querySelector("[type=submit]"), "Restocking…");
      try {
        const res = await restock(productId, qty, prodDate, expiry, lot);
        if(res){
          /* Read the new level back from the reloaded catalogue rather than
             adding qty locally — the server is what decides the total. */
          const p = getProduct(productId);
          /* Name the lot that was opened. The operator no longer chooses the
             code, so this message is the only place they learn it — and they
             need it to label the carton. */
          const lot = res && res.lotCode ? ` Lot ${res.lotCode} opened.` : "";
          toast(`Restocked ${p.name} +${qty} units. New stock: ${p.stock}.${lot}`, "ok");
          renderInventoryManage("restock");
        }
      } catch(err){
        if(err.isValidation) EbUI.showFieldErrors(form, err.fields);
        else toast(err.message, "err");
      } finally { restore(); }
    });
  }

  if(tab==="replenish"){
    container.querySelector("#rep-submit-btn")?.addEventListener("click", async (e)=>{
      const entries = [];
      /* Read once, applied to every line — these are the form's shared dates,
         not per-row values. Blank expiry means "top up, open no lots". */
      const prodDate   = container.querySelector("#rep-prod")?.value || "";
      const expiryDate = container.querySelector("#rep-expiry")?.value || "";
      const expErr     = container.querySelector("#rep-expiry-err");
      if(expErr) expErr.textContent = "";
      if(expiryDate && prodDate && expiryDate <= prodDate){
        if(expErr) expErr.textContent = "Expiry must be after the production date.";
        return;
      }
      container.querySelectorAll(".rep-check:checked").forEach(cb=>{
        const pid  = cb.dataset.pid;
        const qty  = +container.querySelector(`.rep-qty[data-pid="${pid}"]`)?.value||0;
        if(qty > 0) entries.push({ productId:pid, qty, prodDate, expiryDate });
      });
      if(!entries.length){ toast("No products selected or all quantities are 0.", "warn"); return; }
      const restore = EbUI.busy(e.currentTarget, "Replenishing…");
      try {
        /* Only claims success if every line landed; replenish() reports the
           failures itself. */
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

    /* The lot picker.
       --------------
       This was a free-text box marked "(optional)". Requiring a code without
       showing which codes exist would only move the problem: the person
       disposing expired stock would still have to leave for the Expiry Monitor,
       find the lot and type it back. The list is the point.

       Read from the BATCHES array engine.js already loads (limit 200, sorted by
       expiry) and refreshes after every movement, so there is no fetch here and
       the quantities cannot be staler than the last adjustment. */
    const batchSel  = container.querySelector("#adj-batch");
    const batchHint = container.querySelector("#adj-batch-hint");

    function paintLots(){
      const pid  = container.querySelector("#adj-product").value;
      const type = typeHidden.value;
      const p    = getProduct(pid);

      /* Disposal lists only lots that still hold something — there is nothing
         to discard from an empty one. A RETURN lists every lot, including
         emptied ones: a customer can return goods from a lot that has since
         sold out, and refusing that would make the return unrecordable. */
      const lots = BATCHES
        .filter(b => b.productId === pid)
        .filter(b => type === "disposal" ? b.remainingQty > 0 : true)
        .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));

      if(!lots.length){
        batchSel.innerHTML = `<option value="">No lots recorded for this product</option>`;
        batchSel.disabled = true;
        batchHint.textContent = type === "disposal"
          ? `No lot of ${p?.name || "this product"} has stock left to discard. Register one in Batch Tracking.`
          : `No lots recorded for ${p?.name || "this product"}. Register one in Batch Tracking.`;
        return;
      }

      batchSel.disabled = false;
      /* Expiry is shown for a DISPOSAL because that is the decision being made
         — which lot has gone off. A return is about the unit coming back, not
         its date, so the same list is shown without it rather than with a
         number nobody is acting on. */
      batchSel.innerHTML = lots.map(b => {
        const left = `${b.remainingQty} left`;
        const exp  = type === "disposal" ? ` · expires ${fmtDate(b.expiryDate)}` : "";
        return `<option value="${escHtml(b.lotCode)}">${escHtml(b.lotCode)} — ${left}${exp}</option>`;
      }).join("");
      batchHint.textContent = lots.length === 1
        ? "One lot on record for this product."
        : `${lots.length} lots, soonest expiry first.`;
    }

    container.querySelector("#adj-product")?.addEventListener("change", paintLots);

    typeDisposalBtn?.addEventListener("click", ()=>{
      typeHidden.value="disposal";
      typeDisposalBtn.classList.add("active","disposal"); typeDisposalBtn.classList.remove("return");
      typeReturnBtn.classList.remove("active","return");
      container.querySelector("[type='submit']").className="btn btn-red";
      paintLots();
    });
    typeReturnBtn?.addEventListener("click", ()=>{
      typeHidden.value="return";
      typeReturnBtn.classList.add("active","return"); typeReturnBtn.classList.remove("disposal");
      typeDisposalBtn.classList.remove("active","disposal");
      container.querySelector("[type='submit']").className="btn btn-ok";
      paintLots();
    });

    paintLots();
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
      /* The server enforces this too, and its check is the real one. Doing it
         here as well only saves a round trip on the case the picker already
         knows about — a product with no lots to offer. */
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
          renderInventoryManage("adjust");
        }
      } catch(err){
        if(err.isValidation) EbUI.showFieldErrors(form, err.fields);
        else toast(err.message, "err");
      } finally { restore(); }
    });
  }

  if(tab==="archive"){
    /* Rows arrive asynchronously now, so the buttons are wired by
       fillArchiveView's `after` hook rather than here — binding to the
       container before the rows exist would find nothing. */
    fillArchiveView();
  }

  if(tab==="adjlog"){
    /* EbPaginate.list wires its own controls, so the old client-side
       Paginate.render/wirePageSize pair is gone — leaving them would have
       overwritten the working controls with ones that slice a stale array. */
    fillAdjLog();
  }
}

/* ============================================================
   MODULE: EXPIRATION MONITORING
   ============================================================ */
/* Expiration Monitoring — server-paged.

   days_to_expiry comes from the endpoint, computed against the server's
   CURDATE() rather than the browser's clock. Search, status band and sort are
   all query parameters rather than operations on one page, so "soonest first"
   means soonest across every batch and "Expired" counts every expired lot —
   not just the ones that happened to land on the page you are looking at. */
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
          /* No local edit of batchObj.remainingQty here any more — that was a
             guess at what the server would do, and it disagreed with the
             database the moment anything else changed the batch. adjustStock()
             reloads both arrays from the API instead. */
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
