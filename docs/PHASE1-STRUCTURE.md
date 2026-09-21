# Phase 1 — Target Structure Proposal

**Status:** PROPOSAL. No file has been moved. Awaiting (a) your zip backup and
(b) approval of the table in §3.

Locked from Phase 0: project folder `elishabay`, five staff roles in `users`,
customers/partners stay separate tables.

---

## 1. One decision before anything moves: where does the project live?

XAMPP serves `C:\xampp\htdocs`. The project is on `D:\Cap2`. Three ways to
reconcile that:

| Option | Command | Trade-off |
|---|---|---|
| **A. Junction (recommended)** | `mklink /J C:\xampp\htdocs\elishabay D:\Cap2` | Project stays on D:, Apache serves it at `http://localhost/elishabay/`. One command, no config edit, no duplicated copy to keep in sync. Needs an admin shell once. |
| B. Apache Alias | Edit `httpd.conf`, add `Alias /elishabay "D:/Cap2"` + `<Directory>` block | Same result, but edits XAMPP config and needs an Apache restart. |
| C. Move the project | Move `D:\Cap2` → `C:\xampp\htdocs\elishabay` | Simplest mentally, but relocates your working folder and every editor/terminal path you have open. |

Everything below assumes the served root is `/elishabay/`, which all three
options produce identically. The choice does not change the file table.

---

## 2. Target tree

```
elishabay/                          (served at http://localhost/elishabay/)
│
├─ index.html                       NEW — redirect to public/index.html
│
├─ public/                          customer-facing site
│  ├─ index.html
│  ├─ shop.html
│  ├─ batch-traceability.html
│  ├─ become-partner.html
│  └─ profile/
│     ├─ profile.html
│     └─ my-orders.html
│
├─ portal/                          internal staff portal
│  ├─ shell.html                    chrome: login, topbar, sidebar, #main-content
│  ├─ super-admin/index.html        role: Super Admin
│  ├─ admin/index.html              role: Admin
│  ├─ cashier/index.html            role: Cashier
│  ├─ inventory/index.html          role: Inventory Staff
│  ├─ orders/index.html             role: Online Orders Staff
│  └─ views/                        the 24 partials
│
├─ assets/
│  ├─ css/
│  │  ├─ public/   styles.css  shop.css  trace.css  partner.css  profile.css
│  │  └─ portal/   portal.css  glass.css  pos.css  orders.css  inventory.css
│  ├─ js/
│  │  ├─ core/                      NEW in Phase 4 — api, session, rbac, ui, format
│  │  ├─ portal/
│  │  │  ├─ module-loader.js  role-gate.js  pagination.js
│  │  │  ├─ engine.js  pos.js  orders.js  inventory.js
│  │  │  └─ gates/  super-admin.js  admin.js  cashier.js  inventory.js  orders.js
│  │  └─ public/   site.js
│  └─ img/         bgfish.png
│
├─ api/                             NEW in Phase 3 — the only code touching MySQL
├─ db/             schema.sql  seed.sql
├─ docs/           AUDIT.md  PHASE1-STRUCTURE.md  PROGRESS.md  RBAC-MIGRATION-PLAN.md
├─ tools/          verify-structure.py
└─ _archive/       backup-pre-rbac.zip  orphan-css/  shadcn-tooling/
```

### 2.1 Deviations from the brief's layout, and why

1. **`Modules/` → `portal/views/`.** The brief kept `views/` as a maybe. It is the fix for the confusion in Phase 0 §2.1 — `Modules/inventory.html` and `InventoryModule/inventory.html` stop looking like duplicates once one is `portal/views/inventory.html` and the other is `portal/inventory/index.html`.

2. **Portal folders named by role, not by legacy module name.** Today `AdminModule/admin.html` is the **Super Admin** portal and `SubAdminModule/subadmin.html` is the **Admin** portal. That mismatch is a live trap — the file called `admin.html` is not the Admin portal. New names match `data-portal-role` exactly. **This is a change of meaning: `portal/admin/` is the Admin role, and Super Admin now lives at `portal/super-admin/`.**

3. **`admin.js` → `assets/js/portal/engine.js`.** It is the shared engine for all five portals, not Admin's file. Same reasoning strips the `admin-` prefix from `admin-pos.js` / `admin-orders.js` / `admin-inventory.js` and from the four portal stylesheets, all of which are equally shared.

4. **Per-portal gates land in `assets/js/portal/gates/`.** Keeps all JS under `assets/js` per the brief, and avoids a future collision between today's `cashier.js` (a 16-line gate) and Phase 5's `modules/cashier.js` (the real module).

5. **`verify-modules.py` → `tools/verify-structure.py`.** It verifies the whole portal structure, not a `Modules` folder that will no longer exist under that name.

6. **`_archive/` is subdivided** (`orphan-css/`, `shadcn-tooling/`) so it stays readable rather than becoming a junk drawer.

