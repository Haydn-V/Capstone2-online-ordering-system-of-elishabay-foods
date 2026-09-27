"use strict";
/* ============================================================
   ONLINE ORDERS — Notifications, Transactions, Queue, Payment
   Verification, Order Status, History, Receipts, Returns.
   Ported from the former OrdersModule. Reuses engine.js's shared helpers
   ($, $$, peso, escHtml, fmtDate, fmtDateTime, toast, openModal,
   closeModal, getProduct, payMethodLabel, addAuditEntry, dAgo,
   PRODUCTS, ORDERS, RETURNS, NOTIFICATIONS, STATUS_TRANSITIONS,
   STATUS_LABEL, RETURN_STEPS, RETURN_STATUS_STEP, adminState).
   ============================================================ */

/* orderTotal() lived here too, and it was BROKEN AND WINNING.

       function orderTotal(o){
         if(o && typeof o.total === "number" && isFinite(o.total)) return o.total;
         if(typeof orderTotal === "function") return orderTotal(o);   // itself
         return 0;
       }

   The guard `typeof orderTotal === "function"` is always true, so the fallback
   branch called itself for ever. It was plainly meant to delegate somewhere
   else. Worse, this file loads AFTER engine.js, so this copy shadowed the
   correct one in engine.js:504 for the whole portal — both files.

   Reproduced in the running portal before removal:

       orderTotal({total: 123.45})   -> 123.45
       orderTotal({total: null})     -> RangeError: Maximum call stack size exceeded
       orderTotal({total: "245.00"}) -> RangeError: Maximum call stack size exceeded

   The only thing standing between that and a portal-wide crash was every
   endpoint remembering to cast (float) before returning — and a string is
   exactly what PDO hands back for a DECIMAL column when a cast is missed.

   Deleted rather than repaired. engine.js's implementation is strictly better:
   it handles a null order, coerces a numeric string, and falls back to
   txTotal(o.items) with a console.warn instead of silently returning 0. */

/* Put a screen's "rows per page" control into its merged toolbar row.

   THESE WERE A THIRD BAND. Six render functions each opened their content with
   a right-aligned .table-toolbar holding nothing but a page-size select, which
   landed BELOW the tabs-and-filters row as another strip of chrome above the
   table — the stacking Task 2 exists to remove, rebuilt from JavaScript where
   the markup change could not reach it.

   The select cannot simply be moved into the view's HTML: which page sizes are
   offered and which is current are decided at render time. So the render keeps
   owning it and this mounts it into the row instead of into the content.

   Idempotent — a render replaces its own slot rather than appending a second
   one, and creates the filter group only if the screen (a tabs-only one, say)
   has not got one yet. */
function mountToolbarControl(modId, slotName, html){
  const row = document.querySelector(`#mod-${modId} .view-toolbar`);
  if(!row){ return null; }                 /* screen has no merged row — leave it be */
  /* On a screen with tabs the row holds two GROUPS and the control belongs in
     the right-hand one. On a screen without tabs the row IS that group, and
     nesting another inside it added a second auto-margin that fought the
     first — mount straight into the row so the control simply lands after the
     .vt-spacer the view declares. */
  let group = row.classList.contains("view-toolbar-filters")
    ? row
    : row.querySelector(".view-toolbar-filters");
  if(!group){
    group = document.createElement("div");
    group.className = "view-toolbar-filters";
    row.appendChild(group);
  }
  /* A SCREEN'S TABS DO NOT SHARE A SLOT SET.

     Inventory Management mounts different controls per tab — Stock Overview
     wants search + level + page size, Adj. Log wants page size alone. Keyed by
     name only, switching tabs ADDED a slot and left the previous tab's behind,
     so Adj. Log ended up showing Stock Overview's search box as well as its
     own control. Any slot other than the one being mounted is this render's
     responsibility to remove. */
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

/* Was a separate flat-badge renderer used only in tables, while cards
   and modals used statusChip() — same order, two different-looking
   status pills depending on where you saw it, and the table version
   collapsed 7 statuses into 4 colors (accepted/shipping both blue,
   delivered/completed both green). Now delegates to the chip so
   status looks and reads the same everywhere. */
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

/* ============================================================
   NOTIFICATIONS
   ============================================================ */

/* ============================================================
   NOTIFICATION SCOPING  —  who sees what
   ------------------------------------------------------------
   Every portal used to show the same eleven notifications, which
   made the bell useless outside Online Orders: filtering them by
   permission showed Orders 8, Inventory 3 and Cashier ZERO, because
   nothing in the seed concerned POS, payment schemes or sales.

   Two halves to the fix:
     1. NOTIF_PERM maps each type to the permission needed to see it,
        so a role's feed follows from ROLE_PERMISSIONS. Edit a role in
        Roles & Permissions and its notifications change with it —
        there is no second list to keep in sync.
     2. buildDerivedNotifications() generates the alerts Cashier and
        Inventory actually need from live records (PAYMENT_ACCOUNTS,
        BATCHES, ORDERS) instead of hand-written seed rows, so they
        stay true as the data moves. Each becomes a real query once
        there is a database behind this.
   ============================================================ */
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
  /* Only the people who can act on it. A low-rating alert names a customer,
     an order and a complaint, and the one useful response is to open the
     review — which needs reviews.moderate. */
  "review":        "reviews.moderate",
};

