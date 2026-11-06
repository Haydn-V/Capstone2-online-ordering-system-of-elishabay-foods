# Error register — full system sweep

**Originally diagnosis only.** The plan at the end was agreed and is now being
executed in order; each finding carries its current status. Findings still
marked open have not been touched.

> **Phase A (security) — complete.** A1, A2, A3 closed and verified. E3 was
> fixed alongside A1 because it lives in the same function.
>
> **Phase B (correctness) — complete.** B2, B3 closed and verified; B1 was
> already done with A1.
>
> **Phase C (dead features) — complete.** C2/C3 deleted on instruction. C1 was
> misdiagnosed: the owner identified it as the B2B partner registration, which
> turned out to be a complete form on a different page that submitted nowhere —
> built, with the email flow. Two further security findings (S1, S2) surfaced
> while building it and are fixed.
>
> Open: **Phase D** (D1, D2, D4 — the deployment gate), E9, and the orphan
> `#contact-form` handler. See the phase logs at the end.

Swept 22 August 2026 against the live install (XAMPP, `http://localhost/elishabay/`,
MariaDB 10.4.32, PHP 8.2.12). Nine classes of error were looked for. Where a
finding is asserted it was reproduced, not inferred; where it was not reproduced
that is stated.

---

## What was checked, and what came back clean

Recording the clean results matters as much as the findings — it says where the
plan does *not* need to spend effort.

| Class | Method | Result |
|---|---|---|
| PHP runtime errors | Apache/PHP error log since install | **clean** — last application error 18 Aug (the already-fixed `actor_user_id` incident) |
| Portal JS errors | all 24 modules driven as Super Admin | **clean** — 0 exceptions, 0 empty panels |
| Portal network errors | every request during that sweep | **clean** — 62 requests, all 200 |
| Foreign-key integrity | 15 relationships | **clean** — 0 orphans |
| Money arithmetic | order totals vs line items, negatives, refund caps | **clean** |
| Image path integrity | 3 columns + disk | **clean** — 0 non-canonical, 0 dangling, 0 orphaned files |
| Duplicate keys | 6 uniqueness rules | **clean** |
| SQL injection | every query in 50 endpoints | **clean** — fully parameterised, no string interpolation |
| Broken internal links | every `href`/`src` in every HTML file | **clean** |
| Image `alt` attributes | all static `<img>` | **clean** — 0 missing |
| File exposure | 8 sensitive paths over HTTP | **clean** — all 404 |
| Endpoint orphans | 50 endpoints vs all callers | **clean** — every one has a caller |
| Lint | all PHP, JS, Python | **clean** |
| Debug residue | `console.log`, `debugger`, `alert()`, inline `on*` | **clean** — 1 deliberate fallback in `ui.js` |
| Structure suite | `verify-structure.py`, 14 sections | **all pass** |

---

## Findings

Severity is about consequence, not effort.

| # | Severity | Finding | Reproduced |
|---|---|---|---|
| **E1** | **High** | Stored XSS on the public storefront | ✅ payload executed — **FIXED (A1)** |
| **E2** | **High** | Cashier holds three permissions the seed does not grant | ✅ both suites — **FIXED (A2)** |
| **E3** | **Medium** | Every toast on both customer account pages throws | ✅ live — **FIXED (with A1)** |
| **E4** | **Medium** | `orderTotal()` infinitely recurses; shadows a correct copy | ✅ `RangeError` — **FIXED (B2)** |
| **E5** | **Medium** | Contact form has a handler and no form | ✅ 0 elements — **CLOSED**: the real feature was the B2B partner registration (built, C1); the orphan handler is **deleted** |
| **E6** | **Low** | Hero accordion never renders | ✅ 0 panels — **DELETED (C2)** |
| **E7** | **Low** | 3 more dead element ids | ✅ absent — **DELETED (C3)** |
| **E8** | **Low** | `proof_uploaded = 1` on 30 orders with nothing to verify | ✅ SQL — **FIXED (B3)**, live data and seed |
| **E9** | **Info** | 5 seeded orders claim to have overpaid | ✅ SQL — **CONFIRMED INTENTIONAL** by the owner, 23 Aug. Documented in `db/seed.sql`. Not a defect |
| **D1–D4** | **Blocker (deploy only)** | Four production-readiness settings | ✅ config — **D3 FIXED (A3)**; D4 deferred by decision; D1/D2 at the deploy gate |

---

### E1 — Stored XSS on the public storefront · **High**

`assets/js/public/site.js` builds markup with template strings: **31 `innerHTML`
assignments and 2 escaping calls.** Product name, description and category, and
the landing content, are interpolated raw into the DOM.

The portal does not have this problem — `engine.js` makes 107 `escHtml()` calls
against 29 `innerHTML`, `orders.js` 66 against 23. The storefront is the half
that never got an escaper.

