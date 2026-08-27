# CAP2 / Elisha Bay — Progress Log

Running record across sessions. Newest phase at the bottom.

---

## Phase 0 — Audit — **COMPLETE** (16 Aug 2026)

**Changed:** created `docs/AUDIT.md`. No other file touched.

**Works now:** nothing new — read-only phase. Confirmed working as-is:
`verify-modules.py` passes all 15 structural checks; all five portals boot and
assemble 24 partials; public site has no broken relative links.

**Broken / stubbed:**
- Zero `fetch`/XHR in application code. 29 hardcoded arrays. No API exists.
- Auth is a plaintext credential array compared in the browser.
- Public checkout discards orders entirely — no customer→staff order path exists.
- Six absolute paths (`/StuffModule/...`, `/V4Home/...`) 404 under any subfolder.
- `STAFF_ACCOUNTS` duplicated and divergent (6 in engine, 5 on landing page).
- Three incompatible batch-code formats against one `lot_code` column.
- Frozen clock: `INV_TODAY = "2026-06-17"` drives all expiry/overdue output.
- Schema never executed against MySQL (XAMPP was down).

**Corrected premises from the brief:** no `V4Home \ HomePage` path exists;
`inventory.html` is not a duplicate; the schema does have `users`; the RBAC
migration is already complete.

**Decisions taken:** project folder `elishabay`; backup by manual zip (user);
five staff roles stay in `users`, customers/partners stay separate tables.

**Defaults assumed, still reversible:** DB `elisha_bay_db`; `root`/blank creds;
batch format `JBF-YYYY-Bnnn`; notifications read from the table rather than
derived; camelCase partials renamed; shadcn tooling archived; seed dates left
frozen at 2026-06-17.

---

## Phase 1 — Restructure — **COMPLETE** (16 Aug 2026)

**The project now lives at `C:\xampp\htdocs\elishabay`**, served at
`http://localhost/elishabay/`. `D:\Cap2` was left untouched as a fallback and
should be deleted by the user once satisfied.

**Changed:**
- Copied `D:\Cap2` → `C:\xampp\htdocs\elishabay` (excluding `node_modules`).
- Executed all 72 moves from `PHASE1-STRUCTURE.md` §3. `StuffModule/` and
  `V4Home/` no longer exist.
- Renamed `onlineTxns` → `online-txns` and `posPayment` → `pos-payment` across
  21 sites. Both had to become **quoted** object keys in `MOD_PERM`, the
  `navigate()` router and `MOD_DESC` — a bare hyphenated key is a JS syntax
  error, which would have taken the whole engine file down.
- Replaced six hardcoded absolute paths with derived roots: `BASE_PATH` in
  `site.js`, `PORTAL_BASE_PATH` in `engine.js`. Both compute from
  `document.currentScript.src`, not the page URL — `site.js` loads from both
  `public/` and `public/profile/`, so a page-relative base is wrong in one of
  them.
- Repointed `tools/verify-structure.py` and fixed its now-ambiguous labels
  (five rows all read `index.html` after the rename).
- Added root `index.html` (redirect to the storefront) and `.htaccess` denying
  `docs/`, `tools/`, `db/*.sql`, `_archive/`, `.claude`, `.agents`, plus
  `Options -Indexes` — the project is inside the web root now, so anything not
  refused is downloadable.
- Repointed every code comment that named a path which no longer exists.
- Archived: `backup-pre-rbac.zip`, three orphan stylesheets (1,083 lines, zero
  references), and the shadcn tooling including `node_modules`.

**Works now — verified, not assumed:**
- `python tools/verify-structure.py .` → all checks pass (24 partials, no id
  collisions, nav↔section pairing exact, 17 permissions, 0 collisions).
- Apache started; 20 routes return 200; `docs/`, `db/*.sql` and `_archive/`
  correctly return 404.
- Super Admin portal: shell + all 24 partials fetch 200, **zero console
  errors**, login succeeds, 24 panels, 34/34 nav items visible.
- Cashier portal: 8/34 nav items visible — matches `ROLE_PERMISSIONS` exactly,
  and the renamed `pos-payment` is correctly gated behind `pos.use`.
- Both renamed modules navigate and render.
- Staff routes resolve to `http://localhost/elishabay/portal/<role>/` from both
  `public/` and `public/profile/` — the bug this phase existed to kill.
- Logout redirects to the public landing page; landing-preview iframe loads 200.

**Still broken — unchanged by this phase:** everything in the Phase 0 list that
is not a path problem. No API, mock data everywhere, browser-side plaintext
auth, public checkout still discards orders, frozen clock, three batch formats.

**Next:** Phase 2 — import `db/schema.sql` + `db/seed.sql` into MySQL for the
first time, hash the passwords, write `docs/SETUP.md`.

---

## Phase 2 — Database — **COMPLETE** (16 Aug 2026)

**Changed:**
- Started MariaDB 10.4.32 (port 3306 was free). Imported `db/schema.sql` —
  **21 tables, 19 foreign keys, zero errors on the first run.** The static
  checks from Phase 0 held up.
- Hashed all six staff passwords with PHP `password_hash($p, PASSWORD_BCRYPT)`
  and replaced the plaintext values in `db/seed.sql`. The underlying passwords
  are unchanged, so the documented test logins still work; they now live in
  `docs/SETUP.md` instead of the seed file.
- **Found a real defect on import:** `b2b_applications.business_address` is
  `NOT NULL`, but the seed passed NULL for it (and for `bir_tin` and
  `monthly_volume`) because the original JS array never carried those fields.
  MySQL's default non-strict mode downgraded this to a warning and silently
  wrote `''` into all 8 rows. Filled the three columns with demo values
  consistent with each application's existing notes, rather than relaxing a
  constraint that `become-partner.html` genuinely enforces.
- Pinned `sql_mode` to `STRICT_ALL_TABLES,...` per connection via
  `db.sql_mode` in the config, so the app never inherits a permissive server
  setting. Verified it now rejects the exact insert that previously passed.
- Wrote `db/schema-additions.sql` — **proposed, deliberately not applied.**
  Three additions with reasoning: `order_status_history` (the Order Status
  stepper is currently invented at render time; nothing records who moved an
  order), `audit_logs.actor_user_id` (the actor is a name string, so renaming
  an employee orphans their history), and `login_attempts` (Phase 3 puts a
  login endpoint on the network with six known demo credentials behind it). A
  fourth, `sessions`, is explicitly argued against — PHP's file handler is
  adequate for one XAMPP box.
- `api/config/config.example.php` (committed) + `config.php` (gitignored) +
  a `.gitignore`. Added an `.htaccess` rule returning 404 for `api/config/`.
- Wrote `docs/SETUP.md`.

**Works now — verified, not assumed:**
- Full drop-and-reimport under `STRICT_ALL_TABLES`: **298 rows, zero warnings.**
- Row counts match the JS source arrays exactly (15 products, 17 permissions,
  30 role grants, 42 orders, 78 line items, 28 audit rows, 12 batches).
- All six accounts authenticate via `password_verify()`; wrong passwords are
  rejected; the archived account is flagged as such.
- Role→permission grants resolve: Admin 16, Online Orders 6, Cashier 4,
  Inventory 4, Super Admin 0 (correct — `is_system=1` bypasses the table).
- Every `orders.total` matches `SUM(qty × price_at_purchase)` — 0 mismatches.
- Zero orphaned foreign keys across orders, order_items and batches.
- PDO connects through `config.php`; strict mode confirmed active on the
  session.
- `api/config/`, `db/*.sql`, `docs/` all return 404 over HTTP; the site still
  returns 200. `verify-structure.py` still all-pass.

**Still broken:** the front end does not read any of this yet. Login is still
the client-side plaintext array in `engine.js`; every screen still renders from
the 29 hardcoded arrays. Hashing the DB does not close that hole on its own —
Phase 3 and 5 do.

**Decision outstanding:** whether to apply `db/schema-additions.sql`.

**Next:** Phase 3 — the PHP API. PDO with prepared statements only, one JSON
envelope, server-side auth and role checks on every endpoint, `docs/API.md`
written as the endpoints are built.

---

## Phase 3 (part 1) — API core + real authentication — **COMPLETE** (16 Aug 2026)

Scope of this pass: the worst item on the broken list — browser-side plaintext
authentication — fixed end to end, plus the API foundation everything else will
sit on. Data endpoints for the remaining modules are still to come.

**Changed — API:**
- `api/core/Response.php` — the single JSON envelope, correct status codes,
  output buffering so a stray PHP warning cannot corrupt a body.
- `api/config/db.php` — one PDO connection. `ERRMODE_EXCEPTION`,
  `EMULATE_PREPARES=false` (real prepared statements, not client-side
  interpolation), and `sql_mode` pinned so the app never inherits a loose
  server.
- `api/core/bootstrap.php` — warnings become exceptions, fatals get a shutdown
  net, nothing diagnostic is ever echoed into the response.
- `api/core/Auth.php` — bcrypt verification, session regeneration on sign-in,
  idle timeout, archived-account refusal, identical error message for unknown
  email and wrong password (no user enumeration), and a dummy `password_verify`
  on the miss path so timing does not leak either. Optional brute-force
  throttling that degrades gracefully when `login_attempts` is absent.
- `api/core/Rbac.php` — permissions read from `role_permissions`, so a change
  on the Roles screen is a real change. `is_system` roles hold everything.
- `api/core/Validate.php` — collects all field errors rather than failing on
  the first, plus clamped paging.
- Endpoints: `auth/login.php`, `auth/me.php`, `auth/logout.php`,
  `products/list.php`, `users/list.php`.

**Changed — front end:**
- `assets/js/core/api.js` — the only `fetch()` in the project. Envelope
  unwrapping, normalised errors, 15s timeout, and a readable message when the
  server returns HTML instead of JSON.
- `assets/js/core/session.js` — `bootstrap` / `login` / `logout` / `can`.
- **Deleted every plaintext password from client code.** `site.js`'s
  `STAFF_ACCOUNTS` array is gone entirely; `engine.js`'s keeps only display
  fields for the User Management screen, with no password key.
