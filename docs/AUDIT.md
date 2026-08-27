# CAP2 / Elisha Bay — Phase 0 Audit

**Date:** 16 August 2026
**Scope:** every file under `D:\Cap2` except `node_modules/`, `.claude/`, `.agents/`
**Files modified by this phase:** this one only.

---

## 0. Read this first — four premises in the brief are wrong

The brief describes a project that does not match what is on disk. Correcting this
before Phase 1, because two of these would have driven wasted work.

| Brief says | Actually on disk |
|---|---|
| "a path with a backslash and a space in it (`V4Home \ HomePage`)" | **No such path.** The real path is `V4Home/HomePage` — one folder, no space, no backslash. There is not a single space or backslash in any filename in the project. Verified across all 60 files. |
| "`inventory.html` exists in both `StuffModule/InventoryModule/` and `StuffModule/Modules/` — a duplicate" | **Not a duplicate.** `InventoryModule/inventory.html` is a 43-line portal *entry point*; `Modules/inventory.html` is a 128-line *partial* injected into it. Same name, unrelated content, both live. Same applies to `pos`, `products`, `orders*` etc. |
| "no `users` table but the UI has login" | The schema **has** `users`, `roles`, `permissions`, `role_permissions`. It was extended earlier today; `database.txt` is current. |
| Implied: the RBAC migration is outstanding work | **It is done.** `verify-modules.py` passes all 15 checks. The three 1,200–1,700-line duplicate portal engines named in `RBAC-MIGRATION-PLAN.md` no longer exist — they are 16-line role gates now. |

**What *is* actually wrong** is listed in §8. The real structural problems are
absolute URL paths, three orphaned stylesheets, duplicated seed data across the
public/staff boundary, and a `node_modules` tree for a framework this project
does not use.

**The single most important fact for Phases 2–5:** there are **zero** `fetch()`,
`XMLHttpRequest`, or network calls anywhere in the application code. The only
`fetch()` in the project is `module-loader.js` pulling local HTML partials. Every
screen renders from **29 hardcoded JS arrays**. There is no API layer to extend —
Phase 3 builds one from nothing.

---

## 1. File inventory

`node_modules/` (4,412-line lockfile, one dev dependency) excluded. 60 files.

### 1.1 Root

| Path | Type | Lines | What it does | Status |
|---|---|---|---|---|
| `database.txt` | SQL DDL | 386 | Schema: 21 tables, InnoDB, utf8mb4, FKs + indexes. Current. | live |
| `database-seed.txt` | SQL DML | 393 | 298 seed rows mirroring the JS arrays. Current. | live |
| `RBAC-MIGRATION-PLAN.md` | Doc | 527 | Plan for the portal-consolidation migration. **Executed** — see §7. | live (historical) |
| `package.json` | Config | 5 | One devDependency: `shadcn ^4.11.0`. | dead (§8.4) |
| `package-lock.json` | Config | 4,412 | Lockfile for the above. | dead |
| `components.json` | Config | 19 | shadcn/ui config — `"tsx": true`, React aliases, empty Tailwind config. | dead |
| `.mcp.json` | Config | 11 | Registers the shadcn MCP server for Claude Code. | tooling |
| `skills-lock.json` | Config | 119 | Claude Code skills lockfile. | tooling |

### 1.2 `StuffModule/` — internal staff portal