**Reproduced end to end.** A product description was saved through the real
`products/save.php` — which applies no HTML sanitisation — and loaded on
`shop.html` as an anonymous visitor:

```
saved:    Gourmet dried herring.<img src=x onerror="window.__XSS_FIRED=1">
result:   window.__XSS_FIRED === 1        ← executed
          injected element present in the product card
```

Test data reverted immediately; the two audit rows it wrote were removed.

**Who can exploit it:** any account holding `products.manage` or
`landing.manage`. So it is not anonymous injection — it is *a staff account
becoming site-wide script execution against every customer*, including reading
their session. Combined with **E2** (a Cashier already holding more than the
seed grants) the blast radius is wider than the role table suggests.

**Also reachable through:** FAQ questions and answers, About/Vision/Mission, and
the contact block — all rendered by the same unescaped path.

---

### E2 — Cashier permission drift · **High**

Carried forward from the previous pass and still open, because it is a business
decision rather than a defect to fix unilaterally.

The Cashier role holds permission ids `6, 7, 8, 10, 11, 12, 13`. `db/seed.sql`
grants `8, 10, 11, 13`. The extras `6, 7, 12` are present verbatim in the
database dump taken before any of this work began.

**Consequence:** a Cashier can call `audit/list.php`, `batches/list.php` and
`inventory/adjustments.php`, and their sidebar renders Inventory Report,
Inventory Management, Stock Overview, Restock, Replenish and Adjustment.

Both harnesses find it independently — 4 of the 4 remaining `verify-api.py`
failures and both `tools/ui-test/` failures are this one cause.

```sql
DELETE FROM role_permissions WHERE role_id = 3 AND permission_id IN (6, 7, 12);
```

Either an old Roles-screen edit nobody undid, or deliberate. **Needs a decision,
not a patch.**

---

### E3 — Every toast on the customer account pages throws · **Medium**

```js
function showToast(msg, type){
  const wrap = $("#toast-wrap");
  ...
  wrap.appendChild(t);        // no null guard
}
```

| Page | Container it declares |
|---|---|
| `index.html`, `shop.html`, `become-partner.html`, `batch-traceability.html` | `toast-wrap` ✅ |
| **`profile/profile.html`** | **`toast-root`** ❌ |
| **`profile/my-orders.html`** | **`toast-root`** ❌ |
| `portal/shell.html` | `toast-container` (portal uses `EbUI.toast`, which *is* guarded) |

Reproduced: `showToast('probe')` on the profile page →
`TypeError: Cannot read properties of null (reading 'appendChild')`, 0 toasts
rendered.

**Consequence:** on the two account pages, *every* confirmation and *every*
error message is silently lost and throws an uncaught exception —
"Address saved", "Personal info saved", "Password changed", and every failure
path. The underlying saves succeed; the customer is told nothing.

This is why it survived the previous pass: those flows were verified by reading
the database, not by watching for a toast.

**Two defects, not one.** The id mismatch, and `showToast()` having no guard
while its twin `EbUI.toast()` in `core/ui.js` does — the same duplicate-
implementation drift catalogued elsewhere in `REMEDIATION.md`.

---

### E4 — `orderTotal()` infinitely recurses · **Medium**

`assets/js/portal/orders.js:15`

```js
function orderTotal(o){
  if(o && typeof o.total === "number" && isFinite(o.total)) return o.total;
  if(typeof orderTotal === "function") return orderTotal(o);   // calls ITSELF
  return 0;
}
```

The guard `typeof orderTotal === "function"` is always true, so the fallback
branch calls itself for ever. It was clearly meant to delegate to a different
function.

**It also shadows a correct implementation.** `engine.js:504` defines
`orderTotal` too, and `orders.js` loads after it — so the buggy version is the
live one **portal-wide**, for both files.

Reproduced in the running portal:

```
orderTotal({total: 123.45})     -> 123.45          ok
orderTotal({total: null, …})    -> RangeError: Maximum call stack size exceeded
orderTotal({total: "245.00"})   -> RangeError: Maximum call stack size exceeded
```

**Not currently reachable** through the API, because every endpoint casts
`(float)` before returning. That is the entire thing standing between this and a
portal-wide crash: **a string total is exactly what PDO returns for a DECIMAL
column when a cast is missed.** One new endpoint that forgets it takes down
Transaction History, the dashboard, Receipts and Payment Verification at once.

---

### E5 — The contact form does not exist · **Medium**

`site.js:2286` wires a submit handler to `#contact-form` and reads `#cf-name`,
`#cf-email`, `#cf-msg`. **None of the four elements exists in any HTML file.**

Reproduced on the live page: all four absent, `#contact` section present, and
`document.querySelector('#contact form')` → `null`.

The handler is optional-chained (`$("#contact-form")?.addEventListener`) so
nothing throws — it silently does nothing.

