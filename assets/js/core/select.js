/* EbSelect: a themed custom listbox for every dropdown that keeps the native <select> as the source of truth (writes its value and fires change), enhances .filter-select or data-eb-select (opt out with data-eb-select="off"), and leaves touch devices native. */

/* Which dropdowns are enhanced; the trigger takes its shape from the native element's class (see FIELD_CLASSES). */
import { placeLayer, closeOn, isCoarsePointer, isPortal, removeAfterExit } from "./popup.js";

const SELECTOR = "select.filter-select, select.sort-select, select.control, " +
                 "select.auth-input, select[data-eb-select]";

/* Classes that mean "this is a form field, not a toolbar pill". */
const FIELD_CLASSES = ["control", "auth-input"];

/* Popup geometry. */
const GAP        = 6;    /* between trigger and popup */
const MAX_H      = 280;  /* popup scrolls past this */
const MIN_SPACE  = 140;  /* below this much room underneath, flip upward */

let seq = 0;
let openInstance = null;

/* The component's stylesheet, injected once and built only from existing tokens so it follows both themes on portal and storefront. */
const CSS = `
.ebs {
  position: relative; display: inline-flex; vertical-align: middle;
  /* A flex or grid item refuses to shrink below its content unless it is told
     it may. Without this, a wrapper holding "Bangsamoro Autonomous Region In
     Muslim Mindanao (BARMM)" pushes its grid cell wider than the track and the
     control beside it gets overlapped. */
  min-width: 0;
}
/* The native control: still in the DOM, still the value, still submits.
   Clipped rather than display:none so nothing about its participation in
   the form changes. Out of the tab order because the trigger beside it is
   the thing a keyboard user should land on — two tab stops for one control
   is worse than none. */
.ebs > select.ebs-native {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  appearance: none; background: none;
}
.ebs-trigger {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 12px 0 14px; min-height: 38px;
  border-radius: var(--r-pill, 999px);
  border: 1.5px solid var(--border-lift);
  background: var(--surface); color: var(--text);
  font-family: inherit; font-size: .84rem; font-weight: 500;
  cursor: pointer; text-align: left; white-space: nowrap;
  transition: border-color var(--t, .2s), box-shadow var(--t, .2s);
}
.ebs-trigger:hover { border-color: var(--gold); }
.ebs-trigger:focus-visible,
.ebs.is-open .ebs-trigger {
  outline: none; border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-dim);
}
/* min-width: 0 is what makes the ellipsis possible. flex: 1 on its own leaves
   the label's minimum width at its content, so a long option name widens the
   trigger instead of being cut — the text never overflowed, the BOX did.
   (No backticks in this comment: it lives inside a template literal.) */
.ebs-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* A dropdown inside a form field is a different shape from one in a toolbar:
   full width, square-ish corners, the taller padding its sibling inputs use.
   Same component, same popup, same keyboard — only the closed box differs, so
   an enhanced field still lines up with the text inputs above and below it. */
.ebs--field { display: flex; width: 100%; }
/* A form-shaped select that is NOT in a .field sizes to its content. */
.ebs--field.ebs--auto { width: auto; }
.ebs--field.ebs--auto .ebs-trigger { width: auto; min-width: 150px; }
.ebs--field .ebs-trigger {
  width: 100%; min-height: 0; padding: 10px 12px 10px 14px;
  border-radius: var(--r-md, 12px); font-size: .92rem;
}
.ebs-caret {
  width: 15px; height: 15px; flex-shrink: 0; color: var(--text-muted);
  transition: transform var(--t, .2s) var(--ease, ease);
}
.ebs.is-open .ebs-caret { transform: rotate(180deg); }
.ebs-trigger[disabled] { opacity: .55; cursor: not-allowed; }

/* THE POPUP LIVES ON document.body, NOT INSIDE THE TRIGGER.
   Several of these controls sit inside .table-wrap (overflow:auto) and
   inside modals, each of which is its own clipping and stacking context.
   Rendered in place, the list was cut off at the edge of the table. A
   fixed-position layer parented to <body> is outside every one of those
   contexts, so nothing can clip it; the trade is that it has to be
   positioned by script and closed when the page moves under it. */
.ebs-pop {
  position: fixed; z-index: 9999;
  min-width: 160px; max-height: ${MAX_H}px;
  overflow-y: auto; overscroll-behavior: contain;
  /* --glass-bg-overlay, NOT --surface. The portal's glass skin re-points
     --surface to a .52-.58 alpha fill, which is right for a panel with page
     behind it and wrong for a popup with OTHER UI TEXT behind it — over the
     Add Employee modal the field labels underneath ghosted straight through
     the option list. glass.css already carries a near-opaque token for
     exactly this case and already applies it to .modal, .notif-dropdown and
     .user-dropdown; this is the same kind of surface, so it uses the same
     token. The storefront does not load glass.css, where the fallback is its
     own opaque --surface. */
  background: var(--glass-bg-overlay, var(--surface)); color: var(--text);
  -webkit-backdrop-filter: var(--glass-blur-lg, none);
  backdrop-filter: var(--glass-blur-lg, none);
  border: 1px solid var(--glass-border, var(--border-lift));
  border-radius: var(--r-md, 12px);
  box-shadow: var(--glass-shadow-lg, var(--shadow-lg, 0 20px 56px rgba(0,0,0,.28)));
  padding: 5px;
  opacity: 0; transform: scale(.97);
  transform-origin: var(--ebs-origin, top center);
  transition: opacity .13s var(--ease, ease), transform .13s var(--ease, ease);
}
.ebs-pop.is-in { opacity: 1; transform: none; }
.ebs-opt {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: var(--r-sm, 8px);
  font-size: .84rem; line-height: 1.3; cursor: pointer;
  color: var(--text);
}
.ebs-opt[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.ebs-opt:hover,
.ebs-opt.is-active { background: var(--bg-tint); }
.ebs-opt[aria-selected="true"] { font-weight: 700; color: var(--gold-ink); }
/* The tick is the second channel. A selected row that differs only by
   colour is a selected row somebody cannot see. */
.ebs-check { width: 14px; height: 14px; flex-shrink: 0; opacity: 0; }
.ebs-opt[aria-selected="true"] .ebs-check { opacity: 1; }
.ebs-opt-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Search box (address fields). The list scrolls under it. */
.ebs-pop--search { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.ebs-search {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  margin: 6px; padding: 0 12px; border-radius: var(--r-sm, 8px);
  border: 1.5px solid var(--border-lift); background: var(--surface);
}
.ebs-search:focus-within { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-dim); }
.ebs-search svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--text-muted); }
.ebs-search input {
  flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
  padding: 9px 0; font: inherit; font-size: .9rem; color: var(--text);
}
.ebs-list { overflow-y: auto; overscroll-behavior: contain; flex: 1; min-height: 0; padding: 0 5px 5px; }
.ebs-empty { padding: 14px 12px; font-size: .85rem; color: var(--text-muted); text-align: center; }

/* Touch: bottom sheet. */
.ebs-backdrop { position: fixed; inset: 0; z-index: 9998; background: rgba(20,8,6,.45); }
.ebs-pop.ebs-pop--sheet {
  left: 0 !important; right: 0 !important; top: auto !important; bottom: 0 !important;
  width: auto !important; min-width: 0; max-height: 62vh; max-height: 62dvh;
  border-radius: 20px 20px 0 0; border-bottom: 0;
  padding: 0 10px calc(12px + env(safe-area-inset-bottom, 0px));
  background: var(--bg, var(--surface));
  transform: translateY(24px); transform-origin: bottom center;
}
.ebs-pop--sheet.is-in { transform: none; }
/* Rides above the on-screen keyboard (--vvh / --vvtop come from site.js). */
.ebs-pop--sheet.ebs-pop--search {
  bottom: calc(100% - var(--vvh, 100%) - var(--vvtop, 0px)) !important;
  max-height: min(62dvh, calc(var(--vvh, 100dvh) - 70px));
  padding: 0 0 calc(8px + env(safe-area-inset-bottom, 0px));
}
.ebs-pop--sheet.ebs-pop--search::before { margin: 0 0 8px; }
.ebs-pop--sheet .ebs-search { margin: 0 12px 6px; }
.ebs-pop--sheet .ebs-search input { font-size: 16px; padding: 11px 0; }
.ebs-pop--sheet .ebs-list { padding: 0 10px; }
.ebs-pop--sheet::before {
  content: attr(data-title); display: block; position: sticky; top: 0; z-index: 1;
  margin: 0 -10px 6px; padding: 22px 20px 12px; flex-shrink: 0;
  background: inherit; border-bottom: 1px solid var(--border, rgba(110,78,28,.15));
  font-weight: 700; font-size: 1rem; color: var(--text);
  background-image: linear-gradient(var(--border-lift, #ccc), var(--border-lift, #ccc));
  background-size: 40px 4px; background-position: center 9px; background-repeat: no-repeat;
}
.ebs-pop--sheet .ebs-opt {
  min-height: 48px; padding: 12px 14px; font-size: .95rem; border-radius: 12px;
}
.ebs-pop--sheet .ebs-opt + .ebs-opt { margin-top: 2px; }
.ebs-pop--sheet .ebs-opt[aria-selected="true"] { background: var(--gold-dim, rgba(232,163,23,.14)); }
.ebs-pop--sheet .ebs-opt-text { white-space: normal; }

/* Long lists get the same auto-hiding scrollbar the rest of the app uses. */
.ebs-pop { scrollbar-width: thin; scrollbar-color: transparent transparent; }
.ebs-pop:hover { scrollbar-color: var(--gold-line) transparent; }
.ebs-pop::-webkit-scrollbar { width: 7px; }
.ebs-pop::-webkit-scrollbar-track { background: transparent; }
.ebs-pop::-webkit-scrollbar-thumb { background: transparent; border-radius: 99px; }
.ebs-pop:hover::-webkit-scrollbar-thumb { background: var(--gold-line); }

/* A filter dropdown is opened dozens of times an hour. Motion here has to
   be felt rather than watched, hence 130ms; and under reduced-motion it is
   removed entirely rather than shortened, because the transform is the
   part that causes trouble, not its duration. */
@media (prefers-reduced-motion: reduce) {
  .ebs-pop { transition: none; transform: none; opacity: 1; }
  .ebs-caret { transition: none; }
}
`;