---

## 3. Move table — every file

`✎` = the file's own contents also need editing after the move (§4).

### 3.1 Public site → `public/` + `assets/`

| # | Old | New | |
|---|---|---|---|
| 1 | `V4Home/HomePage/index.html` | `public/index.html` | ✎ |
| 2 | `V4Home/HomePage/shop.html` | `public/shop.html` | ✎ |
| 3 | `V4Home/HomePage/batch-traceability.html` | `public/batch-traceability.html` | ✎ |
| 4 | `V4Home/HomePage/become-partner.html` | `public/become-partner.html` | ✎ |
| 5 | `V4Home/HomePage/MyProfile/profile.html` | `public/profile/profile.html` | ✎ |
| 6 | `V4Home/HomePage/MyProfile/my-orders.html` | `public/profile/my-orders.html` | ✎ |
| 7 | `V4Home/HomePage/styles.css` | `assets/css/public/styles.css` | |
| 8 | `V4Home/HomePage/shop.css` | `assets/css/public/shop.css` | |
| 9 | `V4Home/HomePage/trace.css` | `assets/css/public/trace.css` | |
| 10 | `V4Home/HomePage/partner.css` | `assets/css/public/partner.css` | |
| 11 | `V4Home/HomePage/MyProfile/myprofile.css` | `assets/css/public/profile.css` | |
| 12 | `V4Home/HomePage/script.js` | `assets/js/public/site.js` | ✎ |
| 13 | `V4Home/HomePage/Bgfish.png` | `assets/img/bgfish.png` | (case change — two-step rename on Windows) |

`V4Home/` is then empty and removed.

### 3.2 Portal shell and entries

| # | Old | New | |
|---|---|---|---|
| 14 | `StuffModule/Core/portal-shell.html` | `portal/shell.html` | ✎ |
| 15 | `StuffModule/AdminModule/admin.html` | `portal/super-admin/index.html` | ✎ |
| 16 | `StuffModule/SubAdminModule/subadmin.html` | `portal/admin/index.html` | ✎ |
| 17 | `StuffModule/CashierModule/cashier.html` | `portal/cashier/index.html` | ✎ |
| 18 | `StuffModule/InventoryModule/inventory.html` | `portal/inventory/index.html` | ✎ |
| 19 | `StuffModule/OrdersModule/orders.html` | `portal/orders/index.html` | ✎ |

### 3.3 Portal JavaScript

| # | Old | New | |
|---|---|---|---|
| 20 | `StuffModule/Core/module-loader.js` | `assets/js/portal/module-loader.js` | ✎ |
| 21 | `StuffModule/Core/role-gate.js` | `assets/js/portal/role-gate.js` | |
| 22 | `StuffModule/AdminModule/admin.js` | `assets/js/portal/engine.js` | ✎ |
| 23 | `StuffModule/AdminModule/admin-pos.js` | `assets/js/portal/pos.js` | ✎ |
| 24 | `StuffModule/AdminModule/admin-orders.js` | `assets/js/portal/orders.js` | ✎ |
| 25 | `StuffModule/AdminModule/admin-inventory.js` | `assets/js/portal/inventory.js` | |
| 26 | `StuffModule/AdminModule/shared-pagination.js` | `assets/js/portal/pagination.js` | |
| 27 | `StuffModule/AdminModule/admin-gate.js` | `assets/js/portal/gates/super-admin.js` | |
| 28 | `StuffModule/SubAdminModule/subadmin.js` | `assets/js/portal/gates/admin.js` | |
| 29 | `StuffModule/CashierModule/cashier.js` | `assets/js/portal/gates/cashier.js` | |
| 30 | `StuffModule/InventoryModule/inventory.js` | `assets/js/portal/gates/inventory.js` | |
| 31 | `StuffModule/OrdersModule/orders.js` | `assets/js/portal/gates/orders.js` | |

### 3.4 Portal CSS

| # | Old | New |
|---|---|---|
| 32 | `StuffModule/AdminModule/admin.css` | `assets/css/portal/portal.css` |
| 33 | `StuffModule/AdminModule/admin-glass.css` | `assets/css/portal/glass.css` |
| 34 | `StuffModule/AdminModule/admin-pos.css` | `assets/css/portal/pos.css` |
| 35 | `StuffModule/AdminModule/admin-orders.css` | `assets/css/portal/orders.css` |
| 36 | `StuffModule/AdminModule/admin-inventory.css` | `assets/css/portal/inventory.css` |

### 3.5 The 24 partials → `portal/views/`

Straight move, same filename, for 22 of them:

`audit` · `b2b` · `batches` · `dashboard` · `expiry` · `inventory-manage` ·
`inventory` · `landing` · `notifications` · `orderhistory` · `ordersqueue` ·
`orderstatus` · `payments` · `paymentverify` · `pos` · `products` · `receipts` ·
`returns` · `roles` · `sales` · `transactions` · `users`

