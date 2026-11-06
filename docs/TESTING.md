# Testing — Elisha Bay

Two automated suites plus a manual matrix. Run both suites after any change;
anything green that turns red is a regression.

---

## Automated

### Structure — `tools/verify-structure.py`

Reads files only. No server needed.

```bash
python tools/verify-structure.py .
```

Checks the shell and 24 partials assemble, no duplicate or colliding ids, every
`data-mod` pairs with an `id="mod-*"`, every `data-perm` is a real permission,
every permission is used in markup, no identifier collisions between the engine
and the gate files, and the live-reload injection safety rule (see §Gotchas).

### Behaviour — `tools/verify-api.py`

Drives the live API. **Needs Apache, MySQL and the seeded database.**

```bash
python tools/verify-api.py
```

48 checks across seven groups: authentication, CSRF, the role × endpoint
permission matrix, validation, business rules, write persistence, and envelope
shape. It creates a product and removes it again; if interrupted, rows named
`VERIFY Temp Product` may be left behind.

**Current status: 48/48 passing.**

---

## Manual matrix

The suites cover the API. These are the things only a person at a browser can
confirm.

### Per role — sign in and walk the modules

| Role | Email | Modules that must appear | Must NOT appear |
|---|---|---|---|
| Super Admin | `admin@elishabay.ph` | all 24 | — |
| Admin | `subadmin@elishabay.ph` | all except Roles & Permissions | Roles |
| Cashier | `cashier@elishabay.ph` | Dashboard, Notifications, POS, Payment, Transaction History, Sales, Payment Schemes, Transactions (8 nav items) | Users, Inventory Mgmt, Roles, Orders queue |
| Inventory Staff | `inventory@elishabay.ph` | Dashboard, Notifications, Inventory Report, Inventory Mgmt, Expiry, Batches, Audit (7) | POS, Users, Orders, Roles |
| Online Orders Staff | `orders@elishabay.ph` | Dashboard, Notifications, Queue, Payment Verification, Order Status, History, Receipts, Returns, Online Transactions | POS, Users, Inventory Mgmt, Roles |

For each: **zero console errors**, every list shows database rows (not the seed),
and the nav count matches.

Passwords are in `docs/SETUP.md`.

### Cross-portal

1. Sign in as Cashier, then browse to `/portal/super-admin/` → redirected to the
   storefront, not shown a half-empty sidebar.
2. Sign in at the landing page as each role → lands on that role's portal.
3. Log out from a portal → returns to the storefront, and `api/auth/me.php`
   returns 401 afterwards.

### Write round-trips — perform, **reload the page**, confirm it stuck

| Module | Action | Confirm |
|---|---|---|
| Inventory | Restock a product with a new lot code | Stock rises, batch appears, adjustment logged, audit row names the actor |
| Inventory | Dispose more than exists | Refused, message names the real stock level |
| Products | Add a product | Slug id, opening stock 0, audit names the price |
| Products | Edit the price | Audit shows `₱old → ₱new` |
| Products | Archive a variety with active products | Refused, message names the count |
| POS | Sell 2 items, tender cash | Total and change correct, stock down, `sold` up, receipt matches the database |
| Orders | Accept an unverified order | Refused |
| Orders | Verify payment, then accept | Status moves, history records who, **online orders decrement stock** |
| Orders | Cancel an accepted online order | Stock returns, `sold` rolls back |
| Admin | Add an employee | Signs in with that password; stored as a `$2y$10$` hash |
| Storefront | Place an order | Appears in the staff Order Queue with a notification; receipt shows the real order number |

### Validation — every form

Submit empty · a 300-character name · a negative quantity · a duplicate email or
variety name. Each must fail with a readable message against the right field,
and the form must keep what was typed.

### Security spot-checks

These are the ones worth repeating by hand, because they are the ones that
matter if they ever break:

```bash
# A Cashier session calling an admin endpoint directly — the UI hides the link,
# but that is not what protects it.
curl -b cashier.txt http://localhost/elishabay/api/users/list.php     # expect 403

# A write with no CSRF token
curl -b admin.txt -X POST -d '{}' http://localhost/elishabay/api/products/save.php  # expect 403

# Client-supplied prices are ignored
curl -b cashier.txt -X POST -H "X-CSRF-Token: …" \
  -d '{"items":[{"id":"db-pesto","qty":2,"price":1}],"order_type":"pickup","customer_type":"regular","pay_method":"cash","tendered":1000}' \
  http://localhost/elishabay/api/pos/checkout.php   # charges ₱570, not ₱2
```

Also confirm no staff password appears in anything a browser can fetch:

```bash
grep -r "Admin@123" assets/ public/ portal/     # expect no matches
```

---

## What is still mock

Being explicit so a passing suite is not mistaken for a finished system.

**Nothing in the data layer.** Every client array is now loaded from MySQL:
RETURNS, NOTIFICATIONS, PAYMENT_ACCOUNTS, B2B_APPLICATIONS, PRODUCTS,
CUSTOMERS, STAFF_ACCOUNTS, AUDIT_LOG, BATCHES, ADJUSTMENTS, ORDERS, plus
my-orders and public traceability.

**Customer accounts are real** — registration, login, and an order history
scoped by session. Registering with a seeded customer's email claims that
record so their prior orders follow them in.

**Correctly hardcoded, not mock data:** `QUALITY_GRADES`, `RETURN_STEPS`,
`PARTNER_TIERS`, `ROLES`, `MODULE_ORDER`, the `*_TABS` arrays,
`AUDIT_NOTIF_RULES`, `HERO_PANELS`. These are UI configuration.

**Dead scaffolding:** `ORDERS_SEED` and `ONLINE_ORDERS_SEED` still exist but
only populate `ORDERS`, whose contents are replaced by `loadOrders()` on sign-in.