| Path | Type | Lines | What it does | Status |
|---|---|---|---|---|
| `Core/portal-shell.html` | Partial | 1,079 | The chrome shared by all five portals: login view, topbar (notification bell, theme toggle, user dropdown), full sidebar nav, modal overlay, toast container, empty `#main-content`. | live |
| `Core/module-loader.js` | JS | 203 | Boot sequence: fetch shell → fetch 24 partials (4 at a time) → call `init()`. Strips `<script>` from fetched fragments. Renders a diagnostic panel on failure. | live |
| `Core/role-gate.js` | JS | 111 | `installRoleGate(role)` — replaces `checkSessionAuth` so a portal accepts only its own role, and intercepts login submit in capture phase to reject other roles' credentials. | live |
| `AdminModule/admin.js` | JS | 3,322 | **The engine.** All seed data, RBAC, helpers, SVG charts, and every module renderer. See §5.1. | live |
| `AdminModule/admin-orders.js` | JS | 1,320 | Online-orders half: notification derivation from the audit log, queue, payment verification, status transitions, returns, receipts. | live |
| `AdminModule/admin-inventory.js` | JS | 580 | Inventory half: expiry math, `ADJUSTMENTS` seed, restock/dispose mutations, stock overview, archive. | live |
| `AdminModule/admin-pos.js` | JS | 533 | POS half: cart, product tiles, payment method grid, `placeOrder()`, receipt builder. | live |
| `AdminModule/shared-pagination.js` | JS | 87 | `Paginate.slice/render/wirePageSize` — client-side paging over an in-memory array. | live |
| `AdminModule/admin-gate.js` | JS | 16 | `installRoleGate("Super Admin")`. | live |
| `AdminModule/admin.css` | CSS | 1,662 | Base design system for all five portals. | live |
| `AdminModule/admin-glass.css` | CSS | 473 | Glassmorphism token override. Loaded last, deliberately. | live |
| `AdminModule/admin-orders.css` | CSS | 378 | Orders-module styles. | live |
| `AdminModule/admin-pos.css` | CSS | 352 | POS-module styles. | live |
| `AdminModule/admin-inventory.css` | CSS | 146 | Inventory-module styles. | live |
| `AdminModule/admin.html` | Entry | 43 | Super Admin entry. `<div id="portal-root" data-portal-role="Super Admin">` + 8 script tags. | live |
| `SubAdminModule/subadmin.html` + `.js` | Entry | 43 + 16 | Admin role entry + gate. | live |
| `CashierModule/cashier.html` + `.js` | Entry | 43 + 16 | Cashier entry + gate. | live |
| `InventoryModule/inventory.html` + `.js` | Entry | 43 + 16 | Inventory Staff entry + gate. | live |
| `OrdersModule/orders.html` + `.js` | Entry | 43 + 16 | Online Orders Staff entry + gate. | live |
| `CashierModule/cashier.css` | CSS | 408 | Pre-migration per-portal styles. **Referenced by nothing.** | **dead** |
| `InventoryModule/inventory.css` | CSS | 173 | Same. | **dead** |
| `OrdersModule/orders.css` | CSS | 502 | Same. | **dead** |
| `Modules/*.html` (24) | Partials | 45–200 | One `<section id="mod-*">` each. See §4. | live |
| `verify-modules.py` | Python | 281 | Structural verifier — 7 check groups. Currently all-pass. | live |
| `_backup-pre-rbac.zip` | Archive | 139 KB | 10 files: the pre-migration `admin.js` (163 KB), `cashier.js`, `inventory.js`, `orders.js` and their HTML. | **move to `_archive/`** |

### 1.3 `V4Home/HomePage/` — public storefront

| Path | Type | Lines | What it does | Status |
|---|---|---|---|---|
| `index.html` | Page | 991 | Landing: hero slider, best sellers, about/vision/mission, certs, FAQs, contact. | live |
| `script.js` | JS | 1,868 | Everything public-side: catalog render, cart drawer, checkout, receipt, auth modal, theme, hero slider, landing-content bridge, staff-login router. | live |
| `styles.css` | CSS | 1,734 | Public design system. Loaded by all 6 public pages. | live |
| `shop.html` + `shop.css` | Page | 265 + 188 | Catalog with search/filter/sort. | live |
| `batch-traceability.html` + `trace.css` | Page | 302 + 139 | Batch code lookup. **Carries its own inline `BATCHES` registry** (§5.6). | live |
| `become-partner.html` + `partner.css` | Page | 441 + 161 | B2B application form incl. username + password fields. Submit handler does not persist. | live |
| `MyProfile/profile.html` | Page | 361 | Customer profile; edits `state.auth.name` in localStorage only. | live |
| `MyProfile/my-orders.html` | Page | 344 | Order history from an inline `MOCK_ORDERS` array. | live |
| `MyProfile/myprofile.css` | CSS | 401 | Profile styles. | live |
| `Bgfish.png` | Image | 1.0 MB | Hero background. Oversized for the web — worth compressing, not urgent. | live |