- `engine.js`: `checkSessionAuth()` now asks `auth/me.php` instead of trusting
  `sessionStorage["eb-staff"]`; login posts to the API; `hasPerm()` consults
  the server's grants; logout destroys the server session.
- `role-gate.js` reduced to declaring which role an entry point accepts. Its
  old capture-phase interceptor needed the plaintext password list and stopped
  nobody.
- Added an `.htaccess` no-cache rule for `.js`/`.css` — see the note below.

**Works now — verified by direct request, not by looking at the UI:**
- Cashier session → `users/list.php` → **403**. The nav item is hidden *and*
  the endpoint refuses. Super Admin → 200. No session → 401.
- Login: correct password 200; wrong password 401; unknown email 401 with the
  same message; archived account 403; `portal_role` mismatch 403; GET on the
  login endpoint 405; empty body 422 with per-field messages.
- SQL injection probes (`' OR '1'='1`, `x'; DROP TABLE products; --`, and a
  `sort` injection) all treated as literal input; the sort whitelist held; all
  tables intact afterwards.
- Browser: login through the real form works, the session survives a reload
  with **no sessionStorage involved**, the cookie is invisible to JS, a Cashier
  visiting the Super Admin portal is bounced to the public page, and logout
  makes `me.php` return 401.
- RBAC now comes from MySQL: Cashier sees 8 nav items, 26 hidden, matching the
  4 permissions `role_permissions` actually grants.
- `grep` over everything a browser can fetch: **zero** credential hits.

**Gotcha worth remembering:** an hour of this pass went to a stale browser
cache. The old `role-gate.js` was still reassigning `checkSessionAuth`, so the
page ran new engine code against an old gate and silently ignored a valid
session. The `.htaccess` no-cache rule for `.js`/`.css` prevents a repeat;
remove it before any real deployment.

**Still broken:** the other 28 hardcoded arrays. Every screen except login and
RBAC still renders from mock data — dashboard, POS, inventory, orders, returns,
batches, payments, audit. Public checkout still discards orders. The frozen
clock and the three batch-code formats are untouched.

**Next:** the remaining data endpoints and wiring each module to them, one at a
time, verified per module: inventory → products → orders → POS/cashier → admin
→ customer-facing.

---

## Phase 3 (part 2) — CSRF, schema additions, first real data + first write — **COMPLETE** (16 Aug 2026)

**Two decisions taken on my own recommendation** (both flagged twice, both
reversible):

1. **Applied `db/schema-additions.sql`.** `login_attempts` (login throttling was
   inert without it), `order_status_history`, and `audit_logs.actor_user_id`.
   The backfill matched all 28 existing audit rows to real users. Reverse with
   `DROP TABLE login_attempts, order_status_history;` and
   `ALTER TABLE audit_logs DROP COLUMN actor_user_id;`.
2. **Added CSRF protection now** rather than retrofitting it across ~30 write
   endpoints later.

**Changed:**
- `api/core/Csrf.php` — per-session token, `hash_equals` comparison, enforced
  centrally in `bootstrap.php` so an endpoint cannot forget it. GET exempt;
  login and logout exempt for stated reasons. `api.js` attaches
  `X-CSRF-Token` automatically on non-GET; `session.js` stores it from the
  login/me payload.
- `api/categories/list.php`, `api/inventory/adjust.php` (first write endpoint).
- `engine.js`: `PRODUCTS` and `CATEGORIES_DATA` changed from `const` seed
  arrays to `let`, populated by a new `loadCatalog()` from the API on both
  sign-in paths. Mutated in place via `length`/`push` rather than reassigned,
  because pos.js, orders.js and inventory.js hold references to the original
  array and would otherwise keep showing seed data.

**Works now — verified:**
- CSRF: no token 403, wrong token 403, correct token passes, GET exempt,
  logout exempt.
- **Real data on screen.** Set `db-pesto` to price 999 / stock 777 directly in
  MySQL; the Inventory Report rendered "Pesto Bangus … 777 SAFE FAST MOVING
  ₱999" after login. Restored to seeded values afterwards.
- `inventory/adjust.php` end to end: Cashier 403 (lacks `inventory.manage`);
  Inventory Staff restock +50 → 200, stock 142→192; over-disposal 409 with a
  message naming the real stock level; qty 0 + bad enum + missing reason → 422
  with three separate field errors. Stock row, adjustment row and audit row
  (carrying `actor_user_id`) all persisted in one transaction. Test data
  cleaned up afterwards.
- `verify-structure.py` still all-pass.

**Found and fixed:** returned 419 for CSRF failures at first. 419 is a Laravel
convention, not a registered HTTP status — PHP does not recognise it and emits
500 instead, which reads as "the server broke" rather than "refused". Now 403
with a distinct `CSRF` code.

**Still broken:** the remaining hardcoded arrays — orders, returns,
notifications, batches, payment accounts, customers, B2B, audit log, site
content. Public checkout still discards orders. Frozen clock and the three
batch-code formats untouched. `ui.js` / `format.js` / `pagination.js` not built
yet: `engine.js` already defines `toast`, `openModal`, `peso` and `fmtDate` as
globals, and adding same-named core files would collide exactly the way the
pre-RBAC portal engines did — they land in Phase 5 as each module converts.

**Next:** remaining read endpoints (orders, batches, customers, audit) and
per-module wiring, in the brief's order.

---

## Phase 4 — Shared front-end core — **COMPLETE** (16 Aug 2026)

Last phase flagged that `ui.js` / `format.js` / `pagination.js` could not simply
be added, because `engine.js` already owns `toast`, `openModal`, `peso` and
`fmtDate` as top-level names — two files declaring the same top-level binding is
a SyntaxError that kills the whole script, which is precisely why the pre-RBAC
portal engines could never be loaded side by side. So the implementations were
**moved** into the core and `engine.js` now delegates.

**Built — `assets/js/core/`:**
- `format.js` (`EbFormat`) — currency, dates, initials, stock bands, movement
  bands, payment-method and status labels. One implementation, replacing copies
  that had drifted between portal and public site.
- `ui.js` (`EbUI`) — toast and modal (moved out of `engine.js`), plus a
  promise-shaped `confirm()`, the three list states every module needs
  (`loadingRow` / `emptyRow` / `errorRow`), `showFieldErrors` driven by the
  API's 422 `fields` map, `busy()` for in-flight buttons, and `submit()` which
  wraps all of it.
- `rbac.js` (`EbRbac`) — consolidates `hasPerm` / `applyRBAC` / the entry-point
  check that used to live across `engine.js`, `role-gate.js` and
  `admin-gate.js`. Reads permissions from the session, i.e. from the database.
- `pagination.js` (`EbPaginate`) — **server-side** paging driven by the API's
  `meta` block, with a windowed page list (1 … 7 8 9 … 42). The old
  `portal/pagination.js` slices an array already in memory; both exist during
  Phase 5 and a module switches over when it is converted.
- CSS for the list states, spinner (with a `prefers-reduced-motion` fallback),
  pagination gap marker and `.has-error`.

**`engine.js` now delegates** `peso`, `escHtml`, `fmtDate`, `fmtDateTime`,
`stockInfo`, `movementType`, `payMethodLabel`, `initials`, `toast`, `openModal`,
`closeModal` and `applyRBAC`. The names are kept as thin wrappers because ~200
call sites across four files use them; renaming those is churn with no benefit.

**Broke it, then fixed it — worth recording.** The delegating wrappers were
first written as `const` arrows, which took the entire portal down:
`payMethodLabel` is called at *parse time* by the `ONLINE_ORDERS_SEED` `.map()`
near the top of the file, and a `const` is in the temporal dead zone until its
own line runs. The result was "Cannot access 'payMethodLabel' before
initialization", which aborted `engine.js` mid-parse and cascaded into
`AUDIT_LOG is not defined` and `Cannot access '$' before initialization` from
two other files. Rewritten as hoisted `function` declarations. The lesson
generalises: anything called from the top-level seed blocks must be a
declaration, not a const.

**Works now — verified:**
- Login, dashboard, 24 panels, zero real console errors.
- Delegated helpers return correct output: `peso(1234)` → `₱1,234`,
  `fmtDate('2026-06-17')` → `Jun 17, 2026`, `payMethodLabel('gcash')` → `GCash`,
  `stockInfo(5).label` → `Critical`.
- Inventory Report and Transaction History both render real database rows
  through the delegated formatters.
- `toast()` renders via `EbUI`; `openModal()` / `closeModal()` open and close.
- Public site unaffected — `EbFormat` loads, product cards and hero render.
- Every JS file passes `node --check`; every PHP file passes `php -l`;
  `verify-structure.py` all-pass; all six core files serve 200.

**Note on a diagnostic trap:** the browser tool's console buffer is not cleared
between navigations, so it kept replaying the (already fixed) `engine.js`
errors on a public page that never loads `engine.js`. Live state has to be
queried directly rather than trusted from that log.

**Still broken:** unchanged from last phase — orders, returns, notifications,
batches, payment accounts, customers, B2B, audit log and site content are still
hardcoded arrays; public checkout still discards orders; frozen clock; three
batch-code formats.

**Next:** Phase 5 — per-module conversion, one at a time, in the brief's order:
inventory → products → orders → POS/cashier → admin → customer-facing. Each
module gets its own endpoints, loading/empty/error states, and verification
before the next one starts.

---

## Phase 5 — Module 1: Inventory — **COMPLETE** (16 Aug 2026)

First module converted end to end. Establishes the pattern for the rest.

**Endpoints added:** `batches/list.php`, `inventory/adjustments.php`
(`inventory/adjust.php` landed last phase).

**The frozen clock is fixed — for this module.** `INV_TODAY = "2026-06-17"` was
a constant in `inventory.js`; every "days left" chip, expiry warning and date
default was measured from a clock that had stopped. Now `days_to_expiry` is
`DATEDIFF(expiry_date, CURDATE())` computed by MySQL, and the batch response
carries the server's own `today` in `meta`, which the client records so its date
defaults match. `INV_TODAY` survives as a getter over `invToday()` because ~10
call sites use it as a default value.

