"use strict";

/* ===== SHIPPING RATES: distance zones and weight brackets, saved as a whole set by api/shipping/save.php (placed orders keep their fee; every check here is repeated on the server) ===== */

const shipState = { zones: [], weights: [], origin: "Dagupan City, Pangasinan", roadFactor: 1.3,
                    /* Arrival estimates and island/remote areas (migration 038). */
                    etaReady: false, packDays: 1, remote: [], destinations: [], holidays: [] };

/* Starting rate card (migration 021); Default loads it into the form without saving. */
const SHIP_DEFAULTS = {
  zones: [
    { name: "Zone 1", minKm: 0,   maxKm: 50,  baseFee: 60,  etaMinDays: 1, etaMaxDays: 2,  active: true },
    { name: "Zone 2", minKm: 51,  maxKm: 100, baseFee: 80,  etaMinDays: 2, etaMaxDays: 3,  active: true },
    { name: "Zone 3", minKm: 101, maxKm: 200, baseFee: 110, etaMinDays: 2, etaMaxDays: 4,  active: true },
    { name: "Zone 4", minKm: 201, maxKm: 300, baseFee: 140, etaMinDays: 3, etaMaxDays: 5,  active: true },
    { name: "Zone 5", minKm: 301, maxKm: 500, baseFee: 180, etaMinDays: 4, etaMaxDays: 7,  active: true },
    { name: "Zone 6", minKm: 501, maxKm: 700, baseFee: 230, etaMinDays: 5, etaMaxDays: 8,  active: true },
    { name: "Zone 7", minKm: 701, maxKm: "",  baseFee: 280, etaMinDays: 6, etaMaxDays: 10, active: true },
  ],
  weights: [
    { minKg: 0,     maxKg: 1,  fee: 0,   perKgAbove: 0,  active: true },
    { minKg: 1.01,  maxKg: 2,  fee: 20,  perKgAbove: 0,  active: true },
    { minKg: 2.01,  maxKg: 3,  fee: 40,  perKgAbove: 0,  active: true },
    { minKg: 3.01,  maxKg: 5,  fee: 70,  perKgAbove: 0,  active: true },
    { minKg: 5.01,  maxKg: 10, fee: 120, perKgAbove: 0,  active: true },
    { minKg: 10.01, maxKg: "", fee: 120, perKgAbove: 15, active: true },
  ],
};

/* Sensible ceilings, mirrored in api/shipping/save.php. */
const SHIP_LIMITS = { km: 5000, kg: 1000, fee: 10000, perKg: 1000, days: 60 };

const shipNum  = v => (v === null || v === undefined || v === "") ? "" : String(+(+v).toFixed(2));
const shipCopy = o => JSON.parse(JSON.stringify(o));

async function renderShipping(){
  const box = $("#shipping-content");
  if(!box) return;
  if(!hasPerm("shipping.manage")){
    box.innerHTML = `<div class="alert-empty"><strong>No access</strong>You do not have permission to manage shipping rates.</div>`;
    return;
  }
  box.innerHTML = EbUI.skeletonBlock(8);
  try {
    const { data } = await EbApi.get("shipping/rates.php", { all: 1 });
    if(!data.ready){
      box.innerHTML = `<div class="alert-empty"><strong>Shipping tables not installed</strong>Run db/migrations/021-shipping-fees.sql in phpMyAdmin, then reload.</div>`;
      return;
    }
    Object.assign(shipState, {
      zones: data.zones.map(z => ({ ...z, maxKm: z.maxKm ?? "" })),
      weights: data.weights.map(w => ({ ...w, maxKg: w.maxKg ?? "" })),
      origin: data.origin, roadFactor: data.roadFactor,
      etaReady: !!data.etaReady, packDays: data.packDays ?? 1,
      remote: (data.remoteAreas || []).map(r => ({ ...r, note: r.note || "" })),
      destinations: data.destinations || [],
      holidays: (data.holidays || []).map(h => ({ ...h })),
    });
  } catch(err){
    box.innerHTML = `<div class="state-cell state-error"><strong>Could not load shipping rates.</strong><br><small>${escHtml(err.message)}</small></div>`;
    return;
  }
  shipPaint();
}