---

## 2. Duplicates and conflicts

### 2.1 Not duplicates (filename collisions only)

`Modules/inventory.html` vs `InventoryModule/inventory.html`, and likewise
`pos`/`products`/`orders`. Different layer, different content, both required. The
restructure should rename the partials folder to `views/` so the distinction is
visible in the path.

### 2.2 Real duplication — seed data across the public/staff boundary

| Data | Copy A | Copy B | Copy C | Divergent? |
|---|---|---|---|---|
| `STAFF_ACCOUNTS` | `admin.js:57` — 6 accounts, with `id`, `status` | `script.js:31` — **5 accounts**, no `id`, no `status` | — | **Yes.** B is missing `emp-05` (Rosa Dela Torre, archived). A staff member archived in the portal can still sign in from the landing page. |
| `PRODUCTS` (15 items) | `admin.js:21` — adds `archived` | `script.js:57` — adds `long`, `nutri` | — | Yes, by field set. Prices/stock currently agree, but nothing enforces it. |
| Batch registry | `admin.js:170` — `BATCHES`, 12 QA-rich records, lot codes `JBF-2026-B1xx` | `batch-traceability.html:205` — inline `BATCHES` object | `ADJUSTMENTS`/orders reference a *third* code format `BT-YYYYMMDD-X` | **Yes — three formats.** See §8.3. |
| Order history | `admin.js:189` — `ORDERS`, 42 rows | `my-orders.html:146` — `MOCK_ORDERS` | — | Yes. The customer's "my orders" has no relationship to the orders staff see. |
| `CATEGORIES` | `admin.js:16` — objects with `id` | `script.js:51` — string array incl. `"All"` | — | Shape differs. |

This is the #1 correctness argument for Phase 3: one database collapses all of it.

### 2.3 Orphaned files

- `CashierModule/cashier.css`, `InventoryModule/inventory.css`, `OrdersModule/orders.css` — 1,083 lines total, zero `href` references. Leftovers from the pre-migration engines. `RBAC-MIGRATION-PLAN.md` §8 says to diff them against `admin.css` before removing; that diff was never recorded.
- `_backup-pre-rbac.zip` — a backup living inside the source tree.

---

## 3. Reference graph

### 3.1 Public pages

All six load `styles.css` + `script.js`; page-specific CSS as listed in §1.3.
All internal links are **relative** (`index.html`, `../shop.html`). **No broken
links found.** This half of the project relocates cleanly.

### 3.2 Staff portals

Every portal entry loads, in order:

```
../Core/module-loader.js
../AdminModule/shared-pagination.js
../AdminModule/admin.js
../AdminModule/admin-pos.js
../AdminModule/admin-orders.js
../AdminModule/admin-inventory.js
../Core/role-gate.js
<own-gate>.js
```

Order is load-bearing: `role-gate.js` reassigns `admin.js`'s `checkSessionAuth`
at parse time, so it must come after. `module-loader.js` must come first — it
binds `DOMContentLoaded` and calls `init()` only after all 24 partials are in the
DOM. Five stylesheets, all from `AdminModule/`, `admin-glass.css` last.

Runtime fetches: `../Core/portal-shell.html`, then `../Modules/<name>.html` × 24,
resolved against `PORTAL_BASE = "../"`.

### 3.3 The one class of link that will break — absolute paths

Four references assume the project is served at the **web root**:

| File | Reference |
|---|---|
| `script.js:43–47` | `/StuffModule/AdminModule/admin.html` (+ 4 more, one per role) |
| `admin.js:1136` | `/V4Home/HomePage/index.html` (logout redirect) |

Under XAMPP at `htdocs/<project>/` these resolve to `http://localhost/StuffModule/...`
— **404 on every one**. Staff login from the landing page and logout from any
portal both break. This is the *actual* path problem in the project.

`admin.js:3274` uses a relative `../../V4Home/HomePage/index.html` for the
landing preview iframe and is fine — but it must be updated in lockstep with any
move.

---

## 4. The `Modules/` folder — definitively partials

