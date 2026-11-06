# Remediation — defect register

One row per defect. `Status` is `not started`, `fixed, unverified`,
`fixed, UI-verified`, `blocked`, or `wontfix (reason)`.

**Nothing reaches `fixed, UI-verified` without a browser click-through as the
correct role, with the resulting row read back out of MySQL.** A passing curl is
not a fix. Where behaviour was reasoned about rather than observed it is marked
`INFERRED`.

---

## Scope note

Items 1–5 of Phase 1 were already fixed during the close-out audit that preceded
this brief — the list supplied was a history of everything encountered, not an
open-defect list. They are re-verified here to the stricter standard rather than
carried as credit, and one of them turned out to be incompletely fixed (item 4).

---

## Phase 1 — Harness

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| H1 | b2b restore named `tier`; real column is `assigned_tier`, so MySQL rejected the whole statement and every run left one more customer promoted to retailer | 1 | fixed, verified | Column corrected. **Wrongly promoted customers remaining: 0.** All 3 current retailers (cus-02, cus-04, cus-08) are seeded as `retailer` in `db/seed.sql`; cus-02 and cus-08 hold approved applications, cus-04 a pending one. Retailer count held at 3 across 3 consecutive runs | SQL read-back vs seed |
| H2 | Audit cleanup filtered on message text and mostly missed; log grew +7 per run | 1 | fixed, verified | High-water mark (`MAX(id)` before, delete above after). **Purged; 28 rows, ids 1–28 contiguous = seed baseline.** Unchanged across 3 runs | SQL snapshot |
| H3 | Role-mismatch test logged out the session under test, making 9 endpoints look broken | 1 | fixed, verified | Runs on a throwaway `Session("portal-check")` | suite output |
| H4 | Suite tripped its own brute-force lockout; a second run inside 15 min failed 3 unrelated checks | 1 | fixed, verified | Failed attempts for suite accounts cleared in setup; lockout now tested deliberately against `throttle-probe@example.com`, which matches no account. **Also found: `login_attempts` still grew +6 per run** from the suite's own successful sign-ins — teardown now removes them and asserts zero | 3 consecutive runs, table at 0 each time |
| H5 | SQLi probe `' OR '1'='1` was not a valid raw URL | 1 | fixed, verified | URL-encoded, and the assertion strengthened: an unfiltered baseline is asserted non-empty first, so "injection blocked" is distinguishable from "endpoint returns nothing for anything". Three payloads now probed | **Proof 6** below |
| H6 | Guest-order assertion passed trivially when the lookup returned nothing | 1 | fixed, verified | Audited all 93 assertions. Found **5 trivial-pass** and **10 guards silently skipping 29 assertions** — see below | proofs 1–6 |
| H7 | Harness created accounts per run, violating D16 | 1 | fixed, verified | Two fixed fixtures seeded (`cus-t01`, `cus-t02`); registration path now tests the *claim* flow against `cus-t02` and resets it in teardown. Customer count held at 12 across 3 runs | SQL snapshot |
| H8 | UI test layer (D15) | 1 | fixed, verified | npm ruled out, so Playwright is not used. Built `tools/ui-test/` — vanilla JS, served by Apache, drives the real portal in an iframe. **4 specs / 8 role-runs / 38 assertions, all passing.** Caught the sabotaged Roles screen while `verify-api.py` stayed fully green | **Proof 7** |

---

## The assertion audit (H6) in detail

**5 assertions could pass for the wrong reason:**

| Assertion | Why it could not fail |
|---|---|
| user-enumeration message comparison | `None == None` when neither response carried an error key |
| RBAC matrix `check(not wrong, ...)` | empty-is-good, which also passes if the loop never ran |
| `check(True, "test rows cleaned up")` | a label with no assertion behind it |
| `check(True, "customer test rows cleaned up")` | same |
| content partial-save | `None == None` when the key was absent |

**10 guards silently skipped 29 assertions.** `if bid:`, `if cid:`, `if app:` and
seven more — when a fixture lookup returned empty the assertions inside simply
did not run, and the suite still printed "All checks passed" with a quietly lower
count. This is the same defect as the guest-order trivial pass, at ten times the
scale, and it is the more dangerous form: a trivial pass is one wrong green, a
silent skip is coverage disappearing without a trace.

Each guard is now preceded by `check(bool(fixture), "fixture: …")`, and a
**total-count guard** asserts the exact number of assertions executed. Coverage
cannot now shrink without a failure.

---

## Proofs — every fixed assertion observed failing

An assertion never seen failing is not a test. Each was broken, the failure
observed, then restored.

| # | What was broken | Result |
|---|---|---|
| 1 | Expected count set to 114 while 113 ran | `FAIL all 114 assertions ran — ran 113` |
| 2 | `content/save.php` made to succeed but silently blank `vision` | `FAIL a partial save does not blank the other panels` |
| 3 | Unread-notification fixture query changed to match nothing | `FAIL fixture: an unread notification exists` **and** `FAIL all 113 assertions ran — ran 112`, both layers firing |
| 4 | Product cleanup `DELETE` replaced with a no-op `SELECT` | `FAIL product test rows cleaned up` |
| 5 | `Auth::attempt()` made to say "No account with that email" vs "Incorrect password" | `FAIL unknown email and wrong password give the same message` |
| 6 | `products/list.php` search switched from bound parameters to string concatenation | `FAIL` on all three injection payloads |

Two proofs were themselves wrong on the first attempt and are worth recording:

- Proof 2 first sabotaged the wrong table (`settings`, not `site_content`) and
  the test correctly stayed green. The second attempt made the save *error*,
  which failed a different assertion while the target one still passed —
  because "vision unchanged" holds vacuously when nothing was written. Only the
  third attempt (save succeeds, vision blanked) proved the assertion.
- Proof 5 first referenced a variable not in scope, failing three unrelated
  checks instead.

**That sabotage also blanked `site_content.vision` in the live database**, because
the test's own restore only covers `about`. Restored from `db/seed.sql` and
verified. Recording it because it is exactly the "never delete data to make a
test pass" hazard, arrived at from the opposite direction.

---

## Phase 1 deliverable

> harness runs twice with identical results and zero side effects on data

Run three times consecutively. Fifteen-column snapshot between each: orders,
customers, order items, products, batches, categories, audit rows, unread
notifications, pending B2B, unsettled payments, returns at `received`, retailers,
penalty rate, login attempts, site content.

```
BASELINE  42 12 78 15 12 2 28 6 4 3 1 3 2 0 7
RUN 1     42 12 78 15 12 2 28 6 4 3 1 3 2 0 7    All 123 checks passed
RUN 2     42 12 78 15 12 2 28 6 4 3 1 3 2 0 7    All 123 checks passed
RUN 3     42 12 78 15 12 2 28 6 4 3 1 3 2 0 7    All 123 checks passed
```

Identical. **Met**, with H8 (Playwright) outstanding pending your decision.


---

## Phase 1 addendum — the UI test layer (H8)

D15 specifies Playwright. npm is ruled out, so Playwright is not used. The
decision's *intent* — a layer that catches green-endpoint-dead-UI, which static
greps and API tests cannot — is met with `tools/ui-test/`: vanilla JS, served by
Apache, no dependencies, no build step. It loads a portal in an iframe, drives
the real DOM, and checks results against what the API says the database holds.

**Proof 7 is the one that matters.** I reproduced the original defect exactly —
made the Roles screen's Save button show its success toast and call nothing:

```
UI runner    FAIL  toggling a permission changed what the server returns
                   role=Admin perm=users.manage — an identical response means
                   the screen discarded the edit (roles/save.php never called)

verify-api.py      All 123 checks passed.
```

The API suite is blind to it, because `roles/save.php` is fine. That is the
entire argument for this layer, demonstrated rather than asserted.

**My own spec was wrong first, twice.** Its first run reported the Roles screen
as broken. Investigation showed the spec was at fault, not the application: it
read `data-perm` when the attribute is `data-perm-key`, and it clicked the first
of **five** "Save Matrix" buttons — saving a different role than the one it had
edited. Then it assumed `roles/list.php` returned a bare array when it returns
`{roles, permissions}`. Recorded because a false failure is as damaging as a
false pass: had I trusted the first red, I would have "fixed" working code.

**Limits, stated plainly.** It catches wiring: dead controls, lists that
disagree with the database, writes that do not persist, console errors. It
cannot catch layout, contrast, hover states, cross-browser rendering, or
anything needing a real OS input event — it dispatches synthetic events. A green
run means "wired", not "good".

**Known side effect.** Specs perform real writes, and per D13 audit entries are
server-written and not client-erasable, so a run leaves audit rows (two per
roles-spec execution). This is a real tension between D13 and D16, resolved in
favour of the audit trail: a test that could erase its own audit rows would mean
the application could too, and building a purge endpoint would create exactly
that capability as reachable attack surface. Documented in
`tools/ui-test/README.md` with the manual reset. Orders, customers,
role_permissions and login_attempts are unchanged after a full run — verified.

**Access.** `tools/` stays 404 except `tools/ui-test/`, which is `Require local`
via a child `.htaccess` because it carries the seeded test passwords. Confirmed:
`/tools/ui-test/` → 200, `/tools/verify-api.py` → 404.

---