/* ============================================================
   NOTIFICATION URGENCY  —  three levels, one ordering
   ------------------------------------------------------------
   Every notification used to be equal: newest-first, and a plain
   count on the bell. An expired batch sorted underneath an order
   somebody had completed an hour later, and nothing in the topbar
   distinguished "three things happened" from "something is on fire".

   THE LEVEL IS NOT DECIDED HERE. Rows from the database carry a
   stored `priority`, written by api/core/Notify.php at the moment
   the event happened. The type->level table below is fetched from
   that same helper (list.php returns it as meta.priorityMap) and is
   used ONLY for the notifications this file derives client-side
   from live records, which have no database row to carry a level.

   The constant is a fallback for the window before the first
   notifications request resolves, and for a load that fails. It is
   the same table PHP holds; if the two ever disagree, PHP wins,
   because it is what actually reaches the ORDER BY.
   ============================================================ */
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

/* Replaced by the server's copy on the first successful load — see
   loadOpsData() in engine.js. */
let NOTIF_PRIORITY_MAP = { ...NOTIF_PRIORITY_FALLBACK };

/* What each level LOOKS LIKE. A label and a glyph as well as a colour,
   because a coloured dot alone is unreadable to anyone who cannot
   separate the hues — and, on a small pill against two different theme
   backgrounds, to plenty of people who can. */
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
  /* The word is inside the pill, not a title or an aria-label, so it is
     there for everyone rather than only for a screen reader or a mouse. */
  return `<span class="notif-level notif-level-${level}">${meta.icon}${meta.label}</span>`;
}

/* THE ONE ORDER. Unread first, then urgency, then newest.

   Mirrors Notify::orderBy() in PHP, and has to: the server already
   returns rows in this order, but the three lists on screen merge those
   rows with the client-derived ones, so the merged array has to be
   re-sorted by the same rule or the derived alerts would land wherever
   concat() put them.

   Unread outranks urgency deliberately. Read state is shared across the
   team, so "read" means somebody handled it — a critical alert already
   dealt with should not sit above the thing that just happened. */
function sortByUrgency(list){
  return [...list].sort((a,b)=>{
    if(a.read !== b.read) return a.read ? 1 : -1;
    const d = NOTIF_LEVELS.indexOf(notifPriority(a)) - NOTIF_LEVELS.indexOf(notifPriority(b));
    if(d !== 0) return d;
    return a.time > b.time ? -1 : a.time < b.time ? 1 : 0;
  });
}

/* Built lazily; rebuilt whenever inventory activity adds an audit row.
   NOTIF_READ remembers which derived alerts have been read, so a rebuild
   doesn't resurrect them as unread. */
let DERIVED_NOTIFS = null;
const NOTIF_READ = new Set();
/* Audit rows raised during this session are unread; the seeded history is
   not, so the badge counts new activity rather than old records. */
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
        /* Explicitly critical, not merely "scheme-due". The level of a
           derived row depends on its STATE, not only its type: a payment
           coming due next week and one that is already late are the same
           type and are not the same problem. Past the due date is money
           the business is owed and is not getting, which is the Critical
           definition. */
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
        /* A failed lot is stock that must not be sold and may already have
           been — the same shape of problem as an expired one. */
        out.push({ id:"nd-qa-"+b.id, type:"batch-qa", priority:"critical", batchId:b.id, read:false,
          time: b.prodDate + " 09:00",
          msg: "Batch " + b.lotCode + " (" + name + ") FAILED lab testing — pulled from sale" });
      } else if(b.labStatus === "pending"){
        out.push({ id:"nd-qa-"+b.id, type:"batch-qa", batchId:b.id, read:true,
          time: b.prodDate + " 09:00",
          msg: "Batch " + b.lotCode + " (" + name + ") is awaiting lab results" });
      }

      /* ALREADY-EXPIRED LOTS ARE NOT DERIVED HERE ANY MORE.

         Stock on the shelf that can no longer be sold is Critical, and a
         Critical alert has to be a durable row: it must survive a page
         load, it must be markable as read by whoever deals with it, and
         it must be orderable by the server. Notify::syncExpiredBatches()
         materialises those on read — see that method for why it is a lazy
         insert rather than a scheduler.

         The 30/90-day warning stays here, because it is a countdown that
         has to be recomputed against today on every render and nothing is
         actually wrong yet. Excluding d < 0 is what keeps the two from
         producing the same alert twice. */
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

  /* --- Cashier: yesterday's takings, from the same ledger the Sales
         Report reads. Walk-in only: that is the till Cashier works. --- */
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

  /* --- Inventory: restock, bulk replenish, stock adjustment and
         archive/restore, read out of the audit log so the Inventory feed
         mirrors what the Audit Log screen records. --- */
  if(typeof AUDIT_LOG !== "undefined"){
    AUDIT_LOG.forEach(function(entry){
      if(auditIsInventoryActivity(entry)){
        out.push(auditToNotification(entry, LIVE_AUDIT_IDS.has(entry.id)));
      }
    });
  }

  return out;
}


/* ------------------------------------------------------------
   INVENTORY ACTIVITY IN THE AUDIT FEED

   Restock, bulk replenish, stock adjustment and archive/restore all
   funnel through addAuditEntry(), so one hook there covers the four
   rather than patching each call site in admin-inventory.js.

   They are matched by audit `type` plus the wording the inventory
   functions already write, so no existing audit types had to be
   renamed — the Audit Log screen keeps working untouched.
   ------------------------------------------------------------ */
const AUDIT_NOTIF_RULES = [
  { type:"restock",   match:/^Replenish \(bulk\)/i,          kind:"replenish" },
  { type:"restock",   match:null,                            kind:"restock"   },
  { type:"product",   match:/^(Archived|Restored) product/i, kind:"archive"   },
  { type:"product",   match:/^(Disposal|Return) ·/i,         kind:"adjust"    },
  { type:"inventory", match:null,                            kind:"inventory" },
];