**Mutations now persist.** `restock()`, `replenish()` and `adjustStock()` used
to add to `p.stock` and unshift onto an in-memory array — visually identical to
working, and gone on refresh. All three now POST to `inventory/adjust.php` and
reload from the database afterwards rather than predicting the result. The
expiry screen's disposal no longer edits `batchObj.remainingQty` locally either.

**Permission-aware loading.** `loadCatalog()` only fetches batches and the
adjustment log when the role may read them — a Cashier holds neither
`inventory.report` nor `batches.manage`, and asking anyway would pop a 403 error
toast at every Cashier login for data their screens never show.

**Also:** in-flight buttons disabled via `EbUI.busy` (a double-click used to post
two stock movements); 422 field errors rendered against the forms;
`replenish()` reports which lines failed instead of failing silently as a batch.

**Works now — verified end to end through the UI, not just curl:**
- Signed in as Inventory Staff: 15 products, 12 batches, 6 adjustments, all from
  MySQL. `serverToday` = 2026-08-16, the real date.
- Restocked `bg-hawaii` +60 with lot JBF-2026-B999 **through the actual form** →
  stock 42→102, batch row created, adjustment logged, audit row attributed to
  `emp-02`. **Confirmed persisted after a full page reload**, then cleaned back
  to seeded state.
- Expiry screen shows 276D / 284D / 287D — computed from the real clock. Under
  the frozen constant those same rows read roughly 60 days higher.
- Permissions: Cashier → `batches/list.php` 403 and `inventory/adjustments.php`
  403; Inventory Staff → both 200 but `users/list.php` 403; no session → 401.
- All JS passes `node --check`, all PHP passes `php -l`, structure all-pass.

**Two syntax faults caught by `node --check` before they shipped:** adding
`await` inside two handlers that were not `async` — one a click handler on
`#rep-submit-btn` (not a form submit, so it had no event object either). Both
would have been silent until a user pressed the button.

**Known gap in this module:** `archiveInvProduct` / `restoreInvProduct` still
mutate `p.archived` in memory — they need a `products/archive.php` endpoint,
which belongs with the Products module next.

**Next:** Module 2 — Products (CRUD, pricing, categories, images).

---

## Phase 5 — Module 2: Products — **COMPLETE** (16 Aug 2026)

**Endpoints added:** `products/save.php` (create + update), `products/archive.php`,
`categories/save.php`, `categories/archive.php`. This also closes the gap left
by Module 1 — `archiveInvProduct` / `restoreInvProduct` now have a real endpoint.

**What the endpoints refuse, and why it matters:**
- `save.php` ignores `stock`, `sold` and `rating` entirely. Stock moves only
  through `inventory/adjust.php`, which demands a reason and writes an audit
  row — accepting it here would be an untraceable way to change stock.
  **Verified**: a save posting `stock: 99999` left stock at 0.
- Images must be `data:image/(png|jpe?g|webp|gif)`. **Verified**: a
  `data:text/html,<script>alert(1)</script>` payload is rejected 422. Without
  that check the column would store it and every page rendering a product image
  would hand it back.
- `tint` must be a hex colour — it lands in a style attribute.
- Category must exist. The form dropdown "guarantees" this, which is exactly
  why it is checked: the dropdown is not what sends the request.
- Archiving a variety with active products is refused, naming the count.
- Duplicate variety names refused.

**Audit entries now name the change:** `name 'X' → 'Y'; price ₱265.00 → ₱289.00`
rather than "Updated product X". Confirmed the peso sign stores as U+20B1 —
the `?` in the mysql CLI output is the Windows console, not the data.

**Works now — verified through the UI:**
- Created a product through the actual modal → persisted as
  `bg-ui-test-tinapa-bangus` with a readable slug id, opening stock 0, audit row
  attributed to `emp-01`.
- Edited it → price 265→289 and the rename both persisted, with the audit
  naming both changes.
- Archived via curl and via UI; second archive attempt 409.
- Variety archive refused in the UI with the server's message shown as a toast,
  modal left open, category untouched.
- Cashier → `products/save.php` 403.
- Test rows removed; database back to 15 products / 2 categories / 28 audit
  rows / 12 batches, `bg-hawaii` stock 42.

**Diagnostic note:** briefly concluded the UI was failing silently on the
variety-archive refusal, because no toast was visible when queried. It was a
measurement artifact — each browser tool round-trip takes longer than the toast's
3.5s auto-dismiss. Re-checked by wrapping `EbUI.toast` to record calls, which
showed the error message firing correctly. Worth remembering: transient UI has
to be captured, not observed after the fact.

**Still broken:** orders, returns, notifications, payment accounts, customers,
B2B, audit log and site content remain hardcoded. Public checkout still
discards orders. Batch-code formats still three.

**Next:** Module 3 — Orders (queue, status transitions, history, detail), which
is where `order_status_history` from the schema additions gets used.

---

## Phase 5 — Module 3: Orders — **COMPLETE** (16 Aug 2026)

**Endpoints:** `orders/list.php`, `orders/get.php`, `orders/status.php`,
`orders/verify-payment.php`. `ORDERS` now loads from the database like
PRODUCTS/BATCHES.

**The transition table is now enforced server-side.** It previously existed
only as `STATUS_TRANSITIONS` in `engine.js`, shaping which buttons the status
modal offered. Verified by direct request:
- pending → completed: **409**, naming the allowed moves (this jump would skip
  payment verification entirely)
- accepting an unverified order: **409**
- hold/cancel with no reason: **422**
- cancelled order: **409**, terminal
- verifying with no proof uploaded: **409**

Also added a conditional `UPDATE … WHERE status = <what we read>`, so two staff
moving the same order at once produces "Somebody else just changed this order"
rather than one silently overwriting the other.

`order_status_history` — one of the schema additions applied earlier — now gets
its first real use: every move records from, to, who and why.

**Caught a shape mismatch mid-wiring.** `orders/list.php` originally omitted
line items to avoid an N+1 query, but 23 call sites across `orders.js`,
`engine.js` and `pos.js` read `o.items`, and the queue screen threw immediately.
Fixed by fetching all items for the page in **one grouped query** — 3 queries
per page instead of 27 — rather than either N+1 or changing 23 call sites.

**Works now — verified through the UI as Online Orders Staff:**
- 42 orders load from MySQL; queue renders 4 cards with item chips resolved to
  product names.
- Accepting an unverified order is refused, the server's message is toasted, and
  the order stays `pending`.
- `approvePayment()` → verification recorded, then status moved to `accepted`;
  `order_status_history` row written with `changed_by = emp-04` and the note;
  two audit rows. All confirmed in MySQL, then restored.
- Inventory Staff → `orders/list.php` 403 and `orders/status.php` 403.

**Found in the data:** `ORD-20260617-005`'s note says "expected ₱2,390, received
₱2,000", but its line items total ₱2,260. The note was wrong; the mismatch
calculator works from the actual rows. Left as-is — it is seed prose, not a
computed value — but worth knowing before anyone cites it.

**Known gap:** the order screens still hold all 42 orders client-side and page
through them with the old `Paginate`. `EbPaginate` (server-side) exists but each
screen needs its own filtered query to use it. Honest at 42 rows, wrong at
10,000 — noted rather than pretended finished.

**Still broken:** returns, notifications, payment accounts, customers, B2B,
audit log, site content. Public checkout still discards orders. Batch-code
formats still three.

**Next:** Module 4 — POS / Cashier, where checkout must create a real order and
decrement stock in one transaction.

---

## Phase 5 — Module 4: POS / Cashier — **COMPLETE** (16 Aug 2026)

**Endpoint:** `pos/checkout.php`. The first one where getting it wrong costs
money or inventory accuracy, so the guards are the substance of the module.

**Money is computed server-side.** `placeOrder()` used to total the cart in the
browser and store whatever it arrived at — the amount charged was decided by
code running on the till's own machine. The endpoint now prices every line from
`products.price` and ignores anything the client claims a thing costs.
**Verified:** a request sending `price: 1, total: 2` for two units of a ₱285
product was charged ₱570.

**Stock and the order move together.** Previously stock was decremented in a
loop over the local array — correct until the next refresh, then silently not.
Order row, line items, stock decrements and audit entry are now one transaction.

**Concurrency handled, not hoped about:** product rows are locked with
`SELECT … FOR UPDATE`, because two cashiers selling the last unit at the same
moment would otherwise both read `stock = 1`, both pass the check, and leave
stock at −1. The decrement is additionally guarded with `WHERE stock >= ?`.

**Subtle guard worth naming:** duplicate cart lines for the same product are
merged *before* the stock check. Two lines of 5 against 9 in stock would each
pass an individual check and oversell by one. **Verified** — that exact request
returns 409 "9 left, 10 requested".

**Works now — verified through the UI as Cashier:**
- Added 3 × Pinoy Adobo + 2 × Tuyo Delizioso, tendered ₱2,000, checkout →
  order `EB-FF6E99-531`, total **₱1,135** (3×235 + 2×215), change ₱865.
- Stock 138→135 and 155→153, `sold` incremented on both, order + 2 line items +
  audit row all in MySQL. Receipt rendered from the server's figures.
- Cart cleared only after the server confirmed; on failure the cart is left
  intact so the cashier can adjust and retry.
- Oversell, archived product, short cash, missing address and missing reference
  all refused with usable messages.
- Inventory Staff → `pos/checkout.php` **403**.
- Test orders removed; database back to 42 orders / 78 items / 28 audit rows and
  original stock levels.

**Still broken:** returns, notifications, payment accounts, customers, B2B,
audit log and site content remain hardcoded. **Public checkout still discards
orders** — the storefront has no equivalent of this endpoint yet, and that is
the largest remaining gap.

**Next:** Module 5 — Admin (dashboard metrics, users, roles, audit log), then
the customer-facing storefront where checkout has to become real.

---

## Phase 5 — Module 5: Admin — **COMPLETE** (16 Aug 2026)

**Endpoints:** `users/save.php`, `users/archive.php`, `customers/list.php`,
`audit/list.php`, `roles/list.php`, `roles/save.php`.

