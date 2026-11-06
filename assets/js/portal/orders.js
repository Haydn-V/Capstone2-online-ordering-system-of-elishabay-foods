"use strict";
/* ===== ONLINE ORDERS: Notifications, Transactions, Queue, Payment Verification, Order Status, History, Receipts, Returns (uses engine.js helpers and globals) ===== */

/* The duplicate orderTotal() was removed (it recursed forever); engine.js's version is used. */

/* Mount a screen's control (like rows per page) into its toolbar row, replacing that screen's previous slot. */
function mountToolbarControl(modId, slotName, html){
  const row = document.querySelector(`#mod-${modId} .view-toolbar`);
  if(!row){ return null; }                 /* screen has no merged row — leave it be */
  /* Mount into the filter group on tabbed screens, or directly into the row otherwise. */
  let group = row.classList.contains("view-toolbar-filters")
    ? row
    : row.querySelector(".view-toolbar-filters");
  if(!group){
    group = document.createElement("div");
    group.className = "view-toolbar-filters";
    row.appendChild(group);
  }
  /* Remove other tabs' slots so each tab shows only its own controls. */
  group.querySelectorAll("[data-slot]").forEach(el => {
    if(el.dataset.slot !== slotName) el.remove();
  });

  let slot = group.querySelector(`[data-slot="${slotName}"]`);
  if(!slot){
    slot = document.createElement("span");
    slot.dataset.slot = slotName;
    slot.style.display = "contents";
    group.appendChild(slot);
  }
  slot.innerHTML = html;
  return slot;
}

function statusChip(status){
  return `<span class="status-chip status-${status}"><span class="status-dot ${status}"></span>${STATUS_LABEL[status] || status}</span>`;
}

/* Table status badges reuse the status chip so status looks the same everywhere. */
function orderStatusBadge(status){
  return statusChip(status);
}

function emptyState(h, p){
  return `<div class="orders-empty">
    <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>
    <h3>${h}</h3>${p ? `<p>${p}</p>` : ""}</div>`;
}

function nowStamp(){
  return dAgo(0) + " " + new Date().toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit",hour12:false});
}

/* ===== NOTIFICATIONS ===== */

/* ===== NOTIFICATION SCOPING: NOTIF_PERM maps each type to the permission needed to see it, and buildDerivedNotifications() creates Cashier/Inventory alerts from live records ===== */
const NOTIF_PERM = {
  "new-order":     "orders.view",
  "payment":       "orders.accept",
  "hold":          "orders.status",
  "completed":     "orders.status",
  "return":        "orders.returns",
  "inventory":     "inventory.report",
  "expiry":        "inventory.manage",
  "batch-qa":      "batches.manage",
  "scheme-due":    "payments.manage",
  "sales-summary": "sales.report",
  "audit":         "audit.view",
  /* Low-rating alerts are only for roles with reviews.moderate. */
  "review":        "reviews.moderate",
};

/* ===== NOTIFICATION URGENCY: stored rows carry their level from api/core/Notify.php; this fallback table only levels browser-derived alerts until the server's map loads (PHP wins if they differ) ===== */
const NOTIF_LEVELS = ["critical", "warning", "info"];

const NOTIF_PRIORITY_FALLBACK = {
  "inventory":     "critical",
  "new-order":     "warning",
  "payment":       "warning",
  "hold":          "warning",
  "return":        "warning",
  "completed":     "info",
  "audit":         "info",
  "review":        "warning",
  "expiry":        "warning",
  "batch-qa":      "warning",
  "scheme-due":    "warning",
  "sales-summary": "info",
};

/* Replaced by the server's copy on first load (see loadOpsData()). */
let NOTIF_PRIORITY_MAP = { ...NOTIF_PRIORITY_FALLBACK };

/* Each level has a label and icon as well as a colour. */
const NOTIF_LEVEL_META = {
  critical: {
    label: "Critical",
    icon: `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 2a1 1 0 01.894.553l7 14A1 1 0 0117 18H3a1 1 0 01-.894-1.447l7-14A1 1 0 0110 2zm0 5a1 1 0 00-1 1v3a1 1 0 002 0V8a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd"/></svg>`,
  },
  warning: {
    label: "Warning",
    icon: `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`,
  },
  info: {
    label: "Info",
    icon: `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>`,
  },
};

/* A stored level wins; a derived row falls back to its type. */
function notifPriority(n){
  if(n && n.priority && NOTIF_LEVEL_META[n.priority]) return n.priority;
  return NOTIF_PRIORITY_MAP[n && n.type] || "info";
}

function notifLevelChip(n){
  const level = notifPriority(n);
  const meta  = NOTIF_LEVEL_META[level] || NOTIF_LEVEL_META.info;
  /* The level word is visible inside the pill. */
  return `<span class="notif-level notif-level-${level}">${meta.icon}${meta.label}</span>`;
}

/* Sort unread first, then urgency, then newest, mirroring Notify::orderBy() so merged lists stay in order. */
function sortByUrgency(list){
  return [...list].sort((a,b)=>{
    if(a.read !== b.read) return a.read ? 1 : -1;
    const d = NOTIF_LEVELS.indexOf(notifPriority(a)) - NOTIF_LEVELS.indexOf(notifPriority(b));
    if(d !== 0) return d;
    return a.time > b.time ? -1 : a.time < b.time ? 1 : 0;
  });
}

/* Derived alerts are built lazily and rebuilt on new audit activity; NOTIF_READ remembers which were read. */
let DERIVED_NOTIFS = null;
const NOTIF_READ = new Set();
/* Only audit rows from this session count as unread. */
const LIVE_AUDIT_IDS = new Set();

function buildDerivedNotifications(){
  const out = [];

  /* --- Cashier: retailer payment schemes coming due or overdue --- */
  if(typeof PAYMENT_ACCOUNTS !== "undefined"){
    PAYMENT_ACCOUNTS.forEach(function(acct){
      if(acct.paid) return;
      const overdue = typeof isOverdue === "function" && isOverdue(acct);
      const days = Math.round(
        (new Date(acct.dueDate + "T00:00:00") - new Date(TODAY_ISO())) / 86400000);
      if(overdue){
        /* An overdue payment is Critical (one coming due is not). */
        out.push({ id:"nd-sch-"+acct.id, type:"scheme-due", priority:"critical",
          accountId:acct.id, read:false,
          time: acct.dueDate + " 08:00",
          msg: acct.name + " is overdue on " + acct.scheme + " — " + peso(acct.remaining ?? acct.balance) +
               " outstanding since " + fmtDate(acct.dueDate) });
      } else if(days >= 0 && days <= 14){
        out.push({ id:"nd-sch-"+acct.id, type:"scheme-due", accountId:acct.id, read:true,
          time: acct.dueDate + " 08:00",
          msg: acct.name + " — " + acct.scheme + " of " + peso(acct.remaining ?? acct.balance) +
               " due in " + days + " day" + (days === 1 ? "" : "s") });
      }
    });
  }

  /* --- Inventory: QA lab results and batches nearing expiry --- */
  if(typeof BATCHES !== "undefined"){
    BATCHES.forEach(function(b){
      const prod = typeof getProduct === "function" ? getProduct(b.productId) : null;
      const name = prod ? prod.name : b.productId;

      if(b.labStatus === "failed"){
        /* A failed QA lot is Critical. */
        out.push({ id:"nd-qa-"+b.id, type:"batch-qa", priority:"critical", batchId:b.id, read:false,
          time: b.prodDate + " 09:00",
          msg: "Batch " + b.lotCode + " (" + name + ") FAILED lab testing — pulled from sale" });
      } else if(b.labStatus === "pending"){
        out.push({ id:"nd-qa-"+b.id, type:"batch-qa", batchId:b.id, read:true,
          time: b.prodDate + " 09:00",
          msg: "Batch " + b.lotCode + " (" + name + ") is awaiting lab results" });
      }

      /* Expired lots are stored server-side (Notify::syncExpiredBatches()); only the upcoming-expiry warning is derived here. */
      if(typeof daysUntilExpiry === "function" && b.remainingQty > 0){
        const d = daysUntilExpiry(b.expiryDate);
        if(d >= 0 && d <= 90){
          out.push({ id:"nd-exp-"+b.id, type:"expiry", batchId:b.id, productId:b.productId,
            read: d > 30,
            time: b.expiryDate + " 07:00",
            msg: "Batch " + b.lotCode + " (" + name + ") expires in " + d + " days — " + b.remainingQty + " units left" });
        }
      }
    });
  }

  /* Cashier: yesterday's walk-in takings. */
  if(typeof ORDERS !== "undefined"){
    const day = ORDERS.filter(o => o.type === "walk-in" && o.date === TODAY_ISO());
    if(day.length){
      const total = day.reduce((s,o)=> s + (typeof orderTotal === "function" ? orderTotal(o) : (o.total||0)), 0);
      out.push({ id:"nd-sales-today", type:"sales-summary", read:true,
        time: TODAY_ISO() + " 17:00",
        msg: "Walk-in sales today: " + day.length + " transaction" + (day.length === 1 ? "" : "s") +
             " totalling " + peso(total) });
    }
  }

  /* Inventory: restock, replenish, adjustment and archive activity from the audit log. */
  if(typeof AUDIT_LOG !== "undefined"){
    AUDIT_LOG.forEach(function(entry){
      if(auditIsInventoryActivity(entry)){
        out.push(auditToNotification(entry, LIVE_AUDIT_IDS.has(entry.id)));
      }
    });
  }

  return out;
}


/* All inventory activity goes through addAuditEntry(), so one hook matches it by audit type and wording. */
const AUDIT_NOTIF_RULES = [
  { type:"restock",   match:/^Replenish \(bulk\)/i,          kind:"replenish" },
  { type:"restock",   match:null,                            kind:"restock"   },
  { type:"product",   match:/^(Archived|Restored) product/i, kind:"archive"   },
  { type:"product",   match:/^(Disposal|Return) ·/i,         kind:"adjust"    },
  { type:"inventory", match:null,                            kind:"inventory" },
];

/* kind only changes the icon; the type stays "audit". */
function auditKind(entry){
  const rule = AUDIT_NOTIF_RULES.find(function(r){
    return r.type === entry.type && (!r.match || r.match.test(entry.desc || ""));
  });
  return rule ? rule.kind : null;
}

function auditIsInventoryActivity(entry){
  return !!entry && auditKind(entry) !== null;
}

function auditToNotification(entry, unread){
  return {
    id: "nd-aud-" + entry.id,
    type: "audit",
    kind: auditKind(entry),
    read: !unread,
    time: entry.ts,
    msg: entry.desc + (entry.actor ? "  ·  " + entry.actor : ""),
  };
}

/* Wrap addAuditEntry so inventory activity raises a notification immediately. */
if(typeof addAuditEntry === "function"){
  const _addAuditEntry = addAuditEntry;
  addAuditEntry = function(type, desc){
    /* Read the object returned by addAuditEntry, not AUDIT_LOG[0]. */
    const entry = _addAuditEntry(type, desc);
    if(auditIsInventoryActivity(entry)){
      /* Force a rebuild so the new row goes through the normal derivation. */
      DERIVED_NOTIFS = null;
      LIVE_AUDIT_IDS.add(entry.id);
      if(typeof initNotifBadge === "function") initNotifBadge();
      if(adminState && adminState.currentModule === "notifications" &&
         typeof renderNotifications === "function") renderNotifications();
    }
  };
}

/* Invalidate the derived cache once the data loads, since the first read happens before the records arrive. */
function refreshDerivedNotifications(){
  DERIVED_NOTIFS = null;
  if(typeof initNotifBadge === "function") initNotifBadge();
  if(adminState && adminState.currentModule === "notifications" &&
     typeof renderNotifications === "function") renderNotifications();
}

/* Seed rows plus generated ones. */
function allNotifications(){
  if(DERIVED_NOTIFS === null){
    try { DERIVED_NOTIFS = buildDerivedNotifications(); }
    catch(err){ console.warn("[notifications] could not derive alerts:", err); DERIVED_NOTIFS = []; }
    DERIVED_NOTIFS.forEach(function(n){ if(NOTIF_READ.has(n.id)) n.read = true; });
  }
  return NOTIFICATIONS.concat(DERIVED_NOTIFS);
}