**Answer: partials.** Not full pages. Evidence, not inference:

1. `module-loader.js:186–190` fetches `Modules/<name>.html` for each of 24 names in `MODULE_ORDER` and appends the parsed body children into `#main-content`.
2. Each file is one `<section id="mod-NAME">` whose id matches its filename — enforced by `verify-modules.py` check 3, currently passing.
3. `portal-shell.html` carries the nav; every `data-mod="X"` there pairs with an `id="mod-X"` in `Modules/` — check 3 verifies both directions with zero orphans.
4. They *are* wrapped as complete HTML documents deliberately: `verify-modules.py` check 7 requires a `</body>` in each, because Live Server injects its reload script before it, and a bodyless fragment gets that script injected inside the logo `<svg>` instead, corrupting the parse. **Do not "clean up" these wrappers during the restructure.**

The 24 partials: `dashboard`, `pos`, `posPayment`, `notifications`, `onlineTxns`,
`ordersqueue`, `paymentverify`, `orderstatus`, `orderhistory`, `receipts`,
`returns`, `users`, `b2b`, `landing`, `products`, `inventory`,
`inventory-manage`, `expiry`, `sales`, `batches`, `payments`, `transactions`,
`audit`, `roles`.

Note the two casing outliers — `onlineTxns` and `posPayment` are camelCase while
everything else is lowercase/hyphenated. Renaming them touches the filename, the
`id="mod-*"`, the `data-mod` in the shell, `MODULE_ORDER`, and `MOD_PERM`. Worth
doing under the Phase 1 naming rule, but it is a 5-place change each.

---

## 5. Existing JavaScript

### 5.1 `admin.js` (3,322) — the engine
Layout: `CONFIG` → seed arrays → RBAC (`PERMISSIONS`, `ROLE_PERMISSIONS`,
`ROLE_META`, `MOD_PERM`, `hasPerm()`, `applyRBAC()`) → `adminState` (~40 keys:
current user, current module, 20 pager objects, filters, sorts, cart) → helpers
(`$`, `peso`, `fmtDate`, `stockInfo`) → hand-rolled SVG charts
(`drawSparkline`, `drawBarChart`) → per-module renderers → modal/theme/login/nav
→ `init()`.
**Fakes:** `PRODUCTS`, `CATEGORIES_DATA`, `STAFF_ACCOUNTS`, `CUSTOMERS`,
`BATCHES`, `ORDERS` (42), `RETURNS`, `NOTIFICATIONS`, `PAYMENT_ACCOUNTS`,
`B2B_APPLICATIONS`, `SITE_CONTENT`, `AUDIT_LOG`.
**Needs from an API:** one endpoint per array, plus writes for every mutation.
Every renderer reads a module-scope `const` array directly — this is the single
biggest refactor in the project.

### 5.2 `admin-orders.js` (1,320)
Derives notifications from `AUDIT_LOG` at runtime rather than storing them
(`buildDerivedNotifications`, `AUDIT_NOTIF_RULES`), keeps read-state in an
in-memory `Set` — **read state is lost on refresh**. Needs
`notifications` table + `PATCH /notifications/:id/read`. Status transitions are
governed by `STATUS_TRANSITIONS` in `admin.js`; that table must be enforced
server-side too, not just in the modal.

### 5.3 `admin-pos.js` (533)
Cart, tiles, `computeTotal()`, `placeOrder()`, `buildReceipt()`. **Computes money
client-side** and generates its own transaction id (`genTxnId`). Both move to the
server per the brief's money rule.

### 5.4 `admin-inventory.js` (580)
Expiry math against a **hardcoded `INV_TODAY = "2026-06-17"`** — not `new Date()`.
Every "days until expiry" figure in the UI is frozen to that date. `restock()`
and disposal mutate `PRODUCTS`/`BATCHES` in memory and push to `AUDIT_LOG`.

### 5.5 Gates — `role-gate.js` + 5 one-line wrappers
Two mechanisms: replace `checkSessionAuth` to accept only this portal's role, and
a capture-phase `submit` listener that rejects other roles' credentials before
`admin.js` sees the event. Clean, already consolidated. In Phase 4 this becomes
`rbac.js` — but note it currently does **two** jobs (entry-point gating and
session hand-off) that will want separating from `session.js`.