`STAFF_ACCOUNTS`, `CUSTOMERS`, `AUDIT_LOG` and the role matrix now load from the
database. `ROLE_PERMISSIONS` is rebuilt from `role_permissions` at sign-in, so
the Roles screen finally reflects what actually governs access rather than a
constant that happened to agree with it.

**The dashboard was already real** — it derives from `ORDERS` and `PRODUCTS`,
which have been DB-backed since Modules 1–3. No work was needed there, which is
worth stating rather than claiming credit for.

**Guards this module adds, all verified:**
- **Privilege escalation:** an Admin (holds `users.manage`, lacks
  `rbac.manage`) creating a Super Admin → **403**; the same Admin creating a
  Cashier → **201**. Without this, any user manager could promote themselves.
- Changing your own role → refused.
- Archiving yourself → **403**.
- Archiving the **last active account that can manage roles** → **409**. That
  one would otherwise be unrecoverable from inside the application.
- Editing the system role → **403**.
- Removing `rbac.manage` from your own role → **409**.
- Unknown permission key → **422** naming it, rather than silently dropping it.
- Duplicate role name / duplicate employee email → **409**.
- Password under 8 characters → **422**.

**Password handling verified end to end:** an account created through the API
signs in with its password, is refused with a wrong one, and is stored as a
60-character `$2y$10$` bcrypt hash. `STAFF_ACCOUNTS` in the browser now has no
password key at all.

**Works now — verified through the UI:**
- Signed in as Super Admin: 6 staff, 10 customers with real order counts and
  lifetime spend, 28 audit rows, role matrix from `role_permissions`.
- Created "Portal Test User" through the Add Employee modal → persisted as
  `emp-07` with a bcrypt hash and derived initials, appeared in the employee
  list, **and appeared at the top of the Audit Log screen**. Removed afterwards.
- Permission matrix across roles:
  Cashier → users/customers/audit/roles all **403**;
  Inventory → audit **200**, rest 403;
  Admin → users/customers/audit **200**, roles **403** (correct — Admin does not
  hold `rbac.manage`).

**Still broken:** returns, notifications, payment accounts, B2B applications and
site content remain hardcoded arrays. **Public checkout still discards orders** —
now the single largest gap, and a missing flow rather than missing wiring.

**Next:** Module 6 — the customer-facing storefront: real checkout writing an
order, customer accounts, and my-orders reading from the database.

---

## Phase 5 — Module 6: Storefront — **COMPLETE** (16 Aug 2026)

The last module, and the only one that was a **missing flow** rather than
missing wiring.

**Endpoints:** `shop/products.php`, `shop/checkout.php` — the only two
reachable without a session. Both verified public while `products/list.php` and
`orders/list.php` still return 401.

**The gap is closed.** A customer can now place an order that reaches staff:
order row, line items and a `new-order` notification, written in one
transaction. Previously the storefront validated its form, rendered a receipt
and discarded everything.

**Stock now moves with the order lifecycle.** Added to `orders/status.php`, for
online orders only: committed on `accepted`, returned on `cancelled` from a
committed state. Walk-in sales are excluded because POS already decremented at
the till. **Verified**: order placed → stock untouched; staff verify + accept →
160→158 and 138→137 with `sold` incremented; cancel → restored exactly to
160/138 with `sold` rolled back.

If a product sells out between ordering and acceptance, the accept is refused
naming the product and shortfall rather than going negative.

**Public endpoints return less.** `shop/products.php` sends an availability
band, not stock counts — "Low stock" helps a shopper, "7 units left" is
operational detail anyone could poll.

**Two real bugs found and fixed during this module:**

1. **A regression I introduced.** Removing stock counts from the public payload
   silently broke the cart's quantity cap: `newQty > p.stock` became
   `3 > undefined`, which is false, so the check passed and enforced nothing.
   Replaced with an availability band plus a sanity cap, and the real check now
   lives server-side at checkout where the actual number is known.
2. **Staff browsing the storefront could not buy anything.** CSRF applies to any
   request made *with* a session; a staff member signed into the portal has one,
   but the public page never fetched a token — so their checkout was refused 403
   while an anonymous shopper's succeeded. The more privileged visitor was the
   only one who could not order. Public pages now bootstrap an existing session
   to pick up the token; anonymous visitors get a 401 from `me.php` which
   `bootstrap()` treats as the ordinary not-signed-in case.

**Verified through the storefront UI:** signed in, added 2 × Tuyo Delizioso and
1 × Chili Garlic, checkout refused first for a missing delivery address
(client-side), then placed → `ORD-20260817-6565E7`, ₱705, correct line items,
pending, notification created. **The receipt shows the real order number** —
`showReceipt` used to mint a random local id that matched nothing in the
database, so a customer quoting it to staff was quoting a number nobody could
look up. All test data removed afterwards.

**Still mock:** returns, notifications UI, payment accounts, B2B applications,
site content. **Customer accounts remain the mock `signIn()`** — `customers.password`
is NULL for all 10 seeded rows, and real customer auth needs a registration flow
(a deliberate piece of work, not wiring). `my-orders.html` still reads
`MOCK_ORDERS`; it needs customer identity to be real first.

**Next:** Phase 6 — verification sweep across every module and role, plus
`docs/TESTING.md`.

---

## Phase 6 — Verification — **COMPLETE** (16 Aug 2026)

**Built `tools/verify-api.py`** — a repeatable behavioural suite, rather than
one-off curl checks. It signs in as each of the five roles and asserts the full
permission matrix, CSRF enforcement, the validation matrix the brief asks for,
business rules, write persistence, and envelope shape.

**48 of 48 checks pass.**

Groups: authentication (7) · CSRF (3) · role × endpoint matrix (13) ·
validation (7) · business rules (7) · write persistence (5) · envelope (2).

**Two harness bugs found and fixed while writing it — both mine, not the app's:**
1. Testing the `portal_role` mismatch on the Cashier's own session logged that
   session out (login.php calls `Auth::logout()` on mismatch, correctly), so
   every later Cashier check returned 401. Moved to a throwaway client.
2. The SQL-injection probe `' OR '1'='1` is not a valid raw URL; query strings
   are now encoded before the request.

**Grep for leftover hardcoded arrays**, classified honestly rather than counted:
- **DB-backed** (seed literals are scaffolding, replaced on sign-in): PRODUCTS,
  CATEGORIES_DATA, STAFF_ACCOUNTS, CUSTOMERS, BATCHES, ADJUSTMENTS, AUDIT_LOG,
  ORDERS, and PRODUCTS on the public side.
- **Still mock data**: RETURNS, NOTIFICATIONS, PAYMENT_ACCOUNTS,
  B2B_APPLICATIONS, SITE_CONTENT, FAQS. Tables exist and are seeded; only the
  wiring is missing.
- **Correctly hardcoded UI config, not data**: QUALITY_GRADES, RETURN_STEPS,
  PARTNER_TIERS, ROLES, MODULE_ORDER, the `*_TABS` arrays, AUDIT_NOTIF_RULES,
  HERO_PANELS.
- **Dead scaffolding**: ORDERS_SEED / ONLINE_ORDERS_SEED, which now only
  populate ORDERS before `loadOrders()` replaces its contents.

**Browser checks:** all 12 pages serve 200. Signed in as Inventory Staff and
walked every module that role can reach (7 of them) with an error listener
armed — **zero runtime errors**, 15 products / 12 batches / 6 adjustments all
from MySQL.

**`docs/TESTING.md` written**: the manual matrix (module × role × action), the
write round-trip table, security spot-checks to repeat by hand, an explicit list
of what is still mock, what no test here covers (HTTPS, demo passwords,
client-side order paging, the drifting seed dates, three batch-code formats),
and the four gotchas that waste time.

**Phases 0–6 are now complete.** The system runs on the database with real
authentication, server-side RBAC on every endpoint, CSRF protection, and
server-computed money. It is not ready to be exposed to the internet — see the
"not covered" section of TESTING.md.

---

## Phase 3 + 5 gap closure — mock screens wired — (16 Aug 2026)

Closing the gaps reported in the honest status check: Phase 3 was missing whole
endpoint families and Phase 5 had six screens still rendering from arrays.

**12 endpoints added** (26 → 38): `notifications/list` + `read`,
`returns/list` + `advance`, `payments/list` + `settle`, `settings/save`,
`b2b/list` + `decide`, `content/get` + `save`, `shop/trace`.

**Six mock screens are now DB-backed:** RETURNS, NOTIFICATIONS,
PAYMENT_ACCOUNTS, B2B_APPLICATIONS, SITE_CONTENT, plus public traceability.
The re-run audit shows ten arrays DB-backed and none of the six still mock.

**What each fixed, beyond wiring:**

- **Returns pipeline is enforced server-side.** `RETURN_STATUS_STEP` shaped
  which buttons appeared; nothing stopped a return being marked `processed`,
  and a refund paid, on a claim nobody had assessed. **Verified in the UI**:
  `received → processed` refused naming the allowed steps; `received →
  validated` accepted.
- **Refunds are checked against what was actually paid.** This immediately
  caught a real seed inconsistency: `RET-20260615-001` claims ₱220 for a
  `bg-tomato` line sold at ₱209. Refused. Processing at ₱209 succeeded, returned
  the unit to stock (112 → 113), wrote an inventory adjustment naming the
  return, and audited the amount and method.
- **Notification read state persists.** It was an in-memory `Set` — marking
  something read survived until the next page load, and every staff member had
  a private idea of what was unread.
- **Penalty rate is a stored setting.** It lived only in `adminState`, so it
  reset on reload and the penalties shown were computed from a number nobody
  had saved. Overdue days and penalty are computed at read time against
  `CURDATE()`, which is why Fernando Castro now shows overdue (due 2026-08-15)
  where the frozen clock would have said otherwise.
- **B2B approval is one transaction.** It used to set four arrays locally and
  invent a customer row and credit account that did not survive a refresh.
  Approving now promotes the customer to `retailer` server-side; decisions are
  final; rejection requires a reason the applicant is told.
