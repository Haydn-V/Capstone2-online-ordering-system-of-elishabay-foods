/* ============================================================
   EbSelect — one custom listbox, used for every dropdown
   ------------------------------------------------------------
   WHY THIS EXISTS

   Every filter control in the system was a native <select>. The closed
   box is styleable — portal.css dresses `select.filter-select` with the
   pill border, the gold focus ring and a chevron — but the POPUP is
   drawn by the operating system. No stylesheet can reach inside it:
   no hover treatment, no motion, no theming, no dark mode. Clicking a
   filter dropped you out of the application's visual language and into
   Windows'. That is what "the dropdowns feel dead" was describing.

   THE RULE THAT KEEPS THIS FROM BREAKING EVERYTHING

   The native <select> STAYS IN THE DOM and stays the source of truth.
   Over a dozen views and several thousand lines of script read these
   controls directly — `$("#filter-products").onchange`,
   `$("#cust-page-size").value`, `#sort-select` on the storefront, the
   [data-refilters] table in engine.js, EbPaginate's page-size handling.
   This enhances them; it does not replace them.

   On selection the component writes `select.value` and dispatches
   `new Event("change", { bubbles: true })`, so every existing listener
   fires exactly as it did before and the element still submits with its
   form. A parallel state store would have meant finding and rewriting
   every consumer, and the ones missed would have failed silently — a
   filter that no longer filters, with no error to find it by.

   OPT-IN BY ATTRIBUTE OR CLASS

   Anything matching SELECTOR below is enhanced on load. A new screen
   opts in by adding `class="filter-select"` (which it already does, for
   the styling) or `data-eb-select`, and opts OUT with
   `data-eb-select="off"`. No per-screen JavaScript.

   TOUCH DEVICES KEEP THE NATIVE CONTROL — see shouldEnhance().
   ============================================================ */

/* Every dropdown in the system, by the class it already carries.

   `filter-select` is the portal's toolbar filter, `sort-select` the
   storefront's, `control` a form field inside a modal, `auth-input` the same
   on the public partner form. They are NOT one shape — a toolbar filter is a
   pill and a form field is a full-width box — so the trigger takes its shape
   from the class the native carried (see FIELD_CLASSES). Adding
   `data-eb-select` opts a new control in; `data-eb-select="off"` opts out. */
import { placeLayer, closeOn, isCoarsePointer, removeAfterExit } from "./popup.js";

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

/* ------------------------------------------------------------------
   Component stylesheet, injected once.

   It lives here rather than in portal.css or styles.css because the
   component is used by BOTH and those two files are loaded by different
   pages — the alternative was the same block copied into each, which is
   how two stylesheets start disagreeing. Every value is an existing
   token, so it inherits both themes with no work: the tokens are
   redefined per theme by whichever stylesheet is present, and the popup
   reads whatever is in scope on <html>.
   ------------------------------------------------------------------ */
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

/**
 * Should this control be enhanced at all?
 *
 * NO ON TOUCH, DELIBERATELY. A phone's native <select> opens the platform
 * picker — a full-height wheel with momentum, large hit targets and the
 * keyboard handling the OS already does well. A custom listbox on the same
 * device is a smaller, worse copy of it. The brief allows falling back to
 * native below a breakpoint; keying on `pointer: coarse` is better than a
 * width, because it asks what the user is pointing WITH rather than
 * guessing from how wide the window is.
 */
