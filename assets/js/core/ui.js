import { EbFormat } from "./format.js";
/* ============================================================
 UI — toasts, modals, and the three states every list needs
 ------------------------------------------------------------
 Reads the shell markup (#toast-container, #modal-overlay), so it
 only works on a page that has loaded portal/shell.html. The
 toast/modal implementations were moved here from engine.js;
 engine.js now delegates, which is why the markup contract is
 unchanged.

 Published as EbUI for the same reason as EbFormat: engine.js
 already owns `toast` and `openModal` as top-level names.
 ============================================================ */


const fmt = () => EbFormat;
const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------------------------------------------------
   Toast
   --------------------------------------------------------- */
const TOAST_ICONS = {
  ok:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  err:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/* TWIN OF showToast() in assets/js/public/site.js — the duplicate-implementation
   drift catalogued in REMEDIATION.md. They are not interchangeable and neither
   is dead code: this one renders into #toast-container, which exists only in
   portal/shell.html, and takes types ok/err/warn; the storefront's renders into
   #toast-wrap or #toast-root and takes success/info. A page has one or the
   other, never both.

   The storefront's icon well was fixed in this pass (its glyphs had no size
   rule, so a 24-viewBox svg stretched to fill a 22px circle). THIS one did not
   need the same fix and deliberately did not get it: the portal toast has no
   circular well at all — it is a flat bordered card — and portal.css already
   carries `.toast svg { width:17px; height:17px }`. Adding an `.ic` wrapper
   here to match would be divergence, not convergence.

   What must stay in step is behaviour, not markup: both fall back to the
   console when their container is absent, and both escape the message. */
function toast(msg, type = "ok") {
  const container = $("#toast-container");
  /* No shell on the page (a public page, or a portal that failed to boot).
     Falling back to the console beats throwing inside an error handler,
     which is exactly where toast() tends to be called from. */
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

/* ---------------------------------------------------------
   Modal
   --------------------------------------------------------- */
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

  /* Runs once the modal body is in the DOM, so a caller can populate a panel
     asynchronously without racing the render. */
  if (typeof onOpen === "function") onOpen();
}

function closeModal() {
  const overlay = $("#modal-overlay");
  if (overlay) overlay.classList.remove("open");
  document.body.style.overflow = "";
}

/**
 * Promise-shaped confirmation, for destructive actions.
 * Lets a caller `await` instead of threading a callback through.
 */
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

/* ---------------------------------------------------------
   The three states every list has to handle.

   Rendered as table rows so they drop into an existing tbody
   without any layout special-casing.
   --------------------------------------------------------- */
function loadingRow(colspan, message = "Loading…") {
  return `<tr class="state-row"><td colspan="${colspan}" class="state-cell">
    <span class="spinner" aria-hidden="true"></span> ${fmt().escHtml(message)}
  </td></tr>`;
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

/* ---------------------------------------------------------
   Forms
   --------------------------------------------------------- */

/**
 * Render the `fields` map from a 422 envelope against a form.
 * Looks for [data-err-for="fieldname"], falling back to #err-fieldname —
 * both conventions already exist in this markup.
 */
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

/**
 * Disable a button while a request is in flight and restore it afterwards.
 * Stops the double-submit that creates two orders from one impatient click.
 */
function busy(button, label = "Working…") {
  if (!button) return () => {};
  const original = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.textContent = label;
  return () => { button.disabled = wasDisabled; button.textContent = original; };
}

/**
 * Wrap an async submit: clears errors, disables the button, renders 422
 * field errors and toasts anything else. Returns true only on success, so
 * callers can decide whether to close a modal or refresh a list.
 */
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

export const EbUI = {
  toast, openModal, closeModal, confirm,
  loadingRow, emptyRow, errorRow,
  showFieldErrors, clearFieldErrors, busy, submit,
};