**Consequence:** the storefront has a Contact section and **no way for a
customer to send a message.** This is a missing feature wearing the costume of a
finished one — the same shape as the checkout upload that was a `<div>`.

Needs a decision: build the form (which implies an endpoint, storage and a staff
inbox) or remove the dead handler and keep the section informational.

---

### E6 — The hero accordion never renders · **Low**

`renderHeroAccordion()` returns immediately: `#hero-accordion` does not exist.
Live check → **0 `.acc-panel` elements**.

The hero *slider* is a different component, exists, and works — 4 tiles, and it
is what the Phase 8.3 landing-image proof exercised, so that result is unaffected.

Roughly 80 lines of accordion code — panel building, hover timers, click
handling — that has never run. Either the markup was removed and the code left,
or it was never added.

---

### E7 — Three more dead element ids · **Low**

`#stats-bar` and `#trust-badges` are queried by `site.js` and exist nowhere.
Both are guarded, so nothing throws; the features simply never appear.

Same class as E5 and E6. Listed separately because the decision is smaller:
delete the code, or supply the markup.

---

### E8 — `proof_uploaded = 1` on 30 orders with nothing to verify · **Low**

```
online / bank   pay_verified=1   9
online / gcash  pay_verified=1  12
walk-in / cash  pay_verified=1   9
```

30 orders carry `proof_uploaded = 1` with **no reference number and no image**.
This is the historical shape of that column: it was set from whether a reference
*number* was typed, and seeded rows set it directly.

**Currently harmless on the screen that matters** — all 30 have
`pay_verified = 1`, so **0 of them reach Payment Verification**. The Order Detail
modal still reports "Proof Uploaded: ✓ Yes" for them.

The writing side is already corrected (`Payments::orderFields()`); this is
residual data.

---

### E9 — Five seeded orders claim an overpayment · **Info, probably intentional**

| Order | Total | Claimed |
|---|---|---|
| ORD-20260612-001 | 1,277.00 | 1,290.00 |
| ORD-20260615-001 | 1,305.00 | 1,375.00 |
| ORD-20260616-001 | 1,870.00 | 1,915.00 |
| ORD-20260616-002 | 1,438.00 | 1,440.00 |
| ORD-20260617-002 | 897.00 | 919.00 |

Payment Verification has a MISMATCH indicator that compares `proof_amount` to
the order total, so these look like **deliberate fixtures exercising it** rather
than corrupt data. Flagged for confirmation, not for repair.

---

### D1–D4 — Production-readiness blockers · **Blocker before any deployment**

All four are correct for a XAMPP development box and fatal anywhere else. Three
are already documented in the code as dev-only; the fourth is not.

| | Setting | Current | Consequence |
|---|---|---|---|
| **D1** | `app.debug` | `true` | Unhandled exceptions return file paths, SQL fragments and table names to the caller |
| **D2** | `security.cookie_secure` | `false` | The session cookie travels over plain HTTP and is readable by anything on the network path — including a Super Admin's |
| **D3** | `db.user` | `root` | The application connects as the database superuser. A single injection or file-read becomes total database control. It should be a scoped account with rights to this schema only |
| **D4** | `db.password` | *(empty)* | MySQL root has no password. Anyone who reaches port 3306, or any local process, owns the database |

`api/config/config.php` is gitignored and 404s over HTTP, so these are not
currently *exposed* — but D3 and D4 are true of the server itself, not just the
file.

---

## Proposed plan

Ordered by consequence, then by whether one item blocks another. Each phase is
independently verifiable and independently shippable.

### Phase A — Security (do first)

| Step | Item | Work | Verification |
|---|---|---|---|
| A1 | **E1** storefront XSS | Give `site.js` an escaper and apply it to all 31 `innerHTML` sites. Prefer escaping at render over sanitising at write: escaping is reversible and lossless, stripping tags at save silently destroys an admin's copy | Re-run the exact payload; assert `window.__XSS_FIRED` stays undefined. Add it to `verify-structure.py` as a standing check that `site.js` escaping calls ≥ interpolations of DB fields |
| A2 | **E2** Cashier drift | **Your decision.** If it is drift, the one-line `DELETE`; if deliberate, update `db/seed.sql` so the seed and reality agree and the harness stops failing | 4 `verify-api.py` failures and 2 `ui-test` failures clear either way |
| A3 | **D3/D4** database credentials | Create a scoped MySQL user for the app; set a root password | App still runs; `root` no longer in `config.php` |

A1 and A2 interact: fixing A1 removes the payload, fixing A2 removes one route
to planting it. **Do both.**

### Phase B — Correctness