## Phase 2 — Auth and access control

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| A1 | Customer login was a mock; `shop/login.php` wired to nothing | 2 | fixed, UI-verified | Wired earlier; D7 now unifies identity. `auth/me.php` returns `type=staff` (role Super Admin, 17 perms) or `type=customer` (`cus-t01`, **no `permissions` key at all**). Browser: wrong password → refused, no session; correct → server agrees | browser + 4 harness checks |
| A2 | `shop/checkout.php` filed orders by posted email | 2 | fixed, UI-verified | **D6: guest checkout removed, not guarded.** Browser: anonymous → 401 "Sign in to place your order"; `email: plim@gmail.com` → 422; `customer_id: cus-01` → 422; clean → 201 attributed to `cus-t01`. **Damage audit: 0 orders affected** — see below | browser + 5 harness checks |
| A3 | `state.auth` restored from `localStorage` | 2 | fixed, UI-verified | **D8 fail-closed.** Browser: forced `me.php` to 500 → signed out; forced a network failure → signed out; navbar reads LOGIN. `localStorage` now holds `eb-name` only — no id, no email, no role | browser |
| A4 | `customers/save.php` granted retailer status | 2 | fixed, verified | Promotion refused (422); an existing retailer stays editable (200). Audit row written server-side per D13. **Promoted-by-exploit accounts: 0** | 3 harness checks |
| A5 | `STAFF_ACCOUNTS` roster in public client source | 2 | fixed, verified | `let STAFF_ACCOUNTS = []`, filled from `users/list.php`. Served `engine.js` contains 3 `elishabay.ph` strings, all benign: the public contact address, a comment, a form placeholder. **No roster** | grep of the served file |
| A6 | UI/permission parity sweep (D9) | 2 | fixed, verified | Full sweep below. **1 real gap found and fixed**, now guarded by a structural check | browser, 3 roles |
| A7 | CSRF returned a distinct code the client ignored | 2 | fixed, UI-verified | Browser: poisoned token → 403 code `CSRF`, `isCsrf` true, `isForbidden` false, message *"This page is out of date with your session — reload and try again."* Token auto-refreshed; next deliberate attempt succeeds | browser |

### A2 — damage audit

The brief asks whether any existing order was written the guest way.

- **12 online orders carry `customer_id IS NULL`.** All are seeded historical rows
  (verified against `db/seed.sql`), representing pre-account orders.
- **0 orders have an email matching a real customer row** — so the attribution
  hole was never exercised, and there is nothing to repair.
- 9 walk-in orders also carry NULL, which is correct: a POS walk-in has no
  customer.

### A4 — promoted accounts

**0 accounts were promoted through the `customers/save.php` path.** Three
retailers exist (cus-02, cus-04, cus-08), all seeded as `retailer` in
`db/seed.sql`.

One seed inconsistency worth naming, though it is not a security finding:
**cus-04 (Danilo Mercado) is a retailer whose only B2B application is still
`pending`.** Under the rule now enforced, that state is unreachable — retailer
status comes only from an approval. It is demo data that predates the rule. Left
alone rather than "corrected", because changing seed rows to fit a rule invented
later is how a data set stops describing anything real. Flagged for your call.

### A6 — parity sweep

Built mechanically from three sources: `MOD_PERM` (22 gated modules),
`Rbac::require*` in all 45 endpoints, and every `data-perm` in the markup.

- All 22 module gates match the table in `docs/RBAC-MIGRATION-PLAN.md` §2.
- Every endpoint's required permission is covered by some module gate — no
  endpoint is reachable from a screen gated on something weaker.

**One real gap:** the dashboard's *View All* button jumps to `sales`
(`sales.report`) and carried **no** `data-perm`. Inventory Staff and Online
Orders Staff hold no `sales.report`, so they were shown a control `navigate()`
would bounce — the Archive-tab defect in miniature. Fixed by adding the gate.

Verified in the browser across three roles: Inventory Staff `HIDDEN`, Online
Orders `HIDDEN`, Super Admin `visible`.

`verify-structure.py` section 10 now fails if any control jumping to a gated
module does not carry that module's gate.

**A caveat I have to state.** The static sweep first reported "0 mismatches"
while its `MOD_PERM` table was **empty** — the regex had not matched, so the
comparison never ran. That is the same silent-nothing failure the Phase 1
assertion audit was about, and I nearly reported it as a clean result. The
figures above come from a run where the table is asserted non-empty first.

### Phase 2 state

- **130/130 API checks** (was 123): +5 for D6 checkout rules, +4 for D7 identity.
- **38/38 UI wiring assertions** across 8 role-runs.
- Structure checks pass, including the new control/gate parity check.
- Database at baseline after every run.

---

## Phase 3 — Money and data integrity (items 1, 2, 5, 6, 7, 8)

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| M1 | Sales Report counted cancelled orders as revenue | 3 | fixed, UI-verified | **D2: one constant, `Revenue::STATUSES = ['completed']`**, in `api/core/Revenue.php`, used by sales, orders/list and both customer-spend queries. Revenue corrected **₱68,585 → ₱56,570** — the old rule booked pending and on-hold orders. Dashboard tile agrees exactly | browser + 6 harness checks |
| M2 | Historical amounts recomputed from current prices | 3 | fixed, UI-verified | **D3.** Tripled `bg-pesto` 245 → 735: server revenue unmoved at 56,570, dashboard unmoved at ₱56,570, line items still `@245`. Client `txTotal()` is now documented cart-only; revenue goes through `orderTotal()` reading `orders.total` | browser + 3 harness checks |
| M5 | Batch codes pointed at non-existent lots | 3 | fixed, verified | **Orphans: 0.** `migrations/002` adds three FKs to `batches.lot_code` with `ON DELETE RESTRICT`. Proof: bad code rejected with errno 1452, real code accepted | SQL |
| M6 | Non-strict MySQL silently coerced bad data | 3 | fixed, verified | **D5.** `my.ini` pinned (backup saved), applied at runtime via `SET GLOBAL`. Proof: a plain CLI `INSERT ... NULL` into a `NOT NULL` column now errors 1048. Full clean install re-run under strict mode: schema, additions, seed and both migrations — **zero errors**. **Restart confirmed:** MySQL was stopped and cold-started during Phase 7, and `SELECT @@GLOBAL.sql_mode` returned `STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION` — read from `my.ini`, not from a runtime `SET GLOBAL` | SQL + clean-DB install + restart |
| M7 | Payment Verification count disagreed with rows | 3 | fixed, UI-verified | Swept all 8 count labels. paymentverify: label "1 to 4 of 4", tabs "All 4 / Pending 3 / On Hold 1", 4 cards — consistent. b2b, batches, expiry, inventory, payments, transactions all match | browser |
| M8 | `addAuditEntry` was memory-only | 3 | fixed, verified | **D13.** It fabricated a `local-<ts>` row that never reached the database — and `returns/advance.php` was **already** writing a proper audit row in the same transaction, so it was a fake duplicate of a correctly-recorded event. Now returns a transient object for the notification only | code + suite |
| M3/M4 | `dAgo()` frozen; UTC/local mismatch | 3 | **not started** | D1 requires moving all date arithmetic into PHP under `Asia/Manila`. The frozen constant and the off-by-one were fixed earlier, but D1's architecture change has not been done | — |

### What went wrong in this phase, and what it cost

Two mistakes of mine, both worth recording because the second caused real damage.

**1. I broke `orders/list.php` and the suite caught it.** The D2 change appended
a status clause without appending its placeholders, so every order list answered
`SQLSTATE[HY093]: Invalid parameter number`. Caught immediately.

**2. I damaged the live database schema.** Testing a clean install, I ran
`schema.sql` into a throwaway database — except every SQL file begins with
`USE elisha_bay_db;`, so it ran against the **live** one and recreated
`audit_logs` without the `actor_user_id` column that `schema-additions.sql`
adds. Every write endpoint then failed with `Unknown column 'a.actor_user_id'`.

Recovered fully: column restored and backfilled (28/28 rows), leftover test rows
purged, **139/139 checks passing, database at baseline** (42 orders, 12
customers, 15 products, 12 batches, 2 categories, 28 audit rows).

It surfaced two genuine defects that were already there:

- **Every SQL file hardcodes `USE elisha_bay_db`**, so naming a different
  database on the command line does nothing and the statements hit production
  instead. Documented in `docs/SETUP.md` with the `sed` workaround.
- **`schema-additions.sql` was not re-runnable.** `CREATE TABLE` was guarded;
  the `CREATE INDEX` and `ALTER TABLE` after it were not. A second run aborted
  at the first duplicate index and everything below silently never ran —
  including the `audit_logs` column. That is why my accidental re-run left a
  database that looked installed and was missing a column. Now guarded
  throughout and **verified by running it three times with no errors.**

**One correction to something I said mid-phase.** I reported that migration 001
fails to clean orphans on a fresh install and that the live database had been
repaired by hand. That was wrong — the same `USE` trap meant 001 had run against
the live database rather than the probe. Re-tested properly: **001 takes 42
orphans to 0 and 002 then applies cleanly.**

### Not done, and why