function injectCSS() {
  if (document.getElementById("eb-select-css")) return;
  const style = document.createElement("style");
  style.id = "eb-select-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CARET = `<svg class="ebs-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const CHECK = `<svg class="ebs-check" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>`;

/** Skip enhancement on touch devices (pointer: coarse), where the native picker is better. */
function shouldEnhance(select) {
  if (select.dataset.ebSelect === "off") return false;
  if (select.multiple || select.size > 1) return false;
  if (select.closest(".ebs")) return false;            /* already enhanced */
  /* Except the address picker, whose long lists open as a bottom sheet on phones, and the staff portal, which
     uses the themed list (as a bottom sheet) everywhere so its filters match the rest of the portal. */
  if (isCoarsePointer() && !isPortal() && !select.closest(".addr-cell") && !select.hasAttribute("data-eb-select")) return false;
  return true;
}

class EbSelectInstance {
  constructor(select) {
    this.select = select;
    this.id = "ebs-" + (++seq);
    this.open = false;
    this.activeIndex = -1;
    this.typeBuf = "";
    this.typeAt = 0;

    injectCSS();
    this.build();
    this.syncFromNative();
  }

  build() {
    const sel = this.select;

    const wrap = document.createElement("span");
    wrap.className = "ebs";
    /* Shape follows the class, but full width only inside .field. */
    if (FIELD_CLASSES.some(c => sel.classList.contains(c))) {
      wrap.classList.add("ebs--field");
      /* .auth-field counts as a form field too, so long options do not resize the box. */
      if (!sel.closest(".field, .auth-field")) wrap.classList.add("ebs--auto");
    }
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("ebs-native");
    /* The native select is removed from the tab order and hidden from assistive tech, since the trigger carries the label. */
    sel.setAttribute("tabindex", "-1");
    sel.setAttribute("aria-hidden", "true");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ebs-trigger";
    trigger.id = this.id + "-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", this.id + "-pop");
    /* The accessible name comes from the native control's aria-label. */
    const label = sel.getAttribute("aria-label");
    if (label) trigger.setAttribute("aria-label", label);
    else if (sel.id) {
      const lbl = document.querySelector(`label[for="${CSS_ESC(sel.id)}"]`);
      if (lbl) trigger.setAttribute("aria-label", lbl.textContent.trim());
    }
    if (sel.disabled) trigger.disabled = true;
    trigger.innerHTML = `<span class="ebs-label"></span>${CARET}`;
    wrap.appendChild(trigger);

    this.wrap = wrap;
    this.trigger = trigger;
    this.labelEl = trigger.querySelector(".ebs-label");

    trigger.addEventListener("click", e => { e.stopPropagation(); this.toggle(); });
    trigger.addEventListener("keydown", e => this.onTriggerKey(e));

    /* Keep the trigger in sync when other code changes select.value. */
    sel.addEventListener("change", () => this.syncFromNative());

    /* Rebuild the popup when the options change at runtime. */
    this.mo = new MutationObserver(() => this.syncFromNative());
    this.mo.observe(sel, { childList: true, subtree: true, characterData: true });
  }

  get options() {
    return Array.from(this.select.options);
  }

  syncFromNative() {
    const opt = this.select.selectedOptions[0];
    const text = opt ? opt.textContent.trim() : "";
    this.labelEl.textContent = text;
    /* The full label is in the title for hover, since long labels are truncated. */
    this.trigger.title = text;
    this.trigger.disabled = this.select.disabled;
    if (this.open) this.renderOptions();
  }

  /* ---------------- open / close ---------------- */

  toggle() { this.open ? this.close() : this.openPop(); }

  openPop() {
    if (this.open || this.select.disabled) return;
    if (openInstance && openInstance !== this) openInstance.close();

    const pop = document.createElement("div");
    pop.className = "ebs-pop";
    /* Address fields get a search box that narrows the list as you type. */
    this.searchable = !!this.select.closest(".addr-cell");
    /* Touch: a bottom sheet with a dimmed backdrop, titled with the field label. */
    this.sheet = isCoarsePointer();
    if (this.sheet) {
      pop.classList.add("ebs-pop--sheet");
      /* Also the sort / page-size selects that opt in with data-eb-select. */
      const lab = this.select.closest(".addr-cell")?.querySelector("label");
      pop.dataset.title = ((lab ? lab.textContent : "") || this.select.getAttribute("aria-label") || "").replace("*", "").trim() || "Choose one";
      this.backdrop = document.createElement("div");
      this.backdrop.className = "ebs-backdrop";
      document.body.appendChild(this.backdrop);
    }
    pop.id = this.id + "-pop";
    const label = this.trigger.getAttribute("aria-label");
    this.listEl = pop;
    if (this.searchable) {
      pop.classList.add("ebs-pop--search");
      const box = document.createElement("div");
      box.className = "ebs-search";
      box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Type to search…" aria-label="Search">`;
      this.searchEl = box.querySelector("input");
      this.listEl = document.createElement("div");
      this.listEl.className = "ebs-list";
      pop.append(box, this.listEl);
      this.searchEl.addEventListener("input", () => this.filter());
      this.searchEl.addEventListener("keydown", e => this.onSearchKey(e));
    }
    this.listEl.setAttribute("role", "listbox");
    if (label) this.listEl.setAttribute("aria-label", label);
    document.body.appendChild(pop);

    this.pop = pop;
    this.open = true;
    openInstance = this;
    this.wrap.classList.add("is-open");
    this.trigger.setAttribute("aria-expanded", "true");

    this.renderOptions();
    this.activeIndex = this.select.selectedIndex >= 0 ? this.select.selectedIndex : 0;
    this.paintActive(true);
    this.position();

    /* Force a reflow (not requestAnimationFrame, which pauses in background tabs) before showing the popup. */
    void pop.offsetHeight;
    pop.classList.add("is-in");

    pop.addEventListener("mousedown", e => { if (e.target !== this.searchEl) e.preventDefault(); }); /* keep focus where it is */
    pop.addEventListener("click", e => {
      const row = e.target.closest(".ebs-opt");
      if (!row || row.getAttribute("aria-disabled") === "true") return;
      this.choose(+row.dataset.i);
    });
    pop.addEventListener("mousemove", e => {
      const row = e.target.closest(".ebs-opt");
      if (!row) return;
      this.activeIndex = +row.dataset.i;
      this.paintActive(false);
    });

    /* One teardown for all the fixed popup's listeners (see popup.js). */
    /* The fourth argument makes page scrolls reposition the popup instead of closing it (see closeOn()). */
    this.teardown = closeOn(pop, this.wrap, () => this.close(), () => this.position());
    if (this.searchEl) this.searchEl.focus({ preventScroll: true });
  }

  /* Search matches names or words that start with the typed text, falling back to matches inside words only when none start with it. */
  filter() {
    const q = (this.searchEl?.value || "").trim().toLowerCase();
    const rows = this.listEl.querySelectorAll(".ebs-opt");
    const kind = this.options.map(o => {
      if (!q) return 2;
      if (o.value === "") return 0;            /* the "Choose a …" placeholder */
      const t = o.textContent.trim().toLowerCase();
      if (t.startsWith(q) || t.split(/[\s(/-]+/).some(w => w.startsWith(q))) return 2;
      return t.includes(q) ? 1 : 0;
    });
    const need = kind.includes(2) ? 2 : 1;
    this.hiddenRows = new Set();
    let best = -1;
    rows.forEach((row, i) => {
      const show = kind[i] >= need;
      row.hidden = !show;
      if (!show) this.hiddenRows.add(i);
      else if (best < 0 && !this.options[i].disabled) best = i;
    });
    let empty = this.listEl.querySelector(".ebs-empty");
    const none = q && best < 0;
    if (none && !empty) {
      empty = document.createElement("div");
      empty.className = "ebs-empty";
      empty.textContent = "No matching place";
      this.listEl.appendChild(empty);
    } else if (!none && empty) empty.remove();
    if (q && best >= 0) { this.activeIndex = best; this.paintActive(true); }
    else if (!q) this.listEl.scrollTop = 0;
  }

  onSearchKey(e) {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); this.move(1); break;
      case "ArrowUp":   e.preventDefault(); this.move(-1); break;
      case "Enter":     e.preventDefault(); if (!this.hiddenRows?.has(this.activeIndex)) this.choose(this.activeIndex); break;
      case "Escape":    e.preventDefault(); e.stopPropagation(); this.close(true); break;
      case "Tab":       this.close(); break;
    }
  }

  close(refocus) {
    if (!this.open) return;
    this.open = false;
    if (openInstance === this) openInstance = null;
    this.wrap.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.removeAttribute("aria-activedescendant");

    if (this.teardown) { this.teardown(); this.teardown = null; }

    const pop = this.pop;
    this.pop = null;
    this.searchEl = null; this.hiddenRows = null;
    if (pop) { pop.classList.remove("is-in"); removeAfterExit(pop); }
    if (this.backdrop) { this.backdrop.remove(); this.backdrop = null; }
    if (refocus) this.trigger.focus();
  }

  /** Positioning lives in popup.js so EbSelect and EbDate behave the same. */
  position() {
    if (this.sheet) return;   /* pinned to the bottom by CSS */
    placeLayer(this.trigger, this.pop, { gap: GAP, maxH: MAX_H, minSpace: MIN_SPACE,
      /* <select data-dropup> opens its list upward when it can. */
      prefer: this.select.hasAttribute("data-dropup") ? "above" : "below" });
  }

  renderOptions() {
    if (!this.pop) return;
    this.hiddenRows = null;
    this.listEl.innerHTML = this.options.map((o, i) => `
      <div class="ebs-opt" role="option" id="${this.id}-o${i}" data-i="${i}"
           aria-selected="${o.selected ? "true" : "false"}"
           ${o.disabled ? 'aria-disabled="true"' : ""}>
        ${CHECK}<span class="ebs-opt-text"></span>
      </div>`).join("");
    /* Option labels are set as text, never HTML. */
    this.pop.querySelectorAll(".ebs-opt-text").forEach((el, i) => {
      el.textContent = this.options[i].textContent.trim();
    });
  }

  paintActive(scroll) {
    if (!this.pop) return;
    const rows = this.pop.querySelectorAll(".ebs-opt");
    rows.forEach((r, i) => r.classList.toggle("is-active", i === this.activeIndex));
    const row = rows[this.activeIndex];
    if (row) {
      this.trigger.setAttribute("aria-activedescendant", row.id);
      if (scroll) row.scrollIntoView({ block: "nearest" });
    }
  }

  move(delta) {
    const n = this.options.length;
    if (!n) return;
    let i = this.activeIndex;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (!this.options[i].disabled && !this.hiddenRows?.has(i)) break;
    }
    this.activeIndex = i;
    this.paintActive(true);
  }

  moveTo(i) {
    if (i < 0 || i >= this.options.length) return;
    this.activeIndex = i;
    this.paintActive(true);
  }

  /** Commit a choice: write the native value and fire a bubbling change event, which is all the rest of the system listens for. */
  choose(i) {
    const opt = this.options[i];
    if (!opt || opt.disabled) return;
    const changed = this.select.selectedIndex !== i;
    this.select.selectedIndex = i;
    this.syncFromNative();
    this.close(true);
    if (changed) {
      this.select.dispatchEvent(new Event("input",  { bubbles: true }));
      this.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /* ---------------- keyboard ---------------- */

  onTriggerKey(e) {
    const k = e.key;

    /* While a type-ahead search is active (last second), Space is typed as part of the search instead of opening or choosing. */
    if (k === " " && this.typeBuf && Date.now() - this.typeAt <= 1000) {
      e.preventDefault();
      const i = this.typeAhead(k);
      if (i >= 0) { this.open ? this.moveTo(i) : this.choose(i); }
      return;
    }

    if (this.select.closest(".addr-cell") && k.length === 1 && k !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!this.open) this.openPop();
      if (this.searchEl) { this.searchEl.value += k; this.filter(); }
      return;
    }

    if (!this.open) {
      if (k === "Enter" || k === " " || k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault(); this.openPop();
      } else if (k.length === 1) {
        /* Type-ahead also works on the closed control. */
        e.preventDefault();
        const i = this.typeAhead(k);
        if (i >= 0) this.choose(i);
      }
      return;
    }

    switch (k) {
      case "Escape":    e.preventDefault(); this.close(true); break;
      case "Tab":       this.close(); break;   /* let Tab through — focus moves on */
      case "Enter":
      case " ":         e.preventDefault(); this.choose(this.activeIndex); break;
      case "ArrowDown": e.preventDefault(); this.move(1); break;
      case "ArrowUp":   e.preventDefault(); this.move(-1); break;
      case "Home":      e.preventDefault(); this.moveTo(0); break;
      case "End":       e.preventDefault(); this.moveTo(this.options.length - 1); break;
      default:
        if (k.length === 1) {
          e.preventDefault();
          const i = this.typeAhead(k);
          if (i >= 0) this.moveTo(i);
        }
    }
  }

  /** Type-ahead buffer resets after one second of no typing. */
  typeAhead(ch) {
    const now = Date.now();
    this.typeBuf = (now - this.typeAt > 1000) ? ch : this.typeBuf + ch;
    this.typeAt = now;
    const q = this.typeBuf.toLowerCase();
    const opts = this.options;
    const from = this.open ? this.activeIndex : this.select.selectedIndex;
    /* One letter cycles from the next row; several letters start at the current row so "san j" can move on to "San Jose". */
    const multi = this.typeBuf.length > 1;
    for (let n = 1; n <= opts.length; n++) {
      const i = (from + (multi ? n - 1 : n) + opts.length) % opts.length;
      if (!opts[i].disabled && opts[i].textContent.trim().toLowerCase().startsWith(q)) return i;
    }
    return -1;
  }

  destroy() {
    this.close();
    if (this.mo) this.mo.disconnect();
    const sel = this.select;
    sel.classList.remove("ebs-native");
    sel.removeAttribute("tabindex");
    sel.removeAttribute("aria-hidden");
    this.wrap.parentNode.insertBefore(sel, this.wrap);
    this.wrap.remove();
    delete sel._ebs;
  }
}