/* Notifications the signed-in role may see (unmapped types are visible to all). */
function visibleNotifications(){
  return allNotifications().filter(function(n){
    const perm = NOTIF_PERM[n.type];
    return !perm || (typeof hasPerm !== "function") || hasPerm(perm);
  });
}

/* Today's date, from INV_TODAY in inventory.js (resolved at call time). */
function TODAY_ISO(){
  return (typeof INV_TODAY !== "undefined" && INV_TODAY) ? INV_TODAY : "2026-06-17";
}

function initNotifBadge(){
  const unread   = visibleNotifications().filter(n=>!n.read);
  const count    = unread.length;
  const critical = unread.filter(n=> notifPriority(n) === "critical").length;

  const badge = $("#sidebar-notif-badge");
  if(badge) badge.textContent = count > 0 ? count : "";

  /* The badge shows the unread count, with a separate critical style; the exact split is in the title and aria-label. */
  const topBadge = $("#notif-badge");
  if(topBadge){
    topBadge.textContent = count > 9 ? "9+" : (count > 0 ? count : "");
    topBadge.style.display = count > 0 ? "flex" : "none";
    topBadge.classList.toggle("has-critical", critical > 0);
  }

  const bell = $("#notif-btn");
  if(bell){
    const label = count === 0
      ? "Notifications — none unread"
      : critical > 0
        ? `Notifications — ${count} unread, ${critical} critical`
        : `Notifications — ${count} unread`;
    bell.setAttribute("aria-label", label);
    bell.title = label;
    bell.classList.toggle("has-critical", critical > 0);
  }

  renderNotifDropdown();
}

function renderNotifDropdown(){
  const list = $("#nd-list");
  if(!list) return;
  /* Same sort as the Notifications module and dashboard panel. */
  /* Unread only: read rows leave the bell (full history stays in the Notifications module). */
  const recent = sortByUrgency(visibleNotifications().filter(n => !n.read)).slice(0,6);
  list.innerHTML = recent.map(n => `
    <div class="nd-item ${n.read ? "" : "unread"}" data-ndnotif="${n.id}" role="button" tabindex="0">
      <div class="nd-item-icon type-${n.kind || n.type}">${NOTIF_ICONS[n.kind] || NOTIF_ICONS[n.type] || ""}</div>
      <div class="nd-item-body">
        <div class="nd-item-top">
          <span class="nd-item-msg">${escHtml(n.msg)}</span>
          ${!n.read ? `<span class="nd-item-dot"></span>` : ""}
        </div>
        <div class="nd-item-time">${notifLevelChip(n)}<span>${fmtDateTime(n.time)}</span></div>
      </div>
    </div>`).join("") || `<div class="nd-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <strong>Nothing waiting</strong>You're all caught up.
    </div>`;

  $$("#nd-list .nd-item").forEach(el=>{
    const go = ()=>{
      markRead(el.dataset.ndnotif);
      $("#topbar-notif")?.classList.remove("open");
      $("#notif-btn")?.setAttribute("aria-expanded", "false");
      navigate("notifications");
    };
    el.addEventListener("click", go);
    /* The row is a div acting as a button, so it handles Enter and Space itself. */
    el.addEventListener("keydown", e=>{
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); go(); }
    });
  });
}

function initNotifBell(){
  const wrap = $("#topbar-notif");
  const btn  = $("#notif-btn");
  if(!wrap || !btn) return;

  /* Keep aria-expanded in step with the open class. */
  const setOpen = open => {
    wrap.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "notif-dropdown");
  btn.setAttribute("aria-haspopup", "menu");

  btn.addEventListener("click", (e)=>{
    e.stopPropagation();
    setOpen(!wrap.classList.contains("open"));
  });
  document.addEventListener("click", ()=> setOpen(false));

  /* Escape closes the panel and returns focus to the bell. */
  document.addEventListener("keydown", (e)=>{
    if(e.key !== "Escape" || !wrap.classList.contains("open")) return;
    setOpen(false);
    btn.focus();
  });

  $("#nd-mark-all")?.addEventListener("click", (e)=>{ e.stopPropagation(); markAllRead(); });
  $("#nd-view-all")?.addEventListener("click", ()=>{
    setOpen(false);
    navigate("notifications");
  });
  renderNotifDropdown();
}
/* Called by init() after the shell is injected, not on DOMContentLoaded (the bell does not exist yet then). */

/* Group notification types into filter-tab categories. */
const NOTIF_CATEGORY = {
  "new-order": "orders", "payment":"payments", "inventory":"inventory",
  "hold":"status", "completed":"status", "return":"returns", "audit":"audit",
  "review":"reviews",
  /* Cashier / Inventory categories */
  "scheme-due":"payments", "sales-summary":"sales",
  "expiry":"inventory", "batch-qa":"quality",
};
const NOTIF_TABS = [
  { id:"all",       label:"All" },
  { id:"orders",    label:"New Orders" },
  { id:"payments",  label:"Payments" },
  { id:"inventory", label:"Inventory" },
  { id:"status",    label:"Order Status" },
  { id:"returns",   label:"Refunds & Returns" },
  { id:"quality",   label:"Batch & QA" },
  { id:"reviews",   label:"Reviews" },
  { id:"sales",     label:"Sales" },
  { id:"audit",     label:"Audit Log" },
];

const NOTIF_ICONS = {
  "new-order": `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 1a1 1 0 000 2h1.22l.305 1.222a.997.997 0 00.01.042l1.358 5.43-.893.892C3.74 11.846 4.632 14 6.414 14H15a1 1 0 000-2H6.414l1-1H14a1 1 0 00.894-.553l3-6A1 1 0 0017 3H6.28l-.31-1.243A1 1 0 005 1H3z"/></svg>`,
  "payment":   `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z"/><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd"/></svg>`,
  "return":    `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a7 7 0 017 7v2a1 1 0 11-2 0v-2a5 5 0 00-5-5H5.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`,
  "hold":      `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`,
  "completed": `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>`,
  "inventory": `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2a1 1 0 01.894.553l7 14A1 1 0 0117 18H3a1 1 0 01-.894-1.447l7-14A1 1 0 0110 2zm0 4a1 1 0 00-1 1v3a1 1 0 002 0V7a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd"/></svg>`,
  "scheme-due":    `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z"/><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd"/></svg>`,
  "expiry":        `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>`,
  "batch-qa":      `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.415L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>`,
  /* Audit sub-kinds — same "audit" type, distinct glyphs. */
  "restock":       `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 011.414-1.414L9 9.586V4a1 1 0 011-1z" clip-rule="evenodd"/><path d="M3 14a1 1 0 011 1v1h12v-1a1 1 0 112 0v1a2 2 0 01-2 2H4a2 2 0 01-2-2v-1a1 1 0 011-1z"/></svg>`,
  "replenish":     `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M7 3a1 1 0 000 2h6a1 1 0 100-2H7z"/><path d="M4 7a1 1 0 011-1h10a1 1 0 011 1v1H4V7z"/><path fill-rule="evenodd" d="M3 10h14v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5zm4 2a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>`,
  "adjust":        `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z"/></svg>`,
  "archive":       `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 3a2 2 0 00-2 2v1a1 1 0 001 1h14a1 1 0 001-1V5a2 2 0 00-2-2H4z"/><path fill-rule="evenodd" d="M3 8h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm5 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>`,
  "sales-summary": `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>`,
  "review":    `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9.05 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.957a1 1 0 00.95.69h4.162c.969 0 1.371 1.24.588 1.81l-3.367 2.446a1 1 0 00-.364 1.118l1.287 3.957c.3.921-.755 1.688-1.539 1.118l-3.366-2.446a1 1 0 00-1.176 0l-3.367 2.446c-.783.57-1.838-.197-1.538-1.118l1.286-3.957a1 1 0 00-.363-1.118L2.063 9.384c-.783-.57-.38-1.81.588-1.81h4.161a1 1 0 00.951-.69l1.286-3.957z"/></svg>`,
  "audit":     `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm0-7a1 1 0 10-2 0v3a1 1 0 102 0V7z" clip-rule="evenodd"/></svg>`,
};

function renderNotifications(){
  const icons = NOTIF_ICONS;

  const tabsEl = $("#notif-tabs");
  if(tabsEl){
    const scoped = visibleNotifications();
    tabsEl.innerHTML = NOTIF_TABS.map(t=>{
      const inTab = t.id==="all" ? scoped : scoped.filter(n=>NOTIF_CATEGORY[n.type]===t.id);
      /* Hide tabs this role can never fill. */
      if(t.id !== "all" && inTab.length === 0) return "";
      /* Tab badges count unread notifications, matching the bell. */
      const unread = inTab.filter(n=>!n.read).length;
      const active = (adminState.notifFilter||"all")===t.id;
      /* Every tab here, including All, shows its unread count (tabBadgeAlways). */
      const b = tabBadgeAlways(t.label, unread, "unread");
      return `<button class="return-tab-btn ${active?"active":""}" data-notiftab="${t.id}"
                      role="tab" aria-selected="${active}"
                      aria-label="${escHtml(b.aria)}">${b.html}</button>`;
    }).join("");
    $$("#notif-tabs .return-tab-btn").forEach(btn=>{
      btn.onclick = ()=>{ adminState.notifFilter = btn.dataset.notiftab; renderNotifications(); };
    });
  }
  const sortSel = $("#notif-sort");
  if(sortSel){
    sortSel.value = adminState.notifSort || "urgency";
    sortSel.onchange = ()=>{ adminState.notifSort = sortSel.value; renderNotifications(); };
  }

  const filter = adminState.notifFilter || "all";
  /* Urgency is the default sort, matching the bell and dashboard. */
  const sort   = adminState.notifSort || "urgency";
  let list = visibleNotifications().filter(n=> filter==="all" || NOTIF_CATEGORY[n.type]===filter);
  list = sort === "urgency" ? sortByUrgency(list) : [...list].sort((a,b)=>{
    if(sort==="unread" && a.read!==b.read) return a.read ? 1 : -1;
    if(sort==="oldest") return a.time < b.time ? -1 : 1;
    return a.time > b.time ? -1 : 1;
  });

  const html = list.map(n => `
    <div class="notif-row ${n.read ? "" : "unread"}" data-notif="${n.id}">
      <div class="notif-row-icon type-${n.kind || n.type}">${icons[n.kind] || icons[n.type] || ""}</div>
      <div class="notif-row-body">
        <div class="notif-row-top">
          <span class="notif-row-msg">${escHtml(n.msg)}</span>
          ${!n.read ? `<span class="notif-unread-dot"></span>` : ""}
        </div>
        <div class="notif-row-meta">
          ${notifLevelChip(n)}
          <span class="notif-row-time">${fmtDateTime(n.time)}</span>
          ${n.orderId    ? `<span class="notif-row-action" data-goto="orderstatus">View Order →</span>` : ""}
          ${n.returnId   ? `<span class="notif-row-action" data-goto="returns">View Return →</span>` : ""}
          ${n.productId  ? `<span class="notif-row-action" data-goto="inventory-manage">View Inventory →</span>` : ""}
          ${n.type==="audit" ? `<span class="notif-row-action" data-goto="audit">View Audit Log →</span>` : ""}
        </div>
      </div>
    </div>`).join("");
  $("#notif-content").innerHTML = html || emptyState("No notifications", "You're all caught up.");

  $$("#notif-content .notif-row").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest("[data-goto]")) return;
      markRead(el.dataset.notif);
    });
  });
  $$("#notif-content [data-goto]").forEach(el=>{
    el.addEventListener("click", (e)=>{ e.stopPropagation(); navigate(el.dataset.goto); });
  });

  const markAllBtn = $("#mark-all-read-btn");
  if(markAllBtn) markAllBtn.onclick = markAllRead;
}

/* Read state is stored on the server, shared by the team. */
async function markRead(id){
  const n = allNotifications().find(n=>n.id===id);
  if(!n) return;

  /* Mark read on the server first, then update the badge; derived notifications return NOT_FOUND, which is fine. */
  try {
    await EbApi.post("notifications/read.php", { id });
  } catch(err){
    if(err.code !== "NOT_FOUND"){
      console.warn("[notif]", err.message);
      toast("Could not mark that as read.", "err");
      return;
    }
  }
  n.read = true; NOTIF_READ.add(id);
  initNotifBadge(); renderNotifications();
}