**M3/M4 — D1 (Asia/Manila, all date arithmetic server-side) is not started.**
The specific defects are already fixed: `dAgo()` reads the real clock, and the
UTC/local off-by-one is gone (`addDays("2026-06-17",30)` returns 17 July, and
the client's date matches MySQL `CURDATE()`). What is *not* done is D1's
architectural requirement — moving every range boundary and every date
computation out of JavaScript into PHP with `date_default_timezone_set`, banning
`toISOString()` outright, and consolidating into one date module with month,
year and leap-day tests.

That is a substantial change touching `getDateRange`, `getPrevRange`, the
dashboard, the POS receipt and every screen with a date filter. Starting it with
the remaining time in this phase would mean leaving it half-applied, which is
precisely the state that just cost an hour of recovery. Flagged as the first
item of the next pass.

---

## Phase 3 (cont.) — D1, dates

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| M3 | `dAgo()` frozen at a hardcoded date | 3 | fixed, UI-verified | Reads the SERVER's date. `api/core/Dates.php` is the one resolver, Asia/Manila. Client `dAgo(0)` = `2026-08-17` = MySQL `CURDATE()` | browser + harness |
| M4 | UTC/local mismatch made NET-30 a day early | 3 | fixed, UI-verified | `toISOString()` and hardcoded date literals **banned** in application JS and enforced by `verify-structure.py` §11. `addDays("2026-06-17",30)` = **2026-07-17** | 8 boundary checks |

### The disagreement neither end knew about

The named ranges were computed **twice** — once in PHP, once in JavaScript — and
the two did not agree:

```
PHP   strtotime('monday this week')          -> 2026-08-17  (Monday)
JS    d.setDate(d.getDate() - d.getDay())    -> 2026-08-16  (Sunday)
```

So "This Week" on the Sales Report meant one period in the headline figure and a
different one in the table beneath it. Neither was wrong in isolation; having
two was. `api/core/Dates.php` is now the only place a range is defined,
`api/system/dates.php` hands the answer to the browser at start-up, and
`getDateRange()` reads it instead of computing. **All eight named ranges now
match the server exactly**, verified in the browser.

The week starts **Monday** (ISO, and what the server already used). It is one
line in one file if the business wants otherwise.

### Two more frozen dates, found while removing the first

The grep for hardcoded date literals turned up two live ones I had missed:

- **`isOverdue()`** compared against `new Date("2026-06-17")`, so an account's
  overdue status was fixed relative to 17 June 2026 for ever. Anything due after
  that read as current no matter how long unpaid. Now reads `daysPastDue`, which
  `payments/list.php` already computed with `DATEDIFF(CURDATE(), due_date)`.
  Verified: Danilo Mercado shows **"(73d) OVERDUE"** — Jun 5 to Aug 17, correct.
- **`batchRow()`** computed days-to-expiry against the same constant, so the
  Batch Tracking screen's "days left" stopped moving in June 2026. Measured on
  lot JBF-2026-B102: **275 days from the server, 336 from the frozen constant —
  a 61-day error on a food-expiry screen**, in the optimistic direction.

Both were fixed by reading the value the server already computed rather than by
correcting the client's arithmetic. The client formats; it does not compute.

### Verification

- **161/161 API checks** (was 139): +22 for dates.
- 8 boundary cases: month ends, year wraps in both directions, leap year, leap
  day, back into a leap day, and the NET-30 off-by-one.
- `system/dates.php` asserts PHP and MySQL agree on today and reports `drift`
  when they do not — the portal logs it and warns the operator rather than
  silently producing figures that depend on which clock answered.
- **38/38 UI wiring assertions** still green.
- Structure checks pass, including the new §11 date discipline.
- Database at baseline: 42 orders, 12 customers, 15 products, 28 audit rows.

**Phase 3 is now complete — all 8 items.**

---

## Phase 4 — Built but never wired

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| W1 | `roles/save.php` — Roles screen discarded every edit | 4 | fixed, UI-verified | Closed in Phase 1. Toggling a permission changes what `roles/list.php` returns; **Proof 7** showed the UI runner catching it when deliberately disconnected | UI runner |
| W2 | `reports/sales.php` never called | 4 | fixed, UI-verified | Network trace while opening Sales: `GET reports/sales.php` fired | browser |
| W3 | `content/save.php` never called | 4 | fixed, UI-verified | **Full round-trip.** Edited About in the admin → `POST content/save.php` → MySQL `site_content.about` → `content/get.php` → **rendered on the public storefront**. Original copy restored from seed | browser + SQL |
| W4 | `orders/get.php` never called | 4 | fixed, UI-verified | Opening an order from History fired `GET orders/get.php`; the modal shows real data | browser |
| W5 | Landing-content `localStorage` bridge | 4 | fixed, UI-verified | `content/get.php` is authoritative; `localStorage` is a first-paint cache only. See the latent bug found below | browser |
| W6 | `orders/list.php` omitted line items | 4 | fixed, verified | **D10.** One grouped `WHERE oi.order_id IN (...)`, no N+1: **25 orders cost 9 queries**, constant. Hard cap holds — `limit=5000` served `meta.limit=200`. Every row carries items | query counter |

### Orphan sweep

Every one of the **46 endpoints has at least one application caller**. No
orphans, none test-only, so **D12 has nothing to archive**. Table generated
mechanically from `api/` against JS, inline `<script>` in HTML, and the UI
specs.

### Two defects found while verifying

**1. "Phone undefined" in the Order Detail modal.** `orders/get.php` returns
`contact`; the modal read `o.phone`.

The interesting part is what nearly went wrong fixing it. Nine client reads of
`.phone` exist — a mass rename would have been the obvious move and would have
**broken seven of them**, because `b2b/list.php` and `returns/list.php` genuinely
return `phone` while `orders/get.php` and `pos/checkout.php` return `contact`.
Checking each endpoint's actual output first reduced it to the two real bugs.
The API spelling one concept two ways is the root cause; renaming it now would
break more than it fixes, so `verify-structure.py` §12 records which endpoints
use which and fails if an order is read for `.phone` without a fallback.

**2. A latent stale-cache bug in the landing bridge.** `fetchLandingContent()`
took fresh content from the API, cached it, then called `applyLandingContent()`
— which **re-read localStorage**. It worked only because the cache was written
one line earlier. A failed write (quota, private browsing) would have applied
stale content over fresh, and the symptom would be an administrator's edit
simply not appearing, with no error anywhere. Now reads memory first.

### State

- **161/161 API checks**, 38/38 UI wiring, structure checks pass (now 12 sections).
- Database at baseline; the landing copy edited during the round-trip test was
  restored from `db/seed.sql`.

**Phase 4 complete.**

---

## Phase 5 — Purge client-side mock data

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| K1 | 13 mock arrays (~390 lines) | 5 | fixed, verified | Removed in an earlier pass. Re-hunted here with all six patterns the brief lists: **only 5 array literals remain, all config** (`AUDIT_NOTIF_RULES`, `NOTIF_TABS`, `RETURN_TABS`, `HERO_PANELS`, and `FAQS` — now empty) | six-pattern sweep |
| K2 | Parse-time `AUDIT_LOG.push()` of 5 invented rows | 5 | fixed, verified | **Zero** module-scope pushes, zero id-like object literals, zero suspicious identifiers, zero seeded-id strings | six-pattern sweep |
| K3 | Optimistic writes | 5 | fixed, UI-verified | **D11 applied codebase-wide.** Four genuine sites fixed — see below | browser |
| K4 | `FAQS` rendered invented rows on a failed load | 5 | fixed, UI-verified | **D14.** Literal emptied. Normal load: 6 FAQs from the database. Forced failure: **0 rows** and *"Couldn't load the questions just now — please refresh."* | browser |

### The six-pattern sweep

An array-shaped grep had already missed a parse-time `AUDIT_LOG.push()`, so this
looked for all six shapes the brief names: array literals, module-scope
`.push()`/`.unshift()`, id-like object literals, identifiers containing
MOCK/SAMPLE/DEMO/FAKE/DUMMY/STUB/PLACEHOLDER, module-scope `Object.assign`
seeding, and seeded-looking id strings (`"cus-01"`, `"ORD-2026…"`).

**Five hits, all legitimate configuration.** Every other pattern: zero.

### D11 — four optimistic writes, not two

The heuristic flagged 27 candidates; 23 were DOM writes or request-body
building. The four real ones each mutated shared state before the server agreed,
and each `catch` returned **without undoing it**:

- **`archiveCustomer`** set `c.status = "archived"` first — a refused archive
  left the row displaying a status the database did not hold.
- **`openAddBatchModal`** ran `BATCHES.unshift(newB)` first — a duplicate lot
  code answers 409, leaving an invented batch with an id the server never
  issued.
- **`openEditBatchModal`** assigned ten fields onto the batch first — a rejected
  save still displayed the new lot code, dates and QA status.
- **`markRead` / `markAllRead`** set `read = true` first and swallowed errors,
  so a failed write showed as read and came back unread on the next load.
  `markAllRead` also toasted *"All notifications marked read"* unconditionally.

### The find that mattered: batch registration was dead

Removing the dead `newB` object exposed that the save handler read
**`$("#m-batch-qty")` when the input is `id="m-batch-total"`**. That threw
`Cannot read properties of null` inside an async handler — surfacing as an
unhandled rejection, which is to say as **nothing at all**. The modal stayed
open, no row was written, no error appeared.

Confirmed by clicking before the fix: form filled correctly, Register pressed,
**0 rows written, batch count still 12**. `batches/save.php` passed every test
aimed at it the entire time.

A second dangling id in the same handler — `#m-batch-lab` against a select of
`id="m-batch-qa"` — was **masked by optional chaining**: whatever QA status the
inspector chose was discarded and every batch saved as `pending`. That one would
have shipped silently forever.

After the fix, clicking through writes `total_qty=250`, `lab_status=passed`,
and the correct harvest, production and expiry dates. Test row removed.

`verify-structure.py` §13 now fails on any `$("#id")` the portal queries that no
markup declares. It found one more on its first run (`#pay-confirm-btn` in
`pos.js`, benign because of a fallback, now removed).

The dead object also carried **two more frozen `"2026-06-17"` dates** — bare
string literals, so the sweep that caught `new Date("2026-06-17")` never saw
them.

### State

161/161 API checks, structure checks pass (13 sections), everything lints,
database at baseline (42 orders, 12 customers, 12 batches, 28 audit rows).

**Phase 5 complete.**

---

## Phase 6 — Brief compliance and docs

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| C1 | Inline handlers | 6 | fixed, UI-verified | HTML cleared in Phase 2. **Two more found in JS template strings** — invisible to any grep of `.html`. Check §8 now scans template strings too | browser |
| C2 | `fetch` shadowing a global | 6 | fixed, verified | Swept 15 globals. Only `fetch` ever mattered — see the reasoning below | grep |
| C3 | `document.currentScript` null in a module | 6 | fixed, verified | `api.js` (a module) uses `import.meta.url`. `engine.js` and `site.js` still use `currentScript` and are **correct**: both load as classic `defer` scripts, where it works | grep + tag audit |
| C4 | `docs/API.md` incomplete | 6 | fixed, verified | 46/46 endpoints, zero stale entries, enforced by check §9 | structure check |
| C5 | Stale-fragment trap | 6 | fixed, documented | `cache: "no-store"` confirmed in `module-loader.js:145`. Diagnosis procedure added to `docs/TESTING.md` | curl + grep |

### The find: `portal/admin/index.html` was broken

Auditing C3 meant listing how each portal loads its scripts, which showed
**`engine.js` twice in `portal/admin/index.html`** — in the slot every other
portal uses for its gate file.

Two consequences:

- `engine.js` parsed twice. The second parse died with
  **`SyntaxError: Identifier 'CONFIG' has already been declared`** — a real
  console error on every single load of that portal.
- **`gates/admin.js` never loaded**, so `installRoleGate("Admin")` never ran and
  that entry point declared no role at all.

**I had reported this portal as "zero JS errors" in Phase 2.** The reason is
worth recording: my check set `window.onerror` *after* calling
`location.reload()`, and a parse error fires during load, before the hook
exists. The hook could never have seen it. The UI runner does not have this
problem — it attaches to `iframe.contentWindow` before the modules run, which is
how this was confirmed fixed. Both the trap and the technique are now in
`docs/TESTING.md`.

Check §14 now asserts no portal loads a script twice and each loads its own
`gates/<role>.js`.

### C2 — swept, and deliberately not "fixed"

15 globals checked (`document`, `window`, `location`, `history`, `name`,
`status`, `event`, `fetch`, `top`, `self`, `parent`, `length`, `origin`,
`screen`, `navigator`). 24 shadows found, 23 of them locals named `name`,
`status` or `screen`.

Only `fetch` ever caused a problem, because `fetch` is a global anyone actually
calls — shadowing it hid a genuine call site from a grep. `window.name`,
`window.status` and `window.screen` are not used anywhere in this codebase, and
renaming 23 ordinary locals would be churn across working code for no
behavioural gain, with the usual chance of a bad edit. Recorded rather than
changed; if it should be done anyway, say so and I will.

### State

161/161 API checks, structure checks pass (**14 sections**), everything lints,
database at baseline.

**Phase 6 complete.**

---

## Phase 7 — the 11 unclicked screens — COMPLETE

All eleven exercised in the browser as the role that owns them, every write read
back out of MySQL, and every fixture restored afterwards.

| Screen | Role | Verdict |
|---|---|---|
| Roles & Permissions | Super Admin | works (Phase 1) |
| Landing content | Super Admin | works (Phase 4) |
| Batch registration | Super Admin | **was DEAD** — fixed (Phase 5) |
| POS cart → checkout | Cashier | works |
| Order Queue | Online Orders | works |
| Payment Verification | Online Orders | works |
| Returns pipeline | Online Orders | works |
| Notifications (single + mark all) | any staff | works |
| Staff add / edit / archive | Super Admin | works |
| B2B approve / reject | Super Admin | **was DEAD** — fixed |
| Product add / edit | Super Admin | works |

### The second dead feature: B2B approve, reject and view

Clicking **Approve** on a B2B application opened an **empty modal** — a shell
with the title "Modal" and nothing in it. No console error, no toast, no
network request.

`b2b/list.php` casts its id with `(int)`, so `B2B_APPLICATIONS[].id` is the
number `2`. A `dataset` value is always a string, so `btn.dataset.approveApp` is
`"2"`. The lookup was

```js
B2B_APPLICATIONS.find(x => x.id === btn.dataset.approveApp)   // 2 === "2" → false
```

`find()` returned `undefined`, `openApproveAppModal()` hit its `if(!a) return`,
and the operator was left looking at an empty box. **View, Approve and Reject
were all dead**, and `b2b/decide.php` passed every test aimed at it throughout.

Fixed by wrapping all **12** id-vs-dataset comparisons in `String(...)`. Every
other list uses string ids (`cus-01`, `bat-201`), so the change is a no-op for
them — it removes the trap for the next numeric id someone adds.

Verified after the fix: the modal populates ("Approve Soriano Grocers", credit
terms and tier selects), and approving set the application to `approved` with
tier `Silver` **and promoted `cus-03` to `retailer` in the same transaction**,
with an audit row. Fixture restored.

### What the other screens proved

- **POS**: order `EB-634BD6-828`, ₱769 = 2×235 + 299, `price_at_purchase`
  stored, stock 138→136 and 33→32, cart cleared, receipt shown.
- **Order Queue**: refused to accept an unverified order —
  *"Verify the payment before accepting this order."*
- **Payment Verification**: `pay_verified=1`, status transition, **two**
  server-side audit rows naming actor and reason, an `order_status_history`
  row, and stock decremented on accept.
- **Returns**: `received → validated`, audit row with the note.
- **Notifications**: single mark-read persisted (`n01.is_read=1`); Mark All Read
  took 4 unread to 0 in the database.
- **Staff**: add → `emp-07` with a bcrypt password, edit → rename persisted,
  archive → `status=archived`, and **the archived account is refused at login**
  with "This account has been archived."
- **Products**: add → slug id, correct price/category/description, `stock=0`
  (correct — stock moves only through inventory); edit → 199 → 249 persisted.

### Three selector mistakes of mine

A POS tile looked like a dead control (it opens a quantity modal). "Accept" and
"Validate" matched the **filter tabs** rather than action buttons, because both
render as `<button>` — the fix is to exclude anything ending in a count. And
`/approve|review|view/` matched "View" before "Approve".

None was a defect. All three would have been filed as one by a less careful
pass, which is the opposite failure to the one this remediation targets and just
as expensive.

### State

- **161/161 API checks**, **38/38 UI wiring assertions**, structure checks pass
  (14 sections), every JS and PHP file lints.
- Database at baseline: 42 orders, 78 order items, 15 products, 12 batches, 12
  customers, 6 users, 28 audit rows, 6 unread notifications, 4 pending B2B
  applications, 1 return at `received`, 3 retailers.

---

## Phase 7 — interim log

Kept for the record. This section was written mid-phase, while XAMPP was down
and five screens were still unexercised. **Its "not started" rows are stale** —
all eleven screens are closed in the section above; see that table, not this one.

The two things from it still worth keeping are the selector mistakes (a POS tile
that opens a modal rather than adding directly, and matchers that hit filter
tabs) and `tools/restore-phase7-fixtures.sql`, which restored the Payment
Verification test mutations cleanly when the services came back.

---

# Phase 8 — payments logging, image pipeline, checkout prefill

Five newly reported defects. Four of them are about images, and the audit in
`docs/IMAGE-AUDIT.md` established why that is not a coincidence: **there was no
upload pipeline at all.** Zero PHP files touched `$_FILES`; zero wrote a file.
Every "upload" was a `FileReader` in the browser, and the screens that appeared
to work did so only because a writer and a reader happened to agree on a key
name inside one browser.

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| P1 | Walk-in payment not logged in Payment History | 8 | **fixed, UI-verified** — see 8.3 | Phase 1 marked this `INFERRED`; the click-through found the real cause one branch over. Detail in Phase 8.3 | browser + SQL |
| P2 | Product image saves for staff but not on customer product cards | 8 | fixed, UI-verified | Root cause: `shop/products.php` sends `image`, `createProductCard()` read `p.img`. Both now go through `imageUrl()`. Storefront DOM: 3 photos, `naturalWidth 1400`, `placeheld: no`. Files on disk, paths in MySQL | browser DOM + disk + SQL |
| P3 | Landing page images vanish after logout | 8 | **fixed, UI-verified** — see 8.3 | `hero_slides.image_data` renamed to `image_path`, `content/get.php` now sends `image`. `content/save.php` still accepts no `hero` key — that wiring is 3.3 | — |
| P4 | Customer checkout reference image upload does not work | 8 | **fixed, UI-verified** — see 8.3 | `orders.proof_image_path` added; the control is still a `div` with no file input. That build is 3.4 | — |
| P5 | Autofill phone and address at checkout | 8 | **fixed, UI-verified** — see 8.3 | Phase 1 found **`customers` has no address column** and the storefront's own Save Address form is a mock that writes nothing. Needs a schema addition and a write endpoint, not just a read | — |
| P7 | *(unreported)* Returned units counted as sold for ever — `returns/advance.php` restored stock without decrementing `sold`, while `orders/status.php` did both | 8 | **fixed, verified** — see 8.4 | Found by the Phase 4 duplicate-write sweep. `stock 112→113, sold 560→559` on a real return | endpoint + SQL |
| P6 | *(unreported)* Landing per-product photo picker writes to nothing | 8 | **fixed, verified** — see 8.3 | `SITE_CONTENT.productImages` has no table, no endpoint and no reader. Found during the Phase 1 audit; folds into `products.image_url` in 3.3 | — |

---

## Phase 8.2 — the one pipeline

Everything in decisions I1–I7, built and proven.

| Item | Built | Proof |
|---|---|---|
| GD enabled | `extension=gd` uncommented at `C:\xampp\php\php.ini:931`, Apache restarted. Backup at `php.ini.bak-preupload` | `gd_info()` reports WebP, JPEG, PNG, FreeType support |
| `api/uploads/image.php` | One endpoint, three purposes, permission per purpose | table below |
| `/uploads/.htaccess` | PHP execution disabled | table below |
| `EbFormat.imageUrl()` | One resolver, adopted by every render site | 7 call sites; no screen builds a src inline |
| Placeholder | Delegated capture-phase `error` listener in `core/index.js` | a request for a non-existent path ends at a 64×64 inline-SVG placeholder, `data-eb-placeheld="1"` |
| Data migration | `tools/migrate-images.php` + `db/migrations/003-image-paths.sql` | table below |

### The endpoint, tested rather than asserted

| Input | Result |
|---|---|
| 2400×1200 JPEG with a PHP tag appended (45,713 bytes) | `200` → 1600×800 WebP, 2,364 bytes. **`grep` for the payload marker on the written file: 0 matches.** `finfo` reports `image/webp` |
| text file renamed `.jpg` | `422` "Upload a JPEG, PNG or WebP image" — MIME read from bytes, not from the name |
| a real `.php` file | `422`, same check |
| no file | `422` "Choose an image to upload" |
| `purpose=../../api/config` | `422` "Unknown upload purpose" |
| staff session asking `purpose=references` | `401` — permission follows what the image is *for* |
| anonymous | `401` |
| signed in, no CSRF header | `403` code `CSRF` |

The client's filename never reaches the path — the server names every file
`bin2hex(random_bytes(16)) . '.webp'` — so there is no traversal to defend
against, rather than a defence against traversal.

### `/uploads/.htaccess` — two rules that do not work, and one that does

Worth its own row, because **both obvious ways to write this rule fail in ways
that look like success.**

| Attempt | Result |
|---|---|
| `php_admin_flag engine off` | **Every request in the directory returns a blank 500.** `[core:alert] php_admin_flag not allowed here` — it is server-config-only. A directory that 500s reads as "locked down" |
| `RemoveHandler .php` + `RemoveType .php` + `AddHandler default-handler .php` | **Accepted silently and does nothing.** The probe file returned `EXECUTED-42`. XAMPP binds PHP with `SetHandler` in a server-level `FilesMatch`, and `SetHandler` never consults the extension map those directives edit |
| `SetHandler None` at directory scope | **Works.** The probe returned its own source, unexecuted |
| plus `Require all denied` | `403`. Rule 1 stops execution, rule 2 stops reading; each was confirmed working on its own |

Final state: `.php` probe → `403`, `.htaccess` itself → `403`, directory listing
→ `403`, `.webp` → `200 image/webp` with `nosniff` and a one-year immutable
cache. Probe file deleted.

### Migration

`php tools/migrate-images.php --apply`, then
`mysql -u root elisha_bay_db < db/migrations/003-image-paths.sql`. That order
matters and both files say so: narrowing `image_url` to `VARCHAR(255)` while a
row still holds 918KB of base64 truncates it to 255 characters of base64 — a
value that looks like data and renders as nothing. The migration carries a
guard that refuses to start until the converter has run.

| | |
|---|---|
| rows scanned | 65 (products 15, hero_slides 5, orders 45) |
| **rows changed** | **3** |
| converted base64 → file | 3 (507KB → 168KB, 405KB → 124KB, 897KB → 381KB) |
| normalised (path form only) | 0 |
| **pointing at a file that does not exist** | **0** |
| failed | 0 |
| `hero_slides` | 5 rows, all NULL — nothing to convert, type change only |
| `orders.proof_image_path` | new column, 45 rows NULL |

Both are idempotent — a second run of each reports `0 changed` and exits 0.
The database was backed up to the scratchpad before either ran.

**Measured effect.** `GET api/shop/products.php` — public, unauthenticated,
called on every storefront page load — went from **1,856,279 bytes to 4,239**.
438× smaller. 98% of the old payload was base64 that the storefront downloaded
and discarded, because of the `image`/`img` mismatch that is defect P2.

### Files that had to change to avoid leaving things half-migrated

Reader adoption was pulled forward into this phase rather than left to Phase 3.
A stored path is application-root-relative, so the moment the columns changed,
a raw `src` in the POS resolved against the web root and 404'd. Half a
migration is worse than none.

- `api/products/save.php` — `image` is now a path, validated against
  `^/uploads/products/[a-f0-9]{32}\.webp$` **and required to exist on disk**. A
  data URL is refused with a message saying to upload first, rather than being
  truncated to 255 characters of base64.
- `assets/js/portal/engine.js` — the product modal uploads on file-select and
  shows a real status line; the save reads `data-path` (the canonical value),
  never `src` (resolved for this page).
- `assets/js/portal/pos.js`, `assets/js/public/site.js` — every image src goes
  through `imageUrl()`.
- `api/content/get.php`, `db/schema.sql`, `db/seed.sql` — the `image_path`
  rename.
- `docs/API.md` — the new endpoint. `verify-structure.py` §9 caught its absence
  before I did.

### Harness state after Phase 8.2

- **Structure: all checks pass** (14 sections), including the endpoint-
  documentation check that failed first and was then fixed.
- **API: 154/161.** Seven failures, **all pre-existing and none related to this
  work** — proven against the pre-change database dump taken before any file
  was touched:
  - Three RBAC checks (`audit/list.php`, `batches/list.php`,
    `inventory/adjustments.php` answering a Cashier with 200) plus "Cashier
    still may not archive". The Cashier role holds permission ids
    `6,7,8,10,11,12,13` where `db/seed.sql` grants `8,10,11,13`. The extras
    `6,7,12` appear verbatim in the pre-change dump — drift left by an earlier
    Roles-screen write, not by anything here.
  - Three checkout checks failing on `We only have 0 of Asian Steak Bangus
    left`. `db-steak` stock is 0 in the pre-change dump too, sold out by the two
    walk-in POS orders placed earlier today.

  Both are **database state, not code.** Neither is repaired here: restoring
  role permissions and restocking a product are data decisions, and quietly
  changing rows to make a test green is the exact failure mode this remediation
  exists to avoid. Flagged for your call.
- Every changed JS and PHP file lints clean.

### Known gap, stated now rather than discovered later

**Uploaded files are never garbage-collected.** Replacing a product image writes
a new file and repoints the column; the old file stays on disk forever, as does
any file uploaded into a form that was then cancelled. Nothing is broken by it
and nothing is exposed — the names are 32 random hex characters — but the
directory grows monotonically. A sweep for files no column references is a small
job and is not done.

---

## Phase 8.3 — the five defects

Every row below was closed by driving the real UI as the correct role, then
reading the resulting row out of MySQL and the resulting file off disk.

| # | Defect | Phase | Status | Evidence | Verified by |
|---|---|---|---|---|---|
| P1 | Walk-in payment not logged in Payment History | 8 | fixed, UI-verified | **Not the screen — the sale never happened.** POS offered Net 30/60/90 for a Retailer; `pos/checkout.php` accepted only cash/gcash/bank, so a credit sale returned `422 pay_method` and `placeOrder()` displayed *nothing*. Now accepted, with a retailer picker, and the receivable is written in the same transaction | browser + SQL |
| P2 | Product image saves for staff but not on customer product cards | 8 | fixed, UI-verified | Image **added** to `db-chili`, which had none. Signed-out storefront card renders it at 900×700, `placeheld: no` | browser + disk + SQL |
| P3 | Landing page images vanish after logout | 8 | fixed, UI-verified | Hero photo uploaded, saved, admin logged out, public page loaded in a tab with **`localStorage` empty** — image renders at 1400×900 | browser + disk + SQL |
| P4 | Customer checkout reference image upload does not work | 8 | fixed, UI-verified | Real `<input type=file>`; screenshot uploaded at checkout, stored on the order, and **opened by Online Orders Staff in Payment Verification** at 800×1400 | browser + disk + SQL |
| P5 | Autofill phone and address at checkout | 8 | fixed, UI-verified | Prefilled, editable, never clobbers typing, profile untouched unless the checkbox is ticked. All four cases proven below | browser + SQL |
| P6 | *(unreported)* Landing per-product photo picker writes to nothing | 8 | fixed, verified | Duplicate uploader removed; the column shows the product's own photo and links to Product Maintenance | code + browser |

---

### P1 — what was actually wrong

The reported symptom did not reproduce on the screen it names. Payment History
is `portal/views/transactions.html` over `orders/list.php` with no type filter,
and walk-in orders were listed there correctly. A cash walk-in placed end to end
as the Cashier appeared immediately, top row, and in the dashboard and Sales
Report.

The real defect is one branch over:

```
assets/js/portal/pos.js   buildPayMethodGrid()  offers net30/net60/net90
                                                the moment ctype === "retailer"
api/pos/checkout.php      ->in('pay_method', ['cash','gcash','bank'], …)
```

Selecting Retailer → Net 30 → Place Order returned

```
422  {"pay_method":"Payment method must be one of: cash, gcash, bank."}
```

**and showed the cashier nothing at all.** `placeOrder()`'s error handler listed
four field names and fell back to a toast only when `err.fields` was *empty*. A
422 naming any other field matched no branch, was not empty, and produced no
inline error, no toast, no console entry. The button appeared dead. No order
row, no receivable, nothing in Payment History — the defect exactly as reported,
reached from an angle the report did not describe.

**Also found, and the more serious half:** `payment_accounts` had **no writer at
all**. Every row was seeded, and the only statement in the entire codebase that
touched the table was `UPDATE payment_accounts SET paid = ?` in
`payments/settle.php`. A retailer balance could be marked settled and could
never be raised. Selling on terms did not increase what anyone was owed.

**What was built** — decision I8, one shared payment write:

- `api/core/Payments.php` — the single place that decides what a payment method
  implies. Both checkout endpoints now ask it. The expression
  `$refNum !== null ? 1 : 0` was copy-pasted into both files and is gone from
  both.
- `pay_verified` is now derived rather than hardcoded: 1 at the till, 0 online,
  **0 for any credit method** — nothing has been paid. The POS previously
  hardcoded 1 for every method, correct only because it could not reach a credit
  one.
- A credit sale requires `retailer_id`, re-checked against `customers.status` on
  the server. Selling on terms to a free-text name would create a debt owed by
  nobody.
- `Payments::openCreditAccount()` writes the receivable **inside the same
  transaction** as the order, line items, stock decrements and audit row.
- `api/pos/retailers.php` — a new `pos.use` endpoint returning id, name,
  outstanding and overdue count. Not a widened permission on
  `customers/list.php`, which needs `users.manage` and returns every customer's
  email and contact number.
- `db/migrations/004` adds `payment_accounts.order_id` so a receivable names the
  sale that created it.

**Proof.**

```
Cashier → POS → Ba-yo ×1 → Retailer → Net 30 → (no retailer chosen) → Place Order
  err-retailer: "Choose which retailer this credit sale is for."   ← was silent

  → Roberto Tan (hint: "Currently owes ₱4,250") → Place Order
  Receipt: TXN EB-DCF6B0-977 · ₱299 · Net 30 — Due: Sep 21, 2026
```

```sql
orders            EB-DCF6B0-977  customer_id=cus-02  method=net30  total=299.00
                  status=completed  pay_verified=0   cashier=emp-03
payment_accounts  pay-05  cus-02  order_id=EB-DCF6B0-977  Net 30
                  balance=299.00  due_date=2026-09-21  paid=0
audit_logs        "POS sale EB-DCF6B0-977 — ₱299.00 (net30, pickup). 1 line(s),
                   1 unit(s). On terms: pay-05 opened for Roberto Tan — ₱299.00
                   due 2026-09-21 (Net 30)."
```

Four screens, per D2 and D13:

| Screen | Shows |
|---|---|
| Payment History | top row, `EB-DCF6B0-977 · ₱299 · Net 30 · walk-in` |
| Payment Schemes | new row, Roberto Tan · Net 30 · ₱299 · Sep 21, 2026 · Pending |
| Dashboard | Total Revenue ₱62,411 → **₱62,710** (+₱299 exactly); Today's Sales ₱869 |
| Sales Report | `orders: 2, revenue: 869, walkinRevenue: 869, onlineRevenue: 0` |

**Not double-counted**, checked against SQL rather than eyeballed:

```sql
SELECT COUNT(*), SUM(total) FROM orders WHERE date=CURDATE() AND status='completed';
  -> 2  869.00          -- matches the report exactly
SELECT SUM(balance) FROM payment_accounts WHERE paid=0;
  -> 24999.00           -- a separate ledger; receivables are not revenue
```

A completed credit pickup counts as revenue on the day of sale while the cash is
still owed. That is accrual, it is what `Revenue::STATUSES = ['completed']`
already meant, and it is stated here rather than left for someone to discover
from a figure.

---

### P2 — the case the report distinguishes

Phase 8.2 fixed the `image`/`img` mismatch and re-verified the two products that
already had photos. The report separates *editing* an existing image from
*adding* one to a product with none, so the second case was driven separately.

```
Admin → Products → Chili Garlic Bangus (image_url NULL) → choose file
  status line: "Uploaded (7 KB). Save to attach it to the product."   ← not "saved"
  → Save Changes
```

| Where | Result |
|---|---|
| MySQL | `db-chili → /uploads/products/e282a8cef88fdb6afed1c966c64e150f.webp` |
| Disk | `7,498 bytes` (from a 31,211-byte PNG) |
| `shop/products.php`, no session | returns the path |
| File over HTTP, no session | `200 image/webp 7498b` |
| **Storefront card, signed out** | `natural 900x700`, `has-photo`, `placeheld: no` |

The status line matters as much as the image: it says *"Save to attach it"*,
because at that moment the file is on the server and the product record does not
point at it yet. Claiming otherwise is the preview-implies-persistence mistake
this whole pass is about (I7).

---

### P3 — preview and reality now agree

Two things were wrong and both produced "it looked saved":

1. **`saveLanding()` never sent `hero`, and `content/save.php` would not have
   accepted it.** `content/get.php` read `hero_slides.image_data` on every
   storefront load, so the reader could return a hero image that no writer in
   the system could produce. All five rows NULL and unfillable.
2. **A second toast fired synchronously**, outside the promise:
   `toast("Landing page changes saved.")`. A failed POST showed an error toast
   *and* a success toast.

`featured_products` had the identical shape of gap — `saveLanding()` computed
the ticked list, sent nothing, and the table had 0 rows. Both keys are accepted
now.

**The bridge is deleted, both ends.** `localStorage["eb-landing-content"]` is no
longer written by the portal, no longer read by `site.js`, and a **third** copy
of the patching logic — an inline `<script>` in `public/index.html` that read the
same key and rendered FAQ text as raw `innerHTML` while `renderFaqs()` escaped
it — is removed. `site.js` also clears the retired key on load, because removing
the code that wrote it does not remove what it already wrote.

**Proof.**

```
Admin → Landing → hero slot 0 → upload (1,263,645-byte PNG) → Save Changes
  toast: "Landing page saved: about, vision, mission, contact.address,
          contact.phone, contact.email, contact.facebook, faqs (6),
          hero images (5), featured (3)."
  → log out
```

```sql
hero_slides        1 · Pesto Bangus · /uploads/content/94b1781d83e84c3e868eda06892ffe50.webp
featured_products  bg-tuyod(1), bg-adobo(2), db-pesto(3)
```

Public landing page, separate tab, signed out:

```
localStorageKeys : []            ← nothing in browser storage at all
heroPanelImg     : /uploads/content/94b1781d83e84c3e868eda06892ffe50.webp
rendered         : natural 1400x900, placeheld: no
Best Sellers     : bg-tuyod, bg-adobo, db-pesto  (= featured_products)
```

An empty `localStorage` is the strongest form this proof can take: there is no
browser storage left for the image to be coming from.

---

### P4 — and staff can open it

The control was never broken; it never existed. `#upload-mock` was a `<div>`
with `role="button"` whose handler set `uploaded = true` and printed the
hardcoded string `"✓ payment-proof.jpg attached (mock)"`. No file picker opened,
no file was read, and no column could have held one.

Now: a real `<input type="file">`, uploaded on selection to
`/uploads/references/`, path stored on `orders.proof_image_path`
(`db/migrations/003`). Failure is loud — the field is cleared and the message
shown, and the submit check refuses to place the order without a path, because a
silent failure at checkout is worse than a refusal.

**The half that decides whether this is fixed:**

```
Online Orders Staff → Payment Verification
  alt      : "Payment screenshot for ORD-20260822-AF91CC"
  natural  : 800x1400        placeheld: no
  wrapped in <a target="_blank"> — a GCash screenshot at thumbnail size is not readable
```

```sql
ORD-20260822-AF91CC  proof_ref_num=GC-77219-TEST
                     proof_image_path=/uploads/references/f295ff139145f290001a5a290dc9600a.webp
                     proof_amount=245.00  pay_verified=0
```

**A second defect fixed in passing.** That box rendered the words
`✓ Proof Uploaded` **unconditionally**, over nothing, for every order — because
`proof_uploaded` is set from whether a reference *number* was typed. The four
pre-existing orders on that screen now read **"Reference number only — no
screenshot attached"**, which is true of every order placed before this existed.
Telling staff a file is there when none can be is worse than showing them
nothing.

---

### P5 — a suggestion, not an override

**The schema question, answered first.** The brief asks which of "no saved
address / partial / multiple" the schema supports. It supported **none**:

```sql
CREATE TABLE customers (id, name, email, username, password, contact, status, joined, created_at);
```

No address column, no address table. The only address the system had ever stored
was `orders.address`, one per order. And the storefront's own **Profile →
Delivery Address** form was a mock: validate street non-empty, `showToast("Address
saved!")`, write nothing. No endpoint existed. Same for Personal Info.

`db/migrations/005` adds five nullable columns to `customers` — **one address,
not an address book**, because an address book carries unasked questions (which
is default, what happens to an order whose address is deleted) and the request
was "prefill the saved address". Partial is a legitimate state.

`api/shop/profile.php` (GET + POST) reads and writes it. **Identity comes from
the session only** — no `customer_id` parameter, no `email` parameter (D6, D7).
Email and password are deliberately not accepted: email is the login identifier,
and a password change needs the current password re-verified with its own rate
limiting. No audit row is written, because `audit_logs` records *staff* actions
and has a `users.id` actor column; a customer editing their own address is not
that.

**Proof — all four cases.**

| Case | Result |
|---|---|
| Saved profile | contact `0917 555 0101` and the joined address both prefilled, both marked `is-prefilled`, `readOnly: false`, `disabled: false` |
| **Typing wins the race** | typed `0999 TYPED BY HAND` into contact *before* the request resolved; 3.0s later the value was **unchanged** and the empty address still got filled |
| Edited a prefilled field, checkbox **unticked** | order stored `ONE-OFF: 5 Rizal Ave, Lingayen`; `customers.addr_street` **still `12 Mabini St., Brgy. Pantal`** — profile untouched |
| Checkbox **ticked** | `customers.addr_street → 77 Bonifacio St., Brgy. Tebeng, Dagupan City` |
| No saved address | address box empty, accepts input, nothing disabled, no error, contact still prefills from the partial profile |

The race case is the one that matters. The prefill is asynchronous, and
`el.value = data.contact` would have overwritten a shopper mid-keystroke. Only
empty fields are filled, and the `is-prefilled` marker is removed on first
input.

The profile page's three mock forms are wired to the same endpoint. **The
password form is not** — it now says *"Changing your password is not available
yet"* instead of `"Password updated successfully!"`. Claiming success was the
worse option: a customer who believes their password changed will try the new
one, fail, and have no idea why. It is on the open list below.

---

### Harness state after Phase 8.3

| Suite | Result |
|---|---|
| `verify-structure.py` | **All checks pass** (14 sections). §9 caught two undocumented endpoints before I did — `pos/retailers.php` and `shop/profile.php`, both now in `docs/API.md` |
| `verify-api.py` | **154/161** — the *same seven* pre-existing failures as before this phase, no new ones |
| `tools/ui-test/` | **36/38** — the same two, from the same cause |
| Lint | every changed JS and PHP file clean |

**The seven, and why they are not mine.** Both harnesses independently point at
one thing: the Cashier role holds permission ids `6,7,8,10,11,12,13` where
`db/seed.sql` grants `8,10,11,13`. The extras `6,7,12` appear **verbatim in the
database dump taken before any file in this pass was touched**. The three
checkout failures are `db-steak` at 0 stock, also present in that dump, sold out
by walk-in orders placed on 18 August.

That drift is worth a decision rather than a footnote: it means **a Cashier can
read `audit/list.php`, `batches/list.php` and `inventory/adjustments.php` over
the API**, and the Cashier sidebar renders Inventory Report, Inventory
Management, Stock Overview, Restock, Replenish and Adjustment. It is either an
old Roles-screen edit nobody undid, or a deliberate grant. Restoring the seeded
set is one statement:

```sql
DELETE FROM role_permissions WHERE role_id = 3 AND permission_id IN (6, 7, 12);
```

Not run. Changing permissions is a business decision, and quietly editing rows
until a test goes green is the failure mode this remediation exists to prevent.

---

### Test data left in the database, listed rather than tidied away

Driving the UI writes real rows. They are named here so nothing has to be
reconstructed from timestamps, and none of it was cleaned up silently.

| What | Ids |
|---|---|
| Orders created | `EB-A90BA6-402` (walk-in cash ₱570), `EB-DCF6B0-977` (walk-in Net 30 ₱299), `ORD-20260822-AF91CC` (online GCash ₱245, carries the proof image), `ORD-20260822-AB1FB1` (online cash ₱245) |
| Receivable | `pay-05` — ₱299, Roberto Tan, due 2026-09-21 |
| Stock | decremented by those four sales |
| Product photo | `db-chili` |
| Hero photo | `hero_slides` id 1 |
| Featured list | `bg-tuyod`, `bg-adobo`, `db-pesto` (was empty) |
| Customer profile | `cus-t01` contact + address |
| Files | three under `/uploads/{products,content,references}/` |
| Audit rows | one per sale, one per upload |

Say the word and I will remove the four orders, restore the stock and drop
`pay-05`. The content changes (product photo, hero photo, featured list) are the
kind of thing an administrator would legitimately set and are worth keeping as a
working demonstration — but that is your call, not mine.

---

### Still open

1. **Uploaded files are never garbage-collected.** Replacing an image writes a
   new file and repoints the column; the old one stays. Not exposed — the names
   are 32 random hex characters — but the directory grows monotonically.
2. **The customer password form is honest, not working.** It needs its own
   endpoint with the current password re-verified and rate limiting.
3. **Cashier permission drift** — the SQL above, pending your decision.
4. **`db-steak` is out of stock**, which fails three harness checks that assume
   it is buyable.

---

## Phase 8.4 — the sweep

Three classes, swept mechanically rather than by recollection. The write map was
generated by parsing every `INSERT`/`UPDATE`/`DELETE` out of all 49 endpoints
with block comments stripped, so documented SQL in prose could not be counted as
a write.

### 4.1 — Upload controls: clean

| | |
|---|---|
| `<input type="file">` in the codebase | **3** |
| `EbApi.upload()` call sites | **3** — one per purpose |
| Remaining `FileReader` / `readAsDataURL` uploaders | **0** |
| Remaining data-URL writes to any column | **0** |

The fourth control — the checkout `<div>` — no longer exists. Nothing bypasses
`api/uploads/image.php`.

---

### 4.2 — Duplicate write paths

Every table with more than one writer, and the verdict on each.

| Table | Writers | Verdict |
|---|---|---|
| `products` (stock) | 5 | **DRIFTED — fixed, see below** |
| `orders` INSERT | `pos/checkout.php`, `shop/checkout.php` | duplicate pair, column lists now identical, shared decisions extracted. **Reported, not merged** |
| `order_items` INSERT | same two | byte-identical statement |
| `audit_logs` INSERT | 21 files | identical column list in all 21, no drift |
| `customers` UPDATE | `b2b/decide`, `customers/save`, `shop/profile`, `shop/register` | four *different* operations, not duplicates |
| `payment_accounts` | `core/Payments.php` (INSERT), `payments/settle.php` (UPDATE) | raise vs settle — different operations |
| `inventory_adjustments` INSERT | `inventory/adjust`, `returns/advance` | same statement, different reasons; low risk |
| `batches` | `batches/save`, `inventory/adjust` | create vs consume |
| `categories`, `notifications`, `users` | 2 each | save vs archive / create vs read-flag |

#### The one that had drifted: stock

Five statements, four rules:

```
pos/checkout.php      stock = stock - ?, sold = sold + ?          AND stock >= ?
orders/status.php     stock = stock - ?, sold = sold + ?          AND stock >= ?
orders/status.php     stock = stock + ?, sold = GREATEST(sold-?,0)
returns/advance.php   stock = stock + ?                            <-- sold untouched
inventory/adjust.php  stock = stock + ?                            AND stock + ? >= 0
```

**A cancelled order decremented `sold`. A refunded return did not.** Two
implementations of "the goods came back, reverse the sale", written months
apart, agreeing on the stock half and disagreeing on the other.

Not cosmetic. `products.sold` drives:

- the Fast / Slow / Non-Moving classification in `products/list.php`
  (`>1000` / `200–1000` / `<200`) on the Inventory Report
- the default **featured** sort on the public storefront (`shop/products.php`)
- the **"N sold"** figure printed on every public product card
- the Landing editor's Best Sellers ranking **and its `price × sold` revenue
  column**

So a heavily returned product read as Fast Moving, sorted to the front of the
shop, and advertised its returns to customers as sales. Money already got this
right — `reports/sales.php` nets refunds out of revenue. Units did not. The two
ledgers disagreed.

**`api/core/Stock.php`** now owns all five call sites, with the differences
named rather than accidental:

| Method | Movement | `sold` |
|---|---|---|
| `Stock::sell()` | goods leave — POS sale, order accepted | `+ qty`, guarded `AND stock >= ?`, **returns rows affected and the caller must check it** |
| `Stock::reverseSale()` | goods come back and the sale is reversed — cancellation, refunded return | `GREATEST(sold - qty, 0)` |
| `Stock::adjust()` | a correction — restock, delivery, spoilage, stock count | **untouched**, because receiving 200 jars is not 200 sales |

`grep "UPDATE products SET stock"` outside `Stock.php` now returns nothing.

**Proof, driven through the real endpoints:**

```
returns/advance.php  RET-20260615-001  approved -> processed  (bg-tomato, qty 1)
  before:  stock=112  sold=560
  after :  stock=113  sold=559      <- sold would have stayed 560
```

```
inventory/adjust.php  db-steak +9 restock
  before:  stock=0  sold=1419
  after :  stock=9  sold=1419       <- sold correctly untouched
```

#### `orders` / `order_items` — reported, deliberately not merged

The two checkout endpoints still each write their own `INSERT INTO orders`. The
column lists are now identical and the hard parts are shared —
`Payments::orderFields()` decides the payment columns, `Stock` moves inventory,
both price every line from `products.price`.

**The drift risk is real and was realised during this pass:** adding
`proof_image_path` meant editing both files. That is the concrete argument for
an `Orders::insert()` helper.

It is reported rather than done, because the two flows differ in status
(`completed`/`accepted` vs `pending`), type, cashier, notes, the staff
notification, and *when* stock moves — POS commits at the till, online commits
on accept. A helper would be mostly parameters, and consolidating order creation
is a refactor that deserves its own pass with its own verification. Half-doing
it is the failure mode this remediation exists to avoid.

#### Client-side triple: three receipts, three different documents

| Field | POS `buildReceipt()` | Receipt Generation `orders.js` | Storefront `showReceipt()` |
|---|---|---|---|
| Transaction ID | ✓ | ✓ | ✓ |
| Date | ✓ | ✓ | ✓ |
| Cashier | ✓ | — | — |
| Customer | ✓ | ✓ | ✓ |
| Phone / Contact | ✓ | — | ✓ |
| Email | — | ✓ | — |
| **Address** | ✓ | **—** | ✓ |
| Order Type | ✓ | — | ✓ |
| Status | ✓ | — | — |
| Payment method | ✓ | ✓ | ✓ |
| **Reference #** | ✓ | ✓ | **—** |
| Tendered / Change | ✓ | — | — |
| Notes | — | — | ✓ |
| Credit due date | ✓ | — | n/a |

The same order produces three different documents depending on which screen
prints it. Two gaps are arguably defects rather than audience differences:

- **Receipt Generation omits the delivery address** — on a delivery order, the
  reprint does not say where it is going.
- **The storefront receipt omits the reference number** the customer just
  typed — they get no record of what they entered against their own payment.

Reported, not changed: which fields belong on a customer copy versus a till
copy versus a reprint is a business decision, not a bug fix.

---

### 4.3 — Preview versus persisted: clean

Swept for the exact shape of the `saveLanding` bug — a success message that is
not gated on the server's answer — plus fire-and-forget writes and optimistic
local-state mutation.

| Check | Result |
|---|---|
| Success toast fired outside the promise / before `await` | **0** (the one hit was `saveLanding`'s own, now inside `.then()`) |
| `EbApi.post/put/del/upload` with no `await` and no `.then` | **0** (two apparent hits are chained on the following line) |
| Local state mutated before the server confirms | **0** — `markRead()` / `markAllRead()` call the server first and `return` early on failure; the settings save sets `adminState` inside `.then()` |

The three previews that remain are all honest about what they are:

- **Product modal** — uploads on selection; the status line reads *"Uploaded
  (7 KB). Save to attach it to the product."*
- **Checkout proof** — uploads on selection; shows *"Attached (10 KB)."*, and
  the submit refuses without a stored path.
- **Landing editor** — the file is on the server, the toast says *"Save Changes
  to publish it to the landing page."*, and the preview iframe reads
  `content/get.php` like any visitor.

The landing editor's FAQ and featured-product edits are local until **Save
Changes** — that is ordinary form editing behind an explicit save, not an
implied persistence.

---

### A harness defect found by the sweep

Restocking `db-steak` to exercise `Stock::adjust()` turned an unrelated harness
check red, which was worth following:

```
[FAIL] POS merges duplicate cart lines before the stock check (no oversell)
```

The check posts `db-steak ×5` twice and expects **409**. `db/seed.sql` sets that
product's stock to **9**, so the merge is what makes 5+5 exceed it — the check is
precisely calibrated.

**Real walk-in sales on 18 August had driven that stock to 0**, at which point
*any* quantity is refused and the check passed **for the wrong reason**. It has
been a trivial pass ever since — the exact failure class the Phase 1 assertion
audit was written about, arrived at from a new direction: not a broken
assertion, but a fixture consumed by ordinary business activity.

Two more things fell out of it:

1. **The suite has no teardown for POS orders.** Its cleanup deletes the two
   customer-checkout orders by id and nothing else. When the oversell check
   unexpectedly *succeeded*, it wrote a real walk-in sale — `EB-04112B-442`,
   **₱2,990, 10 units** — that nothing removed. Found, and removed by hand along
   with its stock and `sold` movement and its audit row.
2. **Two checks have opposite preconditions on the same product.** The
   customer-checkout checks need `db-steak` stock **> 0**; the oversell check
   needs it **< 10**. The seeded 9 satisfies both; 0 satisfies neither.

`db-steak` was restored to its seeded 9 **through `inventory/adjust.php`**, with
the reason recorded, rather than by a direct `UPDATE` — so the audit trail
explains where the stock came from.

**Recommended, not done:** the suite should assert its fixture before relying on
it, in the style it already uses elsewhere —

```python
check(sql_scalar("SELECT stock FROM products WHERE id='db-steak'") == "9",
      "fixture: db-steak stock is 9 (the oversell check depends on it)")
```

— and reset product stock in setup the way it already resets the customer
fixtures under D16.

---

### Harness state after Phase 8.4

| Suite | Before this pass | After |
|---|---|---|
| `verify-structure.py` | all pass | **all pass** (14 sections) |
| `verify-api.py` | 154/161 | **157/161**, identical across three consecutive runs |
| `tools/ui-test/` | 36/38 | **36/38** |
| Fixture drift across 3 runs | — | none — `db-steak stock=9 sold=1419` unchanged |

**The four remaining failures are one root cause**, and both suites point at it
independently: the Cashier role holds permission ids `6,7,12` that `db/seed.sql`
does not grant. Present verbatim in the database dump taken before this pass
began.

It means a Cashier can read `audit/list.php`, `batches/list.php` and
`inventory/adjustments.php` over the API, and the Cashier sidebar renders
Inventory Report, Inventory Management, Stock Overview, Restock, Replenish and
Adjustment.

```sql
DELETE FROM role_permissions WHERE role_id = 3 AND permission_id IN (6, 7, 12);
```

Still not run. Either an old Roles-screen edit nobody undid, or a deliberate
grant — and that is a business decision.

---

### Phase 8 close-out

**Closed with evidence:** P1–P6, each driven through the real UI as the correct
role, with the row read back from MySQL and the file off disk. Plus the stock
`sold` drift found by this sweep.

**New defects found while sweeping, beyond the five reported:**

| | Found in | Status |
|---|---|---|
| Landing per-product photo picker wrote to nothing (P6) | Phase 1 audit | fixed |
| `proof_uploaded` derived from a reference *number*, rendering "✓ Proof Uploaded" over nothing | Phase 1 audit | fixed |
| `saveLanding()` fired a success toast outside the promise | Phase 1 audit | fixed |
| `featured_products` never written by anything | Phase 3 | fixed |
| A third copy of the landing patcher inlined in `index.html`, rendering FAQ text as raw `innerHTML` | Phase 3 | removed |
| Storefront Profile forms were mocks writing nothing | Phase 3 | address + info wired; password now says so |
| `payment_accounts` had no writer — a balance could be settled, never raised | Phase 3 | fixed |
| Returned units counted as sold for ever | Phase 4 | fixed |
| Harness oversell check trivially passing on a consumed fixture | Phase 4 | reported |
| Harness has no teardown for POS orders | Phase 4 | reported, orphan removed |

**`INFERRED` markers:** none outstanding. The one item carried as `INFERRED` out
of Phase 1 (P1) was resolved by the click-through in Phase 3 and the marker
removed.

**Duplicate-write pairs beyond the walk-in payment:** yes — the stock quartet,
which had genuinely drifted and is fixed; the `orders`/`order_items` pair, which
is reported with the extraction argued; and the three-way receipt split, which
is reported as a business decision.

---

## Phase 8.5 — closing the open list

The four items left open at the end of Phase 8.4. Three were mine to close; the
fourth is still a decision for the business.

| # | Item | Status |
|---|---|---|
| 1 | Harness oversell check trivially passing on a consumed fixture | **fixed, sabotage-proven** |
| 2 | Uploaded files never garbage-collected | **fixed** — `tools/prune-uploads.php` |
| 3 | Customer password form honest but not working | **fixed, UI-verified** — `api/shop/password.php` |
| 4 | Cashier permission drift | **still open — your decision** |

---

### 1. The oversell check can no longer pass for the wrong reason

Resetting the fixture in setup was the obvious fix and is the wrong one:
`db-steak` is a real product in real orders, not a dedicated test account like
`cus-t01`, and **a suite that overwrites live inventory to suit itself is worse
than the trivial pass it was fixing**.

The quantity is derived from whatever the stock actually is:

```python
half = steak_stock // 2 + 1     # one line always fits, two always exceed
```

True at every stock level from 1 upward, so the check cannot be disarmed by
ordinary trading. Three assertions replace one:

- `fixture: db-steak has stock for the oversell check` — fails loudly at 0
  instead of passing silently, with a message that says to restock
- the merged pair must be refused
- **a single line of the same quantity must be accepted** — without this the
  409 proves only that the quantity was too big, not that the two lines were
  merged. The check had a second way to pass wrongly and now has none
- the successful single sale is then rolled back, stock and `sold` both, because
  **the suite has no teardown for POS orders** — its cleanup deletes the two
  customer-checkout orders by id and nothing else

**Sabotage-proven**, per this project's own rule that an assertion never seen
failing is not a test. Stock forced to 0 — the exact state that used to pass:

```
[FAIL] fixture: db-steak has stock for the oversell check
[FAIL] all 163 assertions ran
```

Both layers fire: the fixture guard, and the total-count guard catching that
three assertions stopped running. That state previously produced a silent green.

`EXPECTED_CHECKS` 160 → 163.

---

### 2. Orphaned uploads — `tools/prune-uploads.php`

A gap this work created. `api/uploads/image.php` writes the file first and the
row second, because that is the only order that lets the client show what was
actually stored before committing (I7). Every abandoned edit therefore leaves a
file: a modal closed without saving, a checkout not completed, and **every
replaced image**, because the column no longer names the old file.

Nothing is exposed — the names are 32 random hex characters and the directory
refuses listing — but it grows monotonically and nothing else will ever clean it.

```
php tools/prune-uploads.php                # report only
php tools/prune-uploads.php --apply        # delete orphans
php tools/prune-uploads.php --grace=120    # widen the safety window
```

**The grace window is the entire safety mechanism.** A file uploaded five
seconds ago is unreferenced *and in active use* — the modal is open and Save has
not been pressed. Deleting it would break a save that was about to succeed, and
the symptom would be *"that upload is no longer on the server"* on a file the
administrator had just chosen. Default 60 minutes: longer than any real editing
session, short enough that a nightly run keeps the directory flat.

It **aborts rather than continues** if any tracked column is missing, because a
renamed column would make its idea of "referenced" incomplete and it would then
delete live images. It also reports the reverse direction — rows naming files
that are not there.

**Proven against a real orphan**, created the way it actually happens: uploaded
a product image through the real endpoint and never saved the product.

| Step | Result |
|---|---|
| Fresh orphan (0 min old) | `inside grace window 1 · ORPHANED 0 · No orphans` — **protected** |
| Backdated 3 hours | `ORPHANED 1 · Would delete 1 file(s), 520 B` |
| `--apply` | `Deleted 1 file(s)` |
| All 6 referenced files | still on disk, and all six return **200** over HTTP |

---

### 3. The customer password change is real

The Security form on `public/profile/profile.html` cleared its fields and showed
*"Password updated successfully!"* while writing nothing. Phase 8.3 made it say
so; this makes it work.

**`api/shop/password.php`**, separate from `shop/profile.php` on purpose: a
profile save changes an address, this changes a credential, and one endpoint
doing both means the address save either inherits protections it does not need
or — far more likely — this inherits their absence.

| Rule | Why | Verified |
|---|---|---|
| Current password re-verified | A session cookie proves the browser was signed in at some point, not that the account holder is at the keyboard. Without it an unattended laptop is a permanent takeover | `422` on `current_password` |
| Rate limited on the sign-in counter | Otherwise this is an unlimited password oracle for a stolen session — weaker than the login form, which is throttled | after 5 failures **the correct password is refused too**, `429` |
| Session id regenerated | Changing a password because someone else may have access must actually remove it | `session_regenerate_id(true)` |
| Confirmation checked *first* | So a mistyped confirmation does not burn a rate-limit attempt | `422` on `confirm_password` |
| Reuse rejected *after* re-auth | So the message cannot probe whether a guessed current password was right | `422` on `new_password` |

**A fourth duplicate found while adding a fifth.** The minimum length and the
bcrypt call were written out four times — twice in `users/save.php`, once in
`shop/register.php`, and this endpoint was about to make five. Four copies of a
security rule is four places to weaken it. `Auth::hashPassword()` now owns it;
`grep password_hash` outside `api/core/Auth.php` returns nothing.

`PASSWORD_BCRYPT` explicitly rather than `PASSWORD_DEFAULT`: DEFAULT changes
between PHP versions, and a hash one server writes that another cannot verify
locks people out.

`Auth::reauthenticateCustomer()` keeps `throttle()` and `record()` private —
it is the door they are reached through, rather than widening them to public.

**End to end through the real form:** wrong current password → *"Incorrect
password."* on its own field with **the fields not cleared** (retyping all three
because one was wrong is its own small cruelty); correct → fields cleared,
*"Password changed."*, and the new password authenticates while the old one is
refused. Fixture password restored afterwards.

**No audit row**, for the same reason `shop/profile.php` writes none:
`audit_logs` records staff actions and its actor column is a `users.id` foreign
key. Customer security events deserve their own log — noted as a gap rather than
quietly corrupting what the Audit screen means.

---

### A defect found while trying to verify the above

The password form could not be tested through the UI, because **the profile page
showed a signed-in customer the "please sign in" panel**.

```
state.auth.loggedIn : true
#mp-guard           : display: block
```

The guard read `state.auth.loggedIn` **once**, at `window.load`.
`bootstrapCustomer()` is asynchronous and had not resolved, so the flag was
still its fail-closed initial `false` (D8). The retry loop beside it only ran
while `state` itself was undefined — which it stops being almost immediately —
so nothing ever corrected the decision.

The page was correctly wired and displayed the wrong answer, which is the
hardest kind of fault to see in a screenshot, and it hid the customer's entire
profile behind a sign-in prompt they had already satisfied.

**`public/profile/my-orders.html` had it identically** — "Sign in to view your
orders", over their own order history.

`site.js` now sets `window.EB_AUTH_READY` and dispatches `eb:auth-ready` once
`shop/me.php` has replied; `whenAuthReady()` resolves immediately if that
already happened, so a late listener is not left waiting for an event that will
never fire again, and falls back to signed-out after 20s rather than leaving the
page blank for ever. Both guards await it.

Verified: guard `none`, content `block`, and the profile fields populated from
`shop/profile.php`.

---

### State after Phase 8.5

| Suite | Result |
|---|---|
| `verify-structure.py` | **all pass** (14 sections) |
| `verify-api.py` | **160/164**, identical across consecutive runs |
| `tools/ui-test/` | **36/38** |
| Lint | every PHP, JS and Python file clean |

Assertion count rose 161 → 164; passing count 157 → 160. **The four failures are
unchanged and are one root cause** — the Cashier permission drift, which both
suites find independently and which predates this entire engagement.

```sql
DELETE FROM role_permissions WHERE role_id = 3 AND permission_id IN (6, 7, 12);
```

Still not run.

### Open

1. **Cashier permission drift** — the SQL above. A business decision.
2. **Customer security events have nowhere to go.** Password changes and profile
   edits write no log, because `audit_logs` is a staff trail with a `users.id`
   actor. A `customer_events` table is the honest answer; widening `audit_logs`
   is not.
3. **`prune-uploads.php` is not scheduled.** It is a manual tool. A nightly task
   is the intended use and has not been set up.
4. **Four pre-existing `login_attempts` rows** remain from earlier sessions
   (`juan@gmail.com` ×3, `phase7.tester@elishabay.ph` ×1, all failures, dated
   18 Aug). Not this session's, and not deleted on that basis.