function shouldEnhance(select) {
  if (select.dataset.ebSelect === "off") return false;
  if (select.multiple || select.size > 1) return false;
  if (select.closest(".ebs")) return false;            /* already enhanced */
  if (isCoarsePointer()) return false;
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
    /* The field SHAPE (taller padding, softer radius) follows the class; the
       full WIDTH follows .field, which is the condition the stylesheet itself
       uses for `width: 100%`. Tying width to the class alone stretched the
       Sales Report's "Compare with" select across the entire panel — it wears
       .control for its border, not for its width. */
    if (FIELD_CLASSES.some(c => sel.classList.contains(c))) {
      wrap.classList.add("ebs--field");
      /* `.auth-field` counts as a form field too. It is the auth modal's and
         the retailer form's name for the same wrapper `.field` is elsewhere,
         and leaving it out meant every dropdown in those two forms fell to
         `ebs--auto` and sized itself to its content — so picking "Bangsamoro
         Autonomous Region In Muslim Mindanao (BARMM)" grew the Region box
         across the Province box beside it. */
      if (!sel.closest(".field, .auth-field")) wrap.classList.add("ebs--auto");
    }
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("ebs-native");
    /* Out of the tab order but still programmatically focusable, and hidden
       from the accessibility tree so it is not announced twice — the trigger
       below carries the label and the state. */
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
    /* The accessible name comes off the native control, which already has an
       aria-label on every one of these in the views. */
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

    /* Other code may set select.value directly and dispatch change (or have
       change dispatched at it). Either way the trigger has to follow, or the
       button says one thing while the query runs on another. */
    sel.addEventListener("change", () => this.syncFromNative());

    /* Options are rebuilt at runtime on several screens — the status filters
       in the orders module, the category filter, the retailer picker. Without
       this the popup would keep offering last render's list. */
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
    /* The label ellipsises when it does not fit — "Bangsamoro Autonomous
       Region In Muslim Mindanao (BARMM)" will not fit anywhere sensible — so
       the full text is kept on the title for a hover. The accessible name
       still comes from the content, which browsers prefer over title, so this
       adds nothing for a screen reader to say twice. */
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
    pop.id = this.id + "-pop";
    pop.setAttribute("role", "listbox");
    const label = this.trigger.getAttribute("aria-label");
    if (label) pop.setAttribute("aria-label", label);
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

    /* Flush the start state, then reveal — a forced reflow rather than
       requestAnimationFrame.

       rAF is the usual way to do this and is WRONG here: browsers suspend it
       in a background or hidden tab, so a popup opened while the tab was not
       being painted never got `is-in` and stayed at opacity 0 — an invisible
       list that still ate clicks. Reading offsetHeight commits the initial
       styles synchronously, which is all the transition actually needs, and it
       happens whether or not anything is being painted. */
    void pop.offsetHeight;
    pop.classList.add("is-in");

    pop.addEventListener("mousedown", e => e.preventDefault()); /* keep focus on the trigger */
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

    /* A fixed popup does not move with the page, so anything that moves the
       page under it has to close it — otherwise it hangs in mid-air pointing
       at nothing. One teardown function rather than four listeners to
       remember; see popup.js. */
    /* The fourth argument is what turns a page scroll into a reposition
       instead of a dismissal — see closeOn(). */
    this.teardown = closeOn(pop, this.wrap, () => this.close(), () => this.position());
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
    if (pop) { pop.classList.remove("is-in"); removeAfterExit(pop); }
    if (refocus) this.trigger.focus();
  }

  /** Place the popup against the trigger. Geometry lives in popup.js so this
      and the date picker flip and clamp identically — see the note there. */
  position() {
    placeLayer(this.trigger, this.pop, { gap: GAP, maxH: MAX_H, minSpace: MIN_SPACE });
  }

  renderOptions() {
    if (!this.pop) return;
    this.pop.innerHTML = this.options.map((o, i) => `
      <div class="ebs-opt" role="option" id="${this.id}-o${i}" data-i="${i}"
           aria-selected="${o.selected ? "true" : "false"}"
           ${o.disabled ? 'aria-disabled="true"' : ""}>
        ${CHECK}<span class="ebs-opt-text"></span>
      </div>`).join("");
    /* Text set as text, not interpolated into the template — option labels
       are data (product names, customer names) and must not be able to carry
       markup into the popup. */
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
      if (!this.options[i].disabled) break;
    }
    this.activeIndex = i;
    this.paintActive(true);
  }

  moveTo(i) {
    if (i < 0 || i >= this.options.length) return;
    this.activeIndex = i;
    this.paintActive(true);
  }

  /**
   * Commit a choice.
   *
   * THIS IS THE WHOLE CONTRACT WITH THE REST OF THE SYSTEM: write the native
   * value, then dispatch a bubbling `change`. Everything downstream —
   * [data-refilters] in engine.js, EbPaginate's page-size handling, the
   * storefront's sort handler — is listening for exactly that event on
   * exactly that element and needs no knowledge of this component.
   */
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

    /* A SPACE IN THE MIDDLE OF A SEARCH IS PART OF THE SEARCH.

       Space normally opens the list (closed) or chooses the active row (open).
       But names are full of spaces — "San Jose", "Barangay 105", "Poblacion
       East" — and typing one of those used to hit the space, open or commit the
       list, and drop the rest of the name on the floor. So while a type-ahead
       buffer is live (typed within the last second), Space is a character.
       With no search in progress it keeps its usual job. This is the behaviour
       the WAI-ARIA combobox pattern describes for the same conflict. */
    if (k === " " && this.typeBuf && Date.now() - this.typeAt <= 1000) {
      e.preventDefault();
      const i = this.typeAhead(k);
      if (i >= 0) { this.open ? this.moveTo(i) : this.choose(i); }
      return;
    }

    if (!this.open) {
      if (k === "Enter" || k === " " || k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault(); this.openPop();
      } else if (k.length === 1) {
        /* Type-ahead works on the closed control too, the way the native one
           does: typing "ret" with the box shut selects Retailer outright. */
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

  /**
   * Type-ahead. The buffer resets after a second of silence, so "ret" jumps
   * to Retailer while a later "r" starts again rather than looking for "retr".
   */
  typeAhead(ch) {
    const now = Date.now();
    this.typeBuf = (now - this.typeAt > 1000) ? ch : this.typeBuf + ch;
    this.typeAt = now;
    const q = this.typeBuf.toLowerCase();
    const opts = this.options;
    const from = this.open ? this.activeIndex : this.select.selectedIndex;
    /* ONE LETTER starts AFTER the current row, so pressing "s" again cycles
       through every entry beginning with S. SEVERAL LETTERS start AT the current
       row, so "sa" stays on "San Antonio" while it still matches and moves on
       only when it stops matching.

       This used to compute the offset as `typeBuf.length > 1 ? 0 : n`, which for
       any buffer longer than one letter is zero on EVERY pass — the loop checked
       the current row over and over and never moved. So "san j" stopped on
       "San Antonio" instead of reaching "San Jose", and multi-letter type-ahead
       only ever worked when the current row already matched. Found through the
       address picker, where a city's barangay list runs to a hundred entries;
       the product picker had the same fault. */
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

/* ------------------------------------------------------------------
   Public surface
   ------------------------------------------------------------------ */

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

/* Screens inject their markup after load — the portal's module-loader
   assembles every view before init(), and renders replace whole panels. One
   observer catches all of it, so nothing has to remember to call enhance().
   Debounced because a render can add hundreds of nodes in one go. */
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
