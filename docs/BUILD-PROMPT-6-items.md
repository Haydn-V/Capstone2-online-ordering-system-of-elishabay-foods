# Build prompt — the six scope items that were never implemented

> Paste everything below the line into Claude Code (or your coding agent) with the
> `elishabay` repo open. It is written to be handed over in one go.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system running on XAMPP.
Database: MySQL, schema `elisha_bay_db`. There is no framework, no Composer, and no npm build
step — do not introduce any.

This is the capstone system "Online Ordering System with Inventory and Order Management for
Juris Bay Foods." Its written Scope and Limitations promises six things the code does not do.
Your job is to build all six so the manuscript and the running system agree.

## Before you write anything

1. Read `docs/API.md` for the endpoint catalogue and the response envelope, and
   `docs/REMEDIATION.md` for the decisions already made about this codebase.
2. Read these files in full — they define every convention you must follow:
   - `api/core/bootstrap.php`, `api/core/Response.php`, `api/core/Validate.php`,
     `api/core/Auth.php`, `api/core/Stock.php`, `api/core/Mailer.php`, `api/config/db.php`
   - `api/orders/status.php` — the reference implementation for a guarded status change
   - `api/shop/my-orders.php` — the reference for a customer-scoped read
   - `api/shop/password.php` — the reference for a sensitive customer write
   - `db/migrations/005-customer-profile.sql` — the migration format you must copy
3. Match the house comment style. Every file in this repo opens with a comment saying **why**
   it exists and what it replaces, not what the code does line by line. Write the same.

## Rules that apply to every task

- **Every new endpoint** begins with `require __DIR__ . '/../core/bootstrap.php';` then
  `Response::requireMethod(...)`, then the auth call, then `Validate::check(...)`.
  CSRF is enforced globally inside `bootstrap.php`; the browser side must go through
  `EbApi` (`assets/js/core/api.js`), which attaches `X-CSRF-Token` automatically. Never
  hand-roll a `fetch()` for a non-GET call.
- **Customer endpoints are scoped by the session, never by a parameter.** Load the order or
  the payment record with `WHERE id = ? AND customer_id = ?` using
  `Auth::requireCustomer()['id']`. Return the *same* "Not found." for a record that does not
  exist and for one that belongs to someone else — do not leak which.
- **Any status change is a conditional UPDATE inside a transaction.** Copy the pattern in
  `api/orders/status.php`: `UPDATE ... WHERE id = ? AND status = ?`, then check
  `SELECT ROW_COUNT()`; if it is below 1, roll back and
  `Response::conflict('Somebody else just changed this order. Reload and try again.')`.
- **Write the audit trail.** Every state change inserts into `audit_logs`
  (`ts, actor, actor_user_id, type, description`). For an action taken by a customer,
  `actor` is the customer's name and `actor_user_id` stays `NULL` — see the end of
  `api/shop/checkout.php`. When `Database::hasTable('order_status_history')` is true, also
  insert a row there; `changed_by` is `NULL` for anything a customer or the system did.
- **Do not touch stock outside the existing rules.** Stock is committed when staff *accept*
  an online order and reversed when a committed order is cancelled. A `pending` order has
  never committed stock, so cancelling one must not call `Stock::reverseSale`.
- Update `docs/API.md` with each new endpoint as you add it.

---

# Task 1 — Customer order cancellation

The Scope names an "Order Cancellation Module." `public/profile/my-orders.html` renders a
**Cancel** button for pending orders, but its handler only calls `confirm()` and
`showToast()` — it never reaches the server, and no reason is captured. There is no
customer-facing cancel endpoint at all.

**Create `api/shop/cancel-order.php`**

- `POST`, body `{ "order_id": "...", "reason": "..." }`.
- `Auth::requireCustomer()`.
- Validate: `order_id` required; `reason` required, max 500 characters. A cancellation with
  no reason is not acceptable — the Scope says the reason is recorded.
- Load the order scoped by id **and** `customer_id`. Not found → `Response::notFound()`.
- **Only a `pending` order may be cancelled by the customer.** The Scope says "before they
  are approved for processing." Anything else → `Response::conflict()` with a message that
  names the current status, e.g. *"This order is already accepted and can no longer be
  cancelled. Contact us if you need to change it."*