/* Number cell with unit and min/max/step. */
function shipCell(k, v, { unit, pre = false, max, step = "0.01", placeholder = "", label }){
  return `<div class="ship-in${pre ? " is-pre" : ""}">
    ${pre ? `<span>${unit}</span>` : ""}
    <input class="control" data-k="${k}" type="number" inputmode="decimal" min="0" max="${max}" step="${step}"
           value="${shipNum(v)}" placeholder="${placeholder}" aria-label="${label}">
    ${pre ? "" : `<span>${unit}</span>`}
  </div>`;
}
function shipToggle(on){
  return `<label class="ship-switch" title="${on ? "Active — used in the fee" : "Off — ignored"}"><span class="switch">
    <input type="checkbox" data-k="active" role="switch" ${on ? "checked" : ""} aria-label="Active">
    <span class="switch-track"><span class="switch-thumb"></span></span></span></label>`;
}

function shipZoneRow(z, i, n){
  return `<tr data-zone-row="${i}" class="${z.active ? "" : "is-off"}">
    <td><span class="ship-idx">${i + 1}</span></td>
    <td><input class="control ship-name" data-k="name" maxlength="40" value="${escHtml(z.name)}" aria-label="Zone name"></td>
    <td>${shipCell("minKm", z.minKm, { unit: "km", max: SHIP_LIMITS.km, step: "1", label: "From km" })}</td>
    <td>${shipCell("maxKm", z.maxKm, { unit: "km", max: SHIP_LIMITS.km, step: "1", label: "To km", placeholder: i === n - 1 ? "and up" : "" })}</td>
    <td>${shipCell("baseFee", z.baseFee, { unit: "₱", pre: true, max: SHIP_LIMITS.fee, label: "Base fee" })}</td>
    ${shipState.etaReady ? `<td><div class="ship-days">${shipCell("etaMinDays", z.etaMinDays, { unit: "", max: SHIP_LIMITS.days, step: "1", label: "Fastest delivery, days" })}<span>–</span>${shipCell("etaMaxDays", z.etaMaxDays, { unit: "days", max: SHIP_LIMITS.days, step: "1", label: "Slowest delivery, days" })}</div></td>` : ""}
    <td class="ship-c">${shipToggle(z.active)}</td>
    <td class="ship-c"><button type="button" class="ship-del" data-del-zone="${i}" aria-label="Remove zone ${i + 1}" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></td>
  </tr>`;
}

function shipWeightRow(w, i, n){
  return `<tr data-weight-row="${i}" class="${w.active ? "" : "is-off"}">
    <td><span class="ship-idx">${i + 1}</span></td>
    <td>${shipCell("minKg", w.minKg, { unit: "kg", max: SHIP_LIMITS.kg, label: "From kg" })}</td>
    <td>${shipCell("maxKg", w.maxKg, { unit: "kg", max: SHIP_LIMITS.kg, label: "To kg", placeholder: i === n - 1 ? "and up" : "" })}</td>
    <td>${shipCell("fee", w.fee, { unit: "₱", pre: true, max: SHIP_LIMITS.fee, label: "Weight fee" })}</td>
    <td>${shipCell("perKgAbove", w.perKgAbove, { unit: "₱", pre: true, max: SHIP_LIMITS.perKg, label: "Extra per kg" })}</td>
    <td class="ship-c">${shipToggle(w.active)}</td>
    <td class="ship-c"><button type="button" class="ship-del" data-del-weight="${i}" aria-label="Remove bracket ${i + 1}" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></td>
  </tr>`;
}

