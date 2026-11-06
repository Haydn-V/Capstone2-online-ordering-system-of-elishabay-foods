# StuffModule → Shared Modular RBAC Architecture

**Migration plan — Elisha Bay / Juris Bay Foods capstone**
Prepared 11 August 2026 · no files modified yet

---

## 1. The problem, precisely

Five staff portals exist. Only one of them is wired correctly.

`SubAdminModule/subadmin.html` loads Admin's stylesheets and all four Admin
scripts, then adds `subadmin.js` — 73 lines whose only job is to restrict the
entry point to the `Admin` role. It renders identically to Super Admin because
it *is* Super Admin's code, with `applyRBAC()` hiding what the role lacks.

The other three never load Admin's engine at all:

| Portal | Admin CSS | Admin JS | Own JS | Own seed data | `data-perm` attrs |
|---|---|---|---|---|---|
| `SubAdminModule` | ✅ | ✅ all 4 files | 73-line gate | — | 16 |
| `CashierModule` | ✅ | ❌ **none** | `cashier.js` — 1,744 lines | `PRODUCTS`, `ORDERS`, `DAILY_SALES`, `PAYMENT_ACCOUNTS` | **0** |
| `InventoryModule` | ✅ | ❌ **none** | `inventory.js` — 1,224 lines | `PRODUCTS`, `BATCHES`, `ADJUSTMENTS`, `INV_AUDIT` | **0** |
| `OrdersModule` | ✅ | ❌ **none** | `orders.js` — 1,686 lines | `PRODUCTS`, `ORDERS`, `RETURNS`, `NOTIFICATIONS` | **0** |

They load `admin.css` for styling but reimplement every behaviour underneath it.
That is exactly why contents and design drift: the stylesheet is shared, the
markup and logic are not.

**Zero `data-perm` attributes in those three files means `applyRBAC()` is a
no-op there.** Those portals are not governed by RBAC at all — they are
hardcoded single-role pages that happen to check one hardcoded credential
(`LOCAL_CASHIER`, `LOCAL_STAFF`) at login.

### 1.1 What is duplicated

- **4,654 lines of JavaScript** across the three staff files, re-implementing
  logic Admin already has in `admin-pos.js` (533), `admin-inventory.js` (580)
  and `admin-orders.js` (1,073).
- **Utility helpers**, redeclared in all four engines: `$`, `$$`, `peso`,
  `escHtml`, `fmtDate`, `fmtDateTime`, `initials`, `stockInfo`, `getProduct`,
  `toast`, `openModal`, `closeModal`, `initTheme`, `checkSessionAuth`.
- **Seed data.** Each portal carries its own `PRODUCTS` array. Admin's has 12
  entries with `archived`, `tint` and `desc` fields; the staff copies are
  shorter and shaped differently. Stock edited in one portal is invisible to
  the others.
- **Staff accounts, in three places**: `admin.js:57` (`STAFF_ACCOUNTS`),
  `V4Home/HomePage/script.js:31` (the landing router's own copy — currently
  correct, but manually kept in sync), and a single-role `LOCAL_*` constant
  inside each staff file.

### 1.2 A consequence worth knowing before you try the obvious fix

You cannot simply add `<script src="../AdminModule/admin.js">` to
`cashier.html` and keep `cashier.js`. They collide on **41 top-level
identifiers** — `$`, `$$`, `CONFIG`, `PRODUCTS`, `ORDERS`, `PAYMENT_ACCOUNTS`,
`MOD_DESC`, `checkSessionAuth`, `closeModal`, `escHtml`, `fmtDate` and 30 more.
The second `const` declaration throws `SyntaxError: Identifier 'PRODUCTS' has
already been declared`, and the **entire script file** fails to execute, not
just that line.

Collisions with `admin.js`, measured: `cashier.js` **41**, `inventory.js`
**29** (including `init`, `initLogin`, `initSidebar`, `initModal`,
`initModDescriptions`), `orders.js` **28** (including `init`, `initTheme`).
The old per-portal engines must be *removed*, not layered.

### 1.3 The good news

**Admin is a strict superset.** Every module in every staff portal already
exists in Admin. Nothing is lost by consolidating — the names merely drifted.

