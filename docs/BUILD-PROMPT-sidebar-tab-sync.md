# Build prompt — sidebar highlight does not follow the in-page tabs

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP. No
framework, no build step — do not add any.

One reported bug in the portal's sidebar, which turns out to be three related faults in the
same navigation code. I have traced each; read the surrounding code before changing it and
tell me if any diagnosis is wrong.

## Files

- `assets/js/portal/engine.js` — `navigate()` ~line 1243, `initSidebar()` ~line 1302, the
  Users tab block ~line 1627, the Products tab block ~line 2612
- `assets/js/portal/inventory.js` — `renderInventoryManage()` ~line 187
- `portal/shell.html` — the sidebar markup
- `assets/css/portal/portal.css` — `.nav-parent` / `.nav-sub-list` ~line 543

`engine.js` and `inventory.js` are classic scripts sharing the same globals — `inventory.js`
already calls `adminState`, `toast`, `EbApi` and `$$` directly — so anything defined in
`engine.js` is reachable from `inventory.js` without any wiring.

## Conventions

- Use the existing portal tokens; no new colour literals.
- Match the house comment style — explain **why** a change exists.
- Do not introduce inline `onclick` handlers. There is a comment at `initSidebar()`
  explaining that the brief rules them out; respect it.

---

# The reported symptom

In **Inventory → Inventory Management**, clicking a tab pill in the page body (Stock Overview,
Restock, Replenish (Bulk), Adjustment, Adj. Log, Archive) switches the panel but leaves the
sidebar highlight on whatever was clicked last. Click **Restock** in the sidebar, then
**Replenish (Bulk)** in the pill row, and the sidebar still highlights Restock. User
Management and Products do not behave this way.

---

# Task 1 — There is one highlight rule, written in three places

**Cause.** `navigate()` (~line 1243) owns the real rule:

```js
$$(".nav-item").forEach(btn => btn.classList.remove("active"));
…
$$(".nav-item").forEach(btn => {
  if(btn.dataset.mod === mod && !btn.dataset.tab) btn.classList.add("active");   // the parent
  if(btn.dataset.mod === mod && btn.dataset.tab === tab) btn.classList.add("active"); // the sub-item
});
```

Users (~line 1627) and Products (~line 2612) each re-implement it inline when their own tab
buttons are clicked — and **both copies are subtly wrong**. They clear every `.nav-item` and
then re-add the active class to the matching sub-item only, dropping the `!btn.dataset.tab`
line. So after clicking a tab inside Users or Products, the parent row ("User Management",
"Products") silently loses its highlight, which `navigate()` would have kept. Inventory
Management has no copy at all — which is the bug you reported.

**Fix.** Extract the rule into a single function in `engine.js`, near `navigate()`:

```js
function syncNavHighlight(mod, tab) { … }
```

It clears every `.nav-item` and applies both lines — the parent (no `data-tab`) and the
matching sub-item. Then:

- `navigate()` calls it instead of doing the work inline.
- The Users block and the Products block delete their hand-rolled copies and call it.
- Inventory Management calls it (Task 2).

One rule, one place. The next module with sidebar sub-items then gets it for free.

---

# Task 2 — Wire Inventory Management's tabs to the sidebar

**Cause.** `renderInventoryManage(tab)` in `inventory.js` (~line 187) sets the pill state and
swaps the panel, and never touches the sidebar:

```js
function renderInventoryManage(tab="overview"){
  adminState.invTab = tab;
  $$("#invmgmt-action-tabs .inv-action-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.tab===tab);
    btn.onclick = ()=> renderInventoryManage(btn.dataset.tab);
  });
  …
}
```

**The good news:** the tab keys already line up exactly. The pills in
`portal/views/inventory-manage.html` carry `data-tab="overview|restock|replenish|adjust|adjlog|archive"`,
and the sidebar sub-items in `shell.html` carry `data-mod="inventory-manage"` with the same
six `data-tab` values. Nothing needs renaming.

**Fix.** Call `syncNavHighlight("inventory-manage", tab)` inside `renderInventoryManage()`,
so it applies however the tab was reached — a pill click, a sidebar click through
`navigate()`, or a programmatic render. Putting it in the render rather than only in the pill
handler is the point: it cannot then drift out of sync again.

Consider whether the pill handler should simply call `navigate("inventory-manage", tab)`
instead of `renderInventoryManage(...)` directly. If you go that way, check what else
`navigate()` does — it scrolls `#main-content` to the top and closes the mobile sidebar —
and decide whether that is wanted when someone is only switching tabs within a screen
already on their display. I suspect it is not, and that calling `syncNavHighlight()` from
the render is the better fix. Make the call and say which you chose and why.

---

# Task 3 — Clicking the parent highlights nothing underneath

While you are here: this is why the Restock screen can be open with no sub-item lit at all.

**Cause.** The sidebar's parent row is `data-mod="inventory-manage"` with **no** `data-tab`,
so clicking it calls `navigate("inventory-manage", undefined)`. The render map then resolves
the tab itself:

```js
"inventory-manage": ()=> renderInventoryManage(tab || adminState.invTab || "overview"),
```

So the panel opens on the remembered tab — Restock, say — while the highlighter was handed
`undefined` and lights only the parent. The screen and the sidebar disagree from the first
click.

**Fix.** Resolve the effective tab **before** highlighting, so `syncNavHighlight()` receives
the tab that is actually rendered rather than the one that was passed in. The cleanest shape
is for `navigate()` to compute the effective tab for modules that have a remembered one, then
highlight and render from that single value. Check the other entries in the render map for
the same pattern — `users` and `products` also take a `tab` — and handle any that resolve a
default the same way.

---

# Task 4 — A highlighted item inside a collapsed group is invisible

`.nav-parent.collapsed + .nav-sub-list { display: none; }` (portal.css ~line 547) hides the
sub-items when a group is collapsed, and `.admin-app.sidebar-collapsed .nav-sub-list` hides
them when the whole sidebar is in icon-only mode. If a sub-item becomes active while its
group is collapsed, the highlight lands on something nobody can see.

**Fix.** When `syncNavHighlight()` activates a sub-item, expand its group — remove
`collapsed` from the preceding `.nav-parent` — so the active item is visible. Leave the
icon-only sidebar mode alone; that is a deliberate global state and should not be forced open
by a navigation event. Make sure the parent row still reads as active in icon-only mode, since
that is the only indicator available there.

---

# Verify

Check every module that has both sidebar sub-items and in-page tabs — at minimum Inventory
Management, User Management (Customer / Employee Accounts) and Products (Catalog /
Varieties). For each:

1. Click a sub-item in the sidebar → the correct panel and tab open, the sub-item **and** its
   parent are highlighted.
2. Click a tab in the page body → the sidebar highlight moves to match.
3. Click the parent row → the panel opens on its remembered tab and the sidebar highlights
   that same tab.
4. Collapse the group, navigate to one of its tabs from elsewhere (a dashboard shortcut, for
   example) → the group expands and the active item is visible.
5. Repeat at a mobile width, where `navigate()` closes the sidebar.

Test against the real XAMPP install. If any diagnosis above conflicts with what you find in
the code, follow the code and tell me where I was wrong.