/* One island / remote area: destination, extra fee, extra days, a note for the customer and a pause switch. */
function shipRemoteRow(r, i){
  const opts = shipState.destinations.map(d => `<option${d === r.destination ? " selected" : ""}>${escHtml(d)}</option>`).join("");
  return `<tr data-remote-row="${i}" class="${r.paused ? "is-paused" : ""}">
    <td><select class="control" data-k="destination" aria-label="Destination">${opts}</select></td>
    <td>${shipCell("extraFee", r.extraFee, { unit: "₱", pre: true, max: SHIP_LIMITS.fee, label: "Extra fee" })}</td>
    <td><div class="ship-days">${shipCell("extraMinDays", r.extraMinDays, { unit: "", max: SHIP_LIMITS.days, step: "1", label: "Extra days, fastest" })}<span>–</span>${shipCell("extraMaxDays", r.extraMaxDays, { unit: "days", max: SHIP_LIMITS.days, step: "1", label: "Extra days, slowest" })}</div></td>
    <td><input class="control" data-k="note" maxlength="255" value="${escHtml(r.note || "")}" placeholder="${r.paused ? "Why deliveries are paused (shown to customers)" : "Optional note for customers"}" aria-label="Note"></td>
    <td class="ship-c"><label class="ship-switch" title="Pause deliveries here"><span class="switch">
      <input type="checkbox" data-k="paused" role="switch" ${r.paused ? "checked" : ""} aria-label="Paused">
      <span class="switch-track"><span class="switch-thumb"></span></span></span></label></td>
    <td class="ship-c"><button type="button" class="ship-del" data-del-remote="${i}" aria-label="Remove ${escHtml(r.destination)}" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></td>
  </tr>`;
}

/* Holidays, upcoming first; past ones are kept in the list but folded away under the upcoming. */
function shipHolidayRows(){
  if(!shipState.holidays.length) return `<tr class="state-row"><td colspan="3" class="muted">No holidays listed — only Sundays are skipped.</td></tr>`;
  const today = (typeof lotToday === "function") ? lotToday() : new Date().toISOString().slice(0, 10);
  return shipState.holidays.map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.date < today) - (b.h.date < today) || String(a.h.date).localeCompare(String(b.h.date)))
    .map(({ h, i }) => `<tr data-holiday-row="${i}" class="${h.date && h.date < today ? "is-off" : ""}">
      <td><input class="control" type="date" data-k="date" value="${escHtml(h.date || "")}" aria-label="Holiday date"></td>
      <td><input class="control" data-k="name" maxlength="80" value="${escHtml(h.name || "")}" placeholder="e.g. Eid'l Fitr" aria-label="Holiday name"></td>
      <td class="ship-c"><button type="button" class="ship-del" data-del-holiday="${i}" aria-label="Remove holiday" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></td>
    </tr>`).join("");
}