| Step | Item | Work | Verification |
|---|---|---|---|
| B1 | **E3** toasts | Align the two account pages on `toast-wrap`, **and** give `showToast()` the null guard its twin already has | Trigger a save on both pages and see the toast; assert 0 uncaught exceptions |
| B2 | **E4** `orderTotal` | Delete the duplicate in `orders.js` and let `engine.js`'s implementation stand; if a fallback is genuinely wanted, make it sum the line items | `orderTotal({total:null})` returns a number instead of throwing; add a duplicate-top-level-symbol check to `verify-structure.py` so the next shadowing pair is caught mechanically |
| B3 | **E8** residual `proof_uploaded` | One `UPDATE` setting it to 0 where there is no reference and no image | The SQL check returns 0 |

### Phase C — Dead features (needs your intent, not just engineering)

| Step | Item | Decision required |
|---|---|---|
| C1 | **E5** contact form | Build it (markup + endpoint + storage + somewhere staff read it) or remove the handler and leave the section informational. **Building it is the larger job and the one a customer would notice.** |
| C2 | **E6** hero accordion | Restore the markup or delete ~80 lines of dead code |
| C3 | **E7** `#stats-bar`, `#trust-badges` | Same choice, smaller |

Nothing here is broken in the sense of throwing — these are features that
silently do not exist. They are grouped so the decisions can be made together.

### Phase D — Deployment gate

D1 and D2 flipped, plus a re-run of every suite, immediately before any move off
this machine. Deliberately last: flipping `debug` off now would make development
harder for no gain while the machine is not reachable.

### Not scheduled

- **E9** — awaiting confirmation that the overpayments are intended fixtures.
- **Customer security events have nowhere to go.** Password changes and profile
  edits write no log, because `audit_logs` has a `users.id` actor column and a
  customer is not a user. A `customer_events` table is the honest fix; widening
  `audit_logs` is not.
- **`prune-uploads.php` is not scheduled.** It works; nothing runs it nightly.

---

## Suite state at the time of this sweep

| Suite | Result |
|---|---|
| `verify-structure.py` | **all pass**, 14 sections |
| `verify-api.py` | **160 / 164** — the 4 failures are all E2 |
| `tools/ui-test/` | **36 / 38** — both failures are E2 |
| PHP / JS / Python lint | clean |
| Orphaned uploads | 0 orphaned, 0 dangling |

**Every automated failure in the system traces to one cause: E2.** Everything
else in this register is something no suite currently looks for — which is why
each fix above carries a proposed check to add.

---

# Phase A — security · **complete**

All three steps closed and verified. E3 came with A1 because it lives in the
same function.

| Step | Item | Result |
|---|---|---|
| A1 | E1 storefront XSS | fixed, payload re-tested, standing check added |
| — | E3 toasts on account pages | fixed in the same function |
| A2 | E2 Cashier permission drift | seed restored, access confirmed closed |
| A3 | D3 app running as MySQL root | scoped account, constraints proved |

**All three suites are green for the first time in this engagement:**

| Suite | Before Phase A | After |
|---|---|---|
| `verify-api.py` | 160 / 164 | **164 / 164** |
| `tools/ui-test/` | 36 / 38 | **38 / 38** |
| `verify-structure.py` | all pass, 14 sections | **all pass, 15 sections** |

---

## A1 — storefront XSS

**Escaped at render, not sanitised at write.** Stripping tags when an
administrator saves silently destroys their copy — an ampersand in a product
name is not an attack — and it protects only rows written after the sanitiser
was added. Escaping at output is lossless and covers every row that already
exists.

`esc()` and `escAttr()` added to `site.js` (one implementation, two names so a
reader can see which context a call site is in), applied at **16 interpolation
sites** across the product card, cart, product detail, checkout summary,
receipt, FAQ list and certification badges.

**Re-tested with the exact payload that executed before**, planted through the
real Product Maintenance endpoint in *both* the name and the description:

```
name:  Tuyo Delizioso<script>window.__XSS_NAME=1</script>
desc:  Gourmet dried herring.<img src=x onerror="window.__XSS_FIRED=1">
```

| | Before A1 | After A1 |
|---|---|---|
| `window.__XSS_FIRED` | **`1` — executed** | `undefined` |
| `window.__XSS_NAME` | — | `undefined` |
| Injected `<img>` in the card | present | **none** |
| Injected `<script>` in the name | — | **none** |
| Rendered | as markup | as literal text |

Test data reverted; the audit rows it wrote were removed.

### The standing check

`verify-structure.py` §15, four assertions: `site.js` defines `esc()`; none of
nine known database-backed fields is interpolated raw; `showToast` escapes its
message; `showToast` survives a missing container.

It earned its place immediately — **it caught a `p.name` I had missed** on its
first run. That one turned out to be inside a `showToast()` call, which escapes
at its own boundary, so wrapping it again would have rendered `&amp;` to
customers; the check now removes `showToast(...)` arguments before scanning and
asserts the escaping there separately.