---

## Not covered by any test here

- **HTTPS.** `cookie_secure` is false because XAMPP serves plain HTTP. Must
  become true before this is hosted anywhere.
- **The seeded passwords are demo passwords.** Change them.
- **Order-screen paging** is still client-side over the full order list. Honest
  at 42 rows, wrong at 10,000.
- **The clock** — inventory now uses the server date, but the seeded dates are
  fixed around 2026-06-17, so relative figures drift as real time passes.
- **Three batch-code formats** still exist in the data (`JBF-2026-B112`,
  `BT-20260617-01`, `BT-20260430-A`) against one `lot_code` column.

---

## Gotchas that will waste your time

**Browser caching.** Editing a `.js` file and testing the previous version is an
easy hour lost. `.htaccess` sends `no-cache` for js/css in development; if you
remove that, hard-reload after every edit.

**The `views/` partials are complete HTML documents on purpose.** Live Server
injects its reload script before `</body>`; a fragment without one gets it
injected inside the logo `<svg>`, which corrupts the parse and boots a blank
portal. `verify-structure.py` check 7 enforces this.

**Toasts auto-dismiss after 3.5 seconds.** Long enough for a person, shorter than
a scripted check between steps — capture them by wrapping `EbUI.toast` rather
than looking for them afterwards.

**A stale staff session redirects you.** Visiting a portal your current role does
not belong to sends you to the storefront. Sign out first when switching roles.

---

## Phase 6 role sweep — recorded results

Run 2026-08-17 against all five roles. Each was signed in for real, its portal
loaded, every module its sidebar offers was visited, and three out-of-role
endpoints were called directly from that session's console.

| Role | Modules visited | JS errors | Nav gating | API refuses out-of-role |
|---|---|---|---|---|
| Super Admin | 23 | 0 | all visible | — (holds everything) |
| Admin | 23 | 0 | Roles hidden | `roles/list.php` → FORBIDDEN |
| Cashier | 7 | 0 | 26 items hidden | `users/list.php`, `audit/list.php` → FORBIDDEN |
| Inventory Staff | 13 | 0 | orders/users hidden | `users/`, `orders/`, `roles/list.php` → FORBIDDEN |
| Online Orders Staff | 11 | 0 | inventory/users hidden | `users/`, `batches/`, `audit/list.php` → FORBIDDEN |

The API column is the one that matters. A hidden sidebar item proves nothing —
each of those calls was made from a signed-in session with the endpoint typed
directly, which is what an attacker would do.

### In-memory arrays per role

Because the seed literals are gone (see PROGRESS.md, Phase 6), the arrays hold
exactly what the signed-in role is allowed to fetch, and nothing otherwise:

| Array | Super Admin | Admin | Cashier | Inventory | Online Orders |
|---|---|---|---|---|---|
| `PRODUCTS` | 15 | 15 | 15 | 15 | 15 |
| `ORDERS` | 42 | 42 | 42 | **0** | 42 |
| `CUSTOMERS` | 10 | 10 | **0** | **0** | **0** |
| `STAFF_ACCOUNTS` | 6 | 6 | **0** | **0** | **0** |
| `AUDIT_LOG` | 28 | 28 | **0** | 28 | **0** |
| `BATCHES` | 12 | 12 | **0** | 12 | **0** |

A bold zero is the correct result: that role's fetch returns 403 and nothing
fills the array. Before Phase 6 those same cells held mock rows — a Cashier's
browser carried ten invented customers and the full staff roster, because the
literals were in the file whether or not the fetch succeeded.

### Manual checks not covered by the suites

- Sign in at the wrong portal (Cashier credentials at `/portal/inventory/`) —
  expect a refusal from `auth/login.php`, not a redirect.
- Storefront: forge `localStorage["eb-auth"]` with `loggedIn:true` and reload —
  expect a LOGIN button.
- POS: take a product to zero stock, then try to sell one more.
- Expiry: dispose from a lot, confirm `batches.remaining_qty` drops in MySQL.

---

## Before you diagnose a broken module: hard-reload first

**Stale HTML fragments cost real time three separate times in this project, and
were twice misdiagnosed as a broken JavaScript conversion.** The symptom is
always the same and always convincing: the code on disk is correct, the browser
runs something else, and the error points at a file you just fixed.

So the first step in diagnosing any "this module is broken" report is not to
read the code. It is:

1. Hard-reload (Ctrl+F5), or add a cache-buster: `?cb=1`.
2. **Verify the served file matches the source file**:

```bash
curl -s http://localhost/elishabay/portal/views/dashboard.html | grep data-goto
```

If the served copy lacks a change that is on disk, you are debugging a cached
document, and nothing you read in the source will explain what you are seeing.

`assets/js/portal/module-loader.js` fetches fragments with `cache: "no-store"`
specifically to make this impossible. `Cache-Control: no-cache,
must-revalidate` from `.htaccess` is *not* sufficient on its own — it permits
the browser to satisfy revalidation from its own cache, which is exactly what
kept happening. Do not remove the `no-store` without replacing it with
versioned filenames.

### A verification trap worth knowing

Installing an error hook after the page has loaded cannot see a parse-time
error:

```js
location.reload();
window.onerror = m => errors.push(m);   // too late — parsing already finished
```

A Phase 2 walk of `portal/admin/` reported **zero JS errors** this way while the
page was in fact throwing `Identifier 'CONFIG' has already been declared` on
every load, from a duplicated `<script>` tag.

`tools/ui-test/` avoids this by loading the portal into an iframe and attaching
its handler to `iframe.contentWindow` **before** the modules run. Use it, or
read the console directly, rather than a hook installed from the page under
test.