---

## 2. Module name mapping

Admin defines 24 modules. Section markup and nav ids agree
(`data-mod="pos"` → `id="mod-pos"`).

| Staff portal module | → Admin canonical | Permission (`MOD_PERM`) |
|---|---|---|
| `cashier: walkin` | `pos` | `pos.use` |
| `cashier: payment` | `posPayment` | `pos.use` |
| `cashier: payscheme` | `payments` | `payments.manage` |
| `cashier: transactions` | `transactions` | `transactions.view` |
| `cashier: sales` | `sales` | `sales.report` |
| `inventory: inventory` | `inventory-manage` | `inventory.manage` |
| `inventory: expiry` | `expiry` | `inventory.manage` |
| `inventory: auditlog` | `audit` | `audit.view` |
| `orders: mod-queue` | `ordersqueue` | `orders.accept` |
| `orders: mod-payment-verify` | `paymentverify` | `orders.accept` |
| `orders: mod-order-status` | `orderstatus` | `orders.status` |
| `orders: mod-history` | `orderhistory` | `transactions.view` |
| `orders: mod-receipts` | `receipts` | `orders.view` |
| `orders: mod-returns` | `returns` | `orders.returns` |
| `orders: mod-transactions` | `onlineTxns` | `orders.view` |
| `orders: mod-payscheme` | `payments` | `payments.manage` |
| `dashboard`, `notifications` | same | *(ungated)* |

Admin-only modules with no staff equivalent: `users`, `b2b`, `landing`,
`products`, `inventory` (read-only report), `batches`, `roles`.

### 2.1 Two convention bugs to fix during migration

1. **`orders.html` double-prefixes — all ten nav items.** Its nav uses
   `data-mod="mod-queue"` while its section is `id="mod-queue"`. Admin's
   `navigate()` builds the selector as `` $(`#mod-${mod}`) ``, which under
   Admin's engine resolves to `#mod-mod-queue` and matches nothing. It works
   today only because `orders.js`'s own `navigate(modId)` (line 308) selects by
   raw id instead. Strip the `mod-` prefix from every `data-mod` value in that
   file: `mod-dashboard`, `mod-notifications`, `mod-transactions`, `mod-queue`,
   `mod-payment-verify`, `mod-order-status`, `mod-history`, `mod-receipts`,
   `mod-returns`, `mod-payscheme`.
2. **`inventory.html` uses `data-view`** for the Restock / Replenish / Adjust /
   Archive sub-views. Admin's `initSidebar()` reads `btn.dataset.tab` and passes
   it as `navigate(mod, tab)`. Rename `data-view` → `data-tab`.
3. **`subadmin.html` has an orphan nav item.** It carries
   `data-mod="roles"` but no `id="mod-roles"` section — the Roles & Permissions
   panel was dropped when the file was copied from `admin.html`. It is masked
   today because that nav item is `data-perm="rbac.manage"`, which the `Admin`
   role does not hold, so `applyRBAC()` hides it. Grant `rbac.manage` to `Admin`
   from the Roles screen and the button appears but leads to a blank panel.
   The migration fixes this for free — the shared shell and the `roles` partial
   always ship together.

---

## 3. Target architecture

```
StuffModule/
├── Core/                          ← NEW — shared shell + loader
│   ├── portal-shell.html          ← 1,127 lines lifted from admin.html
│   └── module-loader.js           ← NEW — permission-gated injector
│
├── Modules/                       ← NEW — 24 partials, 1,739 lines total
│   ├── dashboard.html   pos.html            posPayment.html
│   ├── notifications.html  onlineTxns.html  ordersqueue.html
│   ├── paymentverify.html  orderstatus.html orderhistory.html
│   ├── receipts.html       returns.html     users.html
│   ├── b2b.html            landing.html     products.html
│   ├── inventory.html      inventory-manage.html  expiry.html
│   ├── sales.html          batches.html     payments.html
│   └── transactions.html   audit.html       roles.html
│
├── AdminModule/                   ← engine stays put; admin.html shrinks
│   ├── admin.js  admin-pos.js  admin-orders.js  admin-inventory.js
│   ├── admin.css  admin-glass.css  admin-pos.css  admin-orders.css
│   │   admin-inventory.css  shared-pagination.js
│   └── admin.html                 ← 2,865 lines → ~30
│
├── SubAdminModule/    subadmin.html (~30) + subadmin.js (unchanged)
├── CashierModule/     cashier.html  (~30) + cashier.js  (NEW ~70-line gate)
├── InventoryModule/   inventory.html(~30) + inventory.js(NEW ~70-line gate)
└── OrdersModule/      orders.html   (~30) + orders.js   (NEW ~70-line gate)
```