/* Every rule a rate card must satisfy; returns [{table, row, key, msg}]. */
function shipValidate(){
  const errs = [];
  const add = (table, row, key, msg) => errs.push({ table, row, key, msg });
  const num = v => v === "" || v === null || v === undefined ? null : Number(v);

  const check = (rows, table, minK, maxK, lim, label) => {
    if(!rows.length) add(table, -1, null, `Add at least one ${label}.`);
    if(rows.length && !rows.some(r => r.active)) add(table, -1, null, `At least one ${label} must be active.`);
    rows.forEach((r, i) => {
      const lo = num(r[minK]), hi = num(r[maxK]);
      if(lo === null || !Number.isFinite(lo) || lo < 0) add(table, i, minK, `Row ${i + 1}: "From" must be 0 or more.`);
      else if(lo > lim) add(table, i, minK, `Row ${i + 1}: "From" cannot exceed ${lim.toLocaleString()}.`);
      if(hi === null){
        if(i !== rows.length - 1) add(table, i, maxK, `Row ${i + 1}: only the last row can be open-ended ("and up").`);
      } else if(!Number.isFinite(hi) || hi < 0) add(table, i, maxK, `Row ${i + 1}: "To" must be 0 or more.`);
      else if(hi > lim) add(table, i, maxK, `Row ${i + 1}: "To" cannot exceed ${lim.toLocaleString()}.`);
      else if(lo !== null && hi < lo) add(table, i, maxK, `Row ${i + 1}: "To" is below "From".`);
      if(i > 0){
        const prevHi = num(rows[i - 1][maxK]);
        if(prevHi !== null && lo !== null && lo <= prevHi) add(table, i, minK, `Row ${i + 1}: starts at ${lo}, inside row ${i} (up to ${prevHi}). Rows must go up without overlapping.`);
      }
    });
  };
  check(shipState.zones, "zones", "minKm", "maxKm", SHIP_LIMITS.km, "zone");
  check(shipState.weights, "weights", "minKg", "maxKg", SHIP_LIMITS.kg, "weight bracket");

  const names = new Set();
  shipState.zones.forEach((z, i) => {
    const n = String(z.name || "").trim();
    if(!n) add("zones", i, "name", `Row ${i + 1}: give the zone a name.`);
    else if(names.has(n.toLowerCase())) add("zones", i, "name", `Row ${i + 1}: "${n}" is used twice.`);
    names.add(n.toLowerCase());
    const f = num(z.baseFee);
    if(f === null || !Number.isFinite(f) || f < 0 || f > SHIP_LIMITS.fee) add("zones", i, "baseFee", `Row ${i + 1}: base fee must be ₱0 – ₱${SHIP_LIMITS.fee.toLocaleString()}.`);
    if(shipState.etaReady){
      const a = num(z.etaMinDays), b = num(z.etaMaxDays);
      if(a === null || a < 1 || a > SHIP_LIMITS.days) add("zones", i, "etaMinDays", `Row ${i + 1}: delivery days must be 1 – ${SHIP_LIMITS.days}.`);
      else if(b === null || b < a || b > SHIP_LIMITS.days) add("zones", i, "etaMaxDays", `Row ${i + 1}: the longest delivery time must be at least the shortest.`);
    }
  });
  if(shipState.etaReady){
    const seenH = new Set();
    shipState.holidays.forEach((h, i) => {
      if(!h.date) add("holidays", i, "date", `Holiday ${i + 1}: pick a date.`);
      else if(seenH.has(h.date)) add("holidays", i, "date", `Holiday ${i + 1}: ${h.date} is listed twice.`);
      seenH.add(h.date);
      if(!String(h.name || "").trim()) add("holidays", i, "name", `Holiday ${i + 1}: give it a name.`);
    });
    const pd = num(shipState.packDays);
    if(pd === null || pd < 0 || pd > 14) add("remote", -1, null, "Packing time must be 0 – 14 days.");
    const seen = new Set();
    shipState.remote.forEach((r, i) => {
      if(seen.has(r.destination)) add("remote", i, "destination", `Row ${i + 1}: ${r.destination} is listed twice.`);
      seen.add(r.destination);
      const f = num(r.extraFee), a = num(r.extraMinDays), b = num(r.extraMaxDays);
      if(f === null || f < 0 || f > SHIP_LIMITS.fee) add("remote", i, "extraFee", `Row ${i + 1}: extra fee must be ₱0 – ₱${SHIP_LIMITS.fee.toLocaleString()}.`);
      if(a === null || a < 0 || a > SHIP_LIMITS.days) add("remote", i, "extraMinDays", `Row ${i + 1}: extra days must be 0 – ${SHIP_LIMITS.days}.`);
      else if(b === null || b < a || b > SHIP_LIMITS.days) add("remote", i, "extraMaxDays", `Row ${i + 1}: the longest extra time must be at least the shortest.`);
    });
  }
  shipState.weights.forEach((w, i) => {
    const f = num(w.fee), p = num(w.perKgAbove) ?? 0;
    if(f === null || !Number.isFinite(f) || f < 0 || f > SHIP_LIMITS.fee) add("weights", i, "fee", `Row ${i + 1}: fee must be ₱0 – ₱${SHIP_LIMITS.fee.toLocaleString()}.`);
    if(!Number.isFinite(p) || p < 0 || p > SHIP_LIMITS.perKg) add("weights", i, "perKgAbove", `Row ${i + 1}: extra per kg must be ₱0 – ₱${SHIP_LIMITS.perKg.toLocaleString()}.`);
  });
  return errs;
}

function shipShowErrors(errs){
  $$("#shipping-content .is-invalid").forEach(el => el.classList.remove("is-invalid"));
  ["zones", "weights", "remote", "holidays"].forEach(t => {
    const box = $(`#ship-err-${t}`);
    const mine = errs.filter(e => e.table === t);
    if(box){ box.innerHTML = mine.map(e => `<li>${escHtml(e.msg)}</li>`).join(""); box.hidden = !mine.length; }
    mine.forEach(e => {
      if(e.row < 0 || !e.key) return;
      const tr = $(`[data-${t === "zones" ? "zone" : t === "remote" ? "remote" : t === "holidays" ? "holiday" : "weight"}-row="${e.row}"]`);
      tr?.querySelector(`[data-k="${e.key}"]`)?.classList.add("is-invalid");
    });
  });
}