/* `kind` drives only the icon and its colour. The notification `type`
   stays "audit", so permission scoping and the Audit Log tab are
   unaffected — twelve identical slate shields just read as noise. */
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

/* Wrap addAuditEntry so inventory activity raises a notification the
   moment it happens, without the four callers needing to know. */
if(typeof addAuditEntry === "function"){
  const _addAuditEntry = addAuditEntry;
  addAuditEntry = function(type, desc){
    /* Reads the transient object returned by addAuditEntry rather than
       AUDIT_LOG[0]. It used to take the head of AUDIT_LOG, which only worked
       because addAuditEntry had just pushed a fake row there. */
    const entry = _addAuditEntry(type, desc);
    if(auditIsInventoryActivity(entry)){
      /* Force a rebuild so the new row is picked up by the same derivation
         path as the historical ones — one source of truth, no duplicates. */
      DERIVED_NOTIFS = null;
      LIVE_AUDIT_IDS.add(entry.id);
      if(typeof initNotifBadge === "function") initNotifBadge();
      if(adminState && adminState.currentModule === "notifications" &&
         typeof renderNotifications === "function") renderNotifications();
    }
  };
}

/* Throw away the derived cache so the next read rebuilds it.

   THE CACHE IS BUILT ON FIRST READ, AND THE FIRST READ IS TOO EARLY.
   applySignedInUser() calls initNotifBadge() the moment a session is
   confirmed, which reads the list — at which point PAYMENT_ACCOUNTS,
   BATCHES and ORDERS are still empty, because loadOpsData() has not run.
   DERIVED_NOTIFS was then cached as [] and nothing ever cleared it, so a
   Cashier's overdue-payment alerts and an Inventory user's expiry alerts
   were built from nothing and stayed that way for the whole session.

   That went unnoticed while the dashboard's System Notifications panel
   built its own separate list at render time, after the data had landed —
   it hid the fault by not using this path at all. Now that all three
   readers share one list, the cache has to be invalidated when the records
   it is derived FROM arrive. */
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

/* What the signed-in role is allowed to see. Types with no permission
   mapped are visible to everyone. */
function visibleNotifications(){
  return allNotifications().filter(function(n){
    const perm = NOTIF_PERM[n.type];
    return !perm || (typeof hasPerm !== "function") || hasPerm(perm);
  });
}

/* Today, as the seed data understands it. INV_TODAY lives in
   admin-inventory.js, which loads after this file — resolved at call
   time, not parse time, so the reference is safe. */
function TODAY_ISO(){
  return (typeof INV_TODAY !== "undefined" && INV_TODAY) ? INV_TODAY : "2026-06-17";
}

function initNotifBadge(){
  const unread   = visibleNotifications().filter(n=>!n.read);
  const count    = unread.length;
  const critical = unread.filter(n=> notifPriority(n) === "critical").length;

  const badge = $("#sidebar-notif-badge");
  if(badge) badge.textContent = count > 0 ? count : "";

  /* TWO FACTS, ONE BADGE. The number answers "how many things happened";
     the alert styling answers "is any of it on fire". Someone glancing at
     the topbar needs the second without opening anything, and the count
     alone never gave it — nine completed orders and one out-of-stock
     product both read as a number in a red circle.

     The count stays visible in both states rather than being replaced by
     the critical count, because "1" when nine things are waiting would be
     a worse lie than the one being fixed. The title and aria-label spell
     the split out, since a border colour is not a fact anyone should have
     to infer. */
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
  /* Same order as the module and the dashboard panel, from the same
     function — the dropdown used to sort by time alone, which put a
     completed order above an out-of-stock product in the one list that is
     only six rows long. */
  const recent = sortByUrgency(visibleNotifications()).slice(0,6);
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
    /* The row is a div acting as a button, so it has to answer Enter and Space
       itself — the browser only does that for real buttons. */
    el.addEventListener("keydown", e=>{
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); go(); }
    });
  });
}