The engine files stay in `AdminModule/` deliberately: every existing portal
already references them as `../AdminModule/admin.js`, and the landing router
points at `/StuffModule/AdminModule/admin.html`. Leaving them put keeps this
migration additive.

### 3.1 What each portal file becomes

```html
<!-- CashierModule/cashier.html — complete file -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cashier · Elisha Bay</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=sentient@400,500,600,700&display=swap" />
    <link rel="stylesheet" href="../AdminModule/admin.css" />
    <link rel="stylesheet" href="../AdminModule/admin-pos.css" />
    <link rel="stylesheet" href="../AdminModule/admin-orders.css" />
    <link rel="stylesheet" href="../AdminModule/admin-inventory.css" />
    <link rel="stylesheet" href="../AdminModule/admin-glass.css" />
  </head>
  <body>
    <div id="portal-root" data-portal-role="Cashier"></div>

    <script src="../Core/module-loader.js"></script>
    <script src="../AdminModule/shared-pagination.js"></script>
    <script src="../AdminModule/admin.js"></script>
    <script src="../AdminModule/admin-pos.js"></script>
    <script src="../AdminModule/admin-orders.js"></script>
    <script src="../AdminModule/admin-inventory.js"></script>
    <script src="cashier.js"></script>
  </body>
</html>
```

Change `data-portal-role` and the title; that is the entire difference between
the five portals. Add a module to `Modules/` once and every role granted the
matching permission picks it up.

---

## 4. The one hard part: init ordering

`admin.js:3015` ends with `document.addEventListener("DOMContentLoaded", init)`,
and `init()` (line 3005) runs seven setup functions in this order:

```js
function init(){
  initTheme();            // shell only          — safe
  initLogin();            // shell + calls renderDashboard()
  initSidebar();          // shell + #mod-dashboard
  initUserDropdown();     // shell only          — safe
  initModal();            // shell only          — safe
  initModDescriptions();  // reads all 24 panels
  initLandingPreview();   // reads #mod-landing
}
```

Three of these reach into module markup:

- **`initSidebar()`** binds `.nav-item` (shell — fine) *and*
  `.dash-shortcut-btn[data-mod]`, which live at `admin.html:1018`, inside
  `#mod-dashboard`. If the dashboard partial is not in the DOM yet, the
  dashboard shortcut tiles become dead buttons.
- **`initModDescriptions()`** (`admin.js:2956`, reading `MOD_DESC` at
  `admin.js:2932`) loops 21 keys doing
  `getElementById("mod-" + mod)`. It has an `if(!panel) return;` guard, so it
  fails *silently* — every module simply loses its subtitle line.
- **`initLandingPreview()`** grabs `#view-landing-btn` at `admin.html:1841`,
  inside `#mod-landing`. Guarded with `if(btn)`, so it also fails silently.

And `initLogin()` → `checkSessionAuth()` (line 888) ends with `applyRBAC()` and
a direct `renderDashboard()` call, which needs `#mod-dashboard` present.

Silent failure is the danger here. Nothing throws; the portal just quietly
loses features. **Everything must be in the DOM before `init()` runs.**

### 4.1 Sequencing options

**Option A — eager injection (recommended for the first pass).**
Inject the shell and all 24 partials, then call `init()`. `applyRBAC()` hides
what the role lacks, exactly as it does for Super Admin and Sub-Admin today.
Requires no change to the login flow at all.

**Option B — permission-gated injection.**
Inject only the partials the role is granted. Truer to "RBAC decides what
loads", but the role is not known until *after* login, so injection has to
happen at two different moments: once when `sessionStorage["eb-staff"]` already
holds a valid hand-off from the landing page, and again after a successful
manual login on the portal itself. That means restructuring `initLogin()` and
`checkSessionAuth()`.