function shipPaint(){
  const box = $("#shipping-content");
  const zN = shipState.zones.length, wN = shipState.weights.length;
  const icPin = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>`;
  const icBox = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>`;
  const icCalc = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 11h2M14 11h2M8 15h2M14 15h2M8 19h2M14 19h2"/></svg>`;
  box.innerHTML = `
    <div class="ship-summary">
      <div class="ship-stat"><span>Ships from</span><b>${escHtml(shipState.origin)}</b></div>
      <div class="ship-stat"><span>Active zones</span><b>${shipState.zones.filter(z => z.active).length} of ${zN}</b></div>
      <div class="ship-stat"><span>Active weight brackets</span><b>${shipState.weights.filter(w => w.active).length} of ${wN}</b></div>
      <div class="ship-stat ship-formula"><span>Estimated Delivery Fee</span><b>Zone base fee + Weight fee${shipState.etaReady ? " (+ remote-area fee)" : ""}</b></div>
      ${shipState.etaReady ? `<div class="ship-stat ship-formula"><span>Estimated Arrival</span><b>Packing time + zone days (+ remote days), Mon–Sat, no holidays</b></div>` : ""}
    </div>

    <section class="panel ship-card">
      <header class="ship-card-head">
        <span class="ship-ic" aria-hidden="true">${icPin}</span>
        <div class="ship-head-txt"><h3 class="panel-title">Distance zones</h3>
          <p class="ship-sub">Road distance is estimated from ${escHtml(shipState.origin)} (straight line × ${shipState.roadFactor}). Anything beyond the last zone is charged as the last zone.${shipState.etaReady ? " Delivery days count Monday to Saturday, skipping the holidays listed below." : ""}</p>
          ${shipState.etaReady ? `<label class="ship-pack">Packing time before the courier picks it up ${shipCell("packDays", shipState.packDays, { unit: "days", max: 14, step: "1", label: "Packing time in days" }).replace('data-k="packDays"', 'id="ship-pack-days"')}</label>` : ""}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="ship-add-zone">+ Add zone</button>
      </header>
      <div class="table-wrap"><table class="data-table ship-table">
        <thead><tr><th style="width:44px">#</th><th>Zone name</th><th>From</th><th>To</th><th>Base fee</th>${shipState.etaReady ? "<th>Delivery days</th>" : ""}<th class="ship-c">Active</th><th class="ship-c"></th></tr></thead>
        <tbody id="ship-zones">${shipState.zones.map((z, i) => shipZoneRow(z, i, zN)).join("")}</tbody>
      </table></div>
      <ul class="ship-errs" id="ship-err-zones" hidden></ul>
    </section>

    <section class="panel ship-card">
      <header class="ship-card-head">
        <span class="ship-ic" aria-hidden="true">${icBox}</span>
        <div class="ship-head-txt"><h3 class="panel-title">Weight fees</h3>
          <p class="ship-sub">Weight = quantity × each product's net weight. "Extra per kg" adds that amount for every started kilo above the row's "From".</p></div>
        <button type="button" class="btn btn-ghost btn-sm" id="ship-add-weight">+ Add bracket</button>
      </header>
      <div class="table-wrap"><table class="data-table ship-table">
        <thead><tr><th style="width:44px">#</th><th>From</th><th>To</th><th>Fee</th><th>Extra per kg</th><th class="ship-c">Active</th><th class="ship-c"></th></tr></thead>
        <tbody id="ship-weights">${shipState.weights.map((w, i) => shipWeightRow(w, i, wN)).join("")}</tbody>
      </table></div>
      <ul class="ship-errs" id="ship-err-weights" hidden></ul>
    </section>

    ${shipState.etaReady ? `<section class="panel ship-card">
      <header class="ship-card-head">
        <span class="ship-ic" aria-hidden="true">${icPin}</span>
        <div class="ship-head-txt"><h3 class="panel-title">Island &amp; remote areas</h3>
          <p class="ship-sub">Places reached by boat or plane (e.g. Batanes) cost more and take longer than their distance suggests. Each one adds its extra fee and days on top of the zone, and customers are told it may take longer. Switch on <strong>Paused</strong> to stop deliveries there for now (e.g. during a typhoon) — checkout then refuses delivery to that area with your note.</p></div>
        <button type="button" class="btn btn-ghost btn-sm" id="ship-add-remote">+ Add area</button>
      </header>
      <div class="table-wrap"><table class="data-table ship-table ship-remote-table">
        <thead><tr><th>Destination</th><th>Extra fee</th><th>Extra days</th><th>Note for customers</th><th class="ship-c">Paused</th><th class="ship-c"></th></tr></thead>
        <tbody id="ship-remote">${shipState.remote.length ? shipState.remote.map((r, i) => shipRemoteRow(r, i)).join("") : `<tr class="state-row"><td colspan="6" class="muted">No remote areas — every destination uses its distance zone only.</td></tr>`}</tbody>
      </table></div>
      <ul class="ship-errs" id="ship-err-remote" hidden></ul>
    </section>` : ""}

    ${shipState.etaReady ? `<section class="panel ship-card">
      <header class="ship-card-head">
        <span class="ship-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></span>
        <div class="ship-head-txt"><h3 class="panel-title">Holidays (no deliveries)</h3>
          <p class="ship-sub">The courier neither picks up nor delivers on these days, so arrival estimates skip them like Sundays. Add holidays such as Eid'l Fitr and Eid'l Adha once they are proclaimed, and any special non-working days.</p></div>
        <button type="button" class="btn btn-ghost btn-sm" id="ship-add-holiday">+ Add holiday</button>
      </header>
      <div class="table-wrap"><table class="data-table ship-table ship-hol-table">
        <thead><tr><th>Date</th><th>Holiday</th><th class="ship-c"></th></tr></thead>
        <tbody id="ship-holidays">${shipHolidayRows()}</tbody>
      </table></div>
      <ul class="ship-errs" id="ship-err-holidays" hidden></ul>
    </section>` : ""}

    <section class="panel ship-card ship-try">
      <header class="ship-card-head">
        <span class="ship-ic" aria-hidden="true">${icCalc}</span>
        <div class="ship-head-txt"><h3 class="panel-title">Try it</h3></div>
      </header>
      <div class="ship-try-row">
        <div class="field"><label for="ship-try-dest">Destination</label><select class="control" id="ship-try-dest" data-dropup></select></div>
        <div class="field"><label for="ship-try-kg">Weight</label>${shipCell("try", 2.06, { unit: "kg", max: SHIP_LIMITS.kg, label: "Weight in kg" }).replace('data-k="try"', 'id="ship-try-kg"')}</div>
        <div class="ship-try-out" id="ship-try-out"></div>
      </div>
    </section>
`;

  /* Default and Save live in the page header; the pill appears once something changes. */
  const head = $("#ship-head-actions");
  if(head) head.innerHTML = `
    <span class="ship-dirty" id="ship-note" hidden>Unsaved changes</span>
    <button type="button" class="btn btn-ghost" id="ship-default" title="Load the original rate card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
      Default
    </button>
    <button class="btn btn-gold" id="ship-save" title="Changes apply to orders placed after saving. Placed orders keep their fee.">Save rates</button>`;

  /* Row edits go straight into shipState so Add/Remove/Default re-paints keep them. */
  const read = () => {
    $$("#ship-zones [data-zone-row]").forEach(tr => {
      const z = shipState.zones[+tr.dataset.zoneRow];
      tr.querySelectorAll("[data-k]").forEach(el => { z[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim(); });
    });
    $$("#ship-weights [data-weight-row]").forEach(tr => {
      const w = shipState.weights[+tr.dataset.weightRow];
      tr.querySelectorAll("[data-k]").forEach(el => { w[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim(); });
    });
    $$("#ship-remote [data-remote-row]").forEach(tr => {
      const r = shipState.remote[+tr.dataset.remoteRow];
      tr.querySelectorAll("[data-k]").forEach(el => { r[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim(); });
    });
    $$("#ship-holidays [data-holiday-row]").forEach(tr => {
      const h = shipState.holidays[+tr.dataset.holidayRow];
      tr.querySelectorAll("[data-k]").forEach(el => { h[el.dataset.k] = el.value.trim(); });
    });
    const pd = $("#ship-pack-days"); if(pd) shipState.packDays = pd.value.trim();
  };
  const dirty = () => { const n = $("#ship-note"); if(n) n.hidden = false; };
  const recheck = () => { read(); shipShowErrors(shipValidate()); };

  /* No minus sign, no exponent: "-5" and "1e9" never reach a number box. */
  box.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.addEventListener("keydown", e => { if(["-", "+", "e", "E"].includes(e.key)) e.preventDefault(); });
    inp.addEventListener("paste", e => {
      const t = (e.clipboardData?.getData("text") || "").trim();
      if(!/^\d*\.?\d*$/.test(t)){ e.preventDefault(); toast("Only positive numbers can be pasted here.", "warn"); }
    });
    inp.addEventListener("blur", () => {
      if(inp.value === "") return;
      let v = Number(inp.value), max = Number(inp.max);
      if(!Number.isFinite(v) || v < 0) v = 0;
      if(Number.isFinite(max) && v > max) v = max;
      if(inp.step === "1") v = Math.round(v);
      inp.value = shipNum(v);
      if(inp.dataset.k) recheck();
    });
  });

  box.querySelectorAll(".ship-table").forEach(t => {
    t.addEventListener("input", dirty);
    t.addEventListener("change", e => {
      if(e.target.dataset.k === "active") e.target.closest("tr").classList.toggle("is-off", !e.target.checked);
      if(e.target.dataset.k === "paused") e.target.closest("tr").classList.toggle("is-paused", e.target.checked);
      dirty(); recheck();
    });
  });
  $("#ship-add-zone").onclick = () => {
    read();
    const last = shipState.zones[shipState.zones.length - 1];
    /* A new zone starts after the last one, which stops being open-ended. */
    let from = 0;
    if(last){
      if(last.maxKm === "" || last.maxKm == null) last.maxKm = Math.min(SHIP_LIMITS.km - 1, Math.max(+last.minKm || 0, (+last.minKm || 0) + 99));
      from = +last.maxKm + 1;
    }
    shipState.zones.push({ name: `Zone ${shipState.zones.length + 1}`, minKm: Math.min(from, SHIP_LIMITS.km), maxKm: "", baseFee: last ? +last.baseFee || 0 : 0,
      etaMinDays: last ? +last.etaMinDays || 1 : 1, etaMaxDays: last ? +last.etaMaxDays || 3 : 3, active: true });
    shipPaint(); dirty();
  };
  $("#ship-add-weight").onclick = () => {
    read();
    const last = shipState.weights[shipState.weights.length - 1];
    let from = 0;
    if(last){
      if(last.maxKg === "" || last.maxKg == null) last.maxKg = Math.min(SHIP_LIMITS.kg - 1, (+last.minKg || 0) + 5);
      from = +(+last.maxKg + 0.01).toFixed(2);
    }
    shipState.weights.push({ minKg: Math.min(from, SHIP_LIMITS.kg), maxKg: "", fee: last ? +last.fee || 0 : 0, perKgAbove: 0, active: true });
    shipPaint(); dirty();
  };
  box.querySelectorAll("[data-del-zone]").forEach(b => b.onclick = () => { read(); shipState.zones.splice(+b.dataset.delZone, 1); shipPaint(); dirty(); recheck(); });
  box.querySelectorAll("[data-del-weight]").forEach(b => b.onclick = () => { read(); shipState.weights.splice(+b.dataset.delWeight, 1); shipPaint(); dirty(); recheck(); });
  box.querySelectorAll("[data-del-remote]").forEach(b => b.onclick = () => { read(); shipState.remote.splice(+b.dataset.delRemote, 1); shipPaint(); dirty(); recheck(); });
  $("#ship-pack-days")?.addEventListener("input", dirty);
  box.querySelectorAll("[data-del-holiday]").forEach(b => b.onclick = () => { read(); shipState.holidays.splice(+b.dataset.delHoliday, 1); shipPaint(); dirty(); recheck(); });
  const addHol = $("#ship-add-holiday");
  if(addHol) addHol.onclick = () => { read(); shipState.holidays.push({ date: "", name: "" }); shipPaint(); dirty(); };
  const addRemote = $("#ship-add-remote");
  if(addRemote) addRemote.onclick = () => {
    read();
    const used = new Set(shipState.remote.map(r => r.destination));
    const first = shipState.destinations.find(d => !used.has(d));
    if(!first){ toast("Every destination is already listed.", "warn"); return; }
    shipState.remote.push({ destination: first, extraFee: 150, extraMinDays: 3, extraMaxDays: 7, paused: false, note: "" });
    shipPaint(); dirty();
  };

  $("#ship-default").onclick = () => {
    shipState.zones = shipCopy(SHIP_DEFAULTS.zones);
    shipState.weights = shipCopy(SHIP_DEFAULTS.weights);
    shipPaint(); dirty();
    toast("Default rates loaded — click Save rates to keep them.", "ok");
  };

  $("#ship-save").onclick = async e => {
    read();
    const errs = shipValidate();
    shipShowErrors(errs);
    if(errs.length){
      toast(errs[0].msg, "err");
      box.querySelector(".is-invalid, .ship-errs:not([hidden])")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const restore = EbUI.busy(e.currentTarget, "Saving…");
    try {
      await EbApi.post("shipping/save.php", {
        zones: shipState.zones.map(z => ({ name: String(z.name).trim(), minKm: z.minKm, maxKm: z.maxKm === "" ? null : z.maxKm, baseFee: z.baseFee, active: !!z.active, etaMinDays: z.etaMinDays, etaMaxDays: z.etaMaxDays })),
        weights: shipState.weights.map(w => ({ minKg: w.minKg, maxKg: w.maxKg === "" ? null : w.maxKg, fee: w.fee, perKgAbove: w.perKgAbove || 0, active: !!w.active })),
        ...(shipState.etaReady ? {
          packDays: shipState.packDays,
          holidays: shipState.holidays.map(h => ({ date: h.date, name: String(h.name || "").trim() })),
          remoteAreas: shipState.remote.map(r => ({ destination: r.destination, extraFee: r.extraFee, extraMinDays: r.extraMinDays, extraMaxDays: r.extraMaxDays, paused: !!r.paused, note: r.note || "" })),
        } : {}),
      });
      toast("Shipping rates saved.", "ok");
      await renderShipping();
    } catch(err){
      toast(err.fields ? Object.values(err.fields)[0] : err.message, "err");
    } finally { restore(); }
  };

  /* Try it: the server's own calculation from the saved rates. */
  EbApi.get("shipping/rates.php").then(({ data }) => {
    const sel = $("#ship-try-dest"); if(!sel) return;
    sel.innerHTML = data.destinations.map(d => `<option${d === "Metro Manila" ? " selected" : ""}>${escHtml(d)}</option>`).join("");
    if(window.EbSelect) EbSelect.sync(sel);
    const run = async () => {
      const out = $("#ship-try-out"); if(!out) return;
      const kg = Math.min(SHIP_LIMITS.kg, Math.max(0, Number($("#ship-try-kg").value) || 0));
      try {
        const { data: q } = await EbApi.get("shipping/estimate.php", { destination: sel.value, kg });
        out.innerHTML = `<div><span>Distance</span><b>${q.distanceKm != null ? Math.round(q.distanceKm).toLocaleString() + " km" : "—"}</b></div>
          <div><span>Zone</span><b>${escHtml(q.zone || "—")}</b></div>
          <div><span>Base + weight</span><b>${EbFormat.pesoExact(q.zoneFee)} + ${EbFormat.pesoExact(q.weightFee)}</b></div>
          ${q.remote ? `<div><span>Remote area${q.remote.paused ? " — PAUSED" : ""}</span><b>+ ${EbFormat.pesoExact(q.remoteFee)}</b></div>` : ""}
          <div class="ship-try-fee"><span>Estimated Delivery Fee</span><b>${EbFormat.pesoExact(q.fee)}</b></div>
          ${q.eta ? `<div class="ship-try-fee"><span>Estimated Arrival (if ordered today)</span><b>${escHtml(etaText(q.eta))}</b></div>` : ""}`;
      } catch(err){ out.textContent = err.message; }
    };
    sel.addEventListener("change", run);
    $("#ship-try-kg").addEventListener("input", debounce(run, 250));
    run();
  }).catch(()=>{});
}
