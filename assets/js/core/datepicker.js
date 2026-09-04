/* ============================================================
   EbDate — one calendar, used for every date field
   ------------------------------------------------------------
   WHY THIS EXISTS

   Same fault as the native <select>, one step worse. `input[type=date]`
   renders its calendar from the browser, so the Sales Report's date
   range opened a white Chrome popup with a blue selected day, Arial
   type and square corners — no theme, no dark mode, nothing in common
   with the application it appeared inside. On the dark skin it was a
   slab of white light.

   THE SAME CONTRACT AS EbSelect. The native input stays in the DOM and
   stays the source of truth: `renderSales()` reads $("#sales-from").value,
   the batch modal reads #m-batch-expiry, the restock form reads
   #rs-prod. On selection this writes `input.value` in the ISO form those
   readers already expect and dispatches bubbling `input` + `change`, so
   every existing listener fires unchanged and forms still submit.

   WHAT IT KEEPS THAT THE NATIVE CONTROL HAD
   - min / max are honoured, so "expiry cannot be before production"
     keeps working when those attributes are set.
   - Typing. The native field is the only way to enter a date from the
     keyboard without arrowing through a grid, so the trigger accepts
     typed digits and parses them (see onType) rather than forcing
     everyone through the calendar.
   - Touch devices keep the native picker entirely — a phone's date wheel
     is better than any grid this could draw.
   ============================================================ */

import { placeLayer, closeOn, isCoarsePointer, removeAfterExit } from "./popup.js";

const SELECTOR = 'input[type="date"]';

const DAYS   = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

let seq = 0;
let openInstance = null;

/* ------------------------------------------------------------------
   Date helpers.

   ALL LOCAL, NEVER `new Date("2026-09-02")`. That parses as UTC, so east
   of Greenwich it lands on the previous day — the exact class of bug the
   dAgo() note in engine.js records. Every conversion here goes through
   explicit y/m/d numbers.
   ------------------------------------------------------------------ */
const iso   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d) ? null : d;
};
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() &&
                          a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  /* Clamp: 31 Jan + 1 month must be 28/29 Feb, not 2/3 March. */
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), last));
};
const fmt = d => d ? `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}` : "";

const CSS = `
.ebd { position: relative; display: inline-flex; vertical-align: middle; }
.ebd > input.ebd-native {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.ebd-trigger {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 12px; min-height: 38px; min-width: 148px;
  border-radius: var(--r-md, 12px);
  border: 1.5px solid var(--border-lift);
  background: var(--surface); color: var(--text);
  font-family: inherit; font-size: .88rem; cursor: pointer;
  text-align: left; white-space: nowrap;
  transition: border-color var(--t, .2s), box-shadow var(--t, .2s);
}
.ebd-trigger:hover { border-color: var(--gold); }
.ebd-trigger:focus-visible, .ebd.is-open .ebd-trigger {
  outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-dim);
}
.ebd-value { flex: 1; }
/* An empty field says so in muted type rather than showing dd/mm/yyyy, which
   reads as content the operator has to clear before typing. */
.ebd-value.is-empty { color: var(--text-muted); }
.ebd-ico { width: 15px; height: 15px; flex-shrink: 0; color: var(--text-muted); }

.ebd-pop {
  position: fixed; z-index: 9999; width: 268px; padding: 10px;
  /* The calendar does not scroll internally, but a wheel over it must not
     chain through to the page behind — which would scroll the panel away from
     its trigger while the pointer is still on it. */
  overscroll-behavior: contain;
  background: var(--glass-bg-overlay, var(--surface)); color: var(--text);
  -webkit-backdrop-filter: var(--glass-blur-lg, none);
  backdrop-filter: var(--glass-blur-lg, none);
  border: 1px solid var(--glass-border, var(--border-lift));
  border-radius: var(--r-md, 12px);
  box-shadow: var(--glass-shadow-lg, var(--shadow-lg, 0 20px 56px rgba(0,0,0,.28)));
  opacity: 0; transform: scale(.97);
  transform-origin: var(--ebs-origin, top center);
  transition: opacity .13s var(--ease, ease), transform .13s var(--ease, ease);
}
.ebd-pop.is-in { opacity: 1; transform: none; }

.ebd-head { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
.ebd-title {
  flex: 1; text-align: center; font-weight: 700; font-size: .86rem;
  font-variant-numeric: tabular-nums;
}
.ebd-nav {
  width: 28px; height: 28px; border-radius: var(--r-sm, 8px);
  display: grid; place-items: center; cursor: pointer;
  background: none; border: none; color: var(--text-muted);
}
.ebd-nav:hover { background: var(--bg-tint); color: var(--text); }
.ebd-nav:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--gold); }
.ebd-nav svg { width: 15px; height: 15px; }

.ebd-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.ebd-dow {
  text-align: center; font-size: .64rem; font-weight: 800; letter-spacing: .06em;
  text-transform: uppercase; color: var(--text-muted); padding: 4px 0 6px;
}
.ebd-day {
  aspect-ratio: 1; display: grid; place-items: center;
  border-radius: var(--r-sm, 8px); border: none; background: none;
  font-family: inherit; font-size: .8rem; color: var(--text); cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.ebd-day:hover:not(:disabled) { background: var(--bg-tint); }
.ebd-day.is-out { color: var(--text-muted); opacity: .45; }
.ebd-day:disabled { opacity: .28; cursor: not-allowed; }
/* TODAY is a ring, SELECTED is a fill. Two different marks rather than two
   shades of one, so "the day I am on" and "the day I picked" never have to be
   told apart by colour alone — and they can both be true at once. */
.ebd-day.is-today { box-shadow: inset 0 0 0 1.5px var(--gold); font-weight: 700; }
.ebd-day.is-sel {
  background: var(--gold); color: var(--ink, #1E1A0E); font-weight: 800;
}
.ebd-day.is-active:not(.is-sel) { box-shadow: inset 0 0 0 2px var(--gold-line); }
.ebd-day:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--gold); }

.ebd-foot {
  display: flex; justify-content: space-between; gap: 8px;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);
}
.ebd-foot button {
  background: none; border: none; cursor: pointer; font-family: inherit;
  font-size: .76rem; font-weight: 700; color: var(--gold-ink);
  padding: 4px 8px; border-radius: var(--r-sm, 8px);
}
.ebd-foot button:hover { background: var(--bg-tint); }
.ebd-foot button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--gold); }
.ebd-clear { color: var(--out-ink) !important; }

@media (prefers-reduced-motion: reduce) {
  .ebd-pop { transition: none; transform: none; opacity: 1; }
}
`;