**Recommendation: build A, then upgrade to B.** A already delivers the thing
you actually need — one source of truth per module, identical design and data
across all five portals, RBAC governing visibility. B is a security refinement
on top of a system that already works. Doing A first means you always have a
demonstrable build.

The `module-loader.js` sketch below covers Option A, with the hook for B marked.

```js
"use strict";
/* Injects the shared shell + module partials before admin.js's init() runs. */

const MODULE_FILES = [
  "dashboard","pos","posPayment","notifications","onlineTxns","ordersqueue",
  "paymentverify","orderstatus","orderhistory","receipts","returns","users",
  "b2b","landing","products","inventory","inventory-manage","expiry","sales",
  "batches","payments","transactions","audit","roles",
];

async function loadPortal(){
  const root = document.getElementById("portal-root");
  const base = "../";

  // 1. shell first — provides #login-view, #admin-app, sidebar, #main-content
  root.innerHTML = await (await fetch(base + "Core/portal-shell.html")).text();

  // 2. module partials, in declared order, into #main-content
  //    Option B upgrade: filter MODULE_FILES by hasPerm(MOD_PERM[m]) here,
  //    once the role is known.
  const main = document.getElementById("main-content");
  const parts = await Promise.all(
    MODULE_FILES.map(m => fetch(`${base}Modules/${m}.html`).then(r => r.text()))
  );
  main.insertAdjacentHTML("beforeend", parts.join("\n"));

  // 3. only now is it safe to wire everything up
  init();
}

document.addEventListener("DOMContentLoaded", loadPortal);
```

Then in `admin.js`, change the last line:

```js
- document.addEventListener("DOMContentLoaded", init);
+ /* init() is now invoked by Core/module-loader.js, after the shell and
+    module partials have been injected. See §4 of the migration plan. */
+ if (!document.getElementById("portal-root")) {
+   document.addEventListener("DOMContentLoaded", init);   // legacy fallback
+ }
```

The guard means any page still using the old monolithic markup keeps working
during the transition.

`fetch()` on relative paths works here because your landing router already uses
absolute paths (`/StuffModule/AdminModule/admin.html`, `script.js:43`), which
means you are serving over HTTP. **This will not work if anyone opens the files
directly as `file://`** — the fetches fail CORS and the portal renders blank.
Worth a note in your defence documentation.

---

## 5. Execution steps

**Step 1 — Extract the shell.**
Copy `admin.html` → `Core/portal-shell.html`. Delete lines 1006–2790 (the 24
`<section>` blocks) from the copy, leaving `<main class="content"
id="main-content">` empty. Strip `<!DOCTYPE>`, `<html>`, `<head>` and `<body>`
tags — the shell is a fragment. Result: ~1,127 lines. Keep the login view,
topbar, sidebar with all nav items, modal overlay, landing-preview overlay and
toast container.

**Step 2 — Extract the 24 partials.**
Each becomes one file in `Modules/`. Boundaries are clean — the sections are
top-level and balanced (24 `<section>`, 24 `</section>`):

| Module | Lines in `admin.html` | Count |
|---|---|---|
| `dashboard` | 1006–1153 | 148 |
| `pos` | 1156–1252 | 97 |
| `posPayment` | 1255–1281 | 27 |
| `notifications` | 1284–1309 | 26 |
| `onlineTxns` | 1312–1347 | 36 |
| `ordersqueue` | 1350–1363 | 14 |
| `paymentverify` | 1366–1379 | 14 |
| `orderstatus` | 1382–1430 | 49 |
| `orderhistory` | 1433–1487 | 55 |
| `receipts` | 1490–1524 | 35 |
| `returns` | 1527–1566 | 40 |
| `users` | 1569–1723 | 155 |
| `b2b` | 1726–1827 | 102 |
| `landing` | 1830–1877 | 48 |
| `products` | 1880–1928 | 49 |
| `inventory` | 1931–2027 | 97 |
| `inventory-manage` | 2030–2138 | 109 |
| `expiry` | 2141–2249 | 109 |
| `sales` | 2252–2420 | 169 |
| `batches` | 2423–2539 | 117 |
| `payments` | 2542–2602 | 61 |
| `transactions` | 2605–2687 | 83 |
| `audit` | 2690–2756 | 67 |
| `roles` | 2759–2790 | 32 |