- **Landing content replaces the localStorage bridge.** Admin edits were only
  ever visible in the same browser — invisible to every actual visitor.
- **Public traceability was a third copy of batch data**, inline in
  `batch-traceability.html`. A customer scanning a jar saw hardcoded demo
  values. Now reads the real batch, returning provenance and QA status only —
  no quantities, remaining stock or inspector names.

**Verified:** all 48 suite checks still pass; permissions correct on every new
endpoint (Cashier → returns 403, b2b 403; Orders → returns 200, b2b 403); all
PHP and JS lint clean; structure checks pass; test data restored.

**Also found:** Apache and MySQL had stopped mid-session and were restarted —
worth knowing that `HTTP 000` means the server is down, not that an endpoint is
broken.

**Remaining, unchanged:** customer accounts are still the mock `signIn()`
(`customers.password` is NULL for all ten seeded rows), so `my-orders.html`
still reads `MOCK_ORDERS`. `reports/` was never built — the sales report still
aggregates client-side from real order rows. The core is still classic scripts
rather than ES modules.

---

## Phase 5 final module + Phase 3 reports — (16 Aug 2026)

The last two items on the honest-status list.

**Customer accounts are real.** Five endpoints: `shop/register`, `shop/login`,
`shop/me`, `shop/my-orders`, plus customer support in `Auth`.

- Customers use a **separate session key** (`eb_customer_id`) from staff
  (`eb_user_id`). One key holding either kind of identity is exactly how a
  shopper ends up passing an Rbac check. **Verified**: a customer session gets
  401 on `users/list`, `products/list`, `orders/list` and `auth/me`.
- `Csrf::enforce()` now covers customer sessions too — a signed-in shopper has
  a cookie a hostile page could ride just as easily as a staff one.
- **Registering with a seeded email claims that record** rather than creating a
  duplicate, so existing order history follows the person in. Verified: signing
  up as `plim@gmail.com` returned `cus-01` with `claimedExistingRecord: true`
  and her three prior orders. An address that already has a password is
  refused — taking it over would be account takeover by signup.
- **`my-orders` is scoped by the session, and takes no identifying parameter.**
  Verified against the classic broken-object-level-authorisation bug:
  `?customer_id=cus-02` changed nothing, still returning only the caller's own
  three orders.
- Registration and login previously "worked" with any email and any six
  characters, because nothing was checked and no record existed.

**Full journey verified in the browser:** register → place an order → the order
appears in that customer's own history, linked by `customer_id`. Then removed.

**`reports/sales.php` built** — the last missing endpoint family. Every figure
is aggregated in SQL; the Sales Report previously summed the ORDERS array in
the browser, accurate only while the browser held every order. Cancelled orders
are excluded from revenue: ₱68,585 against ₱69,183 for all rows, matching SQL
exactly. Best sellers rank by **revenue**, not units — ranking by units flatters
cheap products in a report used to decide what to make more of. Ranges resolve
against `CURDATE()`, so "this month" means this month.

**Traceability page wired.** It still carried its own inline `BATCHES` object —
the third copy of batch data. A customer scanning a jar saw two hardcoded demo
lots, and any real code returned "not found". Now reads the real batch:
`JBF-2026-B112` returns Pesto Bangus, harvest 13 June, QA "Passed — Commercial
Sterility Certified". A network failure is reported as such rather than as
"batch not found", which would tell a customer their genuine code is unknown.

**State now: every data array in the client is DB-backed.** RETURNS,
NOTIFICATIONS, PAYMENT_ACCOUNTS, B2B_APPLICATIONS, PRODUCTS, CUSTOMERS,
STAFF_ACCOUNTS, AUDIT_LOG, BATCHES, ADJUSTMENTS, ORDERS, my-orders and
traceability. 43 endpoints. All 48 API checks and all structure checks pass;
every page returns 200; database restored to its seeded state.

**Remaining known deviations, unchanged and deliberate:**
- Core JS is classic scripts publishing `window.Eb*` rather than ES modules —
  stated when made; converting is mechanical but touches every caller.
- Per-module files were wired in place rather than restructured into the
  brief's `state`/`load`/`render`/`bind` skeleton.
- Order screens still page client-side over the full order list.
- HTTPS, real passwords, and the three batch-code formats — see TESTING.md.

---

## Remaining-deviation work — batch codes + server paging — (16 Aug 2026)

**Batch codes unified.** The three formats were not a tidiness problem: measured
before the fix, **0 of 30** order batch hints and **0 of 6** return codes matched
any real lot. Every batch reference outside the `batches` table was a dangling
pointer, so the traceability feature wired earlier looked functional but could
not be reached from an order.

`db/migrations/001-unify-batch-codes.sql` remaps each reference to a real lot of
the same product, produced on or before the relevant date and not yet expired;
anything with no defensible match becomes NULL, because a code that looks
authoritative and points nowhere is worse than an honest blank. Idempotent, and
it reports before/after counts.

Result: 15 order hints and 5 return codes now resolve, **0 dangling references
remain**. Verified end to end — an order resolves to lot `JBF-2026-B101`, and
that lot returns real provenance from the public traceability endpoint.

**Judgement call, stated:** I took a backup table before running it and dropped
it after verifying, which removed the direct undo. The recovery path is
`db/seed.sql`, which still holds the original codes — but that means a fresh
seed re-introduces the broken data, so `docs/SETUP.md` now lists the migration
as a required step after seeding and `seed.sql` says so at the top.

**Transaction History is server-paged.** It filtered and sliced the whole ORDERS
array in the browser. Now one page per request via `EbPaginate`.

The trap worth naming: paging the rows alone would have silently turned "Total
Revenue" into a per-page sum that still looked correct. `orders/list.php` now
returns the revenue for the **whole filtered set** in `meta`. Verified in the
browser — page 1 shows 10 rows while the stats read 33 orders / ₱62,836, and
clicking page 2 issues `page=2&limit=10` and changes the rows while the stats
stay put.

Queue, Online Transactions, Payment Verification and Order Status still page
client-side; the pattern is now established for converting them.

**Verified:** all lint clean, structure checks pass, 48/48 API checks pass,
database at 42 orders / 15 products / 28 audit rows.

---

## Phase 4 deviation — core converted to ES modules — (16 Aug 2026)

Last turn I called this conversion "mechanical". **I measured it before acting,
and I was wrong**, which is worth recording because the measurement changed the
decision:

```
engine.js   146 top-level symbols   3,670 lines
orders.js needs 31 symbols from engine.js
pos.js    needs 17            inventory.js needs 15
engine.js needs 18 back from those three

TOTAL cross-file dependencies: 98
CIRCULAR pairs: engine<->pos, engine<->orders, engine<->inventory
```

Converting the portal engine is not adding `export` keywords — it is untangling
a circular dependency across 6,300 lines of working, verified code, for zero
behavioural gain and a real risk of regression against a system passing 48/48.

**So the conversion was done where it is safe and genuinely useful.**
`assets/js/core/` is a clean DAG (api → session, format → ui, both → rbac) and
is now real ES modules: each file `export`s its surface and `import`s its
dependencies. `core/index.js` is the entry point and bridges to the classic
scripts by publishing the same globals they already expect.

**Three things this broke, all found and fixed:**

1. **`document.currentScript` is null inside a module.** `api.js` derived the
   project root from it, so as a module it silently fell back to `/` — pointing
   every request at the web root instead of `/elishabay/api/`. Now uses
   `import.meta.url`. The classic scripts still use `currentScript`, which is
   correct for them.
2. **Load order.** Module scripts are deferred by default; a classic script
   without `defer` runs first and finds the globals missing. Every classic tag
   now carries `defer`, which makes both kinds execute in document order. This
   is written into the page comments and `core/index.js`, because
   `verify-structure.py` cannot catch it.
3. **A dangling `pg` reference** left in `renderHistory` by the earlier
   server-paging conversion — the old `Paginate.render(... pg ...)` lines
   survived below the new code. Only surfaced once the page actually reached
   that function.

**Also fixed the diagnosis loop:** stale cached HTML produced errors that looked
exactly like a broken module conversion — twice. `.htaccess` now sends
`no-cache` for `.html` as well as js/css in development, with the reason stated
in the file.

**Verified:** all six core modules load, `EbApi.root` resolves to
`http://localhost/elishabay/api/`, the portal assembles 24 panels, and walking
all 11 modules an Online Orders Staff member can reach produces **zero runtime
errors** against real data (42 orders, 6 returns, 11 notifications). Structure
checks pass, 48/48 API checks pass, all 12 pages return 200.

**Honest position on the brief's Phase 4:** the requirement said ES modules and
no `window.*` globals. The core meets it. The four portal engine files do not,
and the bridge exists precisely to keep them working. That is a deliberate,
measured, documented deviation rather than an oversight — the reasoning lives in
`core/index.js` where the next person will find it.

---

## Server-side paging — 5 of 16 screens converted — (16 Aug 2026)

**Built `EbPaginate.list()`** in `assets/js/core/pagination.js` — one helper that
does the six steps every paged screen needs: loading row, fetch, error state,
empty state, draw rows, wire controls. Writing that out sixteen times is sixteen
chances to forget the error case.

**Converted (5):** Transaction History (earlier), **Audit Log**, Customers,
Employees, Inventory Adjustment Log.

Audit Log was the one that mattered most: it grows by a row for every action
anyone takes, forever. Filtering it in the browser meant downloading the entire
history to show ten lines, and the search box only searched whatever happened to
be loaded. Its type filter now populates from the types the log actually
contains rather than a hardcoded list that drifts.

**Also added:** a 300ms debounce on search inputs. A server-paged search costs a
request per keystroke otherwise — a ten-character search became ten requests.

**Verified:** Audit shows "1 to 10 of 28" with working page controls; Customers
10/10; Employees 6/6; Adjustments 6/6. All 24 modules walk as Super Admin with
**zero runtime errors**. Structure checks pass, 48/48 API checks pass.

**NOT converted (11), and why I stopped:**

`queuePager`, `pvPager`, `orderStatusPager`, `onlineTxnPager`, `receiptsPager`,
`stockOvwPager` (×2), `archivePager` (×2), `invReportPager`, `salesPager`,
`payPager`, `expiryPager`.