async function markAllRead(){
  /* Server first, then the success toast. */
  try {
    await EbApi.post("notifications/read.php", { all: true });
  } catch(err){
    console.warn("[notif]", err.message);
    toast("Could not mark notifications read.", "err");
    return;
  }
  /* Only mark what this role can see. */
  visibleNotifications().forEach(function(n){ n.read = true; NOTIF_READ.add(n.id); });
  initNotifBadge();
  renderNotifications();
  toast("All notifications marked read", "ok");
}

/* ===== ONLINE TRANSACTIONS ===== */
/* ===== TAB BADGES count only things waiting for you (pending/on-hold orders, in-progress returns, unread notifications), with one shared table for every screen ===== */
const WORK_TABS = new Set([
  /* Orders: Online Transactions, Order Queue, Payment Verification. */
  "pending", "on-hold",
  /* Returns still in flight. */
  "received", "validated", "eligible", "approved",
]);

/* Cap the badge at two digits. */
const BADGE_MAX = 99;

/** Tab inner HTML plus an aria-label like "Pending, 7 awaiting action" (escape aria with escHtml() when used in an attribute). */
/* Notification tabs always show unread counts (skipping the WORK_TABS gate). */
function tabBadgeAlways(label, count, noun){
  const n = Number(count) || 0;
  if(n <= 0) return { html: escHtml(label), aria: label };
  const shown = n > BADGE_MAX ? BADGE_MAX + "+" : String(n);
  return {
    html: `${escHtml(label)} <span class="tab-count">${shown}</span>`,
    aria: `${label}, ${n} ${noun}`,
  };
}

function tabBadge(id, label, count, noun = "awaiting action"){
  const n = Number(count) || 0;
  if(!WORK_TABS.has(id) || n <= 0){
    return { html: escHtml(label), aria: label };
  }
  const shown = n > BADGE_MAX ? BADGE_MAX + "+" : String(n);
  return {
    html: `${escHtml(label)} <span class="tab-count">${shown}</span>`,
    aria: `${label}, ${n} ${noun}`,
  };
}

const TXN_TABS = ["all","pending","accepted","shipping","delivered","completed","cancelled"];

function onlineOrders(){
  return ORDERS.filter(o=>o.type==="online");
}

/* Online Transactions is server-paged, with search and status filtering in the query. */
/* Payment note under the method on Online Transactions and Order Queue: cash pickup, credit terms and walk-in deliveries never need a proof upload. */
function paymentNote(o){
  const note = (text, style) => `<span style="font-weight:${style ? 700 : 600};font-size:.78rem;${style || "color:var(--text-muted)"}">${text}</span>`;
  if(o.proof?.uploaded) return note("✓ Proof uploaded", "color:var(--ok-ink)");
  if(o.type === "walk-in") return note("Paid at the counter");
  if(o.payMethod === "cash" && o.orderType === "pickup") return note("Pay on pickup");
  if(isCreditOrder(o)) return note("Not yet paid for this term");
  return note("⚠ No proof yet", "color:var(--out-ink)");
}