**Sabotage-proven**, per this project's rule that an assertion never seen
failing is not a test. Un-escaping the product description:

```
[FAIL] no database field is interpolated unescaped (9 checked)
       raw: p.desc (product description)
```

Restored, and green again.

### Still open on this front

`products/save.php` applies no HTML sanitisation, and by design — escaping is at
output. But **the portal renders the same fields**, and while `engine.js` and
`orders.js` do escape heavily, no check enforces it there. §15 covers the
storefront only. Worth extending.

---

## A2 — Cashier permission drift

Your decision: restore the seed.

```
before:  6 inventory.report · 7 inventory.manage · 8 sales.report
         10 payments.manage · 11 transactions.view · 12 audit.view · 13 pos.use
after:   8 sales.report · 10 payments.manage · 11 transactions.view · 13 pos.use
```

Live state now matches `db/seed.sql` exactly. `role_permissions` was dumped to
the scratchpad first.

**Verified as access, not just as a row.** Signed in as the Cashier:

| Endpoint | Before | After |
|---|---|---|
| `audit/list.php` | 200 | **403** |
| `batches/list.php` | 200 | **403** |
| `inventory/adjustments.php` | 200 | **403** |
| `orders/list.php` | 200 | 200 |
| `payments/list.php` | 200 | 200 |
| `pos/retailers.php` | 200 | 200 |
| `reports/sales.php` | 200 | 200 |

The Cashier's actual job is untouched; only the three drifted permissions are
gone. Both suites went green on this change alone.

---

## A3 — the application no longer runs as MySQL root

The app connected as the superuser with an empty password. Every injection,
every file-read, every endpoint mistake had the whole server behind it.

`elishabay_app@localhost` created with a 32-hex random password and **exactly
four privileges**:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON elisha_bay_db.* TO 'elishabay_app'@'localhost';
```

**No DDL, deliberately.** The application never issues `CREATE`, `ALTER` or
`DROP` — confirmed by grepping all 50 endpoints — and migrations are run by hand
from the command line, where they should need a deliberate act and a different
credential. `sql_mode` is pinned with `SET SESSION` via PDO's `INIT_COMMAND`,
which needs no privilege; confirmed still
`STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION`.

**The constraint was proved, not assumed:**

```
DROP TABLE audit_logs           -> ERROR 1142  DROP command denied
CREATE TABLE zz(i INT)          -> ERROR 1142  CREATE command denied
SELECT COUNT(*) FROM mysql.user -> ERROR 1142  SELECT command denied
```

And the application still works on it: storefront, login, and a real write
through `products/save.php` (INSERT + UPDATE + audit row) all succeed.

`api/config/config.example.php` — the committed template every install copies —
now carries the scoped account and the `CREATE USER` / `GRANT` recipe, instead
of `root` with an empty password.

### D4 deferred by your decision

**MySQL root still has no password.** Setting one breaks phpMyAdmin and any
other XAMPP project on this machine until their configs are updated, so it was
left. It remains a genuine hole in the *server*, not just in this application:
anything that can reach port 3306, and any local process, still owns the
database. It stays in the register as a deployment blocker.

---

## Phase A residue

Nothing left behind. `bg-tuyod` restored to its seeded name and description,
test audit rows removed, `role_permissions` and `config.php` backed up to the
scratchpad before each change. The generated database password is in the
scratchpad alongside them.

---

# Phase B — correctness · **complete**

| Step | Item | Result |
|---|---|---|
| B1 | E3 toasts on the account pages | already closed with A1 — same function |
| B2 | E4 `orderTotal()` recursion + shadowing | deleted, verified, standing check added |
| B3 | E8 residual `proof_uploaded` | live data and **the seed** corrected, both directions checked |

| Suite | After Phase A | After Phase B |
|---|---|---|
| `verify-api.py` | 164 / 164 | **166 / 166** |
| `verify-structure.py` | 15 sections | **16 sections**, all pass |
| `tools/ui-test/` | 38 / 38 | 38 / 38 |

---

## B2 — `orderTotal()`

**Deleted rather than repaired.** `engine.js:504` already had a correct
implementation; `orders.js` had a broken copy that, because it loads later, was
the one running portal-wide — for both files.

engine.js's version is strictly better and is why deletion was the right move
rather than fixing the duplicate in place: it handles a null order, **coerces a
numeric string**, and falls back to `txTotal(o.items)` with a `console.warn`
instead of silently returning 0.

**Before and after, in the running portal:**

| Input | Before | After |
|---|---|---|
| `{total: 123.45}` | `123.45` | `123.45` |
| `{total: "245.00"}` — the PDO DECIMAL case | **`RangeError`** | `245` |
| `{total: null}` | **`RangeError`** | `0` |
| `{items: []}` (no total) | **`RangeError`** | `0` |
| `null` | **`RangeError`** | `0` |

Every money screen re-checked afterwards — dashboard, Transaction History, Sales
Report, Receipts, Payment Verification, Order History: all render, **no `NaN`
anywhere**, no JS errors. The dashboard's ₱62,710 was cross-checked against
`SELECT SUM(total) FROM orders WHERE status='completed'` and matches exactly.

### Standing check — `verify-structure.py` §16

No top-level symbol may be declared in two of the four classic portal scripts.
253 top-level names across the four files, checked mechanically.

This covers **both** halves of the hazard: for `const`/`let` a redeclaration is a
SyntaxError that kills the entire portal (the failure that made the pre-RBAC
engines impossible to load side by side), and for `function` it is silent — the
later file simply wins, which is what happened here. The silent half is the
dangerous one, because nothing fails and the wrong implementation is just the
one that runs.

**Sabotage-proven:** redeclaring `statusChip` in `pos.js` →
`[FAIL] statusChip in pos.js, orders.js`. Restored, green.

---

## B3 — `proof_uploaded`

30 orders carried the flag with **no reference number and no image**. All 30
came straight from `db/seed.sql`, so correcting only the live database would
have reintroduced them on the next fresh install.

**Both were corrected.**

- Live: `UPDATE` → 30 rows.
- `db/seed.sql`: 30 rows edited.

The seed edit was verified by diffing against a backup rather than trusted:
**30 lines changed, and a line-by-line comparison confirmed every one of them is
a `proof_uploaded` 1→0 and nothing else.** Nothing else in the file moved.

None of the 30 was visible on Payment Verification — all had `pay_verified = 1`
— but the Order Detail modal reported "Proof Uploaded: ✓ Yes" for every one of
them.

### Standing checks — `verify-api.py`

Two assertions, deliberately in **both directions**:

- `no order claims a payment proof it does not have` — a flag with no evidence
  sends staff to verify something that does not exist.
- `no order hides a payment proof it does have` — evidence with no flag keeps a
  real payment off the screen that exists to check it.

The second is the one that would not have occurred to me from the defect alone:
the bug was in one direction, the invariant runs both ways, and only asserting
the direction that broke would leave the other free to break later.

**Both sabotage-proven**, one at a time:

```
UPDATE orders SET proof_uploaded=1 WHERE id='EB-1A2B3C-101'
  -> [FAIL] no order claims a payment proof it does not have