function injectCSS() {
  if (document.getElementById("eb-date-css")) return;
  const st = document.createElement("style");
  st.id = "eb-date-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

const ICON = `<svg class="ebd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;
const PREV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
const NEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

class EbDateInstance {
  constructor(input) {
    this.input = input;
    this.id = "ebd-" + (++seq);
    this.open = false;
    this.typeBuf = "";
    this.typeAt = 0;
    injectCSS();
    this.build();
    this.syncFromNative();
  }

  get min() { return parse(this.input.min); }
  get max() { return parse(this.input.max); }
  get value() { return parse(this.input.value); }

  build() {
    const inp = this.input;
    const wrap = document.createElement("span");
    wrap.className = "ebd";
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    inp.classList.add("ebd-native");
    inp.setAttribute("tabindex", "-1");
    inp.setAttribute("aria-hidden", "true");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ebd-trigger";
    trigger.id = this.id + "-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", this.id + "-pop");
    const label = inp.getAttribute("aria-label") ||
      (inp.id && document.querySelector(`label[for="${inp.id}"]`)?.textContent.trim()) || "Date";
    this.labelText = label;
    trigger.innerHTML = `<span class="ebd-value"></span>${ICON}`;
    /* Inline width/padding the views set on the native input have to follow it
       — the batch modal squeezes three date fields into one row. */
    if (inp.style.cssText) trigger.style.cssText = inp.style.cssText;
    /* Full width ONLY inside .field, because that is the exact condition the
       stylesheet uses — `.field .control { width: 100% }`. Keying on the class
       alone stretched the Sales Report's date range across the whole panel and
       pushed its arrow and Apply button onto their own lines: those inputs
       carry .control for the border and padding, not for the width, and size
       themselves inside a flex row. */
    if (inp.closest(".field")) { wrap.style.width = "100%"; trigger.style.width = "100%"; }
    wrap.appendChild(trigger);

    this.wrap = wrap;
    this.trigger = trigger;
    this.valueEl = trigger.querySelector(".ebd-value");

    trigger.addEventListener("click", e => { e.stopPropagation(); this.toggle(); });
    trigger.addEventListener("keydown", e => this.onTriggerKey(e));
    inp.addEventListener("change", () => this.syncFromNative());
  }

  syncFromNative() {
    const d = this.value;
    this.valueEl.textContent = d ? fmt(d) : "Select date";
    this.valueEl.classList.toggle("is-empty", !d);
    this.trigger.setAttribute("aria-label",
      d ? `${this.labelText}: ${fmt(d)}` : `${this.labelText}: none selected`);
    if (this.open) this.renderGrid();
  }

  outOfRange(d) {
    const lo = this.min, hi = this.max;
    if (lo && d < new Date(lo.getFullYear(), lo.getMonth(), lo.getDate())) return true;
    if (hi && d > new Date(hi.getFullYear(), hi.getMonth(), hi.getDate())) return true;
    return false;
  }

  /* ---------------- open / close ---------------- */

  toggle() { this.open ? this.close() : this.openPop(); }

  openPop() {
    if (this.open || this.input.disabled) return;
    if (openInstance && openInstance !== this) openInstance.close();

    const today = new Date();
    this.cursor = this.value || (this.outOfRange(today) ? (this.min || this.max || today) : today);

    const pop = document.createElement("div");
    pop.className = "ebd-pop";
    pop.id = this.id + "-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-modal", "false");
    pop.setAttribute("aria-label", this.labelText);
    document.body.appendChild(pop);

    this.pop = pop;
    this.open = true;
    openInstance = this;
    this.wrap.classList.add("is-open");
    this.trigger.setAttribute("aria-expanded", "true");

    this.renderGrid();
    placeLayer(this.trigger, pop, { maxH: 380, matchWidth: false });
    /* A forced reflow, not requestAnimationFrame: rAF is suspended in a hidden
       or background tab, which would leave the panel at opacity 0 while still
       taking clicks. Same reasoning as EbSelect. */
    void pop.offsetHeight;
    pop.classList.add("is-in");

    pop.addEventListener("mousedown", e => {
      /* Keep focus on the trigger unless the click is on a real control. */
      if (!e.target.closest("button")) e.preventDefault();
    });
    pop.addEventListener("click", e => {
      const day = e.target.closest("[data-d]");
      if (day && !day.disabled) { this.choose(parse(day.dataset.d)); return; }
      const nav = e.target.closest("[data-mv]");
      if (nav) { this.cursor = addMonths(this.cursor, +nav.dataset.mv); this.renderGrid(); return; }
      if (e.target.closest("[data-today]")) { this.choose(new Date()); return; }
      if (e.target.closest("[data-clear]")) { this.choose(null); return; }
    });

    this.teardown = closeOn(pop, this.wrap, () => this.close(),
      () => placeLayer(this.trigger, pop, { maxH: 380, matchWidth: false }));
  }

  close(refocus) {
    if (!this.open) return;
    this.open = false;
    if (openInstance === this) openInstance = null;
    this.wrap.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    if (this.teardown) { this.teardown(); this.teardown = null; }
    const pop = this.pop;
    this.pop = null;
    if (pop) { pop.classList.remove("is-in"); removeAfterExit(pop); }
    if (refocus) this.trigger.focus();
  }

  renderGrid() {
    if (!this.pop) return;
    const c = this.cursor;
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const start = addDays(first, -first.getDay());     /* back to Sunday */
    const sel = this.value, today = new Date();

    let cells = "";
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const out = d.getMonth() !== c.getMonth();
      const dis = this.outOfRange(d);
      const cls = ["ebd-day"];
      if (out) cls.push("is-out");
      if (sameDay(d, today)) cls.push("is-today");
      if (sameDay(d, sel)) cls.push("is-sel");
      if (sameDay(d, c)) cls.push("is-active");
      cells += `<button type="button" class="${cls.join(" ")}" data-d="${iso(d)}"
        ${dis ? "disabled" : ""} tabindex="${sameDay(d, c) ? 0 : -1}"
        aria-label="${fmt(d)}"${sameDay(d, sel) ? ' aria-current="date"' : ""}>${d.getDate()}</button>`;
    }

    this.pop.innerHTML = `
      <div class="ebd-head">
        <button type="button" class="ebd-nav" data-mv="-1" aria-label="Previous month">${PREV}</button>
        <div class="ebd-title" aria-live="polite">${MONTHS[c.getMonth()]} ${c.getFullYear()}</div>
        <button type="button" class="ebd-nav" data-mv="1" aria-label="Next month">${NEXT}</button>
      </div>
      <div class="ebd-grid" role="grid">
        ${DAYS.map(d => `<div class="ebd-dow" role="columnheader">${d}</div>`).join("")}
        ${cells}
      </div>
      <div class="ebd-foot">
        <button type="button" data-today>Today</button>
        <button type="button" class="ebd-clear" data-clear>Clear</button>
      </div>`;
  }

  /**
   * Commit. THE CONTRACT: write the native value in ISO, then dispatch
   * bubbling input + change. renderSales(), the batch modal and the restock
   * form all read the input directly and listen for change; none of them knows
   * this component exists and none of them needs to.
   */
  choose(d) {
    if (d && this.outOfRange(d)) return;
    const next = d ? iso(d) : "";
    const changed = this.input.value !== next;
    this.input.value = next;
    this.syncFromNative();
    this.close(true);
    if (changed) {
      this.input.dispatchEvent(new Event("input",  { bubbles: true }));
      this.input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  move(days) {
    let d = addDays(this.cursor, days);
    if (this.outOfRange(d)) return;
    this.cursor = d;
    this.renderGrid();
    this.pop?.querySelector(".ebd-day.is-active")?.focus();
  }

  onTriggerKey(e) {
    const k = e.key;
    if (!this.open) {
      if (k === "Enter" || k === " " || k === "ArrowDown") { e.preventDefault(); this.openPop(); }
      else if (/^[0-9]$/.test(k)) { e.preventDefault(); this.onType(k); }
      else if (k === "Backspace" || k === "Delete") { e.preventDefault(); this.choose(null); }
      return;
    }
    switch (k) {
      case "Escape":     e.preventDefault(); this.close(true); break;
      case "Tab":        this.close(); break;
      case "Enter":
      case " ":          e.preventDefault(); this.choose(this.cursor); break;
      case "ArrowLeft":  e.preventDefault(); this.move(-1); break;
      case "ArrowRight": e.preventDefault(); this.move(1); break;
      case "ArrowUp":    e.preventDefault(); this.move(-7); break;
      case "ArrowDown":  e.preventDefault(); this.move(7); break;
      case "Home":       e.preventDefault(); this.move(-this.cursor.getDay()); break;
      case "End":        e.preventDefault(); this.move(6 - this.cursor.getDay()); break;
      case "PageUp":     e.preventDefault(); this.cursor = addMonths(this.cursor, -1); this.renderGrid(); break;
      case "PageDown":   e.preventDefault(); this.cursor = addMonths(this.cursor,  1); this.renderGrid(); break;
    }
  }

  /**
   * Typing a date without opening the calendar.
   *
   * The native control's one real advantage is that somebody who knows the
   * date can just type it. Digits accumulate into ddmmyyyy and commit at eight
   * — the order the placeholder in the views already promises — and the buffer
   * resets after a second's pause so a later keystroke starts a new date
   * rather than extending an abandoned one.
   */
  onType(ch) {
    const now = Date.now();
    this.typeBuf = (now - this.typeAt > 1200 ? "" : this.typeBuf) + ch;
    this.typeAt = now;
    if (this.typeBuf.length > 8) this.typeBuf = ch;
    if (this.typeBuf.length === 8) {
      const dd = +this.typeBuf.slice(0, 2), mm = +this.typeBuf.slice(2, 4), yy = +this.typeBuf.slice(4);
      const d = new Date(yy, mm - 1, dd);
      /* Reject 31/02 rather than letting Date roll it into March. */
      if (d.getFullYear() === yy && d.getMonth() === mm - 1 && d.getDate() === dd) this.choose(d);
      this.typeBuf = "";
    }
  }

  destroy() {
    this.close();
    const inp = this.input;
    inp.classList.remove("ebd-native");
    inp.removeAttribute("tabindex");
    inp.removeAttribute("aria-hidden");
    this.wrap.parentNode.insertBefore(inp, this.wrap);
    this.wrap.remove();
    delete inp._ebd;
  }
}

function shouldEnhance(inp) {
  if (inp.dataset.ebDate === "off") return false;
  if (inp.closest(".ebd")) return false;
  /* Touch keeps the platform date wheel — see the note at the top. */
  if (isCoarsePointer()) return false;
  return true;
}

function enhance(root = document) {
  const found = root.querySelectorAll ? root.querySelectorAll(SELECTOR) : [];
  let n = 0;
  found.forEach(inp => {
    if (inp._ebd || !shouldEnhance(inp)) return;
    try { inp._ebd = new EbDateInstance(inp); n++; }
    catch (err) { console.warn("[EbDate] could not enhance", inp.id || inp, err); }
  });
  return n;
}

function sync(inp) { if (inp && inp._ebd) inp._ebd.syncFromNative(); }
function closeAll() { if (openInstance) openInstance.close(); }

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && openInstance) { e.stopPropagation(); openInstance.close(true); }
}, true);

/* Date fields appear inside modals and inside tab panels that render after
   load, so the same observer strategy EbSelect uses applies here. */
let pending = null;
function watch() {
  new MutationObserver(muts => {
    if (pending) return;
    if (!muts.some(m => m.addedNodes.length)) return;
    pending = setTimeout(() => { pending = null; enhance(document); }, 30);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

function init() { injectCSS(); enhance(document); watch(); }

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

export const EbDate = { enhance, sync, closeAll, SELECTOR };
