import { EbFormat } from "./format.js";
/* UI helpers (toasts, modals and list states), needing portal/shell.html's #toast-container and #modal-overlay; published as EbUI. */


const fmt = () => EbFormat;
const $ = (sel, root = document) => root.querySelector(sel);

/* Toast */
const TOAST_ICONS = {
  ok:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  err:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/* Portal twin of showToast() in site.js (different container and types); keep their behaviour in step: console fallback and escaped message. */
function toast(msg, type = "ok") {
  const container = $("#toast-container");
  /* No toast container on the page, so log to the console instead of throwing. */
  if (!container) { console.log(`[${type}] ${msg}`); return; }

  const el = document.createElement("div");
  el.className = `toast t-${type}`;
  el.innerHTML = (TOAST_ICONS[type] || TOAST_ICONS.ok) +
                 `<span>${fmt().escHtml(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("removing");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/* Modal */
function openModal({
  title, body, confirmLabel = "Confirm", confirmClass = "btn-gold",
  cancelLabel = "Cancel", large = false, onConfirm, onCancel, onOpen,
}) {
  const overlay = $("#modal-overlay");
  if (!overlay) { console.warn("[ui] no #modal-overlay on this page"); return; }

  const modal   = $("#modal");
  const mTitle  = $("#modal-title");
  const mBody   = $("#modal-body");
  const mFooter = $("#modal-footer");

  mTitle.textContent = title;
  if (typeof body === "string") mBody.innerHTML = body;
  else { mBody.innerHTML = ""; mBody.appendChild(body); }

  modal.className = "modal" + (large ? " modal-lg" : "");
  mFooter.innerHTML = "";

  if (cancelLabel) {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-ghost";
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener("click", () => { closeModal(); if (onCancel) onCancel(); });
    mFooter.appendChild(cancelBtn);
  }
  if (confirmLabel) {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = `btn ${confirmClass}`;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener("click", () => { if (onConfirm) onConfirm(); });
    mFooter.appendChild(confirmBtn);
  }

  overlay.classList.add("open");
  document.body.style.overflow = "hidden";
  setTimeout(() => mBody.querySelector("input,textarea,select")?.focus(), 80);

  /* Runs once the modal body is in the DOM, for async content. */
  if (typeof onOpen === "function") onOpen();
}

function closeModal() {
  const overlay = $("#modal-overlay");
  if (overlay) overlay.classList.remove("open");
  document.body.style.overflow = "";
}

/** Promise-based confirmation for destructive actions. */
function confirm({ title, message, confirmLabel = "Confirm", danger = true }) {
  return new Promise(resolve => {
    openModal({
      title,
      body: `<p>${fmt().escHtml(message)}</p>`,
      confirmLabel,
      confirmClass: danger ? "btn-red" : "btn-gold",
      onConfirm: () => { closeModal(); resolve(true); },
      onCancel:  () => resolve(false),
    });
  });
}

/* Skeleton loading: grey shimmering shapes in the layout of what is coming, instead of a spinner. Styles are installed once
   here so the portal and the storefront share them. */
const SK_CSS = `
.sk{ display:block; height:12px; border-radius:6px; background:linear-gradient(90deg, rgba(128,128,128,.13) 25%, rgba(128,128,128,.26) 37%, rgba(128,128,128,.13) 63%);
  background-size:400% 100%; animation:sk-shine 1.3s ease-in-out infinite; }
.sk-line-lg{ height:16px; }
.sk-pill{ height:22px; width:72px; border-radius:999px; }
.sk-circle{ border-radius:50%; }
.sk-row td{ padding-top:16px !important; padding-bottom:16px !important; }
.sk-block{ display:flex; flex-direction:column; gap:12px; padding:18px 4px; }
.sk-card{ display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:16px; border:1px solid rgba(128,128,128,.16); }
.sk-card .sk-img{ height:auto; aspect-ratio:1 / 1; border-radius:12px; }
.sk-sr{ position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
@keyframes sk-shine{ 0%{ background-position:100% 50%; } 100%{ background-position:0 50%; } }
@media (prefers-reduced-motion: reduce){ .sk{ animation:none; } }
`;
function ensureSkeletonCss(){
  if (typeof document === "undefined" || document.getElementById("eb-skeleton-css")) return;
  const s = document.createElement("style");
  s.id = "eb-skeleton-css";
  s.textContent = SK_CSS;
  (document.head || document.documentElement).appendChild(s);
}
ensureSkeletonCss();

const SK_WIDTHS = [72, 54, 86, 40, 64, 78, 48];

/** Skeleton table rows (5 by default) spanning the table's columns; screen readers hear "Loading…". */
function loadingRow(colspan, message = "Loading…", rows = 5) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let c = 0; c < colspan; c++) {
      const w = SK_WIDTHS[(r + c * 3) % SK_WIDTHS.length];
      const sr = r === 0 && c === 0 ? `<span class="sk-sr">${fmt().escHtml(message)}</span>` : "";
      cells.push(`<td>${sr}<span class="sk" style="width:${w}%"></span></td>`);
    }
    out.push(`<tr class="state-row sk-row"${r ? ' aria-hidden="true"' : ""}>${cells.join("")}</tr>`);
  }
  return out.join("");
}

/** A skeleton block of text lines for panels and lists that are not tables. */
function skeletonBlock(lines = 4, message = "Loading…") {
  let html = `<div class="sk-block" role="status"><span class="sk-sr">${fmt().escHtml(message)}</span>`;
  for (let i = 0; i < lines; i++) {
    html += `<span class="sk${i === 0 ? " sk-line-lg" : ""}" style="width:${i === 0 ? 38 : SK_WIDTHS[i % SK_WIDTHS.length]}%"></span>`;
  }
  return html + "</div>";
}

/** Skeleton product cards (image, name, category, price) for grids and carousels. */
function skeletonCards(n = 8, cls = "") {
  let html = "";
  for (let i = 0; i < n; i++) {
    html += `<div class="sk-card ${cls}" aria-hidden="true"><span class="sk sk-img"></span><span class="sk sk-line-lg" style="width:70%"></span><span class="sk" style="width:45%"></span><span class="sk sk-pill"></span></div>`;
  }
  return html;
}

function emptyRow(colspan, title = "Nothing here yet", hint = "") {
  return `<tr class="state-row"><td colspan="${colspan}" class="state-cell">
    <strong>${fmt().escHtml(title)}</strong>${hint ? `<br><small>${fmt().escHtml(hint)}</small>` : ""}
  </td></tr>`;
}

function errorRow(colspan, message, retryAttr = "") {
  return `<tr class="state-row state-error"><td colspan="${colspan}" class="state-cell">
    <strong>Could not load this.</strong><br><small>${fmt().escHtml(message)}</small>
    ${retryAttr ? `<br><button class="btn btn-ghost btn-sm" ${retryAttr}>Try again</button>` : ""}
  </td></tr>`;
}

/* Forms */

/** Show a 422 fields map on a form using [data-err-for] or #err-fieldname. */
function showFieldErrors(form, fields) {
  clearFieldErrors(form);
  Object.entries(fields || {}).forEach(([name, message]) => {
    const target = form.querySelector(`[data-err-for="${name}"]`) ||
                   document.getElementById(`err-${name}`);
    if (target) target.textContent = message;
    const input = form.querySelector(`[name="${name}"], #${name}`);
    if (input) input.classList.add("has-error");
  });
}