Total 1,739 lines of module markup; 1,127 lines of shell.

**This extraction has been verified as lossless.** Splicing the 24 ranges out
and reinserting them at their original positions reproduces `admin.html`
byte-for-byte. The ranges above are safe to script against directly.

One detail the verification surfaced: each section is preceded by a two-line
gap — a blank line and a banner comment such as
`<!-- ── POINT OF SALE: PAYMENT ── -->`. Those 23 comments are *not* inside the
section ranges, so a naive extraction leaves them stranded in the shell around
an empty `<main>`. Move each banner comment into the top of its partial, where
it becomes a useful file header.

**Preserve `class="mod-panel active"` on `dashboard`** (`admin.html:1008`). It
is the only panel carrying `active`, and `checkSessionAuth()` calls
`renderDashboard()` without going through `navigate()` — so nothing else will
add that class on the session-handoff path.

This step should be scripted, not done by hand, so the extraction is provably
lossless (see §7).

**Step 3 — Add `Core/module-loader.js`** as sketched in §4.1.

**Step 4 — Patch `admin.js`'s last line** with the `portal-root` guard.

**Step 5 — Shrink the portal HTMLs.** `admin.html`, `subadmin.html`,
`cashier.html`, `inventory.html`, `orders.html` each become the ~30-line file
from §3.1. Roles: `Super Admin`, `Admin`, `Cashier`, `Inventory Staff`,
`Online Orders Staff`.

**Step 6 — Write the three new role gates.** `cashier.js`, `inventory.js` and
`orders.js` are replaced entirely by copies of `subadmin.js` with the role
constant changed:

```js
const PORTAL_ROLE = "Cashier";   // "Inventory Staff" | "Online Orders Staff"
```

`subadmin.js` is the reference implementation — note in particular *why* it
reassigns `checkSessionAuth` rather than defining its own, and why it binds its
submit handler on `document` in the capture phase (comments at lines 11–13 and
47–49). Keep those comments; they explain a load-order subtlety a reader would
otherwise trip on.

One wording fix: that comment says the gate is "loaded AFTER admin.js, but
BEFORE `DOMContentLoaded` fires". Under the new loader `init()` runs later
still — after the partial fetches resolve — so the reassignment lands in time
by an even wider margin. Update the comment to say "before `init()` is invoked
by `Core/module-loader.js`" so it stays true.

**Step 7 — Delete the old engines.** `cashier.js` (1,744), `inventory.js`
(1,224), `orders.js` (1,686) — replaced in Step 6. Also `cashier.css`,
`inventory.css`, `orders.css`, once you have confirmed nothing in them is
needed; the shared design now comes from `admin.css` + the three
`admin-*.css` files. **Diff these three stylesheets against Admin's before
deleting** — any genuinely portal-specific rule should move into `admin.css`
under a scoping class, not vanish.

**Step 8 — Landing router.** `V4Home/HomePage/script.js:43–47` already maps all
five roles to the right paths, and its `STAFF_ACCOUNTS` copy at lines 31–37 is
complete and correct (it omits only `emp-05`, Rosa Dela Torre, who is
`archived` — correct behaviour). **No change is required for this migration.**