/* querySelector needs the id escaped; older engines lack CSS.escape. */
function CSS_ESC(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/* Public surface */

/** Enhance every matching <select> inside `root` that is not already done. */
function enhance(root = document) {
  const found = root.querySelectorAll ? root.querySelectorAll(SELECTOR) : [];
  let n = 0;
  found.forEach(sel => {
    if (sel._ebs || !shouldEnhance(sel)) return;
    try { sel._ebs = new EbSelectInstance(sel); n++; }
    catch (err) { console.warn("[EbSelect] could not enhance", sel.id || sel, err); }
  });
  return n;
}

/** Re-read the native value/options into the trigger. */
function sync(sel) {
  if (sel && sel._ebs) sel._ebs.syncFromNative();
}

/** Close whatever is open — used by modal close handlers. */
function closeAll() { if (openInstance) openInstance.close(); }

/* Escape anywhere closes the open popup, even when focus has wandered. */
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && openInstance) { e.stopPropagation(); openInstance.close(true); }
}, true);

/* A debounced MutationObserver enhances selects added after load, so screens never need to call enhance(). */
let pending = null;
function watch() {
  const mo = new MutationObserver(muts => {
    if (pending) return;
    const worth = muts.some(m => m.addedNodes.length);
    if (!worth) return;
    pending = setTimeout(() => { pending = null; enhance(document); }, 30);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

function init() {
  injectCSS();
  enhance(document);
  watch();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export const EbSelect = { enhance, sync, closeAll, SELECTOR };