function initNotifBell(){
  const wrap = $("#topbar-notif");
  const btn  = $("#notif-btn");
  if(!wrap || !btn) return;

  /* aria-expanded has to move with the class, or the panel is open for
     sighted users and closed for everybody else. One setter so the two
     cannot drift — same shape as initUserDropdown(). */
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

  /* Escape closes and RETURNS FOCUS to the bell. Neither existed: the panel
     could only be dismissed by clicking somewhere else, so a keyboard user who
     opened it had no way back out — focus stayed where it was while the panel
     vanished under a click they had no reason to make. */
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
/* NOT registered on DOMContentLoaded.

   #topbar-notif and #notif-btn live in portal/shell.html, which
   Core/module-loader.js injects AFTER DOMContentLoaded has already fired.
   Binding here meant the guard above found no bell, returned quietly, and
   the notification dropdown never opened — with no error to show for it.
   init() in admin.js calls this once the shell is in the DOM. */

/* Groups the raw per-event notification `type` values into the
   broader categories shown as filter tabs. */
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
      /* Hide a tab this role can never fill — an Inventory user has no
         use for an empty "Refunds & Returns" filter. Presence is decided by
         the TOTAL; the badge is decided by the unread count below. */
      if(t.id !== "all" && inTab.length === 0) return "";
      /* UNREAD, not total. Read notifications are a record and a tab reading
         "Audit Log 14" said only that fourteen things had ever happened. It
         also reconciles the two places this number appears: these badges are
         the same unread rows the topbar bell counts, split by category, so
         the tabs and the bell can no longer disagree. */
      const unread = inTab.filter(n=>!n.read).length;
      const active = (adminState.notifFilter||"all")===t.id;
      /* Every tab here gets the unread rule, "All" included: elsewhere All is a
         record tab, but this whole screen is a queue and its unread total is
         the one number a reader wants. Hence tabBadgeAlways rather than the
         WORK_TABS gate. */
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
  /* Urgency is the default, and it is the order the bell and the dashboard
     panel are fixed at, so the three agree unless somebody deliberately
     asks this screen for something else. The other options stay: this is
     the one screen where "show me everything oldest-first" is a reasonable
     thing to want. */
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

/* Read state is stored server-side now. It used to live in an in-memory Set,
   so marking something read survived exactly until the next page load — and
   every staff member carried their own private idea of what was unread. */
async function markRead(id){
  const n = allNotifications().find(n=>n.id===id);
  if(!n) return;

  /* D11: the server first, then the badge.

     This marked it read locally and fired the request afterwards, swallowing
     any error — so a failed write showed as read and silently came back unread
     on the next load. Read state is shared across the team, which makes a
     wrong answer here worse than a slow one.

     A derived notification (built from an audit row) has no database row of its
     own, so NOT_FOUND is expected and means "nothing to persist", not failure. */
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
  /* D11: server first. The success toast used to fire regardless of whether
     the request had worked, so "All notifications marked read" appeared even
     when nothing had been. */
  try {
    await EbApi.post("notifications/read.php", { all: true });
  } catch(err){
    console.warn("[notif]", err.message);
    toast("Could not mark notifications read.", "err");
    return;
  }
  /* Only what this role can see — marking another department's alerts
     read on their behalf would be wrong. */
  visibleNotifications().forEach(function(n){ n.read = true; NOTIF_READ.add(n.id); });
  initNotifBadge();
  renderNotifications();
  toast("All notifications marked read", "ok");
}

/* ============================================================
   ONLINE TRANSACTIONS
   ============================================================ */
/* ============================================================
   WHAT A NUMBER ON A TAB MEANS
   ------------------------------------------------------------
   One rule, portal-wide: a badge counts THINGS WAITING FOR YOU, and a
   tab with nothing waiting shows no badge.

   Every tab used to carry one, All and Completed and Cancelled
   included, which made the number a row count — "how many of these
   exist". That tells a staff member nothing about what to do next, and
   it means the same digit signifies work on one tab and history on the
   one beside it.

   WHICH TABS QUALIFY. A queue is a state something is stuck in until a
   person acts; a record is a state it has finished in.

     pending / on-hold   an order waiting to be accepted or released
     received…approved   a return still moving through its pipeline —
                         approved included, because an approved refund
                         is not a paid one
     unread              a notification nobody has read

   Everything else — All, Accepted, Shipping, Delivered, Completed,
   Cancelled, Rejected, Processed — is a record and carries no badge.

   NOT A SET OF SCREEN-LOCAL LISTS. One table here, consumed by all five
   rows, so a sixth screen cannot quietly invent a seventh meaning. */
const WORK_TABS = new Set([
  /* Orders: Online Transactions, Order Queue, Payment Verification. */
  "pending", "on-hold",
  /* Returns still in flight. */
  "received", "validated", "eligible", "approved",
]);

/* Two digits is all the row can hold without the pills reflowing; past
   that the exact figure stops being the useful part anyway. */
const BADGE_MAX = 99;

/**
 * The inner HTML of one tab, and the aria-label that explains it.
 *
 * THE LABEL MATTERS AS MUCH AS THE BADGE. A bare number in a span is
 * announced as a stray digit after the tab name — "Pending, 7" could be a
 * quantity, a page number or a code. The tab gets an explicit
 * "Pending, 7 awaiting action" instead, so it is understandable without
 * seeing the badge at all.
 *
 * @param {string} id     tab id, matched against WORK_TABS
 * @param {string} label  visible text
 * @param {number} count  how many are waiting
 * @param {string} noun   what is being counted, for the spoken label
 *
 * `aria` is interpolated into a double-quoted attribute by the callers and is
 * escaped with escHtml() there — which escapes `"` as well as the angle
 * brackets, so it is safe for an attribute value. There is no escAttr() in the
 * portal; site.js has one, but that is the storefront's own bundle.
 */
/* Every tab on the Notifications screen is a queue — the screen exists to be
   cleared — so unread is meaningful on all of them, including All. This skips
   the WORK_TABS gate and keeps everything else: nothing at zero, the same cap,
   the same spoken label. */
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

const TXN_TABS = ["all","pending","accepted","shipping","delivered","completed","on-hold","cancelled"];

function onlineOrders(){
  return ORDERS.filter(o=>o.type==="online");
}

/* Online Transactions — server-paged.

   Search and status filtering both moved into the query. The search box used to
   match only whatever rows happened to be loaded, so searching for an older
   order found nothing while insisting there were no matches. */
function renderOnlineTxns(){
  const tabsEl = $("#txn-status-tabs");
  const filter = adminState.onlineTxnFilter;

  /* Rows-per-page belongs in the merged toolbar row, not in a band of its
     own above the table — see mountToolbarControl(). */
  mountToolbarControl("online-txns", "page-size", `
    <select class="filter-select" id="online-txn-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#txn-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Customer</th><th>Date</th><th>Payment</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
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
      page, limit, type: "online", with_deliveries: 1, sort: "newest",
      status: filter === "all" ? null : filter,
      search: $("#txn-search")?.value || null,
    }),
    o => `<tr>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}</td>
      <td style="font-weight:700">${peso(o.total)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td><div class="td-actions">
        <button class="btn btn-ghost btn-sm" data-view-order="${o.id}">View</button>
        ${STATUS_TRANSITIONS[o.status]?.length ? `<button class="btn btn-gold btn-sm" data-status-order="${o.id}">Update</button>` : ""}
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

/* ============================================================
   ORDER QUEUE
   ============================================================ */
/* Queue triage covers everything still short of shipping — statuses
   past that point belong to Order Status / History instead. "All"
   lets staff see the full pre-fulfillment picture in one tab. */
const QUEUE_TABS = ["all","pending","accepted","on-hold"];

/* Order Queue — server-paged.

   The tab counts come from meta.counts, which the endpoint computes across the
   whole set with the status filter removed. Deriving them from the page would
   have shown at most `limit` on every badge — a queue of 400 pending orders
   reading "Pending 10". */
function renderQueue(){
  const tabsEl = $("#queue-status-tabs");

  /* Shell first: the tabs and the paging chrome exist before rows arrive, so
     the loading state has somewhere to live. */
  /* Rows-per-page belongs in the merged toolbar row, not in a band of its
     own above the table — see mountToolbarControl(). */
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
  /* "All" means everything short of shipping — statuses past that belong to
     Order Status and History. Sent as a comma list rather than filtered after
     the fact. */
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
      /* Numbered by position on this page, and labelled as such — a bare "#1"
         on page 3 reads as "first in the queue". */
      const seq = ((adminState.queuePager.page || 1) - 1) * (adminState.queuePager.pageSize || 10) + i + 1;
      return `<tr>
      <td class="muted" style="font-weight:700">${seq}</td>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted" style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(itemText)}">${escHtml(itemText)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}<br>${hasProof
        ? `<span style="color:var(--ok-ink);font-weight:700;font-size:.78rem">✓ Proof uploaded</span>`
        : `<span style="color:var(--out-ink);font-weight:700;font-size:.78rem">⚠ No proof yet</span>`}</td>
      <td style="font-weight:700">${peso(o.total)}</td>
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

/* ============================================================
   PAYMENT VERIFICATION
   ============================================================ */
/* The customer's payment screenshot, for the two screens that verify payments.

   AN UPLOADED REFERENCE NOBODY CAN OPEN HAS NOT FIXED THE WORKFLOW.
   That is why defect 3.4 is not closed by making the checkout upload work: the
   whole point of the file is that a member of staff looks at it before
   approving money.

   Three states, each said out loud rather than left to inference:
     - an image        shown, and clickable to open full size in a new tab,
                       because a GCash screenshot at thumbnail size is not
                       readable
     - a reference     "reference number only" — which is what every order
       number only     placed before this existed looks like. This box used to
                       render the words "Proof Uploaded" UNCONDITIONALLY, over
                       nothing, telling staff a file was there when none could
                       ever have been
     - nothing         said plainly

   The image goes through imageUrl() like every other image in the system (I6),
   and a path whose file has gone falls through to the shared placeholder rather
   than a broken-image icon. */
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

const PV_TABS = ["all","pending","on-hold"];

/* Payment Verification — server-paged.

   Scoped server-side with pay_verified=0 plus the pending/on-hold statuses,
   rather than pulling every order and filtering three times in the browser.
   Line values use price_at_purchase from the API, not the product's current
   price — a proof is checked against what the customer was actually charged. */
function renderPaymentVerify(){
  const tabsEl = $("#pv-status-tabs");
  const filter = adminState.pvFilter;

  /* Rows-per-page belongs in the merged toolbar row, not in a band of its
     own above the table — see mountToolbarControl(). */
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

  /* List first, detail on demand: the full proof card opens in a modal from
     the row's View button. */
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

/* The full proof card for one order, with the approve / hold / reject
   decisions. Hold and reject open their own modal in place of this one. */
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
            <div class="pv-row"><span class="pv-row-label">Withholding tax kept by buyer</span><span class="pv-row-val">${EbFormat.pesoExact(withheld)} of ${EbFormat.pesoExact(o.total)}</span></div>` : ""}
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
          <button class="btn btn-ghost btn-sm" data-hold-pay="${o.id}">Place On Hold</button>
          <button class="btn btn-ghost-danger btn-sm" data-reject-pay="${o.id}">Reject Payment</button>
        </div>
      </div>`,
    onOpen(){
      const m = $("#modal-body");
      m.querySelector("[data-approve-pay]")?.addEventListener("click", ()=>{ closeModal(); approvePayment(o.id); });
      m.querySelector("[data-hold-pay]")?.addEventListener("click", ()=> openHoldModal(o.id));
      m.querySelector("[data-reject-pay]")?.addEventListener("click", ()=> cancelOrder(o.id));
    },
  });
}

async function approvePayment(orderId){
  try {
    /* Two steps on purpose: verification is its own recorded decision, and the
       acceptance that follows is refused by the server if verification did not
       land. Doing it in one call would hide which of the two failed. */
    const { data } = await EbApi.post("orders/verify-payment.php", { id: orderId, verified: true });
    if(data.mismatch) toast(data.mismatch, "warn");
    await updateOrderStatus(orderId, "accepted", "Payment verified and approved");
  } catch(err){
    toast(err.message, "err");
  }
  await loadOrders();
  renderPaymentVerify();
  if(typeof initNotifBadge === "function") initNotifBadge();
}

function openHoldModal(orderId){
  openModal({
    title:"Place Order On Hold",
    body:`<p style="font-size:.86rem;color:var(--text-muted);margin-bottom:12px">Provide a reason for placing this order on hold:</p>
      <div class="field"><textarea class="control" id="hold-reason" rows="3" placeholder="e.g. Payment amount mismatch — expected ₱X, received ₱Y"></textarea></div>`,
    confirmLabel:"Confirm On Hold", confirmClass:"btn-gold",
    async onConfirm(){
      const reason = $("#hold-reason").value.trim();
      if(!reason){ toast("Please enter a reason","err"); return; }
      /* Modal stays open when the server refuses, so the typed reason is not
         lost and the operator can see why. */
      if(await updateOrderStatus(orderId, "on-hold", reason)){
        closeModal();
        renderPaymentVerify();
      }
    }
  });
}

function cancelOrder(orderId){
  openModal({
    title:"Reject & Cancel Order",
    body:`<p style="font-size:.86rem;color:var(--text-muted);margin-bottom:12px">Reason for rejection/cancellation:</p>
      <div class="field"><textarea class="control" id="cancel-reason" rows="3" placeholder="e.g. Invalid payment reference number"></textarea></div>`,
    confirmLabel:"Cancel Order", confirmClass:"btn-red",
    async onConfirm(){
      const reason = $("#cancel-reason").value.trim() || "Payment rejected by staff";
      if(await updateOrderStatus(orderId, "cancelled", reason)){
        closeModal();
        renderPaymentVerify();
      }
    }
  });
}

/* ============================================================
   ORDER STATUS MANAGEMENT
   ============================================================ */
/* Order Status — server-paged. */
function renderOrderStatus(){
  /* Rows-per-page belongs in the merged toolbar row, not in a band of its
     own above the table — see mountToolbarControl(). */
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
      const canUpdate = STATUS_TRANSITIONS[o.status]?.length > 0;
      const notes = o.notes || "";
      return `<tr>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td style="font-weight:700">${peso(o.total)}</td>
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
  const transitions = STATUS_TRANSITIONS[o.status] || [];
  if(!transitions.length){ toast("This order status cannot be changed","err"); return; }

  const btns = transitions.map(s=>`
    <button type="button" class="status-transition-btn dest-${s}" data-dest="${s}">
      <span class="status-dot ${s}"></span>
      ${STATUS_LABEL[s]}
    </button>`).join("");

  openModal({
    title:`Update Status — ${orderId}`,
    body:`
      <div class="detail-row"><span class="detail-row-label">Customer</span><span class="detail-row-val">${escHtml(o.customer)}</span></div>
      <div class="detail-row" style="margin-bottom:16px"><span class="detail-row-label">Current Status</span><span class="detail-row-val">${statusChip(o.status)}</span></div>
      <div style="font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Move to</div>
      <div class="status-transition-grid" id="status-transition-grid">${btns}</div>
      <!-- Its own field, not the free-text note.

           The note placeholder used to read "e.g. Tracking number, reason for
           hold…", which is where a tracking number went before this: into a
           text blob nothing could read back. The Limitation promises the number
           is "proof of shipment", and proof has to be retrievable. -->
      <div class="field hide" id="tracking-field" style="margin-top:16px">
        <label>Courier Tracking Number <span class="muted" style="font-weight:400;font-size:.78rem">(required to ship a delivery)</span></label>
        <input class="control" id="status-tracking" type="text" maxlength="60" placeholder="e.g. LBC-8842910337" />
        <span class="field-error" id="err-tracking"></span>
        <span class="field-hint">Issued by the courier on dispatch. We do not track it for the customer — they use the courier's own site.</span>
      </div>
      <div class="field" style="margin-top:16px">
        <label>Note (optional)</label>
        <input class="control" id="status-note" type="text" placeholder="e.g. reason for hold, delivery instructions…" />
      </div>`,
    confirmLabel:null, cancelLabel:"Cancel",
  });
  setTimeout(()=>{
    /* Only a DELIVERY order being dispatched needs one; a pickup is handed
       over at the counter. Shown on focus/hover so the operator sees the
       requirement before pressing, rather than after a refusal. */
    const needsTracking = dest => dest === "shipping" && o.orderType === "delivery";
    const trackingField = $("#tracking-field");
    $$("#status-transition-grid [data-dest]").forEach(btn=>{
      const reveal = ()=> trackingField?.classList.toggle("hide", !needsTracking(btn.dataset.dest));
      btn.addEventListener("mouseenter", reveal);
      btn.addEventListener("focus", reveal);
    });
    /* Revealed up front when shipping is the only sensible next move, so it is
       not hidden behind a hover on a touch screen. */
    if(transitions.some(needsTracking)) trackingField?.classList.remove("hide");

    $$("#status-transition-grid [data-dest]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const note = $("#status-note")?.value.trim() || "";
        const tracking = $("#status-tracking")?.value.trim() || "";
        const errEl = $("#err-tracking");
        if(errEl) errEl.textContent = "";

        /* Checked here too so the operator is not made to wait for a round
           trip to be told a field is empty. The server check is the one that
           counts — see api/orders/status.php. */
        if(needsTracking(btn.dataset.dest) && !tracking && !o.trackingNumber){
          trackingField?.classList.remove("hide");
          if(errEl) errEl.textContent = "Enter the courier tracking number before marking this order shipped.";
          $("#status-tracking")?.focus();
          return;
        }

        const restore = EbUI.busy(btn, "Moving…");
        try {
          /* Only close on success. A refusal — an illegal transition, a
             missing reason, an unverified payment, a missing tracking number —
             leaves the modal open with the note intact and the reason on
             screen. */
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

/* Moves an order, server-side.

   This used to set o.status directly and write a local audit line. The
   transition table in STATUS_TRANSITIONS shaped what the modal offered, but
   nothing enforced it — and a status set only in memory was gone on refresh.
   api/orders/status.php now owns both: it re-checks the transition, requires a
   reason for hold and cancel, refuses to accept an order whose payment is not
   verified, and records the move in order_status_history with who made it.

   Returns true on success so callers can decide whether to close a modal. */
async function updateOrderStatus(orderId, newStatus, note, trackingNumber){
  try {
    const { data } = await EbApi.post("orders/status.php", {
      id: orderId, status: newStatus, note: note || null,
      /* Sent only when there is one. The endpoint ignores it on any transition
         that is not a delivery being dispatched, so a stray value cannot be
         recorded against the wrong event. */
      tracking_number: trackingNumber || null,
    });
    await loadOrders();
    /* The SERVER's status, not the one requested. Accepting a cash pickup
       order completes it in the same move, and a toast reading "Accepted" for
       an order that is done — and already in the Sales Report — sends the
       operator looking for it in the queue. */
    const landed = (data && data.status) || newStatus;
    toast(data && data.autoCompleted
      ? `Order ${orderId} completed — cash on pickup, added to sales.`
      : `Order ${orderId} → ${STATUS_LABEL[landed] || landed}`, "ok");
    if(typeof initNotifBadge === "function") initNotifBadge();
    return true;
  } catch(err){
    /* The server's refusal is the useful message here — it names the allowed
       transitions, or says the payment is unverified. Passing it through beats
       a generic "could not update". */
    toast(err.message, "err");
    return false;
  }
}

/* ============================================================
   TRANSACTION HISTORY
   ============================================================ */
/* Transaction History — paged by the server.

   This used to filter and slice the whole ORDERS array in the browser, which
   only worked while the browser held every order. It asks the database for one
   page now, and for the count and revenue across the entire filtered set —
   paging the rows without that would have quietly turned "Total Revenue" into
   a per-page sum that still looked correct. */
async function renderHistory(){
  const q    = ($("#history-search")?.value || "").trim();
  const from = $("#history-from")?.value;
  const to   = $("#history-to")?.value;

  const pager = adminState.ordHistoryPager;
  const content = $("#history-content");

  content.innerHTML = `<div class="table-wrap"><table class="data-table"><tbody>${EbUI.loadingRow(8, "Loading transactions…")}</tbody></table></div>`;

  let res;
  try {
    res = await EbApi.get("orders/list.php", {
      type: "online", with_deliveries: 1,
      search: q || null,
      from: from || null,
      to: to || null,
      page: pager.page || 1,
      limit: pager.pageSize || 10,
      sort: "newest",
    });
  } catch(err){
    content.innerHTML = `<div class="table-wrap"><table class="data-table"><tbody>${EbUI.errorRow(8, err.message)}</tbody></table></div>`;
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
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${escHtml(o.email)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}</td>
      <td style="font-weight:700">${peso(total)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td><button class="btn btn-ghost btn-sm" data-view-order="${o.id}">View</button></td>
    </tr>`;
  }).join("");

  /* Rows-per-page belongs in the merged toolbar row, not in a band of its
     own above the table — see mountToolbarControl(). */
  mountToolbarControl("orderhistory", "page-size", `
    <select class="filter-select" id="ord-history-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#history-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Customer</th><th>Email</th><th>Date</th><th>Payment</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="ord-history-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="ord-history-pagination" style="margin-left:auto"></div>
    </div>`;
  wireOrderRowActions("#history-content");

  /* EbPaginate drives requests rather than slicing an array — clicking a page
     asks the server for it. */
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

/* ============================================================
   RECEIPT GENERATION
   ============================================================ */
/* Receipt Generation — server-paged. Scoped to completed orders in the query
   rather than pulling every order and filtering to the completed ones. */
function renderReceipts(){
  /* Rows-per-page belongs in the merged toolbar row, not in a band of its
     own above the table — see mountToolbarControl(). */
  mountToolbarControl("receipts", "page-size", `
    <select class="filter-select" id="receipts-page-size" aria-label="Rows per page">
    <option value="10">10 per page</option>
    <option value="25">25 per page</option>
    <option value="50">50 per page</option>
    </select>`);

  $("#receipts-content").innerHTML = `
    <div class="table-wrap viewport-bound">
      <table class="data-table">
        <thead><tr><th>Order ID</th><th>Customer</th><th>Completed</th><th>Total</th><th>Payment</th><th>Actions</th></tr></thead>
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
      page, limit, type: "online", with_deliveries: 1, status: "completed", sort: "newest",
      search: $("#receipt-search")?.value || null,
    }),
    o => `<tr>
      <td class="mono-sm">${escHtml(o.id)}${o.type === "walk-in" ? ` <span class="badge badge-warn" title="Rung up at the POS as a delivery. Paid at the counter; shipped and tracked here like an online order.">Walk-in delivery</span>` : ""}</td>
      <td>${escHtml(o.customer)}</td>
      <td class="muted">${fmtDateTime(o.datetime)}</td>
      <td style="font-weight:700">${peso(o.total)}</td>
      <td>${escHtml(payMethodLabel(o.payMethod))}</td>
      <td><div class="td-actions">
        <button class="btn btn-gold btn-sm" data-receipt-order="${o.id}">Generate Receipt</button>
        <button class="btn btn-ghost btn-sm" data-view-order="${o.id}">View</button>
      </div></td>
    </tr>`,
    {
      colspan: 6,
      empty: { title: "No Completed Orders", hint: "Completed orders will appear here" },
      after: (rows) => {
        /* The receipt modal reads the order out of ORDERS, so the page has to
           be merged in before those buttons are wired. */
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
  /* Line amounts come from each line's price AT PURCHASE, inside
     EbInvoice.fromOrder(). This screen used to multiply by the product's
     CURRENT price, so editing a price quietly rewrote every past receipt. */
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

/* ============================================================
   RETURN MODULE
   ============================================================ */
const RETURN_TABS = [
  {id:"all",       label:"All Requests"},
  {id:"received",  label:"Received"},
  {id:"validated", label:"Validated"},
  {id:"eligible",  label:"Eligible"},
  {id:"approved",  label:"Approved"},
  {id:"rejected",  label:"Rejected"},
  {id:"processed", label:"Processed"},
];

/* Advance a return through its pipeline, server-side.

   Every step below used to set r.status directly and push a local audit line.
   RETURN_STATUS_STEP shaped which buttons appeared, but nothing enforced the
   order — a return could be marked `processed`, and a refund paid, on a claim
   nobody had assessed. api/returns/advance.php owns the pipeline, requires a
   reason for refusals, checks the refund against what was actually paid for
   that line, and puts the goods back on the shelf when the refund completes.

   Returns true on success so callers only close the modal when it worked. */
async function advanceReturn(id, status, extra = {}){
  try {
    const { data } = await EbApi.post("returns/advance.php", { id, status, ...extra });
    await loadOpsData();
    if(data.stockReturned) toast(`${data.stockReturned} unit(s) returned to stock.`, "ok");
    return true;
  } catch(err){
    toast(err.message, "err");
    return false;
  }
}

function renderReturns(){
  const tabsEl = $("#return-tabs");
  tabsEl.innerHTML = RETURN_TABS.map(t=>{
    const count = t.id==="all" ? RETURNS.length : RETURNS.filter(r=>r.status===t.id).length;
    /* Was a parenthesised "(3)" on every tab including All, Rejected and
       Processed. Same rule as the order rows now: a badge means a request
       still needs somebody, and the finished states carry none. */
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

  /* Paging + sort, client-side: RETURNS is already fully loaded. One slot —
     mountToolbarControl keeps a single slot per screen. */
  const pg = adminState.returnPager || (adminState.returnPager = { page: 1, limit: 10, sort: "newest" });
  /* Mounted once — re-mounting on every tab/sort/page rebuilt both menus and
     made them flicker. */
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

  /* List first, detail on demand: the full card (steps, reasons, actions)
     opens in a modal from View. */
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

/* How long after the order completed the request came in — the 24-hour rule
   is enforced when the customer files it; this shows staff the margin. */
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
  return `<span class="status-chip status-${chipStatus}">${statusLabel}</span>`;
}

/* The full return card in a modal. Its action buttons open their own
   step modal in place of this one. */
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

/* The View popup's content: header strip, then one card per concern —
   progress, the return itself, what was said about it, and the next step. */
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
            <span class="order-item-name">${escHtml(it.name)}</span>
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

function returnActions(r){
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

/* The audit row for a return transition is written by returns/advance.php,
   inside the same transaction as the status change (D13). This raises the UI
   notification only — it does not, and must not, record the event. */
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

/* ============================================================
   ORDER DETAIL MODAL (shared by Transactions/Queue/Status/History)
   ============================================================ */
/* Fill the History panel from api/orders/get.php.

   The Order Status stepper was inferred from the current status, so it could
   show that an order had been accepted but never who accepted it or when, and
   a cancelled order's path was unrecoverable. order_status_history records each
   move with the user who made it. */
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
    /* Flag a stored total that disagrees with its own line items rather than
       displaying it as though it were reconciled. */
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
  const total = orderTotal(o);
  const itemRows = o.items.map(it=>{
    const p = getProduct(it.id);
    /* it.price is price_at_purchase, from order_items. This used to multiply
       by the product's CURRENT price, so editing a price silently rewrote what
       every past order appeared to have cost — a receipt that disagreed with
       what the customer was actually charged. */
    const unit = it.price != null ? it.price : (p ? p.price : null);
    return `<div class="order-item-row">
      <span class="order-item-name">${escHtml(it.name || (p ? p.name : it.id))}</span>
      <span class="order-item-qty">×${it.qty}</span>
      <span class="order-item-sub">${unit != null ? peso(unit * it.qty) : "—"}</span>
    </div>`;
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
        <div class="detail-row" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;font-weight:700">
          <span class="detail-row-label">Total</span>
          <span class="detail-row-val" style="color:var(--gold-ink);font-size:1.1rem">${peso(total)}</span>
        </div>
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
          /* A Net order is paid later, in instalments checked in Payment Schemes —
             "Pending" here read as a payment nobody had looked at. */
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
        <div id="order-history-body" class="muted" style="font-size:.85rem">Loading…</div>
      </div>`,
    onOpen: () => fillOrderHistory(orderId),
    confirmLabel: STATUS_TRANSITIONS[o.status]?.length ? "Update Status" : null,
    confirmClass:"btn-gold", cancelLabel:"Close",
    onConfirm: STATUS_TRANSITIONS[o.status]?.length ? ()=>{ closeModal(); openStatusModal(orderId); } : undefined,
  });
}