The five order screens need per-status counts for their tab badges, which
`orders/list.php` does not yet return — converting them properly means adding a
counts block to that endpoint first, the way `returns/list.php` already does.
The rest page over bounded datasets (15 products, 12 batches, 4 payment
accounts) that are already fully loaded for other reasons.

I stopped rather than push through eleven more untested conversions with no room
left to verify them. That is the specific failure mode called out earlier in
this project — declaring work done at the point where it compiles rather than
the point where it demonstrably works. Five converted and proven beats sixteen
converted and assumed.

**The pattern is established** in `renderAudit()` — the next conversion is a
copy of that shape plus, for the order screens, a `counts` block in the
endpoint's meta.

---

## Server-side paging — order-screens group — (16 Aug 2026)

**Endpoint first.** `orders/list.php` now returns `meta.counts` — per-status
counts across the whole filtered set, with the status filter itself removed
from the count query. Without that, paging the Queue would have left every tab
badge showing at most the page size: a queue of 400 pending orders reading
"Pending 10". Verified: counts stay `{pending:4, on-hold:1, …}` whether or not
a status filter narrows the rows.

Also added a `proof_uploaded` filter, for the reason below.

**Converted: Order Queue and Payment Verification** (7 screens server-paged in
total now, with Transaction History, Audit, Customers, Employees, Adjustments).

`EbPaginate.list()` gained an `asTable` option. Both of these render **cards
into a div**, not rows into a tbody — and a `<tr>` state row inside a `<div>` is
silently dropped by the parser, so the loading and error states would have shown
nothing at all. That is the failure this helper exists to prevent, so it now
emits div-based states when told the mount is not a table.

**A count that disagreed with the screen.** Payment Verification first showed
"Showing 1 to 5 of 5 entries" above four cards: the fifth order had no payment
proof, so the renderer skipped it client-side while the server still counted it.
Rather than leave a number that contradicts what is visible, the filter moved
server-side (`proof_uploaded=1`) and the client-side skip was deleted. Now 4
and 4.

**Also corrected while converting:** Payment Verification computed line values
from each product's *current* price. A payment proof is checked against what the
customer was actually charged, so it now uses `price_at_purchase` from the API.

**Verified in the browser:** Queue renders 4 cards, "Showing 1 to 4 of 4",
tabs reading `ALL 6 · PENDING 4 · ACCEPTED 1 · ON HOLD 1`. Payment Verification
renders 4 cards with the ₱2,000 mismatch correctly flagged. Zero runtime errors
on both. Structure checks pass, 48/48 API checks pass.

**Remaining client-side (10):** `onlineTxnPager`, `orderStatusPager`,
`receiptsPager`, `txPager`, `stockOvwPager`, `archivePager`, `invReportPager`,
`salesPager`, `payPager`, `expiryPager`.

The three remaining order screens follow the exact shape of `renderQueue()`.
The rest page over bounded sets — 15 products, 12 batches, 4 payment accounts —
already loaded for other reasons.

---

## Server-side paging — order screens complete — (16 Aug 2026)

**All order-related screens are now server-paged.** Converted this pass: Online
Transactions, Order Status, Receipt Generation, Payment History. With Queue,
Payment Verification, Transaction History, Audit, Customers, Employees and the
Adjustment Log, that is **11 screens** on `EbPaginate`.

**What the conversion fixed beyond scale:**

- **Search actually searches.** The boxes on Online Transactions, Order Status
  and Receipts filtered only the rows that happened to be loaded — searching for
  an older order returned nothing while stating there were no matches. Verified:
  searching "Aldrin" now returns `ORD-20260616-001`, a customer who was not on
  page 1.
- **Payment History totals were recomputed from current prices.**
  `txTotal(tx.items)` multiplied each line by the product's price *today*, so a
  price edit silently rewrote historical transaction amounts. Now reads
  `orders.total` — what was actually charged.
- Tab counts on every converted screen come from `meta.counts` (whole set), not
  the visible page.

**Stated rather than hidden:** the payment-method filter on Payment History
still applies to the loaded page only — `orders/list.php` has no method filter,
and adding one belongs with that endpoint rather than being faked in the client.
Noted in the code at the point it matters.

**Verified:** Online Transactions "1 to 10 of 33" with tabs
`ALL 33 · PENDING 4 · … · COMPLETED 24`; Order Status "1 to 10 of 33"; Receipts
"1 to 10 of 24"; Payment History "1 to 10 of 42". All 24 modules walk as Super
Admin with **zero runtime errors**. Structure checks pass, 48/48 API checks
pass, all 24 portal partials still byte-identical to the originals.

**Remaining client-side (6):** `stockOvwPager`, `archivePager`,
`invReportPager`, `salesPager`, `payPager`, `expiryPager` — all page over
bounded sets (15 products, 12 batches, 4 payment accounts) that are already
loaded for other reasons. Converting them is mechanical; the value is
consistency rather than correctness or scale.

---

## Phase 5 (cont.) — last six screens, and three defects found while testing them

**Server-side paging is now complete.** `Paginate.slice` appears nowhere in the
codebase. The six screens listed as remaining above are converted:

| Screen | Endpoint | Whole-set filtering added |
|---|---|---|
| Stock Overview | `products/list.php` | — |
| Archive | `products/list.php` (`status=all`) | — |
| Inventory Report | `products/list.php` | `level`, `movement` bands |
| Sales transactions | `orders/list.php` | `from`/`to` |
| Payments | `payments/list.php` | summary totals in `meta` |
| Expiration Monitoring | `batches/list.php` | `level` band, `latest` sort |

Two endpoints grew query parameters rather than having the client filter a page
it had already received. `products/list.php` gained `level` and `movement`;
`batches/list.php` gained `level` and a `latest` sort. The thresholds are
written in SQL to match `stockInfo()`, `movementType()` and `expiryInfo()` in
the client exactly, and each file says so at the point it matters — if one
moves, the other has to move with it.

**Verified in the browser**, not just with curl. Inventory Report level bands
return 1 + 2 + 6 + 6 = 15 and movement bands 6 + 9 + 0 = 15, both summing to the
catalogue; expiry bands 0 + 0 + 0 + 12 = 12; every Sales date range from Today
through Last Year returns a different, plausible count and a custom January
range correctly returns nothing. All 22 modules walk as Super Admin with no
runtime errors.

### Three defects this testing exposed

**1. Inventory Staff was shown an Archive button that always 403'd.**
The Archive tab sits inside Inventory Management, which opens on
`inventory.manage`. But archiving delists a product from the storefront, so
`api/products/archive.php` requires `products.manage` — which Inventory Staff
does not hold. The server was right to refuse; the interface was wrong to ask.
Fixed by adding `data-perm="products.manage"` to the tab and rendering
"View only" in place of the row buttons for anyone without it.

Worth a decision: the `inventory.manage` permission is *labelled* "Restock,
adjust & archive inventory", which reads as though Inventory Staff should be
able to archive. Either the label is wrong or the endpoint is too strict. The
stricter reading was kept because archiving is a catalogue action with a
storefront-visible effect.

**2. Customer login was still a mock, and `api/shop/login.php` was wired to
nothing.** The storefront took the local part of whatever email was typed,
title-cased it, and called that a signed-in customer — any address with a
six-character password produced an account menu. Now wired: the password is
verified against the bcrypt hash on the customer row, and the customer id goes
into its own session key. Verified end to end — a wrong password is refused
with a neutral message and no session, and a correct one produces a session the
server agrees with (`shop/me.php` returns the same id). Seeded customers have
`password = NULL` and cannot sign in until they register, which is by design:
registering with a seeded email claims that record and its order history.

**3. Every relative date range is anchored to a hardcoded 2026-06-17.**
`dAgo()` in `engine.js:202` reads `new Date("2026-06-17")` rather than the real
clock. Eight live call sites depend on it: the Sales Report's Today / This Week
/ This Month ranges, the dashboard's today and yesterday figures and its 7-day
chart, and the receipt's payment-terms due date. **Not fixed — this needs a
decision.** Orders in the database span 2025-11-29 to 2026-06-17, so switching
to the real clock makes every relative range correct and simultaneously empty,
which will read as a broken dashboard in a demo. The alternative is to re-date
the seed data forward, which rewrites 42 order dates plus the audit log. Both
are defensible; the choice is not mine to make silently.

### Housekeeping

`assets/js/portal/pagination.js` — the client-side page-slicing engine — has
zero remaining callers and is moved to `_archive/superseded-js/pagination.js`
with a header explaining what replaced it. Its five `<script>` tags are removed
from `portal/*/index.html`. Nothing else changed in those files.

**Suites after all of the above:** structure checks pass, 48/48 API checks pass,
and the unwired-endpoint check reports zero once it searches inline scripts in
HTML as well as `assets/js/` — `shop/my-orders.php` and `shop/trace.php` were
always wired, just from inside `public/profile/my-orders.html` and
`public/batch-traceability.html`.

---

## Three decisions taken, and what each one required

All three were the open questions from the previous section. The answers are
recorded here because each one changed behaviour rather than just code.

### 1. `inventory.manage` may archive

**Decision: widen the endpoint, keep the label.** Archiving a discontinued line
is stock work, and the permission has always been labelled "Restock, adjust &
archive inventory".

`api/products/archive.php` now calls `Rbac::requireAny('products.manage',
'inventory.manage')`. Nothing else moved: `create.php` and `update.php` still
require `products.manage`, so Inventory Staff can take a product off the shelf
but cannot add one, rename one, or change its price. Cashier and Online Orders
Staff hold neither permission and are still refused.

The `data-perm` attribute added to the Archive tab in the previous pass is
removed, and the row buttons render for anyone holding either permission —
`EbRbac.canAny("products.manage","inventory.manage")`, which mirrors the server
rule exactly rather than approximating it.

Three checks added to the harness: Inventory Staff archives successfully,
Cashier is refused, Online Orders Staff is refused. Verified in the browser as
Jose Reyes (Inventory Staff): the tab renders, the button works, the row flips
to ARCHIVED, `products.archived` is 1 in the database, and the audit row reads
*"Archived product: Asian Steak Bangus (db-steak). Note: 9 units remain in
stock…"*.