### 5.6 `script.js` (1,868) — public site
Catalog/cart/checkout/auth/theme/hero/FAQ + the staff-login router. Auth is
`state.auth = {loggedIn, name}` in `localStorage["eb-auth"]` — **a name string, no
user id, no password check, no server**. Checkout (`openCheckout` → `showReceipt`)
validates fields then renders a receipt and **discards the order entirely**. There
is no code path by which a customer order reaches the staff portal.
Landing-content bridge: admin writes `localStorage["eb-landing-content"]`, public
page reads it — same-origin only, invisible to real visitors.

### 5.7 Duplicated logic across files
`$`, `$$`, `peso`, `escHtml`, `stockInfo`, `getProduct`, `showToast`/`toast`,
`openModal`/`closeModal`, `applyTheme`/`initTheme`, `starRating`, `jarSVG`,
`icon` all exist in **both** `admin.js` and `script.js` with slightly different
bodies (e.g. `stockInfo` returns `{cls,label}` publicly vs `{cls,label,level}` in
admin). These are the natural contents of `core/format.js` + `core/ui.js`.

---

## 6. Database

### 6.1 `database.txt` — 21 tables

`categories`, `products`, `roles`, `permissions`, `role_permissions`, `users`,
`customers`, `b2b_applications`, `batches`, `inventory_adjustments`, `orders`,
`order_items`, `product_returns`, `notifications`, `payment_accounts`,
`audit_logs`, `site_content`, `faqs`, `hero_slides`, `featured_products`,
`settings`.

InnoDB / utf8mb4_unicode_ci throughout. FKs declared with deliberate
`ON DELETE` behavior: `RESTRICT` where history must not vanish (products from
orders, batches), `SET NULL` for optional owners (order → customer, user → role),
`CASCADE` for owned children (order_items, role_permissions, notifications).
Indexes on every FK plus the columns the UI filters/sorts on.

**Already reconciled against the UI** (this session): `products.image_url` is
LONGTEXT for base64 uploads; `roles.is_system` marks Super Admin, which holds no
`role_permissions` rows by design; `orders.total` is stored; `customers` and
`b2b_applications` carry `username`/`password`.

Remaining gaps, all deliberate and all Phase 2/3 work:

1. **No `sessions` table.** PHP's native session handler is file-based and fine for a capstone. Only needed if you want "log out everywhere" or session listing.
2. **`audit_logs.actor` is a name string**, not `user_id`. Renaming an employee orphans their history. Recommend adding `actor_user_id` alongside.
3. **`notifications` is a real table, but `admin-orders.js` derives notifications from the audit log at runtime.** Phase 5 must pick one. Recommend the table.
4. **Passwords are plaintext** in `database-seed.txt` — mirroring `STAFF_ACCOUNTS`. Phase 2 replaces them with `password_hash()` output.
5. **No `order_status_history`.** The UI shows status transitions but nothing records who moved an order or when.

### 6.2 `database-seed.txt` — 298 rows

Covers all 21 tables: 15 products, 17 permissions, 30 role grants, 6 users,
10 customers, 8 B2B applications, 12 batches, 42 orders + 78 line items,
6 returns, 11 notifications, 4 payment accounts, 28 audit entries.

Two normalizations already applied and commented in the file: `orders.method`
stores the canonical key (`gcash`) rather than mixed labels (`GCash`); online-order
customers who exist only in the orders array get `customer_id NULL`.

All relative dates (`dAgo()`) were resolved against the system's frozen "today" of
**2026-06-17**. If real usage starts on a different date, expiry and
overdue-payment screens will look wrong until seeded dates are shifted.

Verification status: value/column arity and FK targets check out statically.
**Never executed against MySQL** — XAMPP was not running. First real test is
Phase 2.

---

## 7. RBAC — the migration is complete

`RBAC-MIGRATION-PLAN.md` (11 Aug 2026) planned consolidation of five portals that
had drifted into four separate engines. Its "before" table describes
`cashier.js` at 1,744 lines, `inventory.js` at 1,224, `orders.js` at 1,686, with
zero `data-perm` attributes and hardcoded single-account logins.