- Transaction → conditional UPDATE to `cancelled` → row-count guard → `order_status_history`
  row (`pending` → `cancelled`, `changed_by` NULL, `note` = the reason) → `audit_logs` row →
  commit.
- No stock reversal (see the rule above — say so in the file's comment so the next reader
  does not "fix" it).
- Respond with the new status so the page can re-render without a second request.

**Wire `public/profile/my-orders.html`**

- Replace the toast-only handler. Prompt for a reason (a small modal, or a `prompt()` if you
  keep it minimal — but an empty reason must be refused client-side too), then
  `await EbApi.post("shop/cancel-order.php", { order_id, reason })`.
- On success, move the order into the Cancelled tab and re-render from the response.
- On failure, surface `err.message` in the existing toast. Handle `err.isAuth` the same way
  `loadMyOrders()` already does.
- Show the recorded reason on the cancelled order card.

*Done when:* a signed-in customer can cancel a pending order, the reason appears in the audit
log, and cancelling an accepted order is refused with a clear message.

---

# Task 2 — "Mark Received" confirmation

The Scope says the customer "confirms receipt by pressing the received button," which
completes the order. That button exists on `my-orders.html` for delivered orders and is also
a stub. Right now a delivered order has no route to `completed` except staff doing it
manually.

**Create `api/shop/confirm-received.php`** — a separate file, not a flag on Task 1. This
repo deliberately keeps one endpoint to one job (read the header of `api/shop/password.php`
for the reasoning).

- `POST`, body `{ "order_id": "..." }`.
- `Auth::requireCustomer()`, order scoped by customer id.
- **Only `delivered` → `completed`.** Any other current status → `Response::conflict()`.
- Same transaction, guard, history and audit pattern. `note` = "Confirmed received by
  customer." No stock movement — stock was committed at accept.
- Insert a `notifications` row of type `completed` so staff see the confirmation, following
  the insert in `api/shop/checkout.php` (id format `'n-' . bin2hex(random_bytes(5))`).

**Wire the button** in `my-orders.html` the same way as Task 1.

*Done when:* pressing Mark Received on a delivered order moves it to Completed in both the
customer's list and the staff Order Status screen.

---

# Task 3 — Automatic completion one hour after delivery

The Scope promises the system updates a delivered order to completed one hour after
delivery if the customer never confirms. Nothing schedules this.

There are two problems to solve: **there is no record of when an order became delivered**,
and **XAMPP has no scheduler**.

**Step 1 — record the delivery time.** Migration 006 (see the migration section below) adds
`orders.delivered_at DATETIME NULL`. In `api/orders/status.php`, set it to `NOW()` in the
same UPDATE that moves an order to `delivered`, and clear it to `NULL` if an order ever
leaves `delivered`. Do **not** depend on `order_status_history` for this — that table is
optional and guarded by `hasTable()` everywhere it is used.

**Step 2 — a sweep, not a cron.** Create `api/core/Orders.php` with a static
`autoCompleteDelivered(): int` that runs:

```sql
UPDATE orders
   SET status = 'completed'
 WHERE status = 'delivered'
   AND type = 'online'
   AND delivered_at IS NOT NULL
   AND delivered_at <= NOW() - INTERVAL 1 HOUR
```

and writes one `audit_logs` row per order it moves, with `actor` = "System" and
`actor_user_id` NULL, plus an `order_status_history` row (`changed_by` NULL, note
"Auto-completed one hour after delivery"). Return the number of orders moved.

**Step 3 — call it, throttled.** Call `Orders::autoCompleteDelivered()` at the top of
`api/orders/list.php` and `api/shop/my-orders.php`. Throttle it with a `settings` row
(`key_name = 'autocomplete_last_run'`) so it does no work more than once every five minutes;
read and write that row through the existing `settings` table rather than a file.

**Step 4 — make it schedulable too.** Also create `api/system/auto-complete.php`, a
CLI-and-HTTP entry point that calls the same function and prints the count, so the sweep can
be attached to Windows Task Scheduler on a real deployment. Guard the HTTP path so it
requires an authenticated user with `audit.view`, and let the CLI path (`PHP_SAPI === 'cli'`)
run unauthenticated. Document the Task Scheduler command in `docs/SETUP.md`.

