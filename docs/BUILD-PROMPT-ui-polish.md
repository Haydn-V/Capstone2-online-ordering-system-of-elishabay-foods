# Build prompt — dropdowns, toolbar alignment, header identity, best-seller tiles

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP. No
framework, no Composer, no npm build step — do not add any. This is a presentation pass: no
schema changes, no endpoint changes, no behaviour changes.

## Conventions

- Use the existing tokens in `assets/css/portal/portal.css` and `assets/css/public/styles.css`.
  **No new colour literals.** Everything must hold up in both themes, light and dark.
- Never signal state with colour alone — pair it with a label, icon or shape.
- No inline `onclick` handlers; `initSidebar()` in `engine.js` carries a comment explaining
  why the brief rules them out.
- Respect `prefers-reduced-motion` on everything you animate.
- Match the house comment style: explain **why** a change exists.
- **Read the current CSS before you edit it.** This stylesheet has been revised repeatedly;
  any line number I give below is a starting point, not a promise.

---

# Task 1 — One real dropdown component, used everywhere

The filter controls across the system feel dead, and there is a concrete reason: they are
native `<select>` elements. The browser and the operating system draw the popup list, so no
stylesheet can reach inside it — no hover styling, no motion, no theming. `select.filter-select`
(portal.css ~line 1168) styles the closed box only; everything that happens on click belongs
to the OS.

**Build one custom listbox component and use it for every dropdown in the system** — portal
and storefront both. Then bring the two topbar dropdowns up to the same standard.

## The rule that keeps this from breaking everything

Dozens of call sites read these controls today — `$("#filter-products").onchange`,
`$("#cust-page-size")`, `$("#filter-customers")`, `#sort-select` on the shop page, and more.
Grep `<select` across `portal/views/*.html` and `public/*.html` before you start; there are
well over a dozen.

**So: enhance the existing `<select>`, do not replace it.** Keep the real element in the DOM
as the source of truth (visually hidden, still focusable by the component), render your custom
button and listbox alongside it, and on selection write `select.value` and dispatch
`new Event("change", { bubbles: true })`. Every existing listener then keeps working untouched
and the form still submits normally. If you instead invent a parallel state store, you will
have to find and rewrite every consumer, and the ones you miss will fail silently.

Initialise it by scanning for a class or attribute, so a new screen opts in by adding one
attribute rather than by wiring JavaScript.

## What it has to do

- **Keyboard, fully.** Enter/Space/Down to open, Up/Down to move, Home/End to jump, Enter to
  choose, Escape to close and return focus to the trigger, Tab to close and move on.
  Type-ahead — typing "ret" jumps to "Retailer" — because the native control does it and
  people expect it.
- **Screen readers.** `role="combobox"` with `aria-expanded` and `aria-controls` on the
  trigger, `role="listbox"` and `role="option"` with `aria-selected` in the popup,
  `aria-activedescendant` tracking the highlighted option. The visually-hidden native select
  keeps the accessible name from its existing `aria-label`.
- **Not clipped.** Several of these sit inside `.table-wrap` and inside modals, which have
  their own overflow and stacking contexts. A popup that gets cut off by its container is the
  classic failure here — decide how you avoid it (a fixed-position layer appended to the body
  and positioned to the trigger is the reliable answer) and say what you did. Reposition or
  flip upward when there is no room below, and close on scroll or resize rather than leaving
  the popup floating away from its trigger.
- **Motion with restraint.** A short fade-and-scale from the trigger's edge, options that
  respond on hover and highlight on keyboard focus. This is what was being asked for — but a
  filter dropdown is used dozens of times an hour, so keep it quick. Under
  `prefers-reduced-motion`, no transform, no fade.
- **Long lists** scroll inside a max-height with a styled scrollbar.
- **Touch.** Verify on a narrow viewport. If your component turns out worse than the native
  control on a phone, fall back to native below a breakpoint and say so — that is a
  legitimate answer, not a failure.

## The two topbar dropdowns

`.notif-dropdown` and `.user-dropdown` (portal.css ~lines 742 and 887) already fade and
translate on `.open`. Lift them to match the new component: a transform-origin anchored to the
control they belong to, a small pointer or offset that ties the panel to its trigger, hover
and focus states on every row, a styled scrollbar on `.nd-list`, and a proper empty state when
there are no notifications. Close on Escape and on outside click, and return focus to the
trigger — check whether they already do; if not, that is part of this task.

*Done when:* every dropdown in the portal and the storefront opens with the same motion and
styling, keyboard and screen-reader behaviour matches or beats the native control, no popup is
clipped inside a table or modal, and every existing `change` listener still fires.

---

# Task 2 — Pill tabs and filters on one row

Today the pill tabs sit in `.tabs` and the search, per-page and status controls sit in a
separate `.table-toolbar` below them — two bands of chrome stacked above every table.

**Merge them into a single toolbar row: tabs on the left, filters pushed to the right.**

- One flex row, `justify-content: space-between`, with the tab group and the filter group as
  the two children. Align them on a shared baseline and give every control in the row the same
  height, so the pills, the search box and the dropdowns line up as one band. Mismatched
  heights are most of what reads as "not aligned properly".