**Those files are now 16 lines each.** Steps 1–7 all landed:

| Step | State |
|---|---|
| 1–2 Extract shell + 24 partials | Done |
| 3–4 Loader + init ordering | Done — `init()` moved into `module-loader.js` |
| 5–7 Thin portals, shared engine, delete duplicate engines | Done — all five load `admin.js`; 0 identifier collisions |
| 8 Landing router `STAFF_ACCOUNTS` fix | **Not done** — `script.js:31` still holds its own divergent 5-account copy |
| Option B: permission-gated injection | **Not done** — `selectModules()` still returns all 24; the filter is written in a comment at `module-loader.js:75` |

`verify-modules.py` currently reports **all checks passed**: 24 partials, no id
collisions, nav↔section pairing exact, 17 permissions all defined and all used in
markup, 22 `MOD_PERM` entries all valid, 0 collisions, injection-safety clean.

**What RBAC does not do: security.** `hasPerm()` and `applyRBAC()` hide DOM
elements. `role-gate.js` blocks an entry point. All of it runs in the browser
against a JS array. Credentials sit in plaintext in `admin.js:57` and
`script.js:31`, both served to anyone who opens the page. This is expected for a
static prototype and is exactly what Phase 3 must replace — the brief is right
that browser gating is UX only.

---

## 8. Loose ends and the real structural problems

### 8.1 Absolute paths (blocking for XAMPP)
§3.3. Five `/StuffModule/...` routes and one `/V4Home/...` redirect. These break
the moment the project lives in a subfolder of `htdocs/`. Fix: a single
`BASE_PATH` constant, or PHP-rendered paths.

### 8.2 Frozen clock
`INV_TODAY = "2026-06-17"` (`admin-inventory.js:11`) and `dAgo()` in `admin.js:157`
both hardcode today. Expiry alerts, "days left" chips, overdue payment flags and
every relative date are computed from it. Real data + a real clock will change
what these screens show.

### 8.3 Three batch code formats
`JBF-2026-B112` (`BATCHES`), `BT-20260617-01` (`ORDERS.batch`),
`BT-20260430-A` (`RETURNS.batchCode`, `ADJUSTMENTS.batch`). The schema has one
`batches.lot_code` column. Traceability cannot work until one format wins —
this is a decision I need from you (Q6).

### 8.4 Tooling that does not belong to this project
- `package.json` / `package-lock.json` / `node_modules/` — one devDependency, `shadcn`, a React/Tailwind component CLI. **The project has no React, no Tailwind, no build step, no `.tsx` file.** `components.json` even sets `"tsx": true` with an empty Tailwind config. Nothing imports anything from `node_modules`. It is inert — safe to archive, and **not needed at runtime**.
- `.mcp.json` — registers the shadcn MCP server for Claude Code. Editor tooling.
- `skills-lock.json` — Claude Code skills lockfile. Editor tooling.
- Recommendation: `.mcp.json` and `skills-lock.json` stay at root (they are editor config, not app files); `package*.json`, `components.json` and `node_modules/` go to `_archive/` unless you plan to introduce shadcn later.

### 8.5 `_backup-pre-rbac.zip` in the source tree
139 KB, 10 files, the pre-migration engines. Move to `_archive/`.

### 8.6 Three orphan stylesheets
§2.3. 1,083 lines referenced by nothing.

### 8.7 No version control
`D:\Cap2` is **not a git repository**. There is no commit history and no way to
undo a bad move except the zip. This blocks Phase 1 (see Q1).

---

## 9. Questions I need answered before Phase 1

The brief's variable table was left as `[FILL IN]`, so these are mandatory:

1. **Backup before any move.** There is no git repo here. Do you want me to `git init` + make an initial commit, or will you take a manual zip of `D:\Cap2`? **No file moves happen until one of these exists.**
2. **Project folder under `htdocs/`** — e.g. `elishabay`? This determines the base path used to fix §8.1.
3. **MySQL database name** — `elisha_bay_db` is what `database.txt` currently creates. Keep it?
4. **MySQL user/password for local dev** — `root` with a blank password is the XAMPP default. Confirm.
5. **Roles.** The system has exactly five staff roles: `Super Admin`, `Admin`, `Cashier`, `Inventory Staff`, `Online Orders Staff`; plus `customers` and B2B partners as separate tables (not roles). The brief guessed a different list. Confirm the real five, and tell me whether customers/partners should become rows in `users` with roles instead of separate tables — that is a schema decision, not a code one.
6. **Batch code format** (§8.3) — which of the three wins? I recommend `JBF-YYYY-Bnnn`, since it is the one the public traceability page and the QA batch table already share.
7. **Notifications** (§6.1.3) — derive from the audit log as today, or read the `notifications` table? I recommend the table; the current derivation loses read-state on refresh.
8. **Two camelCase partials** (`onlineTxns`, `posPayment`) — rename to match the lowercase rule? It is a 5-place change each and touches `MOD_PERM`, which `verify-modules.py` checks.
9. **`node_modules` / shadcn** (§8.4) — archive it, or are you planning to use shadcn later?
10. **Confirm the layer split:** `V4Home/HomePage` = public storefront, `StuffModule` = internal staff portal. Everything in this audit assumes yes.
11. **Seed dates** (§6.2) — shift the frozen 2026-06-17 dataset to be relative to the real current date, or leave it as a fixed historical dataset?

---

## 10. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **No version control.** One bad move command is unrecoverable. | **High** | Q1. Nothing moves first. |
| 2 | **`admin.js` is 3,322 lines with ~40 pieces of shared mutable state.** Every renderer reads module-scope `const` arrays synchronously. Making them async is not a find-and-replace — it changes the shape of every render function. | **High** | Convert one module end-to-end (Inventory) and freeze that pattern before touching the others. |
| 3 | Absolute paths (§8.1) break silently — the login button just 404s. | High | Fix in Phase 1 alongside the moves; test staff login from the landing page immediately after. |
| 4 | Moving `Modules/` while `MODULE_ORDER`, `MOD_PERM`, `data-mod`, `id="mod-*"` and `verify-modules.py` all encode the names. | Medium | Update all five in one commit; re-run `verify-modules.py` as the gate. |
| 5 | The live-reload `</body>` wrapper requirement in partials (§4) looks like cruft and will get "cleaned up" by someone. | Medium | Documented here and in `verify-modules.py` check 7. Keep the check. |
| 6 | Schema never executed against MySQL. First import may surface reserved-word or charset issues the static check cannot see. | Medium | Phase 2 step 1 is: start XAMPP, import, report actual errors. |
| 7 | Frozen clock (§8.2) — real dates will change what expiry/overdue screens display, which may read as a regression. | Medium | Decide Q11 before wiring the inventory module. |
| 8 | Plaintext passwords currently work as a login mechanism. Switching to `password_hash()` invalidates every seeded credential simultaneously. | Medium | Seed hashes in Phase 2, keep the same plaintext values so documented test logins still work. |
| 9 | Public checkout discards orders entirely (§5.6). This is not a wiring gap — the customer→order→staff flow does not exist and must be **built**, not connected. | Medium | Scope it explicitly in Phase 5; it is larger than the "shop.js" row in the brief's table implies. |
| 10 | `RETURNS`, `MOCK_ORDERS` and `ORDERS` reference each other by ids that do not always exist in the other array. | Low | The seed file already nulls unresolvable FKs; real data makes this moot. |

---

## 11. Next phase plan

Phase 1 proposes the target tree and an `old path → new path` table for all 60
files, **for your approval before anything moves**. The layout in the brief is
sound; my adjustments will be: `Modules/` → `portal/views/` (kills the
filename-collision confusion), a `BASE_PATH` constant to retire the absolute
routes, `_archive/` receiving the zip + three orphan stylesheets + the shadcn
tooling, and `docs/PROGRESS.md` started at that point. I did not create
`PROGRESS.md` now because §10 of the brief limits this phase to `AUDIT.md`.

Blocked on Q1 (backup) and Q2 (folder name). Q5–Q7 and Q11 are needed before
Phase 2, not before Phase 1.