*Done when:* an order marked delivered more than an hour ago flips to completed the next time
anyone loads an order list, and the audit log shows "System" as the actor.

---

# Task 4 — Emailed verification code for account changes

The Scope says: "the system sends a verification code to the registered email whenever the
user attempts to change important account details. The user must enter the correct
verification code to confirm and finalize the changes." No such code exists.

**Scope the rule precisely.** "Important account details" here means a change to the
**email address** or the **contact number** on `public/profile/profile.html`. Name and
address save immediately, as they do now. The password form keeps its existing
current-password re-verification (`api/shop/password.php`) and does **not** also require a
code — do not weaken or duplicate what is already there.

**Storage.** Migration 006 creates:

```
verification_codes
  id            VARCHAR(50)   PK          -- 'vc-' + 10 hex chars
  customer_id   VARCHAR(50)   NOT NULL    -- FK customers(id) ON DELETE CASCADE
  purpose       VARCHAR(40)   NOT NULL    -- 'profile_change'
  code_hash     VARCHAR(255)  NOT NULL    -- password_hash of the 6-digit code, never plain
  payload       TEXT          NOT NULL    -- JSON of the pending change
  attempts      INT           NOT NULL DEFAULT 0
  expires_at    DATETIME      NOT NULL
  consumed_at   DATETIME      NULL
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
```

Index `customer_id, purpose`. The code is stored hashed for the same reason a password is:
a leaked database must not hand over live account-change tokens.

**Flow.**

1. `api/shop/profile.php` — when the submitted email or contact differs from the stored
   value, do **not** write. Instead: invalidate any unconsumed code for that customer and
   purpose, generate a 6-digit numeric code, insert a `verification_codes` row expiring in
   10 minutes with the pending change as `payload`, email it with `Mailer::send()`, and
   respond `{ "requiresVerification": true, "ticket": "vc-…", "expiresIn": 600, "mailLive": … }`.
   Any non-sensitive fields in the same submission save immediately as they do today.
2. **New `api/shop/verify-code.php`** — `POST { "ticket": "...", "code": "123456" }`.
   `Auth::requireCustomer()`; the ticket must belong to the session customer. Refuse if
   consumed, expired, or `attempts >= 5`, incrementing `attempts` on every wrong code.
   On success: apply the `payload` to the `customers` row inside a transaction, stamp
   `consumed_at`, write an `audit_logs` row, and return the updated profile.
3. Front end: after a `requiresVerification` response, `profile.html` shows a code-entry
   panel (six-digit input, a countdown, and a Resend control that re-issues at most once a
   minute) instead of a success toast. Do not claim the change was saved until step 2 returns.

**If SMTP is not configured.** `Mailer::isLive()` already distinguishes real delivery from
the log transport, and `api/b2b/decide.php` already returns `mailLive` and `mailError` in its
response for exactly this reason. Follow that precedent:

- Always include `mailLive` in the response.
- When mail is not live, the code still goes to the mail log, and the endpoint additionally
  returns it as `devCode` **only** when the repo's existing debug/dev flag is on — find that
  flag in `api/config/config.php` / `config.example.php` and reuse it. Do not invent a new
  one, and never return `devCode` when mail is live.
- When mail is not live, the panel on `profile.html` says so plainly rather than pretending
  an email was sent.

*Done when:* changing the email address on the profile page produces a code, the change only
lands after the correct code is entered, a wrong code is refused five times then locked, and
the whole flow is demonstrable on a machine with no SMTP.

---

# Task 5 — Payment Scheme Module for retailers

The Scope promises retailers a place to "view all outstanding and upcoming payments in one
place," with notification when a payment nears its deadline or is overdue, "including any
penalties incurred." The `payment_accounts` table, the due dates, and the
`settings.penalty_rate` (2%) all exist, and staff can see them at `portal/views/payments.html`
— but there is no customer-facing screen at all.

**Create `api/shop/my-payments.php`** — `GET`, `Auth::requireCustomer()`.

- Only for a customer whose `status = 'retailer'`. Anyone else gets
  `Response::forbidden('Payment schemes are available to approved retail partners.')`.