function clearFieldErrors(form) {
  form.querySelectorAll("[data-err-for], .field-error").forEach(el => { el.textContent = ""; });
  form.querySelectorAll(".has-error").forEach(el => el.classList.remove("has-error"));
}

/** Disable a button during a request and restore it afterwards, preventing double submits. */
function busy(button, label = "Working…") {
  if (!button) return () => {};
  /* Keep the button's original nodes so icons survive a failed request. */
  const original = [...button.childNodes];
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.textContent = label;
  return () => { button.disabled = wasDisabled; button.replaceChildren(...original); };
}

/** Wrap an async submit (clear errors, disable the button, show 422 field errors, toast others); returns true only on success. */
async function submit(form, button, busyLabel, fn) {
  clearFieldErrors(form);
  const restore = busy(button, busyLabel);
  try {
    await fn();
    return true;
  } catch (err) {
    if (err.isValidation) showFieldErrors(form, err.fields);
    else toast(err.message, "err");
    return false;
  } finally {
    restore();
  }
}

/* Reference number, one field per method: GCash is exactly 13 digits (numeric keypad, digits only, a 0/13 counter);
   a bank transfer is 6–20 letters or numbers (spaces and dashes allowed while typing, capitals kept). The form's own
   input becomes a hidden master that its validation and submit code keep reading; only the field for the chosen
   method is shown. Mirrors Payments::checkRef. Returns { refresh() } to call when the method changes. */