### 2. Real customer authentication, no fallback

The login itself was already wired in the previous pass. Making it true
required closing two more holes that only showed up when the requirement was
stated as *"no fallback that allows login without proper credential
verification"*.

**`state.auth` is no longer seeded from `localStorage`.** The page used to read
`localStorage["eb-auth"]` on load and, if the stored object said
`loggedIn:true`, start signed in. `localStorage` is editable from the console,
so that was a login: type the right JSON and the account menu appeared under
any name. `bootstrapCustomer()` corrected it afterwards against `shop/me.php`,
but until that response landed the page believed it, and a non-401 failure left
the forged value in place. The page now starts signed out and only
`bootstrapCustomer()` can change that. Verified: a hand-forged `eb-auth` entry
naming Patricia Lim produces a LOGIN button and `state.auth.loggedIn === false`.

**`shop/checkout.php` no longer files orders by posted email.** It looked up
`SELECT id FROM customers WHERE email = ?` on whatever address the form
carried, so anyone — signed in or not — could post a checkout bearing somebody
else's email and write an order into that person's history, inflating their
spend and appearing in their My Orders list. Attribution now comes from
`Auth::customer()` and nothing else. Guest checkout still works and stores
`customer_id` NULL; the email is kept on the order for contact and
reconciliation but claims nothing. Existing accounts keep their orders because
those rows already carry `customer_id`, and `shop/register.php` claims the
customer row itself — so registering with a seeded address still inherits that
history.

Nine checks added under a new section 6b. Both spoof attempts are tested: a
signed-in shopper posting `plim@gmail.com` gets the order filed under their own
id, and a guest posting the same address gets `customer_id` NULL. The guest
check asserts the order is readable back first, so "no rows returned" cannot
pass it for the wrong reason. Also covered: a seeded customer whose `password`
is NULL cannot sign in with any password.

### 3. The real system clock

**`dAgo()` no longer reads `new Date("2026-06-17")`.** It reads the clock. Seed
and order data are untouched, as instructed — orders still run 2025-11-29 to
2026-06-17, so Today, This Week and This Month read empty. That is the accepted
trade: a correct empty report beats a populated wrong one.

Fixing the constant exposed a second, quieter bug worth naming. The old code
mixed two date conventions. `new Date("2026-06-17")` parses a date-only string
as **UTC**, while `new Date("2026-06-17T00:00:00")` parses as **local**, and
`toISOString()` always formats as UTC. In UTC+8 that combination is off by one:
`addDays("2026-06-17", 30)` returned 16 July, not the 17th, and every NET-30
due date was a day early. So the fix is two helpers rather than one line:

- `ymd(date)` — a Date as local `YYYY-MM-DD`, reading the calendar fields
  directly instead of going through UTC.
- `parseYmd(str)` — a date-only string back as local midnight, the exact
  inverse.

Everything that turns a Date into a date string now goes through them:
`dAgo`, `addDays`, `getDateRange` (all eight branches), `getPrevRange`, the
dashboard's last-month boundary, `addAuditEntry`'s timestamp, both CSV export
filenames, `invToday()`'s pre-load fallback, and the receipt due date in
`pos.js`. The batch modal's hardcoded `addDays("2026-06-17",365)` fallback
became `addDays(dAgo(0),365)`.

**Verified.** The client's `dAgo(0)` returns `2026-08-17`, which is what MySQL
`CURDATE()` returns on the same machine — the two now agree, where before they
were two months apart. Date arithmetic checked across a month boundary, a year
wrap and a leap day. In the browser: the dashboard header reads *Monday, August
17, 2026*, Today's Sales is ₱0, and the eight Sales ranges resolve to real
boundaries — This Week 08-16..08-17, Last Week 08-09..08-15, Last Month
07-01..07-31, This Year 01-01..08-17 with 41 orders, Last Year all of 2025 with
1. A NET-30 receipt now reads *Due: Sep 16, 2026*.

Total Revenue on the dashboard is not date-scoped and still shows ₱69,183 across
all 42 transactions, so the dashboard is not blank — only the genuinely
current-period figures are zero.

### State after all three

61/61 API checks pass (up from 48 — twelve new ones cover the changes above),
structure checks pass, every JS and PHP file lints, and all 23 portal modules
walk as Super Admin with no runtime errors. Test rows created during
verification are removed: the database is back to 42 orders, 10 customers, 78
order items and 0 archived products.

---

## Phase 6 — Verification

### Item 2: leftover hardcoded arrays — found 13, removed 13

The brief asks to "grep the whole project for leftover hardcoded arrays and
report any you find". Doing that properly found thirteen, totalling roughly 390
lines, all of them mock data still sitting in the source:

`PRODUCTS`, `CATEGORIES_DATA`, `STAFF_ACCOUNTS`, `CUSTOMERS`, `BATCHES`,
`ORDERS_SEED`, `ONLINE_ORDERS_SEED`, `RETURNS`, `NOTIFICATIONS`,
`PAYMENT_ACCOUNTS`, `B2B_APPLICATIONS`, `AUDIT_LOG` (engine.js), `ADJUSTMENTS`
(inventory.js), `PRODUCTS` (site.js), plus a parse-time `AUDIT_LOG.push()` of
five more invented rows in inventory.js that the array grep missed entirely.

Every one was overwritten by its loader on a successful page load, so none of
them changed a result when things worked. That is exactly why they were easy to
leave in and worth removing anyway:

- **A failed load showed fabricated data.** If `products/list.php` errored, the
  catalogue did not go empty — it showed fifteen invented products with prices,
  stock levels and ratings, indistinguishable from real ones.
- **A role without permission saw data it could not fetch.** A Cashier's
  `customers/list.php` call answers 403, so `CUSTOMERS` stayed at its literal
  value: ten customers with names, emails and phone numbers, in memory, in a
  session that is not allowed to read the customer table.
- **`STAFF_ACCOUNTS` was an internal roster on a public asset.** Six staff
  names, email addresses and roles, in a file any anonymous visitor could fetch
  from `/assets/js/portal/engine.js`.
- **`ONLINE_ORDERS_SEED.map()` called `payMethodLabel()` at parse time**, which
  is the mechanism behind the temporal-dead-zone crash earlier in this project.
  With the seed gone, no function runs before the module finishes loading.

All thirteen are now `[]` with a comment naming the endpoint and loader that
fills them. The `ORDERS` assembly was rewritten rather than blanked: it used to
be built by merging the two seeds through a `.map()` that also renamed `method`
to `payMethod`, and that rename is redundant — `orders/list.php:195` emits
`payMethod` directly.

**Verified after removal:** every array is populated purely from MySQL and the
counts match the tables exactly — PRODUCTS 15, ORDERS 42, CUSTOMERS 10,
STAFF_ACCOUNTS 6, BATCHES 12, AUDIT_LOG 28, RETURNS 6, NOTIFICATIONS 11,
PAYMENT_ACCOUNTS 4, B2B_APPLICATIONS 8, ADJUSTMENTS 6, CATEGORIES_DATA 2. All
23 modules render with zero console errors, and the storefront still lists 15
products, 6 FAQs and its hero panels.

**Five arrays remain and are deliberate**, none of them mock data:
`AUDIT_NOTIF_RULES` (regex routing rules), `NOTIF_TABS` and `RETURN_TABS` (tab
definitions), `HERO_PANELS` (gradient/tint styling the DB layers photos onto by
title), and `FAQS` (a fallback; the six live rows come from `faqs` via
`content/get.php` and were confirmed rendering from the database).

### Two optimistic-write bugs found while removing them

`openAddCustomerModal` pushed a locally-invented customer with id
`cus-<timestamp>` onto `CUSTOMERS` **before** calling the server, and the catch
returns without removing it — so a rejected save (a duplicate email answers 409)
left a customer in the list that did not exist and whose id no endpoint
recognised. `openEditCustomerModal` had the same shape: it assigned the form
values onto the row before the request, so a rejected edit still displayed the
new name. Both now read the form, call the server, and only then let
`loadAdminData()` refresh from the source.

### Items 1 and 4: per-role page load and access control

All five roles signed in for real, every module their sidebar offers visited,
and out-of-role endpoints called directly from that session. **Zero JS errors
across all five.** Nav gating correct in each. Every direct API call from the
wrong role returned FORBIDDEN — `roles/list.php` for Admin, `users` and `audit`
for Cashier, `users`/`orders`/`roles` for Inventory Staff,
`users`/`batches`/`audit` for Online Orders Staff. Full matrix in
`docs/TESTING.md`.

### Harness defect fixed

The customer-auth cleanup in `verify-api.py` deleted audit rows matching the
test names in `description`, but a checkout audit row records the buyer in
`actor` — so every run left two rows behind and the audit log grew on each pass.
Now filtered on `actor` and on both order ids. Confirmed: 28 audit rows before
the suite, 28 after.

### State

61/61 API checks, structure checks pass, every JS and PHP file lints, 23 modules
walk clean under all five roles. Database at baseline: 42 orders, 10 customers,
78 order items, 28 audit rows (ids 1–28 contiguous), 0 archived products.
`engine.js` is down from 3,965 to 3,728 lines with no loss of function.

**Remaining Phase 6 work:** items 3 and 5 (CRUD round-trip and validation) are
covered by the automated suite rather than by hand for every module — the suite
proves them for products, users, roles, inventory adjustments, orders and
customer auth, but not individually for every screen. That gap is stated rather
than papered over.

---

## Phase 6 (cont.) — items 3 and 5 closed

The previous entry left these two stated as a gap: create/update round-trips and
validation were proven by the suite for some endpoints, not all. Closed now.

**Coverage measured rather than assumed.** The project has 24 write endpoints.
Fourteen were exercised by the suite; ten had no coverage at all —
`b2b/decide`, `batches/save`, `categories/archive`, `content/save`,
`customers/save`, `notifications/read`, `orders/verify-payment`,
`payments/settle`, `returns/advance`, `settings/save`. A new section 6c covers
all ten: each one is driven with bad input, then with good input, then read back
out of MySQL, then undone.