UPDATE orders SET proof_uploaded=0 WHERE id='ORD-20260822-AF91CC'
  -> [FAIL] no order hides a payment proof it does have
```

Restored; 166/166.

`EXPECTED_CHECKS` 163 → 165, so coverage cannot shrink without the total-count
guard firing.

---

## Phase B residue

None. Backups in the scratchpad: `orders.js.pre-B2`, `seed.sql.pre-B3`,
`orders.pre-B3.sql`. Database at 49 orders, Cashier permissions `8,10,11,13`,
both proof invariants at 0.

**Remaining from the register:** E5, E6, E7 (Phase C — dead features, needing a
product decision) and D1, D2, D4 (Phase D — the deployment gate).

---

# Phase C — dead features · **complete**

| Step | Item | Outcome |
|---|---|---|
| C1 | Contact form / partner registration | **Built** — turned out to be a different and larger defect than diagnosed |
| C2 | Hero accordion | **Deleted** on instruction |
| C3 | `#stats-bar`, `#trust-badges` | **Deleted** on instruction |

---

## C2 / C3 — 50 lines of code that had never run

`renderHeroAccordion()` (34 lines), `initCounters()`, `animateCounter()` and one
`#trust-badges` line. Every one guarded on an element that exists in no HTML
file in the project. Verified before removal: `.acc-panel` count **0** on the
live page.

The hero the site actually shows is the **slider** — a different component, four
tiles, working, and untouched. `#about-certs` and `#foot-certs` are real and
stay; only `#trust-badges` went.

After: 0 JS errors on the homepage, slider still 4 tiles with its image, certs
4 + 4, 6 FAQs, 3 best sellers, Contact section intact, all 6 public pages 200.

---

## C1 — the diagnosis was wrong, and the real defect was worse

E5 was catalogued as *"a contact form handler with no form"*. Asked what that
feature was for, the owner described the **B2B partner registration**: a
customer applies, staff accept, staff then email them.

That is a different page — `public/become-partner.html` — and it already
existed, complete: a twelve-field form, and a `b2b_applications` table with a
column for every field. The staff side worked. What did not:

```
fetch / EbApi calls in become-partner.html  : 0
endpoints in api/b2b/                       : decide.php, list.php   (staff only)
code anywhere that INSERTs an application   : 0
```

**A business owner filled in twelve fields, was shown "Application Submitted!",
and no member of staff ever saw it.** The only applications that could exist
were the eight seeded rows.