It is still a second copy of the credential list, and the comment above it
already admits the coupling ("Role names must match `STAFF_ACCOUNTS` in
`StuffModule/AdminModule/admin.js`"). Worth consolidating eventually — extract
the array into a shared `Core/staff-accounts.js` that both the landing page and
`admin.js` load — but that is independent of the RBAC work and should not be
bundled into it.

---

## 6. What this fixes

- One `<section>` per module, in one file, used by all five portals. Design and
  content cannot drift because there is only one copy.
- One engine — `admin.js` + the three feature files. One `PRODUCTS` array. Stock
  adjusted in Inventory is visible in Cashier's POS.
- RBAC actually governs all five portals. `data-perm` markup arrives with the
  partials, so `applyRBAC()` works everywhere instead of only in
  Admin/Sub-Admin.
- **4,654 lines of duplicated JavaScript deleted**, replaced by three ~73-line
  role gates — a net reduction of ~4,435 lines.
- Adding a module means one file in `Modules/`, one nav item in the shell, one
  entry in `PERMISSIONS` and `MOD_PERM`. Every role granted it gets it, with no
  per-portal edits.

---

## 7. Verification

Five scripted checks. **All five have already been run against the current
codebase** to establish the baseline — results below. Re-run them after each
step; anything that was green and turns red is a regression you introduced.

| # | Check | Baseline result |
|---|---|---|
| 1 | Splice the 24 ranges out, reinsert, diff against `admin.html` | ✅ byte-identical |
| 2 | No duplicate `id` attributes in the assembled DOM | ✅ none in `admin.html` |
| 3 | Every `data-mod` has a matching `id="mod-*"` and vice versa | ⚠️ `admin` / `cashier` / `inventory` OK; **`orders` fails all 10**; **`subadmin` orphans `roles`** |
| 4 | Every `MOD_PERM` value exists in `PERMISSIONS` | ✅ 22 entries → 17 permissions, all valid |
| 5 | Every `data-perm` in markup exists in `PERMISSIONS`, and none unused | ✅ both directions clean |

Check 3 is the one that matters most — it is exactly what catches the
`orders.html` and `subadmin.html` bugs in §2.1, and it will catch any partial
you extract without its nav item.

Additionally, before deleting the old engines: **no top-level identifier
collisions** between `admin.js` and everything loaded alongside it. Baseline
today is 41 / 29 / 28 collisions for cashier / inventory / orders (§1.2), which
must reach **0** once Step 7 is done. `subadmin.js` already scores 0 — further
confirmation that it is the pattern to copy.

All of the above is automated in **`verify-modules.py`**, delivered alongside
this plan. Drop it in `StuffModule/` and run:

```
python verify-modules.py
```

It skips checks whose files do not exist yet, so it is useful from before
Step 1 through to the end. Exit code 0 means clean. Against the current
codebase it reports the 5 known failures listed above.

Then, per role, in the browser:

- Log in from the landing page as each of the five accounts; confirm redirect,
  correct nav, and that hidden modules are unreachable by direct
  `navigate("users")` from the console.
- Cashier: POS add-to-cart → payment → receipt.
- Inventory: restock, replenish, adjust, archive (the four `data-tab` views).
- Orders: queue → payment verify → status change → return.
- Cross-portal: restock a product as Inventory Staff, confirm the new stock
  appears in Cashier's POS tiles.
- Confirm the dashboard shortcut tiles work — they are the canary for the
  §4 init-ordering issue.

Test credentials are in `admin.js:57–64`.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Silent feature loss from init ordering (§4) | Dashboard shortcut tiles and module subtitles are the canaries — check both first |
| Someone opens the portal as `file://` | Fetches fail CORS, page renders blank. Document the requirement to serve over HTTP |
| A genuinely unique rule hides in `cashier.css` / `inventory.css` / `orders.css` | Diff against `admin.css` before deleting; migrate keepers under a scoping class |
| Extraction drops a line | Scripted round-trip diff (§7.1) rather than manual copy-paste |
| Flash of unstyled content while partials fetch | Shell renders login view immediately; module injection happens behind it |

Rollback: every step is additive except Steps 5–7. Back up the five portal
HTMLs and three staff JS files, and the whole change reverts by restoring eight
files.

---

## 9. Suggested order of work

1. Steps 1–2 (scripted extraction) + verification 7.1–7.3 — no behaviour change
2. Steps 3–4 (loader + init guard), tested against `admin.html` alone
3. Step 5 for `admin.html` and `subadmin.html` — the two portals already on the
   shared engine, so any breakage is loader-related and isolated
4. Steps 5–7 for Cashier, then Inventory, then Orders — one at a time, each
   fully tested before the next
5. Step 8 (landing router `STAFF_ACCOUNTS` fix)
6. Option B upgrade (permission-gated injection), once all five portals are
   green

Cashier first because it is the smallest surface; Orders last because it also
carries the `data-mod` prefix fix.