- Return that customer's `payment_accounts` rows, scoped by `customer_id`, newest due date
  first, each with: scheme label (reuse `Payments::schemeLabel()`), original balance, due
  date, paid flag, `daysUntilDue` (negative when overdue), and the penalty accrued.
- Compute the penalty from `settings.penalty_rate` using the same rule the staff screen uses.
  **Read `api/payments/list.php` and `api/core/Payments.php` first and reuse their
  calculation** — if the customer's figure and the cashier's figure disagree, the feature is
  worse than not having it. If the rule lives only in the portal JavaScript, move it into
  `Payments` and have both sides call it.
- Include a summary object: total outstanding, count overdue, next due date.

**Create `public/profile/my-payments.html`**, modelled on `public/profile/my-orders.html` —
same shell, same auth guard, same `EbApi` usage, same empty/loading states.

- A banner at the top when anything is overdue (with the penalty) or due within seven days.
- A table of payments with a clear Paid / Due / Overdue state, using the storefront's existing
  status pill styles.
- Link it from the profile sidebar, **visible only when the signed-in customer is a
  retailer** — reuse whatever `shop/me.php` already returns to decide that; add the status to
  that response if it is not there yet.

*Done when:* an approved retailer sees their outstanding balances and penalties, the numbers
match the cashier's Payment Schemes screen exactly, and a regular customer never sees the
link or the endpoint.

---

# Task 6 — Courier tracking number

The stated Limitation says the system does not integrate with courier APIs, but that
"tracking numbers will be issued upon dispatch and will serve as proof of shipment." There
is no tracking-number field anywhere in the schema or the interface, so the limitation
currently promises something the system cannot do.

- Migration 006 adds `orders.tracking_number VARCHAR(60) NULL` after `batch_code_hint`.
- `api/orders/status.php` accepts an optional `tracking_number` in the body. It is
  **required** when moving an order to `shipping` where `order_type = 'delivery'`, and
  ignored otherwise. Validate max 60 characters. Save it in the same UPDATE, and include it
  in the audit description.
- Surface it in `api/orders/get.php`, `api/orders/list.php` and `api/shop/my-orders.php`.
- Portal: add the input to the shipping action on the Order Status screen
  (`portal/views/orderstatus.html` + `assets/js/portal/orders.js`), and show the value on
  the order detail and in Transaction History.
- Storefront: show it on the order card in `my-orders.html` for shipping and delivered
  orders, labelled so the customer understands they track it on the courier's own site.

*Done when:* staff cannot move a delivery order to shipping without entering a tracking
number, and the customer can see that number on their order.

---

# Migration 006

Create `db/migrations/006-scope-completion.sql`. **Copy the exact structure of
`db/migrations/005-customer-profile.sql`**: a header comment explaining why each change
exists, a `DELIMITER //` stored procedure guarded by `information_schema` lookups so the file
is safe to run twice, `CALL` then `DROP PROCEDURE`, no `USE` statement, and a verification
query in a trailing comment block.

It must add:

1. `orders.delivered_at DATETIME NULL` — Task 3.
2. `orders.tracking_number VARCHAR(60) NULL` — Task 6.
3. the `verification_codes` table — Task 4.
4. `order_status_history` if it does not exist (its definition is in
   `db/schema-additions.sql`) — several tasks write to it, and it is currently optional.

Also fold the same columns into `db/schema.sql` so a fresh install matches a migrated one,
and check whether `db/seed.sql` needs any adjustment.

---

# Order of work

1. Migration 006 + `db/schema.sql`, applied and verified against the live database.
2. Task 1 and Task 2 (endpoints, then the two buttons in `my-orders.html`).
3. Task 3 (needs `delivered_at` from step 1 and the completed transition from step 2).
4. Task 6 (small, and it touches `orders/status.php`, which step 3 also edits — do them
   close together).
5. Task 4.
6. Task 5.

After each task: run it against the real XAMPP database with the seeded data, confirm the
audit log entry appears, and update `docs/API.md`. Do not batch all six and test at the end.

If any spec above conflicts with a convention you find in the codebase, follow the codebase
and tell me what you changed and why.