function renderOnlineTxns(){
  const tabsEl = $("#txn-status-tabs");
  const filter = adminState.onlineTxnFilter;

  /* Rows per page goes in the toolbar row (see mountToolbarControl()). */
  mountToolbarControl("online-txns", "page-size", `
    <select class="filter-select" id="online-txn-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#txn-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table otx-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th>Payment</th><th class="num">Total</th><th>Status</th><th class="otx-act-h">Actions</th></tr></thead>
        <tbody id="online-txn-tbody"></tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="online-txn-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="online-txn-pagination" style="margin-left:auto"></div>
    </div>`;

  EbPaginate.list(
    "online-txn",
    adminState.onlineTxnPager,
    () => $("#online-txn-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      /* Most recently updated or processed first (latest status change, delivery or completion). */
      page, limit, type: "online", with_deliveries: 1, sort: "activity",
      status: filter === "all" ? null : filter,
      search: $("#txn-search")?.value || null,
    }),
    o => `<tr>
      <td>
        <div class="otx-id">${escHtml(o.id)}</div>
        <div class="otx-tags">
          <span class="otx-tag">${o.orderType === "delivery" ? "Delivery" : "Pickup"}</span>
          ${o.itemCount ? `<span class="otx-tag">${o.itemCount} item${o.itemCount === 1 ? "" : "s"}</span>` : ""}
          ${o.type === "walk-in" ? `<span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}
        </div>
      </td>
      <td><div class="otx-cust">
        <span class="otx-avatar" aria-hidden="true">${escHtml(String(o.customer || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase())}</span>
        <div><div class="otx-name">${escHtml(o.customer)}</div>${o.customerType === "retailer" ? `<div class="otx-sub">Retail partner</div>` : ""}</div>
      </div></td>
      <td>
        <div class="otx-date">${fmtDateTime(o.datetime)}</div>
        ${o.lastActivity && fmtDateTime(o.lastActivity) !== fmtDateTime(o.datetime) ? `<div class="otx-sub">Updated ${fmtDateTime(o.lastActivity)}</div>` : ""}
      </td>
      <td><div class="otx-pay">${escHtml(payMethodLabel(o.payMethod))}</div>${paymentNote(o)}</td>
      <td class="num"><span class="otx-total">${orderDueHtml(o)}</span></td>
      <td>${orderStatusBadge(o.status)}</td>
      <td><div class="td-actions otx-actions">
        <button class="btn btn-ghost btn-sm" data-view-order="${o.id}">View</button>
        ${nextStatuses(o).length ? `<button class="btn btn-gold btn-sm" data-status-order="${o.id}">Update</button>` : ""}
      </div></td>
    </tr>`,
    {
      colspan: 7,
      empty: { title: "No orders found", hint: "Try a different filter or search term" },
      after: (rows, meta) => {
        rows.forEach(r => {
          const i = ORDERS.findIndex(o => o.id === r.id);
          if(i > -1) ORDERS[i] = r; else ORDERS.push(r);
        });
        if(tabsEl){
          const c = meta.counts || {};
          const all = Object.values(c).reduce((n,v)=>n+v, 0);
          tabsEl.innerHTML = TXN_TABS.map(t=>{
            const n = t === "all" ? all : (c[t] || 0);
            /* Badge only where there is work waiting — see tabBadge(). */
            const b = tabBadge(t, t==="all" ? "All" : (STATUS_LABEL[t]||t), n);
            return `<button class="tab-btn ${t===adminState.onlineTxnFilter?"active":""}" data-txnfilter="${t}"
                            role="tab" aria-selected="${t===adminState.onlineTxnFilter}"
                            aria-label="${escHtml(b.aria)}">${b.html}</button>`;
          }).join("");
          $$("#txn-status-tabs .tab-btn").forEach(btn=>{
            btn.addEventListener("click", ()=>{
              adminState.onlineTxnFilter = btn.dataset.txnfilter;
              adminState.onlineTxnPager.page = 1;
              renderOnlineTxns();
            });
          });
        }
        wireOrderRowActions("#txn-content");
      },
    }
  );

  if($("#txn-search") && !$("#txn-search").dataset.wired){
    $("#txn-search").dataset.wired = "1";
    $("#txn-search").addEventListener("input", debounce(()=>{
      adminState.onlineTxnPager.page = 1;
      renderOnlineTxns();
    }, 300));
  }
}


function wireOrderRowActions(scopeSel){
  $$(`${scopeSel} [data-view-order]`).forEach(btn=>{
    btn.addEventListener("click", ()=> openOrderDetail(btn.dataset.viewOrder));
  });
  $$(`${scopeSel} [data-status-order]`).forEach(btn=>{
    btn.addEventListener("click", ()=> openStatusModal(btn.dataset.statusOrder));
  });
}

/* ===== ORDER QUEUE ===== */
/* Queue covers everything before shipping; All shows that whole picture. */
const QUEUE_TABS = ["all","pending","accepted"];

/* Order Queue is server-paged, with tab counts from meta.counts across the whole set. */
function renderQueue(){
  const tabsEl = $("#queue-status-tabs");

  /* Draw the tabs and pager first so the loading state has a place. */
  /* Rows per page goes in the toolbar row (see mountToolbarControl()). */
  mountToolbarControl("ordersqueue", "page-size", `
    <select class="filter-select" id="queue-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#queue-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>#</th><th>Order ID</th><th>Customer</th><th>Items</th><th>Date</th><th>Payment</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="queue-tbody"></tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="queue-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="queue-pagination" style="margin-left:auto"></div>
    </div>`;

  const filter = adminState.queueFilter;
  /* All means every status before shipping, sent as a comma list. */
  const statuses = filter === "all" ? QUEUE_TABS.slice(1).join(",") : filter;

  EbPaginate.list(
    "queue",
    adminState.queuePager,
    () => $("#queue-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      page, limit, type: "online", with_deliveries: 1, status: statuses, sort: "oldest",
    }),
    (o, i) => {
      const hasProof = o.proof.uploaded;
      /* One line in the table; the full list and address are in Details. */
      const itemText = o.items.map(it => `${it.name || it.id} ×${it.qty}`).join(", ");
      /* Row numbers continue across pages. */
      const seq = ((adminState.queuePager.page || 1) - 1) * (adminState.queuePager.pageSize || 10) + i + 1;
      return `<tr>
      <td class="muted" style="font-weight:700">${seq}</td>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted" style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(itemText)}">${escHtml(itemText)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}<br>${paymentNote(o)}</td>
      <td style="font-weight:700">${orderDueHtml(o)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-view-order="${o.id}">Details</button>
        ${hasProof ? `<button class="btn btn-gold btn-sm" data-verify-order="${o.id}">Verify</button>` : ""}
        <button class="btn btn-red btn-sm" data-status-order="${o.id}">Update Status</button>
      </div></td>
    </tr>`;
    },
    {
      colspan: 9,
      empty: { title: "Queue Empty", hint: filter==="all" ? "No orders awaiting review" : `No ${STATUS_LABEL[filter]||filter} orders` },
      after: (rows, meta) => {
        /* Keep ORDERS in step so the detail and status modals can find the row. */
        rows.forEach(r => {
          const i = ORDERS.findIndex(o => o.id === r.id);
          if(i > -1) ORDERS[i] = r; else ORDERS.push(r);
        });
        if(tabsEl){
          const counts = meta.counts || {};
          const totalPre = QUEUE_TABS.slice(1).reduce((n,t)=> n + (counts[t]||0), 0);
          tabsEl.innerHTML = QUEUE_TABS.map(t=>{
            const n = t === "all" ? totalPre : (counts[t] || 0);
            /* Badge only where there is work waiting — see tabBadge(). */
            const b = tabBadge(t, t==="all" ? "All" : (STATUS_LABEL[t]||t), n);
            return `<button class="tab-btn ${t===adminState.queueFilter?"active":""}" data-queuefilter="${t}"
                            role="tab" aria-selected="${t===adminState.queueFilter}"
                            aria-label="${escHtml(b.aria)}">${b.html}</button>`;
          }).join("");
          $$("#queue-status-tabs .tab-btn").forEach(btn=>{
            btn.addEventListener("click", ()=>{
              adminState.queueFilter = btn.dataset.queuefilter;
              adminState.queuePager.page = 1;
              renderQueue();
            });
          });
        }
        wireOrderRowActions("#queue-content");
        $$("#queue-content [data-verify-order]").forEach(btn=>{
          btn.addEventListener("click", ()=> navigate("paymentverify"));
        });
      },
    }
  );
}

/* ===== PAYMENT VERIFICATION ===== */
/* Payment screenshot box with three clear states: the image (click to open full size), reference number only, or nothing. */
function proofImageBlock(o){
  const src = o.proof && o.proof.image ? imageUrl(o.proof.image) : "";
  if(src){
    return `<a class="proof-shot" href="${escHtml(src)}" target="_blank" rel="noopener noreferrer" title="Open full size">
      <img src="${escHtml(src)}" alt="Payment screenshot for ${escHtml(o.id)}" loading="lazy"
           style="max-width:100%;max-height:180px;border-radius:8px;display:block;margin-top:8px">
    </a>
    <div class="proof-status uploaded">Screenshot attached — click to enlarge</div>`;
  }
  if(o.proof && o.proof.refNum){
    return `<div class="proof-status" style="color:var(--text-muted)">Reference number only — no screenshot attached</div>`;
  }
  return `<div class="proof-status" style="color:var(--text-muted)">No payment proof supplied</div>`;
}

const PV_TABS = ["all","pending"];

/* Payment Verification is server-paged (unverified pending/on-hold orders), using price_at_purchase. */
function renderPaymentVerify(){
  const tabsEl = $("#pv-status-tabs");
  const filter = adminState.pvFilter;

  /* Rows per page goes in the toolbar row (see mountToolbarControl()). */
  mountToolbarControl("paymentverify", "page-size", `
    <select class="filter-select" id="pv-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#pv-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Customer</th><th>Email</th><th>Date</th><th>Payment</th><th>Amount Due</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="pv-tbody"></tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="pv-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="pv-pagination" style="margin-left:auto"></div>
    </div>`;

  /* The full proof card opens in a modal from View. */
  const pvRows = new Map();

  EbPaginate.list(
    "pv",
    adminState.pvPager,
    () => $("#pv-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      page, limit, type: "online", pay_verified: 0, proof_uploaded: 1,
      status: filter === "all" ? "pending,on-hold" : filter,
      sort: "oldest",
    }),
    o => {
      pvRows.set(String(o.id), o);
      const due = (o.tax && o.tax.amountDue != null) ? o.tax.amountDue : o.total;
      return `<tr>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${escHtml(o.email || "—")}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}</td>
      <td style="font-weight:700">${peso(due)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td><button class="btn btn-ghost btn-sm" data-pv-view="${escHtml(o.id)}">View</button></td>
    </tr>`;
    },
    {
      colspan: 8,
      empty: { title: "All Verified", hint: filter==="all" ? "No pending payment proofs to review" : `No ${STATUS_LABEL[filter]||filter} proofs to review` },
      after: (rows, meta) => {
        rows.forEach(r => {
          const i = ORDERS.findIndex(o => o.id === r.id);
          if(i > -1) ORDERS[i] = r; else ORDERS.push(r);
        });
        if(tabsEl){
          const c = meta.counts || {};
          tabsEl.innerHTML = PV_TABS.map(t=>{
            const n = t === "all" ? ((c.pending||0) + (c["on-hold"]||0)) : (c[t] || 0);
            /* Badge only where there is work waiting — see tabBadge(). */
            const b = tabBadge(t, t==="all" ? "All" : (STATUS_LABEL[t]||t), n);
            return `<button class="tab-btn ${t===adminState.pvFilter?"active":""}" data-pvfilter="${t}"
                            role="tab" aria-selected="${t===adminState.pvFilter}"
                            aria-label="${escHtml(b.aria)}">${b.html}</button>`;
          }).join("");
          $$("#pv-status-tabs .tab-btn").forEach(btn=>{
            btn.addEventListener("click", ()=>{
              adminState.pvFilter = btn.dataset.pvfilter;
              adminState.pvPager.page = 1;
              renderPaymentVerify();
            });
          });
        }
        $$("#pv-content [data-pv-view]").forEach(b=> b.addEventListener("click", ()=>{
          const o = pvRows.get(b.dataset.pvView);
          if(o) openPaymentVerifyModal(o);
        }));
      },
    }
  );
}

/* Full proof card with the order, where it goes, and approve or reject (reject opens its own modal). */
function openPaymentVerifyModal(o){
  const total = (o.tax && o.tax.amountDue != null) ? o.tax.amountDue : o.total;
  const withheld = o.tax && o.tax.withholdingTax > 0 ? o.tax.withholdingTax : 0;
  const match = Math.abs((o.proof.amount || 0) - total) < 0.01;
  const itemRows = o.items.map(it =>
    `<div class="pv-row"><span class="pv-row-label">${escHtml(it.name || it.id)} ×${it.qty}</span><span class="pv-row-val">${it.price != null ? peso(it.price * it.qty) : "—"}</span></div>`).join("");
  openModal({
    title: `Verify Payment — ${o.id}`,
    large: true,
    cancelLabel: null,   /* the header × closes it */
    confirmLabel: null,
    body: `
      <div class="pv-modal-head">
        <span class="order-card-customer">${escHtml(o.customer)}</span>
        ${statusChip(o.status)}
        <span style="flex:1"></span>
        <span style="font-size:.78rem;color:var(--text-muted)">${fmtDateTime(o.datetime)}</span>
      </div>
      <div class="pv-card pv-card-modal">
        <div class="pv-card-body">
          <div class="pv-section">
            <div class="pv-section-label">Order Details</div>
            ${itemRows}
            <div class="pv-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:10px">
              <span class="pv-row-label" style="font-weight:700">Total Due</span>
              <span class="pv-row-val" style="font-size:1.1rem;color:var(--gold-ink)">${EbFormat.pesoExact(total)}</span>
            </div>${withheld ? `
            <div class="pv-row"><span class="pv-row-label">Retailer discount</span><span class="pv-row-val">${EbFormat.pesoExact(withheld)} of ${EbFormat.pesoExact(o.total)}</span></div>` : ""}
            <!-- Where the order goes, so staff check the address while verifying the payment. -->
            <div class="pv-section-label" style="margin-top:16px">${o.orderType === "delivery" ? "Delivery Details" : "Pickup Details"}</div>
            <div class="pv-row"><span class="pv-row-label">Fulfilment</span><span class="pv-row-val">${o.orderType === "delivery" ? "Delivery" : "Pickup at the store"}</span></div>
            ${o.orderType === "delivery" ? `
            <div class="pv-row pv-row-wrap"><span class="pv-row-label">Address</span><span class="pv-row-val">${escHtml(o.address || "No address given")}</span></div>
            ${o.tax && o.tax.shipping ? `<div class="pv-row"><span class="pv-row-label">Delivery fee</span><span class="pv-row-val">${EbFormat.pesoExact(o.tax.shipping.fee)}${o.tax.shipping.destination ? ` <span class="muted" style="font-weight:500;font-size:.78rem">· ${escHtml(o.tax.shipping.destination)}</span>` : ""}</span></div>` : ""}` : ""}
            <div class="pv-row"><span class="pv-row-label">Contact</span><span class="pv-row-val">${escHtml(o.contact || o.phone || "—")}</span></div>
            ${o.email ? `<div class="pv-row pv-row-wrap"><span class="pv-row-label">Email</span><span class="pv-row-val">${escHtml(o.email)}</span></div>` : ""}
          </div>
          <div class="pv-section">
            <div class="pv-section-label">Payment Proof</div>
            <div class="pv-row"><span class="pv-row-label">Method</span><span class="pv-row-val">${escHtml(payMethodLabel(o.payMethod))}</span></div>
            <div class="pv-row"><span class="pv-row-label">Amount Stated</span><span class="pv-row-val ${match?"match":"mismatch"}">${peso(o.proof.amount)} ${match?"✓":"✗ MISMATCH"}</span></div>
            <div class="proof-box">
              <div style="font-size:.72rem;color:var(--text-muted);font-weight:700">Reference Number</div>
              <div class="proof-ref">${escHtml(o.proof.refNum || "—")}</div>
              ${proofImageBlock(o)}
            </div>
          </div>
        </div>
        <div class="pv-actions">
          <button class="btn btn-gold btn-sm" data-approve-pay="${o.id}">
            <svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
            Approve — Move to Accepted
          </button>
          <button class="btn btn-ghost-danger btn-sm" data-reject-pay="${o.id}">Reject Payment</button>
        </div>
      </div>`,
    onOpen(){
      const m = $("#modal-body");
      m.querySelector("[data-approve-pay]")?.addEventListener("click", ()=>{ closeModal(); approvePayment(o.id); });
      m.querySelector("[data-reject-pay]")?.addEventListener("click", ()=> cancelOrder(o.id));
    },
  });
}

async function approvePayment(orderId){
  try {
    /* Verify, then accept, as two calls so it is clear which one failed. */
    const { data } = await EbApi.post("orders/verify-payment.php", { id: orderId, verified: true });
    if(data.mismatch) toast(data.mismatch, "warn");
    await updateOrderStatus(orderId, "accepted", "Payment verified and approved");
  } catch(err){
    toast(err.message, "err");
  }
  await loadOrders();
  /* Re-draw whichever screen the verification was opened from. */
  const mod = adminState.currentModule;
  if(mod === "online-txns") renderOnlineTxns();
  else if(mod === "ordersqueue") renderQueue();
  else if(mod === "orderstatus") renderOrderStatus();
  else renderPaymentVerify();
  if(typeof initNotifBadge === "function") initNotifBadge();
}

/* Refund note prefilled from the store's contact details (Landing Page → Contact), editable per order. */
function defaultRefundNote(){
  const c = (typeof SITE_CONTENT !== "undefined" && SITE_CONTENT.contact) || {};
  const ways = [c.phone && `call or text ${c.phone}`, c.email && `email ${c.email}`, c.facebook && `message us on ${c.facebook}`].filter(Boolean);
  return `If you already paid, contact us to arrange your refund${ways.length ? ": " + ways.join(", ") : ""}. Please include your order number and payment reference.`;
}

function cancelOrder(orderId){
  openModal({
    title:"Reject & Cancel Order",
    body:`<div class="field"><label for="cancel-reason">Reason for rejection/cancellation</label>
        <textarea class="control" id="cancel-reason" rows="2" maxlength="180" placeholder="e.g. Invalid payment reference number"></textarea></div>
      <div class="field"><label for="cancel-refund">Refund note for the customer</label>
        <textarea class="control" id="cancel-refund" rows="3" maxlength="280">${escHtml(defaultRefundNote())}</textarea></div>`,
    confirmLabel:"Cancel Order", confirmClass:"btn-red",
    async onConfirm(){
      const reason = $("#cancel-reason").value.trim() || "Payment rejected by staff";
      const refund = $("#cancel-refund").value.trim();
      const note = refund ? `${reason} — Refund: ${refund}` : reason;
      if(await updateOrderStatus(orderId, "cancelled", note)){
        closeModal();
        renderPaymentVerify();
      }
    }
  });
}

/* ===== ORDER STATUS MANAGEMENT ===== */
/* Order Status — server-paged. */
function renderOrderStatus(){
  /* Rows per page goes in the toolbar row (see mountToolbarControl()). */
  mountToolbarControl("orderstatus", "page-size", `
    <select class="filter-select" id="order-status-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#status-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
        <tbody id="order-status-tbody"></tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="order-status-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="order-status-pagination" style="margin-left:auto"></div>
    </div>`;

  EbPaginate.list(
    "order-status",
    adminState.orderStatusPager,
    () => $("#order-status-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      page, limit, type: "online", with_deliveries: 1, sort: "newest",
      status: $("#status-filter")?.value || null,
      search: $("#status-search")?.value || null,
    }),
    o => {
      const canUpdate = nextStatuses(o).length > 0;
      const notes = o.notes || "";
      return `<tr>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td style="font-weight:700">${orderDueHtml(o)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td class="muted" style="font-size:.8rem;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(notes)}">${escHtml(notes)||"—"}</td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-view-order="${o.id}">Detail</button>
        ${canUpdate ? `<button class="btn btn-gold btn-sm" data-status-order="${o.id}">Update Status</button>` : ""}
      </div></td>
    </tr>`;
    },
    {
      colspan: 7,
      empty: { title: "No orders found", hint: "Adjust search or filter" },
      after: (rows) => {
        rows.forEach(r => {
          const i = ORDERS.findIndex(o => o.id === r.id);
          if(i > -1) ORDERS[i] = r; else ORDERS.push(r);
        });
        wireOrderRowActions("#status-content");
      },
    }
  );

  const reset = ()=>{ adminState.orderStatusPager.page = 1; renderOrderStatus(); };
  if($("#status-search") && !$("#status-search").dataset.wired){
    $("#status-search").dataset.wired = "1";
    $("#status-search").addEventListener("input", debounce(reset, 300));
  }
  if($("#status-filter") && !$("#status-filter").dataset.wired){
    $("#status-filter").dataset.wired = "1";
    $("#status-filter").addEventListener("change", reset);
  }
}


function openStatusModal(orderId){
  const o = ORDERS.find(o=>o.id===orderId);
  if(!o) return;
  const transitions = nextStatuses(o);
  if(!transitions.length){ toast("This order status cannot be changed","err"); return; }

  const btns = transitions.map(s=>`
    <button type="button" class="status-transition-btn dest-${s}" data-dest="${s}">
      <span class="status-dot ${s}"></span>
      <span class="stb-label">${STATUS_LABEL[s]}</span>
    </button>`).join("");

  openModal({
    title:`Update Status — ${orderId}`,
    body:`
      <div class="detail-row"><span class="detail-row-label">Customer</span><span class="detail-row-val">${escHtml(o.customer)}</span></div>
      <div class="detail-row" style="margin-bottom:16px"><span class="detail-row-label">Current Status</span><span class="detail-row-val">${statusChip(o.status)}</span></div>
      <div class="status-move-heading">Move to</div>
      <div class="status-transition-grid" id="status-transition-grid">${btns}</div>
      <!-- Its own field, not the free-text note.

           The note placeholder used to read "e.g. Tracking number, reason for
           hold…", which is where a tracking number went before this: into a
           text blob nothing could read back. The Limitation promises the number
           is "proof of shipment", and proof has to be retrievable. -->
      <div class="field hide" id="tracking-field" style="margin-top:16px">
        <label>Courier Tracking Number <span class="muted" style="font-weight:400;font-size:.78rem">(required to ship a delivery)</span></label>
        <input class="control" id="status-tracking" type="text" maxlength="25" autocomplete="off" placeholder="e.g. LBC-8842910337" />
        <span class="field-error" id="err-tracking"></span>
        <span class="field-hint">Issued by the courier on dispatch. We do not track it for the customer — they use the courier's own site.</span>
      </div>
      <div class="field" style="margin-top:16px">
        <label>Note (optional)</label>
        <input class="control" id="status-note" type="text" placeholder="e.g. reason for cancelling, delivery instructions…" />
      </div>`,
    confirmLabel:null, cancelLabel:"Cancel",
  });
  setTimeout(()=>{
    /* Tracking number is needed only when dispatching a delivery order. */
    const needsTracking = dest => dest === "shipping" && o.orderType === "delivery";
    const trackingField = $("#tracking-field");
    $$("#status-transition-grid [data-dest]").forEach(btn=>{
      const reveal = ()=> trackingField?.classList.toggle("hide", !needsTracking(btn.dataset.dest));
      btn.addEventListener("mouseenter", reveal);
      btn.addEventListener("focus", reveal);
    });
    /* Show the tracking field up front when shipping is the next step. */
    if(transitions.some(needsTracking)) trackingField?.classList.remove("hide");

    $$("#status-transition-grid [data-dest]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        /* Accepting (or completing) a GCash/bank order whose proof is not yet verified opens the proof to verify instead of failing. */
        if(["accepted", "completed"].includes(btn.dataset.dest) && needsPaymentCheck(o)){
          if(o.proof?.uploaded){
            closeModal();
            openPaymentVerifyModal(o);
          } else {
            toast("The customer has not uploaded a proof of payment yet, so this order cannot be accepted yet. Wait for the proof, or cancel the order.", "warn");
          }
          return;
        }
        const note = $("#status-note")?.value.trim() || "";
        const tracking = ($("#status-tracking")?.value.trim() || "").toUpperCase();
        const errEl = $("#err-tracking");
        if(errEl) errEl.textContent = "";
        $("#status-tracking")?.classList.remove("is-invalid");

        /* Quick empty-field check; the server's check is the real one. */
        if(needsTracking(btn.dataset.dest) && !tracking && !o.trackingNumber){
          trackingField?.classList.remove("hide");
          if(errEl) errEl.textContent = "Enter the courier tracking number before marking this order shipped.";
          $("#status-tracking")?.focus();
          return;
        }

        /* 8–25 letters, digits or dashes, matching api/orders/status.php. */
        if(tracking && !/^(?=.*\d)[A-Z0-9-]{8,25}$/.test(tracking)){
          trackingField?.classList.remove("hide");
          if(errEl) errEl.textContent = "Tracking numbers are 8–25 letters, numbers or dashes.";
          $("#status-tracking")?.focus();
          return;
        }

        const restore = EbUI.busy(btn, "Moving…");
        try {
          /* Close only on success, keeping the note and showing the reason on refusal. */
          if(await updateOrderStatus(orderId, btn.dataset.dest, note, tracking)){
            closeModal();
            if(adminState.currentModule==="orderstatus") renderOrderStatus();
            if(adminState.currentModule==="online-txns") renderOnlineTxns();
            if(adminState.currentModule==="ordersqueue") renderQueue();
          }
        } finally { restore(); }
      });
    });
  }, 50);
}

/* GCash / bank transfer orders need a verified payment before they are accepted (cash and Net terms do not). */
function needsPaymentCheck(o){
  return !o.payVerified && !isCreditOrder(o) && o.payMethod !== "cash" && o.type !== "walk-in";
}

/* Move an order via api/orders/status.php, which enforces transitions, reasons and payment verification and records history; returns true on success. */
async function updateOrderStatus(orderId, newStatus, note, trackingNumber){
  try {
    const { data } = await EbApi.post("orders/status.php", {
      id: orderId, status: newStatus, note: note || null,
      /* Send the tracking number only when there is one. */
      tracking_number: trackingNumber || null,
    });
    await loadOrders();
    /* Toast the status the server actually set. */
    const landed = (data && data.status) || newStatus;
    toast(data && data.autoCompleted
      ? `Order ${orderId} completed — cash paid on pickup, added to sales.`
      : `Order ${orderId} → ${STATUS_LABEL[landed] || landed}`, "ok");
    if(typeof initNotifBadge === "function") initNotifBadge();
    return true;
  } catch(err){
    /* A refused tracking number goes under its box (the Update Status popup stays open); others as a toast. */
    const trackErr = err.fields && err.fields.tracking_number;
    if(trackErr && $("#err-tracking")){
      $("#err-tracking").textContent = trackErr;
      $("#status-tracking")?.classList.add("is-invalid");
      $("#status-tracking")?.focus();
    }
    toast(trackErr || err.message, "err");
    return false;
  }
}

/* ===== TRANSACTION HISTORY ===== */
/* Transaction History is server-paged, with count and revenue covering the whole filtered set. */
/* Channel badge for the mixed-channel pages; a walk-in delivery keeps its delivery note in the tooltip. */
function channelBadge(o){
  if(o.type !== "walk-in") return `<span class="badge badge-info">Online</span>`;
  return o.orderType === "delivery"
    ? `<span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked like an online order.">Walk-in · Delivery</span>`
    : `<span class="badge badge-warn">Walk-in</span>`;
}

async function renderHistory(){
  const q    = ($("#history-search")?.value || "").trim();
  const from = $("#history-from")?.value;
  const to   = $("#history-to")?.value;

  const pager = adminState.ordHistoryPager;
  const content = $("#history-content");

  content.innerHTML = `<div class="table-wrap"><table class="data-table"><tbody>${EbUI.loadingRow(9, "Loading transactions…")}</tbody></table></div>`;

  let res;
  try {
    res = await EbApi.get("orders/list.php", {
      /* Every channel unless the Channel filter narrows it (server-side, so paging and the totals follow it). */
      type: $("#history-channel")?.value || null,
      search: q || null,
      from: from || null,
      to: to || null,
      page: pager.page || 1,
      limit: pager.pageSize || 10,
      /* Most recent activity first, so an order completed today tops the list even if placed days ago. */
      sort: "activity",
    });
  } catch(err){
    content.innerHTML = `<div class="table-wrap"><table class="data-table"><tbody>${EbUI.errorRow(9, err.message)}</tbody></table></div>`;
    return;
  }

  const list = res.data;
  const meta = res.meta || {};

  $("#history-stats").innerHTML = `
    <div class="mini-stat"><div class="mini-stat-label">Matching Orders</div><div class="mini-stat-val">${meta.total ?? list.length}</div></div>
    <div class="mini-stat"><div class="mini-stat-label">Total Revenue</div><div class="mini-stat-val gold">${peso(meta.revenue ?? 0)}</div></div>`;

  if(!list.length){
    content.innerHTML = emptyState("No records found","Adjust search or date range");
    return;
  }

  const rows = list.map(o=>{
    const total = orderTotal(o);
    return `<tr>
      <td class="mono-sm">${escHtml(o.id)}</td>
      <td>${channelBadge(o)}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${escHtml(o.email || "—")}</td>
      <td class="muted">${fmtDateTime(o.datetime)}${o.lastActivity && fmtDateTime(o.lastActivity) !== fmtDateTime(o.datetime) ? `<br><span style="font-size:.74rem">Updated ${fmtDateTime(o.lastActivity)}</span>` : ""}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}</td>
      <td style="font-weight:700">${orderDueHtml(o)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td><button class="btn btn-ghost btn-sm" data-view-order="${o.id}">View</button></td>
    </tr>`;
  }).join("");

  /* Rows per page goes in the toolbar row (see mountToolbarControl()). */
  mountToolbarControl("orderhistory", "page-size", `
    <select class="filter-select" id="ord-history-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#history-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Channel</th><th>Customer</th><th>Email</th><th>Date</th><th>Payment</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="ord-history-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="ord-history-pagination" style="margin-left:auto"></div>
    </div>`;
  wireOrderRowActions("#history-content");

  /* Clicking a page asks the server for it. */
  EbPaginate.render("ord-history", meta, page => {
    adminState.ordHistoryPager.page = page;
    renderHistory();
  });
  EbPaginate.wirePageSize("ord-history",
    { get limit(){ return adminState.ordHistoryPager.pageSize; },
      set limit(v){ adminState.ordHistoryPager.pageSize = v; },
      get page(){ return adminState.ordHistoryPager.page; },
      set page(v){ adminState.ordHistoryPager.page = v; } },
    renderHistory);
}

/* ===== RECEIPT GENERATION ===== */
/* Receipt Generation is server-paged and limited to completed orders. */
function renderReceipts(){
  /* Rows per page goes in the toolbar row (see mountToolbarControl()). */
  mountToolbarControl("receipts", "page-size", `
    <select class="filter-select" id="receipts-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#receipts-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Channel</th><th>Customer</th><th>Completed</th><th>Total</th><th>Payment</th><th>Actions</th></tr></thead>
        <tbody id="receipts-tbody"></tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="receipts-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="receipts-pagination" style="margin-left:auto"></div>
    </div>`;

  EbPaginate.list(
    "receipts",
    adminState.receiptsPager,
    () => $("#receipts-tbody"),
    (page, limit) => EbApi.get("orders/list.php", {
      page, limit, type: $("#receipt-channel")?.value || null, status: "completed", sort: "completed",
      search: $("#receipt-search")?.value || null,
    }),
    o => `<tr>
      <td class="mono-sm">${escHtml(o.id)}</td>
      <td>${channelBadge(o)}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${fmtDateTime(o.completedAt || o.datetime)}</td>
      <td style="font-weight:700">${orderDueHtml(o)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}</td>
      <td><div class="td-actions">
        <button class="btn btn-gold btn-sm" data-receipt-order="${o.id}">Generate Receipt</button>
        <button class="btn btn-ghost btn-sm" data-view-order="${o.id}">View</button>
      </div></td>
    </tr>`,
    {
      colspan: 7,
      empty: { title: "No Completed Orders", hint: "Completed orders will appear here" },
      after: (rows) => {
        /* Merge the page into ORDERS before wiring the receipt buttons. */
        rows.forEach(r => {
          const i = ORDERS.findIndex(o => o.id === r.id);
          if(i > -1) ORDERS[i] = r; else ORDERS.push(r);
        });
        wireOrderRowActions("#receipts-content");
        $$("#receipts-content [data-receipt-order]").forEach(btn=>{
          btn.addEventListener("click", ()=> openReceipt(btn.dataset.receiptOrder));
        });
      },
    }
  );

  if($("#receipt-search") && !$("#receipt-search").dataset.wired){
    $("#receipt-search").dataset.wired = "1";
    $("#receipt-search").addEventListener("input", debounce(()=>{
      adminState.receiptsPager.page = 1;
      renderReceipts();
    }, 300));
  }
}


function openReceipt(orderId){
  const o = ORDERS.find(o=>o.id===orderId);
  if(!o) return;
  /* Line amounts use the price at purchase (EbInvoice.fromOrder()). */
  const invoice = EbInvoice.fromOrder(o);
  EbInvoice.ensureStyles();

  /* Workflow facts the paper form has no place for — shown here, not printed. */
  const notes = [
    `Status <b>${escHtml(STATUS_LABEL[o.status] || o.status)}</b>`,
    `Paid by <b>${escHtml(payMethodLabel(o.payMethod))}</b>`,
  ];
  if(o.proof && o.proof.refNum) notes.push(`Ref # <b>${escHtml(o.proof.refNum)}</b>`);

  openModal({
    title: "Sales Invoice — " + orderId,
    large: true,
    body: `<div class="invoice-till-note">${notes.join('<span aria-hidden="true">·</span>')}</div>
      ${EbInvoice.render(invoice)}`,
    confirmLabel:"Print", confirmClass:"btn-ghost", cancelLabel:"Close",
    onConfirm(){ EbInvoice.print(invoice); }
  });
}

/* ===== RETURN MODULE ===== */
const RETURN_TABS = [
  {id:"all",       label:"All Requests"},
  {id:"received",  label:"Received"},
  {id:"validated", label:"Validated"},
  {id:"eligible",  label:"Eligible"},
  {id:"approved",  label:"Approved"},
  {id:"rejected",  label:"Rejected"},
  {id:"processed", label:"Processed"},
];

/* Advance a return via api/returns/advance.php, which enforces the pipeline, reasons and refund limits (returned goods are not restocked); returns true on success. */
async function advanceReturn(id, status, extra = {}){
  try {
    const { data } = await EbApi.post("returns/advance.php", { id, status, ...extra });
    await loadOpsData();
    return true;
  } catch(err){
    toast(err.message, "err");
    return false;
  }
}

function renderReturns(){
  renderLargeRefundBar();
  const tabsEl = $("#return-tabs");
  tabsEl.innerHTML = RETURN_TABS.map(t=>{
    const count = t.id==="all" ? RETURNS.length : RETURNS.filter(r=>r.status===t.id).length;
    /* Only unfinished return states show a badge. */
    const b = tabBadge(t.id, t.label, count, "to process");
    return `<button class="return-tab-btn ${adminState.returnTab===t.id?"active":""}" data-returntab="${t.id}"
                    role="tab" aria-selected="${adminState.returnTab===t.id}"
                    aria-label="${escHtml(b.aria)}">${b.html}</button>`;
  }).join("");
  $$("#return-tabs .return-tab-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{ adminState.returnTab = btn.dataset.returntab; if(adminState.returnPager) adminState.returnPager.page = 1; renderReturns(); });
  });

  const tab = adminState.returnTab;
  const q   = ($("#return-search")?.value || "").toLowerCase();
  const list = (tab==="all" ? RETURNS : RETURNS.filter(r=>r.status===tab))
    .filter(r=> !q ||
      r.id.toLowerCase().includes(q) ||
      r.orderId.toLowerCase().includes(q) ||
      r.customer.toLowerCase().includes(q) ||
      (r.items || []).some(it => (it.name || "").toLowerCase().includes(q)) ||
      r.productName.toLowerCase().includes(q));

  if(!list.length){
    $("#returns-content").innerHTML = emptyState("No returns found","Try a different search term or filter");
    return;
  }

  /* Client-side paging and sort, since RETURNS is fully loaded. */
  const pg = adminState.returnPager || (adminState.returnPager = { page: 1, limit: 10, sort: "newest" });
  /* Mount the toolbar controls once to avoid flicker. */
  if(!$("#ret-sort")) mountToolbarControl("returns", "paging", `
    <select class="filter-select" id="ret-sort" aria-label="Sort returns">
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="customer">Customer A–Z</option>
      <option value="refund">Refund high–low</option>
    </select>
    <select class="filter-select" id="ret-page-size" aria-label="Rows per page">
      <option value="10">10 per page</option>
      <option value="25">25 per page</option>
      <option value="50">50 per page</option>
    </select>`);
  const sortSel = $("#ret-sort"), sizeSel = $("#ret-page-size");
  if(sortSel && !sortSel.dataset.wired){
    sortSel.dataset.wired = "1";
    sortSel.addEventListener("change", ()=>{ pg.sort = sortSel.value; pg.page = 1; renderReturns(); });
    sizeSel.addEventListener("change", ()=>{ pg.limit = Number(sizeSel.value) || 10; pg.page = 1; renderReturns(); });
  }
  if(sortSel) sortSel.value = pg.sort;
  if(sizeSel) sizeSel.value = String(pg.limit);

  /* Return IDs are RET-YYYYMMDD-NNN, so the ID sorts by date. */
  const sorted = [...list].sort((x,y)=>
    pg.sort === "oldest"   ? x.id.localeCompare(y.id) :
    pg.sort === "customer" ? x.customer.localeCompare(y.customer) :
    pg.sort === "refund"   ? (y.refundAmount||0) - (x.refundAmount||0) :
                             y.id.localeCompare(x.id));
  const pages = Math.max(1, Math.ceil(sorted.length / pg.limit));
  if(pg.page > pages) pg.page = pages;
  const pageRows = sorted.slice((pg.page - 1) * pg.limit, pg.page * pg.limit);

  /* The full return card opens in a modal from View. */
  $("#returns-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Return ID</th><th>Customer</th><th>Order ID</th><th>Items</th><th>Units</th><th>Refund</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${pageRows.map(r=>`<tr>
          <td class="mono-sm">${escHtml(r.id)}</td>
          <td>${escHtml(r.customer)}</td>
          <td class="mono-sm">${escHtml(r.orderId)}</td>
          <td>${escHtml(returnItemsSummary(r))}</td>
          <td>${r.qty}</td>
          <td style="font-weight:700">${r.refundAmount ? peso(r.refundAmount) : "—"}</td>
          <td>${returnStatusChip(r)}</td>
          <td><button class="btn btn-ghost btn-sm" data-view-ret="${escHtml(r.id)}">View</button></td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="ret-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="ret-pagination" style="margin-left:auto"></div>
    </div>`;
  EbPaginate.render("ret", { page: pg.page, limit: pg.limit, total: sorted.length, pages },
    p => { pg.page = p; renderReturns(); });
  $$("#returns-content [data-view-ret]").forEach(btn=> btn.addEventListener("click", ()=>openReturnDetail(btn.dataset.viewRet)));
}

/* A request can carry several products (customer requests, migration 016). */
function returnItemsSummary(r){
  const items = r.items && r.items.length ? r.items : [{ name: r.productName }];
  return items[0].name + (items.length > 1 ? ` +${items.length - 1} more` : "");
}

/* Show how long after completion the request came in. */
function returnWindowNote(r){
  if(!r.orderCompletedAt || !r.receivedDate) return "—";
  const h = (new Date(r.receivedDate.replace(" ","T")) - new Date(r.orderCompletedAt.replace(" ","T"))) / 36e5;
  const txt = h < 1 ? `${Math.max(1, Math.round(h*60))} min` : `${Math.round(h)} h`;
  return h <= 24
    ? `<span style="color:var(--ok-ink)">✓ ${txt} after completion</span>`
    : `<span style="color:var(--out-ink)">⚠ ${txt} after completion</span>`;
}

/* Where the customer asked for the refund to go (GCash / bank, migration 017). */
function returnRefundToRows(r){
  const t = r.refundTo;
  if(!t) return `<p class="muted" style="margin:0;font-size:.86rem">No refund account given — contact the customer.</p>`;
  const row = (k, v) => `<div class="detail-row"><span class="detail-row-label">${k}</span><span class="detail-row-val">${v}</span></div>`;
  return row("Method", t.method === "bank" ? "Bank Transfer" : "GCash")
    + (t.bankName ? row("Bank", escHtml(t.bankName)) : "")
    + row("Account Name", escHtml(t.accountName || "—"))
    + row(t.method === "bank" ? "Account Number" : "GCash Number", t.accountNumber ? `<code>${escHtml(t.accountNumber)}</code>` : "—")
    + (t.qr ? `<a href="${escHtml(imageUrl(t.qr))}" target="_blank" rel="noopener noreferrer" title="Open QR full size">
         <img src="${escHtml(imageUrl(t.qr))}" alt="Customer's refund QR code" style="width:140px;height:140px;object-fit:contain;border-radius:8px;border:1px solid var(--border);margin-top:8px;background:#fff"></a>` : "");
}

function returnStatusChip(r){
  const chipStatus = r.status==="processed" ? "completed" : r.status==="ineligible"||r.status==="rejected" ? "cancelled" : r.status==="approved"||r.status==="eligible" ? "accepted" : r.status==="received"?"pending":r.status;
  const statusLabel = {received:"Received",validated:"Validated",eligible:"Eligible",ineligible:"Ineligible",approved:"Approved",rejected:"Rejected",processed:"Processed"}[r.status] || r.status;
  return `<span class="status-chip status-${chipStatus}">${statusLabel}</span>` +
    (isLargeRefund(r) && r.status !== "ineligible" && r.status !== "rejected" ? ` <span class="ret-large-chip" title="At or above the large-refund threshold">Large</span>` : "");
}

/* The full return card in a modal; its actions open step modals. */
function openReturnDetail(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  openModal({
    title: `Return — ${r.id}`,
    large: true,
    cancelLabel: null, confirmLabel: null,   /* the header × closes it */
    body: renderReturnCard(r),
    onOpen(){
      $("#modal").classList.add("modal-xl");   /* reset by the next openModal */
      wireReturnActions("#modal-body");
    },
  });
}

/* View popup: header, then cards for progress, the return, notes and next step. */
function renderReturnCard(r){
  const step = RETURN_STATUS_STEP[r.status] || 1;
  const steps = RETURN_STEPS.map((s,i)=>{
    const n = i+1;
    const cls = n<step?"done":n===step?"active":"";
    return `<div class="return-step ${cls}"><div class="step-num">${n<step?"✓":n}</div><span class="step-label">${s}</span></div>`;
  }).join("");
  const actions = returnActions(r);
  const row = (label, val) => `<div class="detail-row"><span class="detail-row-label">${label}</span><span class="detail-row-val">${val}</span></div>`;

  return `
    <div class="ret-detail">
      <div class="ret-detail-head">
        <div>
          <div class="ret-detail-customer">${escHtml(r.customer)}</div>
          <div class="muted ret-detail-sub">${escHtml(r.id)} · Order ${escHtml(r.orderId)}</div>
        </div>
        ${returnStatusChip(r)}
      </div>

      <div class="order-detail-section">
        <div class="order-detail-heading">Progress</div>
        <div class="return-step-indicator ret-stepper">${steps}</div>
      </div>

      <div class="order-detail-section">
        <div class="order-detail-heading">Return Details</div>
        <div class="ret-detail-grid">
          <div>
            ${row("Request Type", r.scope === "whole" ? "Whole order" : "Selected items")}
            ${row("Contact", escHtml(r.phone || "—"))}
            ${row("Purchase Date", fmtDate(r.purchaseDate))}
            ${r.batchCode ? row("Batch Code", `<code>${escHtml(r.batchCode)}</code>`) : ""}
          </div>
          <div>
            ${row("Requested", r.receivedDate ? fmtDateTime(r.receivedDate) : "—")}
            ${row("Return Window", returnWindowNote(r))}
            ${r.refundAmount ? row(r.status === "processed" ? "Refunded" : "Refund Amt.", `<span style="color:var(--gold-ink)">${peso(r.refundAmount)}</span>`) : ""}
            ${r.refundMethod ? row("Refund Via", escHtml(payMethodLabel(r.refundMethod))) : ""}
          </div>
        </div>
      </div>

      <div class="order-detail-section">
        <div class="order-detail-heading">Items Returned · ${r.qty} ${r.qty === 1 ? "unit" : "units"}</div>
        <div class="order-items-list">${(r.items || []).map(it => `
          <div class="order-item-row">
            <span class="order-item-name">${escHtml(it.name)}${it.batchCode ? ` <span class="badge badge-muted" title="Batch / lot code">Batch ${escHtml(it.batchCode)}</span>` : ""}</span>
            <span class="order-item-qty">×${it.qty}</span>
            <span class="order-item-sub">${peso(it.subtotal)}</span>
          </div>`).join("")}
        </div>
        <div class="detail-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:10px;font-weight:700">
          <span class="detail-row-label">Total Paid for Items</span>
          <span class="detail-row-val" style="color:var(--gold-ink)">${peso((r.items || []).reduce((n, it) => n + (it.subtotal || 0), 0))}</span>
        </div>
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Refund To</div>
        ${returnRefundToRows(r)}
      </div>
${r.refundReceipt ? `
      <div class="order-detail-section" style="border-left:3px solid var(--ok)">
        <div class="order-detail-heading">Refund Receipt</div>
        <a class="proof-shot" href="${escHtml(imageUrl(r.refundReceipt))}" target="_blank" rel="noopener noreferrer" title="Open full size">
          <img src="${escHtml(imageUrl(r.refundReceipt))}" alt="Refund receipt for ${escHtml(r.id)}" loading="lazy"
               style="max-width:100%;max-height:240px;border-radius:8px;display:block">
        </a>
      </div>` : ""}
${r.proofImage ? `
      <div class="order-detail-section">
        <div class="order-detail-heading">Customer's Photo</div>
        <a class="proof-shot" href="${escHtml(imageUrl(r.proofImage))}" target="_blank" rel="noopener noreferrer" title="Open full size">
          <img src="${escHtml(imageUrl(r.proofImage))}" alt="Return photo for ${escHtml(r.id)}" loading="lazy"
               style="max-width:100%;max-height:240px;border-radius:8px;display:block">
        </a>
        <div class="proof-status uploaded" style="margin-top:6px">Click to open full size</div>
      </div>` : ""}

      <div class="order-detail-section">
        <div class="order-detail-heading">Notes</div>
        <div class="return-reason ${r.status==="rejected"?"rejected-reason":""}"><strong>Customer Reason</strong>${escHtml(r.reason)}</div>
        ${r.notes ? `<div class="return-reason staff-notes"><strong>Staff Notes</strong>${escHtml(r.notes)}</div>` : ""}
        ${r.rejectedReason ? `<div class="return-reason rejected-reason"><strong>Rejection Reason</strong>${escHtml(r.rejectedReason)}</div>` : ""}
      </div>

      ${actions ? `<div class="ret-detail-actions">${actions}</div>` : ""}
    </div>`;
}

/* Large refunds (api/returns/advance.php enforces this). */
function isLargeRefund(r){
  const lr = adminState.largeRefund;
  return !!(lr && lr.threshold > 0 && (+r.refundAmount || 0) >= lr.threshold);
}
function largeRefundBlocked(r){
  return isLargeRefund(r) && !(adminState.largeRefund && adminState.largeRefund.canHandle);
}
function largeRefundNote(){
  return `<span class="ret-large-note">Large refund (${peso(adminState.largeRefund.threshold)}+): needs an Admin or the Super Admin.</span>`;
}

/* Super Admin sets the limit; everyone else sees it. */
function renderLargeRefundBar(){
  const el = $("#ret-limit");
  const lr = adminState.largeRefund;
  if(!el) return;
  if(!lr){ el.innerHTML = ""; return; }
  const txt = lr.threshold > 0
    ? `Refunds of <b>${peso(lr.threshold)}</b> or more need an Admin or the Super Admin.`
    : `No large-refund limit is set.`;
  el.innerHTML = `<span class="ret-limit-ic" aria-hidden="true">₱</span><span class="ret-limit-txt">${txt}</span>` +
    (lr.canSetLimit ? `<button type="button" class="btn btn-ghost btn-sm" id="ret-limit-edit">Change limit</button>` : "");
  $("#ret-limit-edit")?.addEventListener("click", ()=>{
    openModal({
      title: "Large Refund Threshold",
      body: `<p style="font-size:.86rem;color:var(--text-muted);margin-bottom:12px">Refunds at or above this amount can only be approved and processed by an Admin or the Super Admin. Set 0 for no limit.</p>
        <div class="field"><label for="ret-limit-input">Threshold (₱)</label><input class="control" type="number" id="ret-limit-input" min="0" step="0.01" value="${lr.threshold}"/></div>`,
      confirmLabel: "Save", confirmClass: "btn-gold",
      async onConfirm(){
        const v = parseFloat($("#ret-limit-input").value);
        if(!(v >= 0)){ toast("Enter 0 or a positive amount","err"); return; }
        try {
          const { data } = await EbApi.post("settings/save.php", { refund_large_threshold: v });
          lr.threshold = data.refund_large_threshold;
          toast("Large refund threshold saved","ok");
          closeModal(); renderReturns();
        } catch(err){ toast(err.message, "err"); }
      }
    });
  });
}

function returnActions(r){
  if((r.status === "eligible" || r.status === "approved") && largeRefundBlocked(r)) return largeRefundNote();
  switch(r.status){
    case "received":  return `<button class="btn btn-gold btn-sm" data-validate-ret="${r.id}">Validate Customer & Order</button>`;
    case "validated": return `
      <button class="btn btn-gold btn-sm" data-eligible-ret="${r.id}">Mark Eligible</button>
      <button class="btn btn-ghost-danger btn-sm" data-ineligible-ret="${r.id}">Mark Ineligible</button>`;
    case "eligible":   return `<button class="btn btn-gold btn-sm" data-approve-ret="${r.id}">Approve Return</button>`;
    case "ineligible": return `<button class="btn btn-ghost-danger btn-sm" data-reject-ret="${r.id}">Formally Reject</button>`;
    case "approved":   return `<button class="btn btn-gold btn-sm" data-refund-ret="${r.id}">Process Refund</button>`;
    default: return "";
  }
}

function wireReturnActions(scope = "#returns-content"){
  $$(`${scope} [data-validate-ret]`).forEach(btn=> btn.addEventListener("click", ()=>validateReturn(btn.dataset.validateRet)));
  $$(`${scope} [data-eligible-ret]`).forEach(btn=> btn.addEventListener("click", ()=>markEligible(btn.dataset.eligibleRet)));
  $$(`${scope} [data-ineligible-ret]`).forEach(btn=> btn.addEventListener("click", ()=>markIneligible(btn.dataset.ineligibleRet)));
  $$(`${scope} [data-approve-ret]`).forEach(btn=> btn.addEventListener("click", ()=>approveReturn(btn.dataset.approveRet)));
  $$(`${scope} [data-reject-ret]`).forEach(btn=> btn.addEventListener("click", ()=>rejectReturn(btn.dataset.rejectRet)));
  $$(`${scope} [data-refund-ret]`).forEach(btn=> btn.addEventListener("click", ()=>processRefund(btn.dataset.refundRet)));
}

/* The audit row is written by returns/advance.php; this only raises the UI notification. */
function addReturnAudit(returnId, status, notes){
  addAuditEntry("order", `Return ${returnId} → ${status}.${notes?` ${notes}.`:""}`);
}

function validateReturn(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  const o = ORDERS.find(o=>o.id===r.orderId);
  openModal({
    title:"Validate Customer & Order",
    body:`
      <div class="order-detail-section">
        <div class="order-detail-heading">Return Request</div>
        <div class="detail-row"><span class="detail-row-label">Customer</span><span class="detail-row-val">${escHtml(r.customer)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Email</span><span class="detail-row-val">${escHtml(r.email)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Phone</span><span class="detail-row-val">${escHtml(r.phone)}</span></div>
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Order Verification</div>
        <div class="detail-row"><span class="detail-row-label">Order ID</span><span class="detail-row-val">${escHtml(r.orderId)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Order Found</span><span class="detail-row-val" style="color:var(--ok-ink)">${o?"✓ Confirmed":"✗ Not found"}</span></div>
        <div class="detail-row"><span class="detail-row-label">Items</span><span class="detail-row-val">${escHtml(returnItemsSummary(r))} · ${r.qty} ${r.qty === 1 ? "unit" : "units"}</span></div>
        <div class="detail-row"><span class="detail-row-label">Return Window</span><span class="detail-row-val">${returnWindowNote(r)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Purchase Date</span><span class="detail-row-val">${fmtDate(r.purchaseDate)}</span></div>
      </div>
      <div class="field"><label>Validation Notes</label><input class="control" id="validate-notes" value="Order ID confirmed, product batch verified"/></div>`,
    confirmLabel:"Confirm Validation", confirmClass:"btn-gold",
    async onConfirm(){
      const notes = $("#validate-notes").value.trim();
      if(await advanceReturn(returnId, "validated", { note: notes })){
        toast("Return validated","ok");
        closeModal(); renderReturns();
      }
    }
  });
}

function markEligible(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  openModal({
    title:"Check Eligibility — Eligible",
    body:`<p style="font-size:.86rem;color:var(--text-muted);margin-bottom:12px">Confirm this return is eligible for a refund. Enter any relevant notes:</p>
      <div class="field"><textarea class="control" id="elig-notes" rows="3">${escHtml(r.notes)}</textarea></div>
      <div class="field"><label>Refund Amount (₱)</label><input class="control" type="number" id="elig-amount" min="0" value="${r.refundAmount}"/></div>`,
    confirmLabel:"Mark Eligible", confirmClass:"btn-gold",
    async onConfirm(){
      const notes = $("#elig-notes").value.trim();
      const amount = parseFloat($("#elig-amount").value) || r.refundAmount;
      if(!await advanceReturn(returnId, "eligible", { note: notes, refund_amount: amount })) return;
      addReturnAudit(returnId, "eligible", notes);
      toast("Return marked eligible","ok");
      closeModal(); renderReturns();
    }
  });
}

function markIneligible(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  openModal({
    title:"Check Eligibility — Ineligible",
    body:`<p style="font-size:.86rem;color:var(--text-muted);margin-bottom:12px">Reason this return does not qualify:</p>
      <div class="field"><textarea class="control" id="inelig-reason" rows="3" placeholder="e.g. Product returned outside 7-day window"></textarea></div>`,
    confirmLabel:"Mark Ineligible", confirmClass:"btn-red",
    async onConfirm(){
      const reason = $("#inelig-reason").value.trim();
      if(!reason){ toast("Enter a reason","err"); return; }
      if(!await advanceReturn(returnId, "ineligible", { rejected_reason: reason })) return;
      addReturnAudit(returnId, "ineligible", reason);
      toast("Return marked ineligible","warn");
      closeModal(); renderReturns();
    }
  });
}

function approveReturn(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  openModal({
    title:"Approve Return",
    body:`<div class="detail-row" style="margin-bottom:12px"><span class="detail-row-label">Refund Amount</span><span class="detail-row-val" style="color:var(--gold-ink)">${peso(r.refundAmount)}</span></div>
      <div class="field"><label>Approval Notes</label><input class="control" id="approve-notes" placeholder="e.g. Approved: manufacturing defect — broken seal"/></div>`,
    confirmLabel:"Approve Return", confirmClass:"btn-gold",
    async onConfirm(){
      const notes = $("#approve-notes").value.trim() || "Return approved";
      if(!await advanceReturn(returnId, "approved", { note: notes })) return;
      addReturnAudit(returnId, "approved", notes);
      toast("Return approved","ok");
      closeModal(); renderReturns();
    }
  });
}

function rejectReturn(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  openModal({
    title:"Formally Reject Return",
    body:`<p style="font-size:.86rem;color:var(--text-muted);margin-bottom:12px">Final rejection reason for the record:</p>
      <div class="field"><textarea class="control" id="reject-final-reason" rows="3">${escHtml(r.rejectedReason)}</textarea></div>`,
    confirmLabel:"Reject Return", confirmClass:"btn-red",
    async onConfirm(){
      const reason = $("#reject-final-reason").value.trim() || r.rejectedReason;
      if(!await advanceReturn(returnId, "rejected", { rejected_reason: reason })) return;
      addReturnAudit(returnId, "rejected", reason);
      toast("Return rejected and recorded","warn");
      closeModal(); renderReturns();
    }
  });
}

function processRefund(returnId){
  const r = RETURNS.find(r=>r.id===returnId);
  if(!r) return;
  const pref = r.refundTo ? r.refundTo.method : "gcash";
  let receipt = null;   /* path from api/uploads/image.php, purpose "refunds" */
  openModal({
    title:"Process Refund",
    body:`<div class="detail-row"><span class="detail-row-label">Customer</span><span class="detail-row-val">${escHtml(r.customer)}</span></div>
      <div class="detail-row" style="margin-bottom:12px"><span class="detail-row-label">Refund Amount</span><span class="detail-row-val" style="color:var(--gold-ink)">${peso(r.refundAmount)}</span></div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Send To</div>
        ${returnRefundToRows(r)}
      </div>
      <div class="field"><label for="refund-method">Refund Method</label>
        <select class="control" id="refund-method">
          <option value="gcash" ${pref==="gcash"?"selected":""}>GCash</option>
          <option value="bank" ${pref==="bank"?"selected":""}>Bank Transfer</option>
        </select>
      </div>
      <div class="field"><label for="refund-receipt">Transfer Receipt <span style="color:var(--out)">*</span></label>
        <input class="control" id="refund-receipt" type="file" accept="image/png,image/jpeg,image/webp">
        <div class="muted" style="font-size:.78rem;margin-top:4px">Screenshot of the completed GCash / bank transfer. The customer sees this as proof of refund.</div>
        <img id="refund-receipt-preview" alt="Receipt preview" class="hide" style="max-width:100%;max-height:200px;border-radius:8px;margin-top:8px;display:block">
        <div class="field-error" id="refund-receipt-err" style="color:var(--out-ink);font-size:.8rem"></div>
      </div>
      <div class="field"><label for="refund-notes">Transaction Notes</label><input class="control" id="refund-notes" placeholder="e.g. GCash ref 1234 5678 90"/></div>`,
    confirmLabel:"Confirm Refund Processed", confirmClass:"btn-gold",
    onOpen(){
      const inp = $("#refund-receipt"), prev = $("#refund-receipt-preview"), err = $("#refund-receipt-err");
      inp.addEventListener("change", async ()=>{
        const file = inp.files && inp.files[0];
        if(!file) return;
        err.textContent = "Uploading…"; receipt = null;
        try {
          const data = await EbApi.upload(file, "refunds");
          receipt = data.path;
          prev.src = imageUrl(receipt); prev.classList.remove("hide");
          err.textContent = "";
        } catch(e){ err.textContent = e.message; prev.classList.add("hide"); }
      });
    },
    async onConfirm(){
      if(!receipt){ $("#refund-receipt-err").textContent = "Upload the transfer receipt first."; return; }
      const method = $("#refund-method").value;
      const notes = $("#refund-notes").value.trim() || `Refund ${peso(r.refundAmount)} via ${payMethodLabel(method)}`;
      if(!await advanceReturn(returnId, "processed",
            { refund_method: method, refund_amount: r.refundAmount, refund_receipt: receipt, note: notes })) return;
      addReturnAudit(returnId, "processed", notes);
      toast(`Refund of ${peso(r.refundAmount)} processed`, "ok");
      closeModal(); renderReturns();
    }
  });
}

/* ===== ORDER DETAIL MODAL (shared by Transactions, Queue, Status, History) ===== */
/* Fill the History panel from api/orders/get.php (who changed each status and when). */
async function fillOrderHistory(orderId){
  const box = document.getElementById("order-history-body");
  if(!box) return;
  try {
    const { data } = await EbApi.get("orders/get.php", { id: orderId });
    if(!data.history || !data.history.length){
      box.innerHTML = `<span class="muted">No recorded status changes — this order has not moved since it was placed.</span>`;
    } else {
      box.innerHTML = data.history.map(h => `
        <div class="detail-row">
          <span class="detail-row-label">${fmtDateTime(h.at)}</span>
          <span class="detail-row-val">${escHtml(STATUS_LABEL[h.from] || h.from || "placed")} → <strong>${escHtml(STATUS_LABEL[h.to] || h.to)}</strong>
            <span class="muted"> by ${escHtml(h.by)}</span>
            ${h.note ? `<br><span class="muted">${escHtml(h.note)}</span>` : ""}</span>
        </div>`).join("");
    }
    /* Flag a stored total that does not match its line items. */
    if(data.totalsAgree === false){
      box.innerHTML += `<div class="detail-row" style="color:var(--out-ink)">
        <span class="detail-row-label">Warning</span>
        <span class="detail-row-val">Stored total ${peso(data.total)} does not match its line items (${peso(data.computedTotal)}).</span></div>`;
    }
  } catch(err){
    box.innerHTML = `<span class="muted">Could not load history: ${escHtml(err.message)}</span>`;
  }
}

function openOrderDetail(orderId){
  const o = ORDERS.find(o=>o.id===orderId);
  if(!o) return;
  /* Before the retailer discount; the discount and Amount due rows follow it. */
  const total = orderGross(o);
  const itemRows = o.items.map(it=>{
    const p = getProduct(it.id);
    /* it.price is price_at_purchase, never the current product price. */
    const unit = it.price != null ? it.price : (p ? p.price : null);
    /* One row per batch the units came from (its own qty and subtotal); a line with no batch stays one row. */
    const name = escHtml(it.name || (p ? p.name : it.id));
    const lots = (it.lots || []).filter(l => l.lot);
    const parts = lots.map(l => ({ lot: l.lot, qty: l.qty }));
    const rest = it.qty - parts.reduce((n, x) => n + x.qty, 0);
    if(rest > 0) parts.push({ lot: null, qty: rest });
    return parts.map(x => `<div class="order-item-row">
      <span class="order-item-name">${name}${x.lot ? ` <span class="badge badge-muted" title="Batch / lot code">Batch ${escHtml(x.lot)}</span>` : ""}</span>
      <span class="order-item-qty">×${x.qty}</span>
      <span class="order-item-sub">${unit != null ? peso(unit * x.qty) : "—"}</span>
    </div>`).join("");
  }).join("");

  openModal({
    title:`Order Detail — ${orderId}`,
    large:true,
    body:`
      <div class="order-detail-section">
        <div class="order-detail-heading">Customer</div>
        <div class="detail-row"><span class="detail-row-label">Name</span><span class="detail-row-val">${escHtml(o.customer)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Email</span><span class="detail-row-val">${escHtml(o.email)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Phone</span><span class="detail-row-val">${escHtml(o.contact || o.phone || "—")}</span></div>
        <div class="detail-row"><span class="detail-row-label">Address</span><span class="detail-row-val">${escHtml(o.address || "—")}</span></div>
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Items</div>
        <div class="order-items-list">${itemRows}</div>
        ${o.tax && o.tax.shipping ? `<div class="detail-row" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
          <span class="detail-row-label">Estimated Delivery Fee <span class="muted" style="font-size:.78rem">${escHtml([o.tax.shipping.destination, o.tax.shipping.weightKg != null ? (+o.tax.shipping.weightKg).toFixed(2) + " kg" : ""].filter(Boolean).join(" · "))}</span></span>
          <span class="detail-row-val">${EbFormat.pesoExact(o.tax.shipping.fee)}</span>
        </div>
        ${o.tax.shipping.etaFrom ? `<div class="detail-row"><span class="detail-row-label">Estimated Arrival${o.tax.shipping.remote ? ' <span class="muted" style="font-size:.78rem">Island / remote area</span>' : ""}</span>
          <span class="detail-row-val">${escHtml(etaText({ from: o.tax.shipping.etaFrom, to: o.tax.shipping.etaTo }))}</span></div>` : ""}` : ""}
        <div class="detail-row" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;font-weight:700">
          <span class="detail-row-label">Total</span>
          <span class="detail-row-val" style="color:var(--gold-ink);font-size:1.1rem">${peso(total)}</span>
        </div>
        ${o.tax && (o.tax.withholdingTax > 0 || o.tax.termInterest > 0) ? `
        ${o.tax.withholdingTax > 0 ? `<div class="detail-row"><span class="detail-row-label">Retailer discount</span><span class="detail-row-val">− ${EbFormat.pesoExact(o.tax.withholdingTax)}</span></div>` : ""}
        ${o.tax.termInterest > 0 ? `<div class="detail-row"><span class="detail-row-label">Interest (${escHtml(payMethodLabel(o.payMethod))}, ${+o.tax.termInterestRate}%)</span><span class="detail-row-val">+ ${EbFormat.pesoExact(o.tax.termInterest)}</span></div>` : ""}
        <div class="detail-row" style="font-weight:700"><span class="detail-row-label">Amount due</span>
          <span class="detail-row-val" style="color:var(--gold-ink);font-size:1.1rem">${EbFormat.pesoExact(o.tax.amountDue)}</span></div>` : ""}
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Payment</div>
        <div class="detail-row"><span class="detail-row-label">Method</span><span class="detail-row-val">${escHtml(payMethodLabel(o.payMethod))}</span></div>
        ${o.credit ? "" : `<div class="detail-row"><span class="detail-row-label">Proof Uploaded</span><span class="detail-row-val" style="color:${o.proof.uploaded?"var(--ok)":"var(--out)"}">${o.proof.uploaded?"✓ Yes":"✗ No"}</span></div>`}
        ${o.proof.refNum ? `<div class="detail-row"><span class="detail-row-label">Reference #</span><span class="detail-row-val"><code>${escHtml(o.proof.refNum)}</code></span></div>` : ""}
        ${o.proof.image ? `<div class="detail-row"><span class="detail-row-label">Payment Screenshot</span><span class="detail-row-val">${proofImageBlock(o)}</span></div>` : ""}
        ${o.trackingNumber ? `<div class="detail-row"><span class="detail-row-label">Tracking #</span><span class="detail-row-val"><code>${escHtml(o.trackingNumber)}</code></span></div>` : ""}
        ${o.deliveredAt ? `<div class="detail-row"><span class="detail-row-label">Delivered</span><span class="detail-row-val">${fmtDateTime(o.deliveredAt)}</span></div>` : ""}
        ${o.credit
          /* Net orders show their instalment status instead of "Pending". */
          ? `<div class="detail-row"><span class="detail-row-label">Payment</span><span class="detail-row-val">On ${escHtml(o.credit.scheme)} terms · ${peso(o.credit.paidAmount)} of ${peso(o.credit.owed)} paid${o.credit.settled ? " — settled" : ` · ${peso(o.credit.remaining)} left, due ${fmtDate(o.credit.dueDate)}`}</span></div>`
          : `<div class="detail-row"><span class="detail-row-label">Verified</span><span class="detail-row-val" style="color:${o.payVerified?"var(--ok)":"var(--text-muted)"}">${o.payVerified?"✓ Verified":"Pending"}</span></div>`}
      </div>
      <div class="order-detail-section">
        <div class="order-detail-heading">Status</div>
        <div class="detail-row"><span class="detail-row-label">Current</span><span class="detail-row-val">${statusChip(o.status)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Date Placed</span><span class="detail-row-val">${fmtDateTime(o.datetime)}</span></div>
        ${o.notes ? `<div class="detail-row"><span class="detail-row-label">Notes</span><span class="detail-row-val">${escHtml(o.notes)}</span></div>` : ""}
      </div>
      <div class="order-detail-section" id="order-history-section">
        <div class="order-detail-heading">History</div>
        <div id="order-history-body" class="muted" style="font-size:.85rem">${EbUI.skeletonBlock(3)}</div>
      </div>`,
    onOpen: () => fillOrderHistory(orderId),
    confirmLabel: nextStatuses(o).length ? "Update Status" : null,
    confirmClass:"btn-gold", cancelLabel:"Close",
    onConfirm: nextStatuses(o).length ? ()=>{ closeModal(); openStatusModal(orderId); } : undefined,
  });
}