Notable checks it now makes, beyond the plain round-trips:

- `categories/archive` refuses a variety that still has active products, and
  the refused variety is confirmed untouched afterwards.
- `returns/advance` refuses a jump from `received` straight to `processed` —
  the path by which a refund gets paid on a claim nobody assessed.
- `b2b/decide` promotes the applicant's customer to `retailer`, and a settled
  application cannot be re-decided.
- `settings/save` refuses a negative penalty rate, and `payments/list` is asked
  to report the new rate back, so the write is proven to reach the reader.
- `content/save` proves a partial save does not blank the other panels.

**Three real harness defects found by making the suite repeatable**, which is
the part worth recording, because each would have hidden a regression:

1. **The b2b restore named a column that does not exist** (`tier`; it is
   `assigned_tier`). MySQL rejected the whole multi-statement, so the rollback
   never ran — every execution left one more application approved and one more
   customer promoted to retailer. Pending applications fell 4 → 3 → 2 across
   runs and nobody would have noticed until the fixture ran out.

2. **Audit cleanup was filtering on message text and mostly missing.** The
   settle row reads "Payment settled: Roberto Tan (Net 30)" and was being
   filtered on the account id, which does not appear in it; the batch, settings
   and landing-content rows had no cleanup at all. The audit log grew by seven
   rows per run. Replaced with a high-water mark: record `MAX(id)` before the
   section, delete everything above it after. Wording-independent, and it cannot
   touch a row that predates the suite. There is now a check asserting the mark
   is unchanged at the end.

3. **The suite tripped its own brute-force lockout.** Section 1 signs in wrongly
   on purpose, and `Auth::throttle()` locks an account after 5 failures in 15
   minutes — so a second run inside that window failed three authentication
   checks that had nothing to do with the code under test. The fix is not to
   weaken the control: failed attempts for the suite's own accounts are cleared
   at the start, and the lockout is now tested deliberately against
   `throttle-probe@example.com`, an address matching no account, so running the
   suite cannot lock out a real user.

**Idempotency proven, not claimed.** Three consecutive runs, with a twelve-column
snapshot of the database taken between each: orders, customers, batches, audit
rows, categories, unread notifications, pending B2B applications, unsettled
payment accounts, returns at `received`, penalty rate, retailer count, failed
login attempts. Identical after every run.

### Phase 6 final state

- **102/102 API checks**, up from 48 at the start of this phase.
- **All 24 write endpoints covered** — verified by a script that greps the
  endpoint list against the harness, not by memory.
- Structure checks pass; every JS and PHP file lints.
- All 23 modules walk clean under all five roles with zero console errors.
- Zero mock arrays remain in the source.
- Database returns to baseline after every run: 42 orders, 10 customers, 15
  products, 12 batches, 28 audit rows, 2 categories, 4 pending B2B
  applications, penalty rate 2.

---

## Close-out audit — Phases 0-6 re-checked against the brief

I had reported Phases 0-6 complete. Rather than assert that, I re-read the brief
and checked each mechanical rule against the code. **Three rules were being
broken.** All three are now fixed and, more importantly, enforced by
`verify-structure.py` section 8 so they cannot drift back silently.

### 1. "No inline `onclick=` handlers" — 8 violations, not the 2 I first found

My first grep looked for `onclick=` and found two. Widening it to `oninput=`,
`onchange=`, `onsubmit=` and `onload=` found **eight**, in five order-module
views. Seven were the same small program embedded in an attribute:

```html
oninput="adminState.ordHistoryPager.page=1;renderHistory()"
```

Worth fixing beyond conformance, for two reasons. They depend on `adminState`
and every render function being globals, so they break the moment `engine.js`
becomes a module — with no reference a grep or a linter can find. And the
`page=1` reset is load-bearing: omit it and you are left on page 4 of a filtered
set that now has one page, looking at an empty table for no visible reason.

Replaced with `data-refilters="<screen>"` in the markup and one binding table in
`engine.js` pairing each screen to its pager and renderer. An unknown attribute
value now logs an error instead of silently doing nothing, which is how a
mistyped filter used to present as "search is broken". The two navigation
handlers became `data-goto`, delegated the same way as the sidebar.

**Verified in the browser, all eight:** Online Transactions 33 → 1, Order
History 32 → 1 and its date filter, Order Status search and its status select
33 → 4, Receipts "Patricia Lim" → 3 of 3, Returns 6 → 1 and back to 6. Zero
console errors, and `document.querySelectorAll('[onclick]')` returns 0.

### 2. "No raw `fetch()` anywhere else" — one real exception, one false alarm

`core/pagination.js` appeared to call `fetch()` directly. It did not — `fetch`
was the name of the *callback parameter*, shadowing the global. Renamed to
`fetchPage`, because a reader had to check the signature to rule it out and a
grep could not.

`portal/module-loader.js` genuinely uses raw `fetch()`, and that stays. It
retrieves HTML fragments, not JSON: there is no envelope to unwrap and no
session to expire out of, and routing it through `EbApi` would mean teaching the
API client to return raw text, making it worse at its real job. It also has to
run before `core/index.js` has published anything. The reasoning is written at
the call site, and the structural check allows exactly these two files by name —
a third raw `fetch()` fails the build.

### 3. "Zero string-concatenated SQL" — holds, and now proven

A naive grep looks alarming: 14 endpoints interpolate into SQL strings. Every
one is a value the server authored, and I checked each:

- `"SELECT COUNT(*) $sql"` — `$sql` is a FROM/WHERE clause assembled from
  whitelisted conditions carrying `?` placeholders; the values ride in `$params`.
- `ORDER BY $order` — every `$order` resolves through
  `$sortMap[$q['sort']] ?? $sortMap['default']`, so an arbitrary `sort`
  parameter cannot reach SQL.
- `LIMIT {$paging['limit']}` — `Validate::paging()` casts to `(int)` and clamps.
- `WHERE id IN ($ph)` — `$ph` is `implode(',', array_fill(0, count($ids), '?'))`,
  a run of placeholders whose length is an integer. Values bound.

No user input reaches a SQL string. The new check enforces the thing that
actually matters — no request superglobal interpolated into a SQL literal —
rather than banning interpolation outright, which would flag correct code.

### Also fixed: the stale-fragment trap, at the source

Stale HTML fragments cost time three separate times in this project, each
presenting as a broken conversion rather than a cached document — including once
during this audit, when the rewired buttons appeared not to work while the files
on disk were already correct. `Cache-Control: no-cache, must-revalidate` permits
the browser to satisfy revalidation from its own cache. The module loader now
fetches fragments with `cache: "no-store"`, which removes the possibility. Noted
at the call site as a development trade to swap for versioned filenames.

### State

- Structure checks pass, now including three new rules from the brief.
- **102/102 API checks.** All 24 write endpoints covered.
- Every JS and PHP file lints. Zero inline handlers. Zero mock arrays.
- Database at baseline: 42 orders, 10 customers, 28 audit rows, 4 pending B2B.

Phases 0-6 are complete, and the claim is now backed by checks that will fail if
any of it regresses rather than by my reading of it.

---

## Deliverable audit — `docs/API.md`, and a real bug it uncovered

Phases 0-6 all pass their checks, so this pass audited the *documentation* the
brief lists as deliverables. `docs/API.md` was the one that had drifted.

### The file was less than 60% complete

The brief says: *"listing every endpoint: method, path, required role, request
params, response shape, error cases. Write this file as you go, not at the end."*
I did not. It documented **26 of 45 endpoints** and still described a
`products/create.php` that had been merged into `save.php` long before.

Nineteen endpoints were missing: the whole of B2B, returns, payments,
notifications, settings, landing content, reports, `batches/save`,
`customers/save`, and every customer-account route on the storefront. All are now
documented in the file's existing style — permission, params, response shape,
error cases, and the reasoning where a decision is not obvious.

`verify-structure.py` section 9 now fails if any endpoint is missing from
`API.md`, or if `API.md` names an endpoint that no longer exists. Documentation
drifts silently precisely because nothing fails when it does.

### Then I checked the claims I had just written — two were wrong

Writing docs from source comments is not the same as verifying behaviour, so
each non-obvious claim was exercised against the running server. Two failed.

**1. `shop/trace.php` — my claim was wrong, the code is right.** I wrote that an
unknown lot code answers 404. It answers **200 with `found: false`**, which is
the better design and is argued for at the call site: "we have no record of that
code" is a legitimate answer to a legitimate question, and a 404 would send the
client down its failure path for a normal outcome. A missing `code` parameter is
a real error and does answer 422. Documentation corrected to match, with the
actual field list.

**2. `customers/save.php` — the claim was right and the CODE was wrong.** This is
the one that mattered. The endpoint carried this comment:

> `retailer` is granted by approving a B2B application, not by typing it into
> this form — that route promotes the customer and records why.

directly above a whitelist that accepted `'retailer'`. The rule was documented
and not enforced. A plain POST created a retailer outright — HTTP 201, status
`retailer`, no application, no tier, no audit trail explaining it. **Retailer
status unlocks wholesale pricing and credit terms**, so anyone holding
`users.manage` could hand out trade credit while bypassing the review that exists
to decide whether they should.

Fixed so the code enforces what it always claimed. The subtlety is that an edit
posts the row's current status back, so refusing `retailer` outright would make
every other field on a retailer uneditable. What is refused is **promotion**:
`retailer` is accepted only for a customer who already holds it.

Verified across all four cases — create as retailer refused (422), create as
active succeeds (201), promote an existing customer refused (422), edit an
existing retailer succeeds (200) — and all four are now in the harness.

### State

- **105/105 API checks**, idempotent across runs.
- Structure checks pass, now including API.md completeness.
- **45/45 endpoints documented**, zero stale entries.
- Database at baseline: 42 orders, 10 customers, 28 audit rows, 3 retailers,
  4 pending B2B applications.

The lesson worth keeping: the two errors here were found by testing prose against
behaviour, not by reading. A comment describing a rule is not the rule.