### And the form was more broken than that

The page's inline script ran during parse, **before** the deferred `site.js` it
depends on, so the first working line — `ICONS.eye` — threw

```
Uncaught ReferenceError: ICONS is not defined
```

which killed the function before it reached
`form.addEventListener('submit', ...)`. **The submit handler was never attached
at all**, so pressing Submit did a native form post and even the fake
confirmation had stopped appearing. Fixed by waiting for `DOMContentLoaded`;
deferred scripts run before it fires. Verified: the password eye toggle renders
again, which it had not.

### What was built

| Piece | |
|---|---|
| `api/b2b/apply.php` | Public endpoint. Full server-side validation, 3-per-IP-per-hour rate limit, duplicate-pending refusal, password hashed on arrival, application + staff notification + audit row in one transaction, acknowledgement email |
| `become-partner.html` | Wired to it. The confirmation panel appears **only after** the server returns a reference code; field errors land on their inputs and the form is left filled in |
| `api/core/Mailer.php` | Dependency-free SMTP client + log transport |
| `b2b/decide.php` | Emails the applicant on approve **and** reject; creates the partner account on approval |
| `storage/.htaccess` | **Security fix found while building this** — see below |

### Two things the form's own values forced

**Credit terms are normalised.** The dropdown offers `"Net 60 Days Credit
Terms"`; `b2b_applications.requested_terms` is seeded with `"Net 60"`,
`payment_accounts.scheme` stores `"Net 60"`, and `Payments::schemeLabel()`
produces `"Net 60"`. Storing the label verbatim would have put a value in the
column that nothing downstream matches. Mapped server-side, where canonical
values belong. `"Cash on Delivery"` is a real answer and stores NULL.

**Approval now creates the account.** `decide.php` carried the comment *"approval
does not invent one — the partner account is created at signup"*. There is no
separate signup: the application form collects a username and password precisely
because applying *is* the signup. Approving without creating it left an approved
partner with no way to log in. A rejected applicant still never gets an account.

### Proven end to end

```
form submitted  -> APP-2026-009 created, requested_terms normalised to "Net 60",
                   password stored as $2y$10$..., staff notification + audit row
approved Silver -> cus-12 created with status='retailer', application linked
sign-in test    -> that customer signed in with the password typed on the form
```

Rejection tested separately: a reason is still mandatory (422 without one) and
is sent to the applicant verbatim.

### The email is real, not asserted

The SMTP client was verified against a live SMTP server rather than only its log
transport. Full transcript captured:

```
EHLO localhost
AUTH LOGIN  -> credentials base64-decoded correctly at the far end
MAIL FROM:<no-reply@elishabay.ph>
RCPT TO:<lpascual@outlook.com>
DATA  -> multipart/alternative, RFC 2047-encoded subject, text + HTML parts
QUIT
```

`mailLive: true` on that request; `false` when using the log transport, so the
staff screen can tell the difference instead of implying delivery.

**Mail is never part of a transaction.** `Mailer::send()` does not throw and runs
after the commit. A decision is a database fact; rolling back an approval
because a mail server timed out would be the wrong trade every time.

`mail.transport` is back to `'log'`. Filling in `host`, `port`, `username` and
`password` in `api/config/config.php` switches on real delivery — for Gmail that
is `smtp.gmail.com:587`, `tls`, and an **App Password**, not the account
password.

---

## Two security findings uncovered while building C1

Neither was in the original register. Both were found by checking rather than
assuming, and both are fixed.

### S1 - storage/mail/ was world-readable · **High**

The mail log holds the full text of every email sent: recipient names, email
addresses, business details, application references.

```
GET /elishabay/storage/mail/probe.eml   ->   200   (whole message)
GET /elishabay/storage/mail/            ->   403   (listing already refused)
```

**The refused listing is what made it dangerous** — the directory looked
protected while any guessed or leaked filename returned the contents.

`storage/.htaccess` denies everything, next to the data rather than as a rule in
the project root, so a future `storage/exports/` is covered the moment it is
created. Verified 200 -> **403**.

### S2 - .gitignore pointed at a directory that does not exist · **High**

```
# User uploads (product images). Keep the folder, ignore its contents.
public/uploads/*
```

There is no `public/uploads/`. Uploads go to `/uploads/` at the project root
(decision I3) — so **nothing was ignored**: product photos, and worse,
`uploads/references/`, which holds customers' **GCash and bank payment
screenshots**, would have been committed to the repository.

`storage/` had the opposite problem: ignored so completely that
`storage/.htaccess` went with it, meaning a fresh clone would recreate the
directory with nothing protecting it.

Both corrected and verified with a real `git add --dry-run`: only `.htaccess`
and `.gitkeep` files are tracked; no `.webp`, no `.eml`.

---

## State after Phase C