const REF_RULES = {
  gcash: { label: "GCash Reference Number", placeholder: "13-digit reference from your GCash receipt", max: 13, mode: "numeric",
           clean: v => v.replace(/\D/g, "").slice(0, 13),
           hint: v => `${v.length}/13 digits` },
  /* Spaces and dashes may separate groups but do not count; typing stops at 20 letters or numbers. */
  bank:  { label: "Bank Reference Number", placeholder: "6–20 letters or numbers from your bank confirmation", max: 30, mode: "text",
           clean: v => { let n = 0, out = "";
             for(const ch of v.toUpperCase().replace(/[^A-Z0-9 -]/g, "")){
               if(/[A-Z0-9]/.test(ch)){ if(n === 20) break; n++; }
               out += ch;
             }
             return out; },
           hint: v => { const n = v.replace(/[\s-]/g, "").length; return `${n}/20 characters${n < 6 ? " (at least 6)" : ""}`; } },
};
function splitRefField(master, getMethod, labelEl){
  if(!master || master._ebRef) return master && master._ebRef;
  master.type = "hidden";
  const wrap = document.createElement("div");
  wrap.className = "ref-split";
  wrap.innerHTML = Object.entries(REF_RULES).map(([m, r]) => `
    <div class="ref-one" data-ref-method="${m}" hidden>
      <input class="control" type="text" inputmode="${r.mode}" maxlength="${r.max}" autocomplete="off"
             placeholder="${r.placeholder}" aria-label="${r.label}" data-ref-input="${m}">
      <small class="ref-count" data-ref-count="${m}"></small>
    </div>`).join("");
  master.after(wrap);
  const inputs = {};
  wrap.querySelectorAll("[data-ref-input]").forEach(inp => {
    const m = inp.dataset.refInput, r = REF_RULES[m];
    inputs[m] = inp;
    inp.addEventListener("input", () => {
      const v = r.clean(inp.value);
      if(v !== inp.value) inp.value = v;
      master.value = v.trim();
      wrap.querySelector(`[data-ref-count="${m}"]`).textContent = v ? r.hint(v) : "";
      master.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  const api = {
    refresh(){
      const m = getMethod();
      wrap.querySelectorAll(".ref-one").forEach(el => { el.hidden = el.dataset.refMethod !== m; });
      const t = labelEl && labelEl.querySelector("[data-ref-label]");
      if(t && REF_RULES[m]) t.textContent = REF_RULES[m].label;
      master.value = inputs[m] ? inputs[m].value.trim() : "";
    },
    focus(){ inputs[getMethod()]?.focus(); },
    input(){ return inputs[getMethod()] || null; },
  };
  master._ebRef = api;
  api.refresh();
  return api;
}

export const EbUI = {
  toast, openModal, closeModal, confirm,
  loadingRow, emptyRow, errorRow, skeletonBlock, skeletonCards,
  showFieldErrors, clearFieldErrors, busy, submit, splitRefField,
};