- **Handle the screens that have only one of the two.** Products and User Management have both.
  Batches, Expiry, Payments and Sales have filters and no tabs; some screens have tabs and no
  filters. The merged row must look deliberate in all three cases, not left-heavy or
  right-heavy with a gap where the missing half was.
- **Responsive.** At narrow widths the two groups stack, tabs first, each group still aligned
  internally and full width. Verify at 390px that nothing overflows horizontally and the
  tab pills wrap rather than squash.
- Leave the *second* `.table-toolbar` — the one below the table carrying the "showing N of M"
  text and the pagination — where it is. That one is correct.
- Do this once in the stylesheet and apply it across the views, rather than per screen.

*Done when:* every screen with tabs and filters shows them as a single aligned row, screens
with only one of the two still look right, and the layout stacks cleanly on a phone.

---

# Task 3 — Outline the signed-in identity in the header

The header now shows the user's name and role beside the avatar. The request is to give that
block **a visible outline so it reads as one identifiable unit** — a bordered pill enclosing
the name, the role and the avatar together, as sketched on the screenshot.

- Wrap name, role and avatar in one rounded container with a real border, using the existing
  border and surface tokens. It should read as a quiet chip, not a call-to-action — it must not
  compete with the gold primary buttons.
- **It is still the dropdown trigger.** Whatever markup you change, clicking anywhere in the
  chip must open the user menu, it must stay keyboard-focusable, and it must show a clear
  `:focus-visible` ring on the whole chip rather than on the avatar alone. Give it a hover
  state so it is discoverable as a control.
- Keep the avatar circle visually distinct inside the outline — the border should hug the
  group, not fight the circle. Mind the spacing on the right so the chip does not crowd the
  edge of the bar.
- **Responsive.** At the width where the name and role currently collapse, the outline must
  collapse with them — either hugging just the avatar or disappearing entirely. An empty
  bordered box around a lone circle looks like a mistake. Verify at 390px.
- Both themes: check the border is visible on the dark surface, not just the light one.

*Done when:* the name, role and avatar read as one outlined chip at desktop width, it still
opens the user menu by mouse and keyboard, and it degrades cleanly on a phone.

---

# Task 4 — Best Sellers: a tile grid, not a spreadsheet

**Where:** the Landing Page module's Best Sellers selector, built in `assets/js/portal/engine.js`
around line 2475 as `rows.map(function(p, i){ … <tr class="${on ? "is-featured" : ""}"> … })`,
with `.lp-cell-img` and `.lp-rank` styled in `portal.css` (~line 1636).

It is currently a dense table — rank, product, units sold, revenue, rating, stock, photo — and
reads as a spreadsheet when its actual job is picking a handful of products to feature.

**Rebuild it as a grid of tiles.** Each tile carries:

- the **product photo** (or the placeholder when there is none),
- the **product name and category**,
- the **rank** and **units sold**, given real weight — this is the ranking the caption
  promises,
- a clear **feature on/off control**,
- revenue, rating and stock on a single quiet secondary line, so nothing is lost but nothing
  competes.

**Four things that will break if you are not careful:**

1. **The save reads `$$("[data-feat]")`.** Two places collect the checked boxes — the change
   handler around line 2536 and the save around line 2633. Keep a real checkbox carrying
   `data-feat="<product id>"` inside each tile and both keep working. If you replace it with a
   div acting as a switch, you must update both call sites and give it proper
   `role="switch"` + `aria-checked` + keyboard support. The checkbox is the smaller change and
   the more accessible one.
2. **Line ~2540 calls `box.closest("tr")`** to toggle the `is-featured` class. There is no
   `<tr>` in a tile grid — that line will throw or silently do nothing. Point it at the tile.
3. **The selected state has to be obvious at a glance.** The whole point of the screen is
   seeing which six are featured. Give a selected tile a distinct treatment — border, tint and
   a check — not colour alone.
4. **An empty selection must stay reachable.** There is a comment at ~line 2630 recording a
   real bug: unticking every product silently kept the previous list, so "nothing is
   featured" was a state the administrator could not reach. Do not reintroduce it.

Keep the "Ranked by units sold — tick the products to feature" caption, the photo
Change / Add photo control and its `data-goto-product` jump to Products, and the storage meter
below. Make the grid responsive — several tiles per row on desktop, one or two on a phone.

*Done when:* the Landing Page module shows a scannable tile grid, ticking and unticking still
saves correctly including down to zero featured products, and the photo controls still work.

---

# Order of work

1. Task 3 — smallest, self-contained, immediately visible.
2. Task 4 — one screen, no shared CSS.
3. Task 2 — shared toolbar layout; check every screen that uses it afterwards.
4. Task 1 — the largest. Build the component, prove it on one screen, then roll it out.

Test each against the real XAMPP install in both themes and at both desktop and phone widths
before moving on. Do not batch all four and test at the end.

Two things I want stated back in your summary: how you stopped the dropdown popup being
clipped inside tables and modals, and whether you kept native selects on touch devices.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