| Suite | Result |
|---|---|
| `verify-structure.py` | **all pass**, 16 sections |
| `verify-api.py` | **166 / 166** |
| Lint | PHP, JS, Python clean |
| Public pages | all 6 return 200 |
| Exposure | `storage/mail/` 403, `uploads/references/` 403, `api/config/` 404 |

**Test data reverted.** `APP-2026-009` and `cus-12` deleted; `APP-2026-006` and
`APP-2026-007` returned to `pending`; `cus-09` back to `active`; notifications,
audit rows and `.eml` files removed. 8 applications and 3 retailers, matching
the seed.

## Still open

- **E5's original subject.** The orphan `#contact-form` handler in `site.js` is
  unrelated to the partner registration and is still dead code — it validates
  three fields that do not exist and shows *"Message sent"* without sending
  anything. Not deleted, because it was never decided.
- **E9** — the five seeded overpayments, awaiting confirmation they are
  deliberate MISMATCH fixtures.
- **Phase D** — D1 `app.debug`, D2 `cookie_secure`, D4 MySQL root password.

---

# Closing items · **complete**

Two decisions taken by the owner on 23 August, both actioned.

## The orphan `#contact-form` handler — deleted

Fourteen lines in `site.js` binding a submit handler to `#contact-form` and
reading `#cf-name`, `#cf-email`, `#cf-msg`. **None of those four elements has
ever existed in any HTML file in this project**, and the optional chaining meant
it silently bound to nothing.

Its own comment said *"JS validation only — no real submit"*: it called
`form.reset()` and showed *"Message sent — we'll get back to you!"* while
sending nothing anywhere. Had the markup existed, it would have lied to every
customer who used it.

Deleted once it was established this was **not** the partner-registration
feature. That is a separate page — `public/become-partner.html` — which now
genuinely submits via `api/b2b/apply.php` and emails the applicant.

The Contact section on the landing page is unchanged and still shows the
address, phone number and email. Verified after removal: 0 JS errors, contact
details rendering, hero slider 4 tiles, 6 FAQs, 3 best sellers, certs 4, cart
wiring intact.

**A re-sweep of `site.js` now finds no dead element ids at all** — every id the
storefront queries exists in markup, where the original audit found seven that
did not.

## E9 — confirmed intentional, and written down where it will be found

The five orders whose `proof_amount` exceeds their `total` are deliberate
fixtures. Payment Verification compares the two and renders **"✗ MISMATCH"**
when they differ (`assets/js/portal/orders.js:816`); without rows that actually
differ, that branch would never render and nobody would see the indicator work.

The figures are untouched. What changed is that `db/seed.sql` now says so, next
to the rows:

```
FIVE ROWS HAVE proof_amount > total ON PURPOSE.
  ORD-20260612-001  1277.00 / claimed 1290.00
  ...
Confirmed intentional by the owner, 23 Aug 2026. Do not "fix" these figures.
```

The comment exists because an integrity sweep flags `proof_amount > total` as an
anomaly and it looks exactly like corrupt data until someone knows why. This is
the second time that question has had to be asked; it should not be a third.

---

## Register status

Every finding from the original sweep is now closed or explicitly deferred.

| | Finding | Status |
|---|---|---|
| E1 | Storefront stored XSS | fixed (A1) + standing check |
| E2 | Cashier permission drift | fixed (A2) |
| E3 | Toasts throwing on account pages | fixed (with A1) |
| E4 | `orderTotal()` recursion + shadowing | fixed (B2) + standing check |
| E5 | Contact form handler with no form | closed — real feature built (C1), handler deleted |
| E6 | Hero accordion never renders | deleted (C2) |
| E7 | Three dead element ids | deleted (C3) |
| E8 | `proof_uploaded` on 30 orders with no proof | fixed (B3), live data **and** seed, + two standing checks |
| E9 | Five overpayment fixtures | **not a defect** — confirmed intentional, documented |
| S1 | `storage/mail/` world-readable | fixed (found during C1) |
| S2 | `.gitignore` missing the real uploads path | fixed (found during C1) |
| D3 | App running as MySQL root | fixed (A3) |
| **D1** | `app.debug = true` | **open — Phase D, deployment gate** |
| **D2** | `cookie_secure = false` | **open — Phase D, deployment gate** |
| **D4** | MySQL root has no password | **open — deferred by decision** |

**Final state:** `verify-api.py` 166/166 · `verify-structure.py` all pass,
16 sections · PHP, JS and Python lint clean · all six public pages 200 ·
`storage/mail/` and `uploads/references/` both 403 · no dead element ids in the
storefront.

Phase D is deliberately not done. `app.debug` and `cookie_secure` are correct
for a XAMPP development box and should be flipped as part of moving off this
machine, not before — turning them off now makes development harder for no gain
while nothing is reachable from outside.