Two renamed under the lowercase rule (Phase 0 Q8):

| # | Old | New | |
|---|---|---|---|
| 59 | `StuffModule/Modules/onlineTxns.html` | `portal/views/online-txns.html` | ✎ |
| 60 | `StuffModule/Modules/posPayment.html` | `portal/views/pos-payment.html` | ✎ |

### 3.6 Database, docs, tools

| # | Old | New |
|---|---|---|
| 61 | `database.txt` | `db/schema.sql` |
| 62 | `database-seed.txt` | `db/seed.sql` |
| 63 | `RBAC-MIGRATION-PLAN.md` | `docs/RBAC-MIGRATION-PLAN.md` |
| 64 | `StuffModule/verify-modules.py` | `tools/verify-structure.py` ✎ |
| — | `docs/AUDIT.md` | stays |

### 3.7 Archived

| # | Old | New | Why |
|---|---|---|---|
| 65 | `StuffModule/_backup-pre-rbac.zip` | `_archive/backup-pre-rbac.zip` | Backup inside the source tree |
| 66 | `StuffModule/CashierModule/cashier.css` | `_archive/orphan-css/cashier.css` | 408 lines, zero references |
| 67 | `StuffModule/InventoryModule/inventory.css` | `_archive/orphan-css/inventory.css` | 173 lines, zero references |
| 68 | `StuffModule/OrdersModule/orders.css` | `_archive/orphan-css/orders.css` | 502 lines, zero references |
| 69 | `package.json` | `_archive/shadcn-tooling/package.json` | shadcn only; no React/Tailwind/build step |
| 70 | `package-lock.json` | `_archive/shadcn-tooling/package-lock.json` | ″ |
| 71 | `components.json` | `_archive/shadcn-tooling/components.json` | ″ |
| 72 | `node_modules/` | `_archive/shadcn-tooling/node_modules/` | 8,815 files; single directory rename, same volume |

### 3.8 Staying at root

`.mcp.json`, `skills-lock.json` — Claude Code editor config, not application files.

---

## 4. Content edits required after the moves

Moving files is the easy half. These edits are what keep the site from 404ing.

**4.1 Five portal entry HTMLs** — every `<link>` and `<script>` path changes,
e.g. `../AdminModule/admin.js` → `../../assets/js/portal/engine.js`. 13 lines
each, 65 total.

**4.2 Six public HTMLs** — CSS/JS paths become `../assets/...` (or
`../../assets/...` under `profile/`). `index.html` also picks up
`assets/img/bgfish.png`.

**4.3 `module-loader.js`** — `PORTAL_BASE + "Core/portal-shell.html"` →
`"../shell.html"`; `Modules/<name>.html` → `../views/<name>.html`; two entries in
`MODULE_ORDER` renamed.

**4.4 The absolute-path fix (Phase 0 §8.1)** — the actual bug this phase exists
to kill. Introduce one constant and route through it:

- `site.js` `STAFF_ROUTES` — 5 routes, `/StuffModule/AdminModule/admin.html` → `/elishabay/portal/super-admin/`
- `engine.js:1136` logout → `/elishabay/public/index.html`
- `engine.js:3274` landing-preview iframe → `../../public/index.html`

**4.5 The two partial renames** — 21 sites: `MODULE_ORDER`, `MOD_PERM`,
`MOD_DESC`, the `navigate()` router map, `data-mod` in `shell.html`, the
`id="mod-*"` in each partial, and three `currentModule` comparisons in `pos.js` /
`orders.js`.

**4.6 `tools/verify-structure.py`** — `PORTALS`, `ENGINE`, `MODULES_DIR`, `SHELL`
constants all repoint. It is the gate for this whole phase, so it gets updated
first and re-run last.

---

## 5. Verification for this phase

1. `python tools/verify-structure.py` — must return all-pass, same as today.
2. Load all 6 public pages + all 5 portals in the browser; **zero console errors, zero 404s** in the network log.
3. Staff login from the landing page for each of the 5 roles → lands on the right portal (this is what the absolute-path bug currently breaks).
4. Logout from a portal → returns to the public landing page.
5. Landing-page preview iframe in the Super Admin portal still renders.

---

## 6. Order of execution, once approved

1. Update `verify-structure.py` first, so the gate exists before the moves.
2. Create the new empty tree.
3. Move CSS + images, fix references, verify.
4. Move public HTML + `site.js`, fix references, verify.
5. Move portal JS, then shell + partials, then the 5 entries — fix references, verify after each.
6. Apply the two partial renames as one atomic change across all 21 sites.
7. Apply the absolute-path fix.
8. Archive the dead files last, so nothing is out of reach while debugging.
9. Full verification sweep (§5), then write it up in `docs/PROGRESS.md`.
