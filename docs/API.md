# API Reference — Elisha Bay

Base URL: `http://localhost/elishabay/api/`

Browser JavaScript cannot query MySQL. Every data operation goes through these
PHP endpoints, and only PHP touches the database.

---

## The rule that governs everything here

**Client-side checks are user experience. They are not security.**

`applyRBAC()` hides nav items and buttons the signed-in role lacks. That makes
the interface comprehensible — it does not stop anyone. Any person who can open
the site can also open a terminal and `curl` an endpoint directly, with a valid
session cookie and no interface at all.

Therefore **every endpoint checks authentication and permission for itself**,
server-side, before doing anything. An endpoint that trusts the client because
"the button is hidden" is a security hole. This is verified, not assumed: a
Cashier session calling `users/list.php` receives 403 even though a Cashier's
browser never renders that link.

Equally: never trust a value from the client because a form supplied it. Ids,
prices, quantities and hidden fields are all attacker-controlled. Money is
computed server-side and returned; the browser displays it, it does not decide
it.

---

## Response envelope

Every response, success or failure, uses one shape. Callers branch on `ok`.

**Success**

```json
{ "ok": true, "data": { }, "meta": { "page": 1, "limit": 25, "total": 42, "pages": 2 } }
```

`data` is the payload. `meta` appears only on paginated lists.

**Failure**

```json
{ "ok": false, "error": { "code": "VALIDATION", "message": "Please correct the highlighted fields.", "fields": { "email": "Enter a valid email address." } } }
```

`fields` maps a field name to a message so a form can render errors inline. It
is `{}` when the failure is not field-specific.

### Error codes and statuses

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION` | 422 | Input failed a rule. Check `fields`. |
| `BAD_REQUEST` | 400 | Malformed request, e.g. a body that is not JSON. |
| `UNAUTHENTICATED` | 401 | Not signed in, or the session expired. The client should show the login view. |
| `FORBIDDEN` | 403 | Signed in, but lacks the permission. Show a message; do not redirect to login. |
| `NOT_FOUND` | 404 | No such record. |
| `CONFLICT` | 409 | Violates a uniqueness rule, e.g. a duplicate email. |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP verb. |
| `RATE_LIMITED` | 429 | Too many failed sign-in attempts. |
| `SERVER` | 500 | Unhandled fault. Details go to the PHP error log, not the response, unless `app.debug` is on. |

Client-side only, produced by `api.js` rather than the server: `NETWORK`
(unreachable), `TIMEOUT` (over 15s), `BAD_RESPONSE` (the body was not JSON,
which usually means a PHP fatal — check the error log).

---

## Authentication

Sessions are PHP's own, carried in an **httponly** cookie (`eb_session`, path
`/elishabay/`, SameSite=Lax). JavaScript cannot read it — which is the point.
All requests are same-origin and send it automatically.

Passwords are bcrypt hashes verified with `password_verify()`. No plaintext
password exists anywhere in the project.

The session stores a user id and nothing else. Role and permissions are re-read
from the database on **every** request, so archiving an account or changing its
role takes effect on the very next call rather than whenever the user happens to
sign out.

Idle sessions expire after `security.session_lifetime` (default 2 hours). The
session id is regenerated on sign-in to prevent session fixation.

---

### POST `auth/login.php`

Public.

**Request**

```json
{ "email": "cashier@elishabay.ph", "password": "…", "portal_role": "Cashier" }
```

`portal_role` is optional. When present, the account must hold that role or the
request is refused — this is what stops a Cashier signing in at the Super Admin
portal, and it is enforced here because the browser-side version of that check
stopped nobody.

**Response 200**

```json
{ "ok": true, "data": {
    "user": { "id": "emp-03", "name": "Ana Cruz", "email": "cashier@elishabay.ph", "avatar": "AC", "role": "Cashier" },
    "permissions": ["sales.report", "payments.manage", "transactions.view", "pos.use"]
} }
```

**Errors**

| Status | When |
|---|---|
| 422 | Email or password missing. |
| 401 | Wrong password **or unknown email** — deliberately the same message, so the endpoint cannot be used to discover which staff addresses exist. |
| 403 | Account archived, has no role, or does not match `portal_role`. |
| 429 | Too many recent failures (requires the `login_attempts` table). |

---

### GET `auth/me.php`

Requires a session. The front end bootstraps from this on every page load.

**Response 200** — same `user` and `permissions` as login, plus `catalogue`:
the full permission list (`permission_key`, `area`, `label`) for rendering the
Roles screen.

**401** when not signed in. `api.js` surfaces this as `err.isAuth`, and the
portal drops to its login view rather than rendering an empty dashboard.

---

### POST `auth/logout.php`

Destroys the session and clears the cookie. **Always returns 200**, even with no
active session — logging out of nothing is not an error, and a 401 here would
show a sign-in prompt to somebody trying to leave.

---

## CSRF

Authentication rides in a cookie, and browsers attach cookies to requests made
on any page's behalf — so a form on another origin could POST here carrying the
victim's session. `SameSite=Lax` blocks the classic cross-site form POST, but a
token the attacker's page cannot read is the actual defence.

- A token is minted per session and returned by `auth/login.php` and
  `auth/me.php` as `data.csrf`.
- `api.js` sends it back as an **`X-CSRF-Token`** header on every
  POST/PUT/DELETE, automatically.
- `bootstrap.php` enforces it centrally, so an endpoint cannot forget to.
- **GET is exempt.** A GET that changes state is itself the bug; no token fixes
  that.
- `auth/login.php` and `auth/logout.php` are exempt: there is no session to
  forge at login, and refusing a stale token on logout would strand a user who
  cannot leave.

A missing or wrong token returns **403** with code `CSRF`. (Not 419 — that is a
Laravel convention, not a registered HTTP status, and PHP silently turns it into
a 500 that reads as "the server broke" rather than "refused".)

Comparison uses `hash_equals`, so a wrong token cannot be discovered one
character at a time by timing.

---

## Uploads

### POST `uploads/image.php` — `multipart/form-data`

**The only upload endpoint in the system** (decision I1). Product photos,
landing content images and customer payment references all come through it.

Before it existed there were four upload controls and zero lines of
server-side upload code: two of them base64'd the file into a JSON body, two
sent nothing at all, and each screen had its own idea of where an image lives.
Three separate "the image doesn't show" defects came out of that. There is one
place now that decides what a valid image is, and one place that names the file.

**Body (multipart):**

| field | value |
|---|---|
| `file` | the image — JPEG, PNG or WebP |
| `purpose` | `products` \| `content` \| `references` |

**Permission is decided by `purpose`**, because it is decided by what the image
is *for*:

| purpose | who | requires | lands in |
|---|---|---|---|
| `products` | staff | `products.manage` | `/uploads/products/` |
| `content` | staff | `landing.manage` | `/uploads/content/` |
| `references` | customer | a customer session | `/uploads/references/` |

A staff session asking for `references` is refused, and vice versa. The check
runs before the file is looked at, so an unauthorised caller cannot use this as
a free image validator or a way to fill the disk.

**Returns:**

```json
{ "ok": true, "data": {
    "path": "/uploads/products/c8442dea7f6640f894ca2176a621073b.webp",
    "bytes": 2364, "width": 1600, "height": 800 } }
```

**The path is application-root-relative** — it starts at the project root, not
at the web server root, and never at the calling page. It is deliberately *not*
`/elishabay/uploads/…`: the install prefix is `app.base_path` in config and can
differ between machines, so baking it into every row would mean a database that
resolves on one deployment only. `EbFormat.imageUrl()` prepends the prefix.

Relative paths (`uploads/…`, `../uploads/…`) are what made staff screens resolve
an image while customer screens 404'd, so a stored value always begins with `/`.

**What it does to the file:**

- MIME read from the bytes with `finfo`. `$_FILES['type']` is a browser-supplied
  string and is not evidence of anything.
- Extension derived from the verified MIME. **The client's filename is never
  used** — not in the path, not for the extension, not stored anywhere. There is
  no traversal to defend against because no caller-supplied string reaches the
  path.
- Decoded by GD and re-encoded to WebP at quality 82, longest edge 1600. That
  drops EXIF, ICC profiles and anything appended to the container.
- Named `bin2hex(random_bytes(16)) . '.webp'`.
- Audit row written, attributed to the staff user or, for a customer upload,
  to their name with a NULL `actor_user_id`.

**Verified, not asserted.** A 2400×1200 JPEG with `<?php echo "PWNED"; ?>`
appended came back as a 1600×800 WebP with no trace of the payload; a text file
renamed `.jpg` was refused on MIME; an anonymous request got 401; a request
without the CSRF header got 403 code `CSRF`.

**Limits:** 8MB posted, 50 megapixels decoded (a 40,000×40,000 PNG is a few
hundred KB on the wire and about 6GB in memory — the byte cap does not catch it,
the pixel cap does).

**`/uploads/` has its own `.htaccess`** that stops PHP executing there. Read the
comments in it before changing it: the two obvious ways to write that rule both
fail, one with a blank 500 on every request and one silently.

**Reference uploads are remembered.** A successful `references` upload appends
its path to `$_SESSION['eb_issued_uploads']` (capped at 50, oldest dropped).
Nothing reads that list except `uploads/discard.php` below, and it is the only
reason that endpoint can be trusted with a path. `products` and `content`
uploads are deliberately *not* recorded: a staff member who is also signed in
as a customer in the same browser would otherwise be able to discard a product
photo through the customer-facing endpoint.

---

### POST `uploads/discard.php`

**Requires a customer session.** Deletes a payment screenshot that was uploaded
but never attached to an order.

**Body:** `path` — `/uploads/references/<32 hex>.webp`

**Why it exists.** `uploads/image.php` writes the file the moment the shopper
picks it, because uploading at submit time would mean a checkout that fails
halfway with the order already priced. The cost of that choice is orphans:
every screenshot removed or replaced before the order is placed is a file no
row will ever point at. The checkout's **Remove** and **Replace** controls call
this, so `uploads/references/` does not grow without bound.

**Why letting a client name a file to delete is safe here.** It doesn't. The
posted path is compared, whole, against `$_SESSION['eb_issued_uploads']` — the
list of paths `uploads/image.php` actually issued to *this* session — and the
absolute path is then built from the matched entry, never from the request. The
regex is defence in depth, not the gate: shape proves only that a string *looks*
like one of ours. A caller cannot delete another customer's screenshot, cannot
reach `/uploads/products/`, and cannot traverse.

**A path that reached an order is no longer discardable.** `shop/checkout.php`
removes the proof it used from the session list in the same request that writes
the order, so a shopper cannot place an order and then delete the payment
evidence staff are meant to verify.

**Idempotent.** A repeat discard, or one whose file is already gone, answers
200 — the caller asked for the file to be gone and it is gone. A path that was
never issued and a path that does not exist return the *same* message, so the
endpoint cannot be used to probe for other customers' uploads.

Writes an audit row, balancing the one `uploads/image.php` writes. Without it
the log shows a file being created and never mentions that it was thrown away.

---

## Products

### GET `products/list.php`

Requires any signed-in staff member. Not gated behind `products.manage`,
because the catalogue is displayed in POS, inventory and reports — screens that
read it without managing it. Writes are gated separately.

**Query**

| Param | Default | Notes |
|---|---|---|
| `page` | 1 | |
| `limit` | 25 | Clamped to 200. An absurd value is a typo, not a licence to fetch everything. |
| `search` | — | Matches name, id or description. |
| `category` | — | Category name. `All` is ignored. |
| `status` | `active` | `active`, `archived` or `all`. |
| `sort` | `name` | `name`, `price`, `stock`, `sold`, `newest`. Resolved through a whitelist — a sort column is an identifier and cannot be bound as a parameter, so it is never taken from input directly. |

**Response 200** — array of products with `meta` paging. Numeric columns are
cast at the edge, so `price` is a number and `best` is a boolean rather than the
strings MySQL returns for `DECIMAL` and `TINYINT`.

### POST `products/save.php`

**Requires `products.manage`.** Creates when `id` is absent, updates when
present — one endpoint because the validation, permission and audit rules are
identical, and two files would be two places to forget a rule.

**Body:** `id?`, `name`, `category_id`, `price`, `description?`, `tint?`,
`is_best?`, `image?`

**Deliberately not accepted: `stock`, `sold`, `rating`.** Stock moves only
through `inventory/adjust.php`, which records a reason and writes an audit row;
letting the product form set it would be a way to change stock with no trace.
Verified: a save posting `stock: 99999` leaves stock at its real value.

**`image` is a PATH, not an image.** Upload the file to `uploads/image.php`
first and send the `path` it returns. Accepted shape is exactly
`/uploads/products/<32 hex>.webp`, and the file must exist on disk.

A data URL is **refused**, with a message saying to upload first. It used to be
the only accepted form: the client posted the whole file inside this JSON body
and it went into `products.image_url` as LONGTEXT. Three rows held 1.81MB
between them, and every public storefront request carried all of it. Silently
accepting that shape into today's `VARCHAR(255)` would truncate it to 255
characters of base64 — a value that looks like data and renders as nothing.

**`image` is read three ways on update**, because "the key is missing" and "the
key is null" are different requests:

| Body | Result |
|---|---|
| key absent | keeps the stored photo — protects any caller that posts a partial body |
| `"/uploads/products/<32 hex>.webp"` | stored, after the shape and `is_file()` checks |
| `null` or `""` | `image_url` set to **NULL** — the photo is removed |

Until the Remove control was added, only the first two were reachable: the read
was `$image ?? $existing['image_url']`, so no request could clear the column and
a wrong photo could be replaced but never taken off. The audit entry
distinguishes *image set*, *image replaced* and *image removed*.

**Clearing or replacing an image leaves the `.webp` on disk.** Nothing is
unlinked inside the save. The file is not deleted here for the same reason
`uploads/image.php` writes the file before the row exists: at save time the only
thing known is that *this* row no longer names it, and a delete that raced a
second administrator's in-flight edit would produce "that upload is no longer on
the server" for a file they had just chosen. Collection is the job of
`tools/prune-uploads.php`, which checks **every** column that can name a file
(`products.image_url`, `hero_slides.image_path`, `orders.proof_image_path`) and
only touches files older than its grace window:

```bash
php tools/prune-uploads.php            # report only
php tools/prune-uploads.php --apply    # delete the orphans
```

Run it on a schedule; otherwise `/uploads/products/` grows monotonically and
nothing else will ever clean it.

`tint` must match `#[0-9a-f]{3,8}` — it ends up in a style attribute.

New ids are slugs in the seed's style (`bg-ui-test-tinapa-bangus`), uniquified
on collision, rather than an opaque timestamp.

The audit entry **names what changed**: `name 'X' → 'Y'; price ₱265.00 →
₱289.00`, not "Updated product X".

**Errors:** 403 · 404 unknown id · 422 (missing name, bad category, negative
price, bad tint, non-image data URL).

---

### POST `products/archive.php`

**Requires `products.manage`.** Body: `{ id, archived: true|false }`.

**Archive, never delete.** Orders and batches reference products under
`ON DELETE RESTRICT`; deleting one would either fail or take order history with
it. Archiving hides it from shop and POS while past transactions stay readable.

Returns a `notice` when archiving a product that still holds stock — the units
do not disappear and are still counted in inventory, which is better said than
discovered later. 409 if it is already in the requested state.

---

### POST `categories/save.php` · `categories/archive.php`

**Require `products.manage`.** Same create-or-update shape.

`archive.php` **refuses to archive a variety that still has active products**,
naming the count: *"Cannot archive 'Deboned Bangus' — 6 active products still
use it."* Otherwise those products would be filed under a variety that appears
in no filter — visible on some screens, missing from others, for no reason the
operator can see.

Duplicate variety names are refused with 409; the name appears in filters and on
the storefront, so a duplicate is confusing rather than merely untidy.

---

## Users

### GET `users/list.php`

**Requires `users.manage`.**

**Query:** `page`, `limit`, `search` (name or email), `status`
(`active` / `archived` / `all`).

Password hashes are never selected — the column does not appear in the query at
all, rather than being fetched and then removed.

**403** for any role without `users.manage`, including via a direct request.

---

## Categories

### GET `categories/list.php`

Requires any signed-in staff member. `?status=active|archived|all`.
Returns id, name, desc, archived and a live `products` count per category.

---

## Inventory

### POST `inventory/adjust.php`

**Requires `inventory.manage`.** The reference implementation for every write
endpoint — read it before adding another.

**Request**

```json
{ "product_id": "db-pesto", "qty": 50, "type": "restock",
  "reason": "Weekly production run",
  "batch_code": "JBF-2026-B120",
  "production_date": "2026-08-16", "expiry_date": "2027-08-16" }
```

`type` is `restock`, `disposal` or `return`. The **sign is decided server-side**
from the type — the client does not get to send a negative quantity. The three
batch fields are only read on a restock that opens a new lot; topping up an
existing batch is a valid restock with no lot code.

**Response 200** — the product's fresh stock level, read back from the database
rather than calculated in PHP, plus the signed `movement`.

**Errors:** 403 without the permission · 404 unknown product · 409 archived
product, duplicate lot code, or a removal that would drive stock negative ·
422 field errors.

**What makes it the pattern:**

- Permission checked before any work.
- Everything validated, including values the UI "already checks".
- Stock update, adjustment row, optional batch row and audit row all inside one
  transaction — they move together or not at all.
- **The audit entry is written here, not by the client.** If the browser were
  responsible for logging, the one action worth hiding is the one that would
  never get logged.
- Rolls back and rethrows on any failure.

---

### GET `batches/list.php`

Requires `batches.manage` **or** `inventory.report` — the list feeds both QA
Traceability and Expiration Monitoring, which different roles hold.

**Query:** `page`, `limit` (default 50), `product_id`, `lab_status`
(`passed`/`pending`/`failed`), `search` (lot code or product), `expiring_within`
(days), `sort` (`expiry`/`lot`/`product`/`remaining`).

**`days_to_expiry` is computed by MySQL against `CURDATE()`**, not by the
browser. `inventory.js` used to calculate it from `INV_TODAY = "2026-06-17"`,
a constant frozen in the file, so every "days left" figure drifted further from
reality each day. The response `meta` also carries `today`, which the client
records so all its date defaults use the same clock.

`expiring_within` deliberately includes already-expired lots: a batch that went
out of date last week is more urgent than one going next week, and excluding it
is how expired stock stays on a shelf.

Each row carries an `expiryLevel` band (`gone`/`crit`/`warn`/`ok`) so every
screen applies the same thresholds instead of re-deciding what "critical" means.

---

### GET `inventory/adjustments.php`

Requires `inventory.report` or `inventory.manage`. The stock adjustment log.

**Query:** `page`, `limit`, `product_id`, `type` (`disposal`/`return`), `search`.

Product name is joined, not stored on the row, so renaming a product does not
leave the log describing something that no longer exists under that name.

---

## Orders

### GET `orders/list.php`

Requires any of `orders.view`, `transactions.view`, `orders.accept`,
`orders.status` — the same list backs the Order Queue, Online Transactions and
Transaction History screens, which different roles reach.

**Query:** `page`, `limit`, `status` (one value or a comma-separated set),
`type`, `customer_type`, `pay_verified`, `search`, `from`/`to` (YYYY-MM-DD,
validated — a malformed date would otherwise match nothing and read as "no
orders that week"), `sort`.

**Line items are included**, fetched in one grouped query for the whole page.
A 25-row page costs 3 queries, not 27. `items` is never null; every renderer
maps over it without checking.

---

### GET `orders/get.php?id=…`

One order with items and **real status history**. The Order Status stepper used
to be inferred from the current status, so it could show that an order was
accepted but never who accepted it or when, and a cancelled order's path was
unrecoverable.

`price_at_purchase` is returned as stored — re-deriving line totals from the
product's current price would silently rewrite order history every time
somebody edited a price. The response also carries `computedTotal` and
`totalsAgree` so a mismatch between the stored total and its line items is
visible rather than hidden.

---

### POST `orders/status.php`

Requires `orders.status` or `orders.accept`. Body: `{ id, status, note? }`.

**The transition table is enforced here.** `STATUS_TRANSITIONS` in `engine.js`
decides what the modal offers — that is a dropdown, and it stops nobody from
posting `{"status":"completed"}` against a pending order, which would skip
payment verification entirely. The same table lives server-side and that copy
is the one that counts.

| Rule | Response |
|---|---|
| Illegal transition | 409, naming what *is* allowed from the current status |
| `completed` / `cancelled` | terminal — 409, "cannot be changed further" |
| `on-hold` / `cancelled` without a reason | 422 |
| `accepted` while `pay_verified = 0` | 409, "Verify the payment before accepting" |
| Another user moved it first | 409, "Somebody else just changed this order" |

That last one comes from a conditional `UPDATE … WHERE status = <what we read>`;
if no row matches, the move is abandoned rather than overwriting someone else's.

Writes `order_status_history` (from, to, who, note) and an audit row, in one
transaction.
**Courier tracking number (optional body field `tracking_number`).**

The stated Limitation says the system does not integrate with courier APIs but
that "tracking numbers will be issued upon dispatch and will serve as proof of
shipment". There was no field for one anywhere in the schema or the interface,
so the limitation promised something the system could not do.

- **Required** when a `delivery` order moves to `shipping` — the moment the
  promise is made and the only moment the number exists.
- **Ignored** for a `pickup` order and for every other transition, so a value
  posted alongside an unrelated status change is discarded rather than stored
  against the wrong event.
- Max 60 characters. An existing number is preserved through later transitions;
  a later `delivered` move does not wipe it.
- Appears in the audit description, because a shipment recorded without it is
  exactly the gap the field exists to close.

Its own field, not the free-text note. The note's placeholder used to read
*"e.g. Tracking number, reason for hold…"* — which is where the number went
before this: into a text blob nothing could read back. Proof has to be
retrievable.

**`orders.delivered_at`** is stamped in the same UPDATE that moves an order to
`delivered`, and cleared when it leaves. Same statement so the two can never
disagree; a column on `orders` rather than a lookup into
`order_status_history` because that table is optional and the one-hour sweep
must not silently stop running without it.

Surfaced as `trackingNumber` and `deliveredAt` by `orders/get.php`,
`orders/list.php` and `shop/my-orders.php`.

---

### POST `orders/verify-payment.php`

Requires `orders.accept`. Body: `{ id, verified, note? }`.

Verification is a human judgement about a payment proof. What the server does is
refuse the obviously wrong cases — no proof uploaded (for `gcash`/`bank`; cash
on pickup has none to upload), or an order already completed/cancelled — and
record who made the call, which is the part that matters when a payment is
later disputed.

A **short or over payment is reported, not blocked**: it returns a `mismatch`
string and writes it to the audit trail, because a partial may be accepted
deliberately. Testing this surfaced a seed-data inconsistency — order
`ORD-20260617-005`'s note claims "expected ₱2,390" while its line items compute
to ₱2,260.

---

## Point of Sale

### POST `pos/checkout.php`

**Requires `pos.use`.** Creates a walk-in order, decrements stock and writes the
audit entry — in one transaction.

**Body:** `items: [{id, qty}]`, `order_type`, `customer_type`, `pay_method`,
`customer_name?`, `contact?`, `address?`, `ref_num?`, `tendered?`,
`retailer_id?`

**Credit terms.** `pay_method` accepts `net30`, `net60` and `net90` **only when
`customer_type` is `retailer`**, and the accepted set comes from
`Payments::methods()` rather than a list written out in the endpoint. It used to
be a hardcoded `['cash','gcash','bank']` while the POS offered Net 30/60/90 the
moment a cashier picked "Retailer" — so a credit sale returned

```
422  pay_method: Payment method must be one of: cash, gcash, bank.
```

and `placeOrder()` had no branch for a `pay_method` field error, so **nothing
was displayed at all**. The cashier saw the button do nothing, no order row was
written, and the payment never reached Payment History. That was the reported
defect.

A credit sale requires `retailer_id` — a `customers.id` whose `status` is
`retailer`, re-checked against the database, not trusted from the dropdown. It
opens a `payment_accounts` receivable **in the same transaction** as the order,
the line items, the stock decrements and the audit row (decision I8): a sale
without its debt is money the business cannot see it is owed, and a debt without
its sale is one nobody can explain.

The response carries `creditAccount: {id, scheme, balance, dueDate}` for a
credit sale and `null` otherwise. The due date is computed by MySQL with
`DATE_ADD(CURDATE(), …)`; the receipt prints that value rather than deriving its
own.

`pay_verified` is **0** for a credit sale — nothing has been paid — and 1 for an
immediate method taken at the till.

---

### GET `pos/retailers.php`

**Requires `pos.use`.** The retailers a cashier may sell to on credit, with what
each already owes.

Not `customers/list.php`, which requires `users.manage` — a permission a Cashier
does not hold and should not — and returns every customer with their email,
contact number and join date. This returns `id`, `name`, `outstanding` and
`overdue` for retailers only. Same reasoning as `shop/products.php` against
`products/list.php`: give the screen the slice, not the permission to read the
whole table.

`outstanding` and `overdue` are computed against `CURDATE()` at read time, never
stored. They are shown next to the name in the picker because deciding whether
to extend more credit is a person's call, and not showing them the number is how
it stops being a call at all.

Archived customers are never returned.

**The client sends ids and quantities. Nothing else about money is believed.**
Prices come from `products.price`; line totals and the grand total are computed
here. **Verified:** a request sending `price: 1` and `total: 2` for two units of
a ₱285 product was charged ₱570.

| Guard | Behaviour |
|---|---|
| Duplicate lines for one product | Merged *before* the stock check. Two lines of 5 against 9 in stock would otherwise pass two separate checks and oversell. |
| Insufficient stock | 409, naming what is left and what was asked |
| Archived product | 409 |
| Cash under the total | 422 — checked against the **server's** total, not the browser's |
| Delivery without address / e-payment without reference | 422 |

Rows are locked with `SELECT … FOR UPDATE` for the life of the transaction: two
cashiers selling the last unit simultaneously would otherwise both read
`stock = 1`, both pass, and land at −1. The decrement is additionally guarded
with `WHERE stock >= ?`.

Pickups are `completed` on the spot; deliveries enter the fulfilment flow as
`accepted`.

The response carries everything the receipt prints, computed server-side, so the
printed figures and the stored figures cannot disagree.

---

### POST `users/save.php`

**Requires `users.manage`.** Create when `id` absent, update when present.

Passwords are hashed here and never stored, logged or echoed back. A blank
password on update means "leave it alone", not "clear it". Minimum 8 characters.

**Privilege escalation guard:** only a holder of `rbac.manage` may assign a role
that itself carries `rbac.manage`. Without this, an Admin — who holds
`users.manage` but not `rbac.manage` — could create a Super Admin account and
sign into it. **Verified:** that exact request returns 403, while the same Admin
creating a Cashier succeeds.

You also cannot change your own role: that is how an account either locks itself
out mid-session or quietly grants itself more.

### POST `users/archive.php`

**Requires `users.manage`.** Archive, never delete — `orders.cashier` and
`audit_logs.actor_user_id` reference users, so deletion would either fail or
detach the record of what they did.

Refuses two things: archiving **yourself**, and archiving the **last active
account that can manage roles**. The second is a door that locks from the
outside with the key inside — nobody could restore it or fix permissions
afterwards.

Takes effect immediately on a live session, because `Auth::user()` re-reads
status from the database on every request.

---

## Customers

### GET `customers/list.php`

**Requires `users.manage`.** Order count and lifetime spend are aggregated in
SQL, not by loading every order and summing in PHP. Cancelled orders are
excluded from spend. Walk-in orders (`customer_id NULL`) correctly count toward
nobody.

---

## Audit log

### GET `audit/list.php`

**Requires `audit.view`.** Filters: `type`, `actor`, `search`, `from`/`to`.

**Read-only, permanently.** There is no create, update or delete endpoint for
audit rows — a log the system can edit is not evidence of anything. Entries are
written by the endpoints performing the actions, inside their transactions.

`to` is expanded to `23:59:59`, or "up to today" would silently exclude
everything logged today. Rows flag `actorArchived` so a since-archived employee
is visible as such without rewriting the name history recorded at the time.

---

## Roles

### GET `roles/list.php` · POST `roles/save.php`

**Require `rbac.manage`.** Reading is already privileged — this screen decides
what everyone else can do.

A **system role (Super Admin) cannot be edited** and holds every permission by
definition; it owns no `role_permissions` rows, and `list.php` reports the full
catalogue for it so the matrix does not misleadingly show zero ticks.

You **cannot remove `rbac.manage` from your own role** — there is no way to undo
that from inside the application.

Unknown permission keys are rejected rather than silently dropped, so a typo
cannot leave the screen showing a permission as granted that was never stored.
Grants are replaced wholesale in a transaction; a partial apply would leave a
role holding a mixture of old and new rights. The audit entry names exactly what
was granted and revoked.

---

## Storefront (public)

These two are the only endpoints reachable without a session. Everything else
returns 401.

### GET `shop/products.php`

**Public.** The storefront catalogue.

Being public changes what may be returned. `products/list.php` is the staff
endpoint and includes stock counts and archived rows; none of that belongs on a
page anyone can open. This returns a coarse availability band (`inStock`,
`stockLevel`, `stockLabel`) instead of an exact count — "Low stock" is useful to
a shopper, "7 units left" is operational detail a competitor can poll.

### POST `shop/verify-code.php`

**Requires a customer session.** Completes a change `shop/profile.php` held back
pending an emailed code.

**Body:** `ticket`, `code` (six digits)

The Scope says "the system sends a verification code to the registered email
whenever the user attempts to change important account details". `profile.html`
has always carried the hint *"A verification code will be sent to confirm email
changes"* under the email input; the mechanism did not exist.

**Important means email and contact number** — the two ways an account is
reached and recovered. Name and address save immediately. The password form
keeps its own current-password re-verification (`shop/password.php`) and does
**not** also require a code; that would be two mechanisms guarding one door.

**The change waits, rather than being applied and rolled back.** `profile.php`
writes nothing sensitive — the pending values sit in
`verification_codes.payload` as JSON until a correct code arrives. An abandoned
verification leaves the account exactly as it was, with no window in which it is
reachable at an address the owner has not confirmed.

**The code goes to the address already on file**, never the proposed one.
Somebody holding a stolen session cannot receive it; the real owner does, and
learns an attempt was made.

| Rule | |
|---|---|
| Stored | `password_hash()` of the code, never the code. For the minutes it lives it is a bearer credential |
| Expiry | 10 minutes |
| Attempts | 5, counted **on the row** — a lockout a client can reset by clearing a cookie is not a lockout. A wrong code increments even if the request later fails for another reason |
| Resend | Reuses an unexpired code issued in the last 60 seconds rather than minting a new one. Otherwise Resend silently invalidates the code already in the inbox and the customer is told the one they can see is wrong |
| Replay | `consumed_at` is stamped conditionally, so a double-clicked button cannot apply the change twice |
| Uniqueness | `customers.email` is UNIQUE and is re-checked **at both ends** — someone can register the address during the ten minutes a code is live |

**This reverses a decision recorded in `shop/profile.php`.** Its note read *"never
the email … changing it is an account-recovery operation, not a profile edit."*
That was correct while nothing could prove the request came from the account
holder rather than from a stolen session. The code closes exactly that gap.

**`password_hash()` directly, not `Auth::hashPassword()`** — that helper enforces
the account password policy (`Auth::PASSWORD_MIN`, 8) and a six-digit code fails
it. Lowering the constant to fit would weaken every real password to accommodate
one unrelated thing. A code's strength is that it is random, single-use,
attempt-capped and short-lived, not that it is long.

**Without SMTP configured:** `mailLive` is `false`, the code still goes to
`storage/mail/`, and the endpoint additionally returns it as `devCode` — but
**only** when `app.debug` is on *and* mail is not live. Never when mail is live,
whatever debug says. The panel says plainly that no email was sent rather than
pretending one was.

**This one writes an audit row**, where an ordinary profile edit does not. An
email change moves where password resets and order confirmations go; if it
happens without the owner's knowledge there has to be something to find. The old
address is recorded, because afterwards it is the only place it still exists.

---

### GET `shop/my-payments.php`

**Requires a customer session, and `status = 'retailer'`.** The retailer's own
credit accounts.

The Scope promises retailers "all outstanding and upcoming payments in one
place", with notification when a payment nears its deadline or is overdue,
"including any penalties incurred". The `payment_accounts` table, the due dates
and `settings.penalty_rate` all existed, and staff could see them at
`portal/views/payments.html` — there was no customer-facing screen at all. A
retailer could find out what they owed only by asking the person they owed it to.

Scoped by the session's customer id, never by a parameter.

**A non-retailer is refused, not shown an empty list.** An empty list reads as
"you owe nothing" — true, but it answers a question a regular customer never
asked and implies a facility they do not have.

**The numbers come from the same place the cashier's do.**
`Payments::accountStanding()` was extracted from `api/payments/list.php` when
this endpoint was written, precisely so there is one calculation instead of two.
It was three lines and copying them would have been quicker; that is the mistake
this codebase has already paid for twice, with the stock quartet and the
`proof_uploaded` expression. A retailer shown a penalty a peso different from
the cashier's screen will not assume a rounding rule — they will assume they are
being overcharged.

Verified against an overdue account: customer and cashier both report
`balance 12800 · penalty 256 · totalDue 13056`.

Returns each account with `scheme`, `balance`, `dueDate`, `paid`,
`daysUntilDue` (negative when overdue — the sign carries the meaning),
`penalty`, `totalDue`, and a `state` of `paid` / `overdue` / `due-soon` /
`pending`. Plus a `summary`: `totalOutstanding` (**including penalties** — a
figure that quietly excludes them is the one that causes the argument at the
counter), `overdueCount`, `dueSoonCount`, `nextDueDate`, `penaltyRate`.

Overdue days are `DATEDIFF(CURDATE(), due_date)` in SQL, derived at read time
and never stored, so an account does not sit at "3 days late" for ever because
nobody reopened the page.

`public/profile/my-payments.html` is the screen, modelled on
`my-orders.html` — same shell, same auth guard, same `EbApi` usage. The sidebar
link is shown only to a retailer (`shop/me.php` now returns `status` for that),
which is presentation: the endpoint refuses everyone else regardless.

---

### POST `shop/password.php`

**Requires a customer session.** Changes the signed-in customer's own password.

**Body:** `current_password`, `new_password`, `confirm_password`

**Deliberately not part of `shop/profile.php`.** A profile save changes an
address; this changes a credential. One endpoint doing both would mean the
address save inherits re-authentication and rate limiting it does not need — or,
far more likely, this inherits their absence.

Three rules, each with a reason:

1. **The current password is re-verified.** A session cookie proves the browser
   was signed in at some point, not that the person at the keyboard is the
   account holder. Without this, an unattended logged-in laptop is a permanent
   account takeover.
2. **Rate limited on the same counter as sign-in** (`login_attempts`,
   `security.max_login_attempts`). Otherwise this is an unlimited password
   oracle for anyone holding a stolen session — weaker than the login form,
   which is throttled. Verified: after five wrong attempts, **the correct
   password is refused too**, with `429 RATE_LIMITED`.
3. **The session id is regenerated on success**, so any other session riding the
   old id dies. Changing a password because you fear someone else has access has
   to actually remove that access. The customer doing it stays signed in.

Refusals: a wrong current password is `422` on `current_password`; a mismatch is
`422` on `confirm_password`, checked *before* the current password so a mistyped
confirmation does not burn a rate-limit attempt; reusing the current password is
refused *after* re-authentication, so the message cannot be used to probe
whether a guessed password was right.

**Password rules live in `Auth::hashPassword()`** — minimum length and the
bcrypt call, in one place. They had been written out four times (twice in
`users/save.php`, once in `shop/register.php`, and this would have been a
fifth). `PASSWORD_BCRYPT` explicitly rather than `PASSWORD_DEFAULT`: DEFAULT
changes between PHP versions, and a hash one server writes that another cannot
verify locks people out.

**No audit row**, for the reason given under `shop/profile.php`. Customer
security events deserve their own log; widening the staff audit trail to hold
them would corrupt what the Audit screen means. Recorded as a known gap.

**What it replaces:** the Security form on `public/profile/profile.html` was a
mock — it cleared the fields and showed *"Password updated successfully!"* while
writing nothing.

---

### POST `shop/cancel-order.php`

**Requires a customer session.** Cancels the customer's own **pending** order.

**Body:** `order_id`, `reason` (required, max 500)

The Scope names an "Order Cancellation Module". `my-orders.html` rendered a
Cancel button whose handler called `confirm()` then `showToast("Order
cancelled")` — nothing reached the server, no reason was captured, and the order
stayed pending. There was no customer-facing cancel endpoint at all.

**The reason is mandatory** because the Scope says it is recorded, and because a
queue of orders that vanished without explanation tells the business nothing.
`orders/status.php` already refuses a staff cancellation without one.

**Only `pending`** — the Scope says "before they are approved for processing".
Any other status is a `409` naming the current one and saying what to do
instead, e.g. *"This order is already accepted and can no longer be cancelled.
Contact us if you need to change it."*

**Scoped by session.** A missing order and somebody else's order both return
`404 "Not found."` — telling the caller which would confirm the id is real.

**No stock reversal, deliberately.** An online order commits stock when staff
*accept* it, so a pending order has never committed any. Reversing it would
credit inventory that was never debited. `orders/status.php` reverses only from
a committed state, which this endpoint cannot reach.

Conditional UPDATE inside a transaction, `order_status_history` row
(`changed_by` NULL, note = the reason), audit row (`actor` = customer name,
`actor_user_id` NULL). Returns `{ id, status, reason }`.

---

### POST `shop/confirm-received.php`

**Requires a customer session.** Moves the customer's own **delivered** order to
`completed`.

**Body:** `order_id`

The Scope says the customer "confirms receipt by pressing the received button".
That button existed and was a stub; a delivered order had no route to
`completed` except staff doing it by hand.

**A separate file from `cancel-order.php` on purpose.** Both are "customer
changes their own order's status" and could share one endpoint with a `to`
parameter — but cancellation requires a reason and refuses anything but
`pending`, while confirmation requires none and refuses anything but
`delivered`. A shared endpoint carries both sets of branches and a parameter
deciding which apply, which is how a customer eventually cancels a delivered
order. Same reasoning as the header of `shop/password.php`.

No stock movement: stock was committed at accept, and the goods have already
left. Inserts a `notifications` row of type `completed` so staff see it.

Races with the auto-complete sweep are expected and handled — the conditional
UPDATE means whichever gets there first wins and the other is told to reload.

---

### GET · CLI `system/auto-complete.php`

Runs the one-hour delivered → completed sweep.

```
CLI:   php api/system/auto-complete.php
HTTP:  GET /api/system/auto-complete.php     (requires audit.view)
```

The Scope promises a delivered order becomes completed an hour later if the
customer never confirms. Nothing scheduled it, and nothing recorded *when* an
order became delivered — `orders.delivered_at` (migration 006) is that record.

**A sweep, not a cron.** XAMPP ships no scheduler, and a capstone that only
behaves correctly where somebody configured Task Scheduler does not behave
correctly. `Orders::sweepIfDue()` is called by `orders/list.php` and
`shop/my-orders.php`, throttled to once every five minutes through a `settings`
row (`autocomplete_last_run`) and wrapped so it can never turn somebody's order
list into a 500.

This endpoint is the same function behind a door a scheduler can knock on, so a
real deployment gets punctual completion instead of completion-on-next-page-load.
**One implementation, two routes** — there is no second copy of the rule to
drift. It calls `autoCompleteDelivered()` directly rather than `sweepIfDue()`:
a scheduler that asked for the run should get it, not be skipped because a page
load happened four minutes ago.

**The CLI path is unauthenticated** — a scheduled task has no session, and it is
reached only by something already running on the server, which has the database
credentials anyway. The HTTP path requires `audit.view`.

Audit rows are written with `actor` = **"System"** and `actor_user_id` NULL.
Attributing them to whichever staff member happened to load a page would make
the trail actively misleading.

---

### GET · POST `shop/profile.php`

**Requires a customer session.** The signed-in customer's saved contact number
and delivery address.

**Identity comes from the session and only from the session** (D6, D7). There is
no `customer_id` parameter and no `email` parameter — supplying one changes
nothing, because nothing reads them. Same rule as `shop/checkout.php`: an
endpoint that lets the client name the account is an endpoint that lets any
client edit any account.

**GET** returns:

```json
{ "id": "cus-t01", "name": "…", "email": "…", "contact": "0917…",
  "address": { "street": "…", "city": "…", "province": "…", "zip": "…",
               "region": "…", "line": "…, …, …", "hasAny": true } }
```

`address.line` is the joined single-line form the checkout textarea wants,
assembled server-side so the checkout and the profile page cannot each invent
their own way of joining five fields.

**POST** accepts `name?`, `contact?` and `address?: {street, city, province,
zip, region}`. Only the keys present are written; each address part is
independently clearable. It returns exactly what a fresh GET would.

**Not accepted: `email`** — it is the login identifier and the key other records
join on; changing it is account recovery, not a profile edit. **Not accepted:
passwords** — that needs the current password re-verified and its own rate
limiting, and a profile save that could also change credentials is a different
security problem wearing a form's clothes.

**No audit row is written.** `audit_logs` records staff actions against the
business's data — its actor columns are a staff name and a `users.id` foreign
key. A customer editing their own address is not that, and writing it with a
NULL `actor_user_id` would quietly turn the staff audit trail into a general
activity log that the Audit screen then pages through.

**One address, not an address book.** `db/migrations/005` adds five nullable
columns to `customers`. Before it there was no address storage anywhere — the
only address the system had ever kept was `orders.address`, one per order — and
the storefront's own Profile > Delivery Address form was a mock that validated a
field and called `showToast("Address saved!")` with no endpoint behind it. All
five columns are nullable and partial is a legitimate state.

---

### POST `shop/checkout.php`

**Public.** Places a real order.

**This is the flow that did not exist.** The storefront validated its form,
rendered a receipt and threw the order away — the customer saw "Order Placed!"
and nothing reached the staff portal.

Differences from `pos/checkout.php`, all deliberate:

| | POS | Storefront |
|---|---|---|
| Status | `completed` (pickup) | **`pending`** — a claim to be checked |
| Payment | verified at the till | `pay_verified = 0` |
| Stock | decremented immediately | **not decremented** |

Stock is not committed at order time, because an unverified stranger must not
be able to zero the inventory by placing orders nobody accepts. Availability
*is* checked, so the shopper is told immediately rather than after staff chase
them. **Stock commits when staff accept the order** — see below.

Prices come from the database; the storefront's own JS copy is editable by
anyone with a console open. An email that matches an existing customer links the
order to them, but no account is ever created as a side effect of buying —
signup is a deliberate act.

Also writes a `new-order` notification so the staff bell lights up.

**Empties the customer's `cart_items` inside the same transaction that writes
the order.** Not from the browser afterwards and not in a follow-up request: an
order that does not commit must not cost the shopper their cart, and a dropped
connection between two requests empties everything or nothing at random.

### Retailer credit terms at checkout

`pay_method` accepts `net30`, `net60` and `net90` **when the buyer is a
retailer**, alongside `cash`, `gcash` and `bank`.

This used to pass `Payments::methods(false)` unconditionally, with a comment
saying the storefront "has no retailer selection". That stopped being true when
D6 made checkout require a customer session: the endpoint now knows exactly who
is buying. Retailer status is **re-derived from the `customers` row inside the
request** (`Auth::customer()` re-reads it every request), never taken from the
client. The storefront renders the Net tiles from `state.auth.status`, which is
presentation; a regular customer posting `net30` gets
`Payment method must be one of: cash, gcash, bank.`

**A credit order carries no reference number and no screenshot.** Nothing has
been paid, so there is nothing to reference. `Payments::orderFields()` returns
`pay_verified = 0`, both proof columns null and `proof_amount = 0` for any
credit method, and the `ref_num` requirement lists `gcash`/`bank` explicitly
rather than testing `!== 'cash'` — written that way so adding a credit method
could not silently start demanding a screenshot for it.

**The receivable is opened in the same transaction as the order** (decision I8),
via `Payments::openCreditAccount()`. A sale recorded without its receivable is
money the business cannot see it is owed; a receivable without its sale is a
debt nobody can explain. The due date is computed by the database with
`DATE_ADD(CURDATE(), INTERVAL ? DAY)` — not in PHP, and certainly not in the
browser (D1) — so the receipt, the retailer's Payment Schemes page and the
cashier's screen all print the same date.

**Credit is refused while an earlier account is overdue.** 409, naming the
amount and the oldest due date:

> You have ₱13,056.00 overdue on your account (due 6 Aug 2026). Settle it to use
> credit terms again — you can still place this order on cash, GCash or bank
> transfer.

A decision, recorded because it is a business rule rather than an obvious one.
The alternative is an unbounded credit line, which nobody asked for: the
partnership grants *terms*, not a *limit*, and with no limit in the schema the
only bound available is "settle the last one first". It refuses the **terms**,
not the order — the shopper switches to cash, GCash or bank and completes.
The figure includes accrued penalty via `Payments::accountStanding()`, because
a total that quietly excludes it is the one that causes the argument. Checked
inside the transaction so it reads the same snapshot the INSERT is written
against.

**Response** gains `credit`: `null` for an immediate sale, otherwise
`{ id, scheme, balance, dueDate }` — the `payment_accounts` row that was opened.
`message` names the scheme and the due date.

---

### Stock and the order lifecycle

`orders/status.php` now moves stock for **online orders only**:

- **On `accepted`** — stock is decremented and `sold` incremented. If it sold
  out between the customer ordering and staff accepting, the transition is
  refused naming the product and the shortfall, rather than driving stock
  negative.
- **On `cancelled` from a committed state** — stock is returned and `sold`
  rolled back.

A walk-in sale already decremented at the till, so it is excluded. Before this,
online orders never touched stock at all, which meant the shop could sell the
same jar indefinitely.

---

---

## B2B applications

### POST `b2b/apply.php`

**PUBLIC** — no session and no CSRF token. An applicant has no account yet, so
there is no session to ride and nothing to forge. That is why the rate limit
below matters more here than on an authenticated endpoint.

**Body:** `business_name`, `applicant_name`, `email`, `phone`, `business_type`,
`business_address` (all required); `bir_tin?`, `username?`, `password?`,
`requested_terms?`, `monthly_volume?`, `notes?`

**What was missing.** `public/become-partner.html` has had a complete
twelve-field form since the beginning, and `b2b_applications` has a column for
every one of them. The staff side worked — `b2b/list.php` reads applications,
`b2b/decide.php` approves or rejects them. **The customer side sent nothing:**
no `fetch`, no endpoint, and no `INSERT INTO b2b_applications` anywhere in the
codebase. The submit handler validated, advanced a stepper and displayed
*"Application Submitted! … we'll reach out within 2 business days"*. The only
applications that could exist were the eight seeded rows, and a real business
owner was told it worked while no member of staff ever saw it.

Worse, the inline script on that page ran **before** the deferred `site.js` it
depended on, so `ICONS.eye` threw `ReferenceError` and killed the function
before `form.addEventListener('submit', …)` — the handler was never even
attached. Fixed by waiting for `DOMContentLoaded`.

**Rules:**

| | |
|---|---|
| Rate limit | 3 applications per IP per hour. A public endpoint that writes a row is a spam target, and the table feeds a review queue that is useless when flooded. Counted per IP, not per email — the sender picks the email and changing it is free |
| Duplicate | A second *pending* application from the same email is refused with its existing reference. It is an impatient resubmit, not a new request |
| Already a retailer | Refused — they should sign in, not apply |
| `bir_tin` | Optional; 9 or 12 digits however punctuated. A new business may not have one, and refusing over it loses a real customer |
| `requested_terms` | Normalised: the form's `"Net 60 Days Credit Terms"` is stored as `"Net 60"`, matching `payment_accounts.scheme` and `Payments::schemeLabel()`. `"Cash on Delivery"` stores NULL |
| `password` | Hashed on arrival via `Auth::hashPassword()`, so a pending application never holds a readable one |

Writes the application, a staff notification and an audit row in one
transaction, then emails the applicant an acknowledgement with their reference.
The email is sent **after** the commit and cannot fail the request.

Returns `{ appId, status, business, emailed }`.


**A signed-in customer applying is bound to their session.** This endpoint took
`email` from the request body and resolved `customer_id` by looking that address
up in `customers`. Safe while every applicant was a stranger; **not** safe once
an authenticated customer can apply — they could file an application naming
somebody else's address, and on approval `b2b/decide.php` would promote *that
person's* account to retailer, opening a trade credit line against an account
the applicant does not own.

When a customer session exists the email and `customer_id` come from the session
and the body is not consulted, the same rule `shop/checkout.php` states outright
("Always the session's address. Never read from the request."). The override
happens **before** validation, so the duplicate-application lookup, the
already-a-retailer refusal and the customer link all run against the session's
address. With no session the old behaviour stands — a stranger applying is still
the normal case.

**Credentials are required from a stranger and refused from a signed-in
applicant.** Server-side they were previously optional for everybody; only the
form's `required` attributes asked, and an attribute is not a check. An approved
application with no username left `decide.php` inserting a customer row with
NULL credentials — an account nobody can sign in to, created silently. A
signed-in applicant already has a username and password, so asking for a second
set invites a collision on the UNIQUE `customers.username` column;
`decide.php` promotes with `COALESCE(username, ?)`, so the existing login
survives approval untouched. The form hides the credentials block for them, and
this refusal is what makes that hiding true.

---

### Approval creates the partner account

`b2b/decide.php` gained this. It previously carried the comment *"approval does
not invent one — the partner account is created at signup"*, but **there is no
separate signup**: `b2b/apply.php` collects a username and password precisely
because applying *is* the signup for a wholesale account. Approving without
creating it left an approved partner with no way to log in.

On approval, if the applicant has no customer row and chose credentials, one is
created with `status = 'retailer'` and the application is linked to it. If they
already had a row, it is promoted, and a missing username/password is filled in
from the application — `COALESCE`, so an existing password is never overwritten.
A rejected applicant never gets an account.

Verified end to end: application submitted through the real form → approved at
Silver tier → `cus-12` created as `retailer` → **that customer signed in with
the password typed on the application form**.

---

### Email

`b2b/decide.php` emails the applicant on both outcomes. `api/core/Mailer.php`
speaks SMTP directly — this project has no Composer, and PHP's `mail()` shells
out to a sendmail XAMPP ships unconfigured whose failure mode is to return true
having delivered nothing.

**Mail is never part of a transaction.** `Mailer::send()` does not throw and is
called *after* the commit. A decision is a database fact; whether the
notification arrived is separate, and rolling back an approval because a mail
server timed out would be the wrong trade every time.

The response reports what actually happened — `emailed`, `mailLive`,
`mailError` — so the staff screen can say "emailed" or "could not email" rather
than implying one and doing the other.

Two transports, set by `mail.transport` in config:

- **`smtp`** — real delivery. Verified against a live SMTP server: `EHLO`,
  `AUTH LOGIN` with correctly base64-encoded credentials, `MAIL FROM`,
  `RCPT TO`, `DATA`, `QUIT`, and a well-formed multipart MIME message with a
  RFC 2047-encoded subject.
- **`log`** — writes the complete message to `storage/mail/*.eml`. **Not a
  stub.** An approval must not fail because nobody has entered credentials yet,
  and an install without them can still demonstrate the whole flow. It never
  pretends: `mailLive` is `false` and the staff screen says so.

The rejection reason staff type is sent verbatim, which is why `decide.php`
refuses a rejection without one — a decision the applicant cannot understand is
one they cannot act on.

**`storage/` is not public.** It holds the full text of every email sent, with
recipients' names, addresses and business details. The directory listing was
already refused, which is what made it dangerous — it looked protected while a
direct request for a filename returned **200 and the whole message**.
`storage/.htaccess` now denies everything; verified 200 → 403.

---

### GET `b2b/list.php`

Requires `b2b.review`.

**Query:** `page`, `limit`, `search` (business, applicant or email), `status`
(`pending`/`approved`/`rejected`).

---

### POST `b2b/decide.php`

Requires `b2b.review`.

**Body:** `{ "app_id": "APP-2026-008", "decision": "approved"|"rejected",
"tier": "Bronze"|"Silver"|"Gold", "reason": "…" }`

`app_id` is the human-facing `app_id_code`, not the numeric primary key.

Approving is a **two-table change in one transaction**: the application is
settled and the applicant's customer record is promoted to `retailer`, which is
what unlocks wholesale pricing and credit terms elsewhere. A rejection requires
`reason` — the applicant is told it, so "no reason given" is not an option the
endpoint offers.

**A decision is final.** Re-deciding a settled application answers 409. Silently
changing someone's commercial terms after they have been notified is not an
operation this exposes; issue a new application instead.

**Errors:** 404 unknown application · 409 already decided · 422 unknown
`decision`, missing `tier` on approval, or missing `reason` on rejection.

---

## Batches

### POST `batches/save.php`

Requires `batches.manage`. Omit `id` to create.

**Body:** `{ "id"?, "lot_code", "product_id", "harvest_date",
"production_date", "expiry_date", "total_qty", "quality_grade", "lab_status",
"qa_inspector", "notes" }`

**Registering a batch does not add its quantity to product stock.** Stock moves
only through `inventory/adjust.php`, which records a reason and writes an audit
row. A batch is the provenance record for units, not the act of receiving them —
doing both here would double-count every restock that opens a lot.

**`total_qty` is not editable on update.** `remaining_qty` is derived from it by
every disposal and sale recorded against the lot, so rewriting the original
quantity would make those movements stop adding up.

Lot codes are the traceability key a customer types into the public lookup, so a
duplicate answers 409 rather than making that lookup ambiguous. Setting
`lab_status` to `failed` while units remain in stock succeeds but says so in the
audit note — the units are on a shelf and somebody has to pull them.

**Errors:** 404 unknown batch on update · 409 duplicate lot code · 422 expiry on
or before production date, harvest after production, unknown product.

---

## Landing page content

### GET `content/get.php`

**Public** — no session. Feeds the storefront's About/Vision/Mission panels,
contact block, FAQ accordion, hero slides and featured products.

Returns `{ about, vision, mission, contact, faqs: [{q,a}], hero: [{title,img}],
featured: [productId] }`. `hero[].img` is a data URL or `""`; the storefront
supplies its own gradient panels when empty.

---

### POST `content/save.php`

Requires `landing.manage`.

**Body:** `{ "about"?, "vision"?, "mission"?, "contact"?: {…}, "faqs"?: [{q,a}] }`

**Only the keys present in the request are written**, so saving one panel cannot
blank the others — a partial form post is the normal case, not an error. FAQs are
the exception: they are an ordered list, so supplying them replaces the set
wholesale, inside a transaction.

---

## Customers

### POST `customers/save.php`

Requires `users.manage`. Omit `id` to create.

**Body, create:** `{ "name", "email", "contact", "status" }`
**Body, update:** `{ "id", "status" }` — plus `name`, `email` and `contact`,
which must **match what is stored**.

**An administrator cannot change a customer's name, email or contact number.**
A customer record belongs to the customer; they maintain those three fields
themselves through Profile (`shop/profile.php`). The update path refuses a
different value in any of them with 422.

The reasoning is the same one that keeps passwords out of this file: whoever
controls the email address controls the password reset, so an administrator who
can change it can take the account. **A customer's password is never touched
here** either — credentials are set through `shop/register.php`.

**Refused, not ignored.** Silently writing the stored value back would leave the
caller believing the rename worked. Round-tripping the *current* values is fine
and is not an error — a client that posts back a record it just read has changed
nothing.

The Edit button that needed this has been removed from Customer Accounts in the
portal. That removal is presentation; this refusal is the enforcement.

`status` accepts `active` or `archived`. **Retailer status cannot be granted
here** — it comes from approving a B2B application, which reviews the business,
records a tier and says why. Retailer status unlocks wholesale pricing and credit
terms, so allowing it here would let anyone holding `users.manage` hand out trade
credit with no application and no audit trail.

Posting `status: "retailer"` for a customer who already holds it is accepted;
promoting a customer who does not answers 422.

**Archiving is not done here** — see `customers/archive.php` below. It used to
be: the portal posted the whole record back with `status: "archived"` to change
one field, which is the only reason this endpoint ever accepted identity fields
on an update.

**Errors:** 404 unknown customer · 409 duplicate email · 422 missing name,
malformed email, malformed contact number, or an attempt to change name, email
or contact on an existing customer.

---

### POST `customers/archive.php`

Requires `users.manage`.

**Body:** `{ "id": "cus-01", "archived": true }`

Changes `customers.status` and **nothing else** — there is no name, email or
contact parameter to send. An absent `archived` flag is a 400, never read as
"restore", the same rule `products/archive.php` and `users/archive.php` apply.

**A restore does not go to `active`.** `users/archive.php` can hardcode that
because `users.status` is only ever `active` or `archived`. Here the same column
also carries `retailer`, so archiving overwrites the answer to *what kind of
customer is this* with the answer to *is this account open*. Restoring a
retailer to `active` would strip their wholesale pricing and credit terms with
nothing saying so — they would find out at checkout, when Net 30 stopped being
offered.

So the previous value is **recorded**, in `customers.status_before_archive`
(migration 008), and read back on restore. Recording beats inferring: "do they
have an approved `b2b_applications` row?" is wrong in both directions — a
partnership that was later ended still has its approved row, and a retailer
granted by any future route that does not write an application would not be
restored at all.

A row archived before migration 008 has `NULL` there and comes back as `active`.
That under-grants rather than over-grants, which is the right way round for a
value that unlocks trade credit.

**Errors:** 400 missing `archived` · 404 unknown customer · 409 already in the
requested state.

---

## Notifications

### GET `notifications/list.php`

Any signed-in staff member.

**Query:** `page`, `limit` (default 50), `type` (`new-order`/`payment`/`hold`/
`completed`/`return`/`inventory`/`audit`), `unreadOnly`.

`meta.unread` is the whole-set unread count, which is what the bell badge shows —
counting the current page would make the badge shrink as you paged forward.

---

### POST `notifications/read.php`

Any signed-in staff member.

**Body:** `{ "id": "n01" }` or `{ "all": true }`

**Read state is shared, not per-user.** This is one operations team working one
queue, and a notification a colleague has already dealt with should not still be
shouting at everyone else. Per-user read state needs its own table and is a
different product decision.

---

## Payments

### GET `payments/list.php`

Requires `payments.manage`. Retailer credit accounts.

**Query:** `page`, `limit` (default 10).

`meta` carries whole-set figures, not page ones: `penaltyRate` (from `settings`),
`outstanding` (total owed including penalties) and `overdueCount`. Penalties are
computed server-side from the stored rate and each account's due date — the
client displays the figure, it does not decide it.

---

### POST `payments/settle.php`

Requires `payments.manage`.

**Body:** `{ "id": "pay-01", "paid": true, "note"?: "…" }`

**The amount written to the audit trail is computed here**, penalty included,
rather than taken from the request. A client that could name the settled amount
could settle a ₱12,800 debt for ₱1.

---

## Reports

### GET `reports/sales.php`

Requires `sales.report`.

**Query:** `range` (`today`/`week`/`month`/`year`/`custom`), `from`, `to`.

**Cancelled orders are excluded from revenue.** The client used to sum the loaded
orders array with no status filter, so every period containing a cancellation was
overstated. Aggregation happens in SQL, which also means the figures stay right
once the order list is paged and the browser no longer holds every row.

Returns `meta.totals` — `orders`, `revenue`, `average`, `units`,
`walkinRevenue`, `onlineRevenue` — plus the resolved `range`.

---

## Returns

### GET `returns/list.php`

Requires `orders.returns`.

**Query:** `page`, `limit`, `search`, `status`.

---

### POST `returns/advance.php`

Requires `orders.returns`.

**Body:** `{ "id": "RET-…", "status": "…", "note"?, "refund_amount"?,
"refund_method"?, "rejected_reason"? }`

Same principle as `orders/status.php`: `RETURN_STATUS_STEP` in `engine.js`
decides which buttons appear, and that is a rendering decision. **The pipeline is
enforced here.** A return that jumps straight to `processed` skips eligibility
assessment and approval — which is how a refund gets paid on a claim nobody
checked. Illegal transitions answer 409.

---

## Settings

### POST `settings/save.php`

Requires `payments.manage`.

**Body:** `{ "penalty_rate": 2.5 }`

The rate previously lived only in `adminState.penaltyRate` in the browser, so it
reset on every reload and the penalties shown were computed from a number nobody
had saved.

**Only known keys are writable.** A settings endpoint that accepts arbitrary
key/value pairs from the client is a way to write anything into the table.

**Errors:** 422 negative or non-numeric rate · 400 when the body contains no
recognised setting.

---

## Storefront — customer accounts

### POST `shop/login.php`

**Public.** CSRF-exempt, like `auth/login.php` — there is no session to protect
yet.

**Body:** `{ "email", "password" }`

Separate from `auth/login.php`, which is staff only. **A customer session grants
no permissions and satisfies no `Rbac` check.** The two identities live in
different session keys (`eb_customer_id` vs `eb_user_id`) precisely so that a
shopper can never be mistaken for a staff member by code that only asks "is
somebody signed in?".

A wrong password and an unregistered address return the identical message, with a
dummy `password_verify()` on the miss so the two take the same time. A seeded
customer whose `password` is `NULL` cannot sign in at all until they register.

**Errors:** 401 wrong credentials or no password set · 403 archived account ·
429 throttled after repeated failures.

---

### POST `shop/register.php`

**Public.** CSRF-exempt.

**Body:** `{ "name", "email", "password", "contact"?, "address"? }`

**An email matching a seeded customer claims that record** rather than creating a
duplicate, so their existing order history follows them — the response sets
`claimedExistingRecord` so the page can say "welcome back". An address that
already has a password answers 409 and points at signing in, which reveals only
what a failed sign-in would.

Signs the customer straight in on success.

---

### GET `shop/me.php`

Requires a customer session. Returns the signed-in customer and a CSRF token.
401 when there is none — the storefront treats that as "signed out" and clears
its cached copy.

**`shop/login.php` and `shop/register.php` return `status` too**, and for the
same reason. They did not, and `signIn()` in `site.js` built `state.auth`
without it while the page-load restore path built it *with* it — two shapes for
one object. A retailer who signed in through the modal had
`state.auth.status === undefined` for the whole of that session, so the Payment
Schemes link stayed hidden and the credit tiles at checkout never rendered.
Reloading fixed it, which is what made it look intermittent rather than broken.
`state.auth` is now built by one helper, `setAuthState()`, from whichever
endpoint answered.

---

### GET `shop/cart.php`

**Requires a customer session.** The signed-in customer's saved cart.

**Returns:** `{ items: [...], count, changes: [...] }`. Each item carries the
quantity *and* the product fields the drawer draws with — `name`, `price`,
`image`, `tint`, `cat`, plus the same coarse `stockLevel` / `stockLabel` band
`shop/products.php` sends. The storefront can therefore render the cart from
this response alone, without waiting on the catalogue request to resolve first.

**The cart lives on the account, not in the browser.** `state.cart` in
`assets/js/public/site.js` was a plain in-memory array: a reload emptied it, a
sign-out emptied it, and a second device never saw it. `#cart-badge` rendering
`0` was the honest answer, not a display defect. Storage is `cart_items`, added
by `db/migrations/007-persistent-cart.sql`.

**Not `localStorage`, for the reason recorded above `_savedAuth` in `site.js`.**
The signed-in flag used to be restored from `localStorage`, which made typing
the right JSON into the console a login; it is deliberately not restored any
more. A cart in `localStorage` is the same mistake one size down — per-browser
rather than per-account, so it misses the device change that is most of the
point, and shared by everyone who uses the machine.

**Reconciles against the current catalogue, and writes the reconciliation
back.** A saved cart can sit for a week; the catalogue does not. A line whose
product has been archived or gone out of stock is dropped, and a line whose
quantity now exceeds stock is clamped to it. `shop/checkout.php` already
re-checks both, but the shopper meets that refusal at the last step, after
filling in an address. The changes are persisted rather than only applied to
the response — otherwise the next load would put them back and the same line
would have to be fixed twice.

`changes` reports every drop and clamp with the product name and a reason, so
the page can say what happened. A cart that quietly loses a line is worse than
the stale line was.

Scoped to the session customer throughout. There is no parameter that could
carry an id.

---

### POST `shop/cart-save.php`

**Requires a customer session.** Upserts **one** cart line.

**Body:** `product_id`, `qty` (0–99).

**`qty: 0` deletes the row.** That is the whole delete API. A separate
`cart-remove.php` would carry the same auth, the same scoping and the same
validation and differ only in the SQL verb, and the storefront already treats
"none of this" as a quantity — pressing minus at 1 removes the line.

**One line, not the whole cart.** A "replace my cart with this array" endpoint
is the obvious alternative and is worse: every add and every stepper click
would post the entire cart, so two tabs open on the same account would each
overwrite the other with whatever they last saw. A per-line upsert means two
tabs editing different products both land.

`INSERT … ON DUPLICATE KEY UPDATE` on the `(customer_id, product_id)` primary
key, so the database decides insert-or-update atomically and two requests
racing on the same line cannot both choose insert.

Refuses an archived or out-of-stock product, and a quantity above current
stock, with the count — saving a line that can never be bought only moves the
disappointment to checkout, and `shop/cart.php` would strip it on the next
load, which reads as the cart losing things by itself.

**`customer_id` in the body is refused, not ignored** — the same rule
`shop/checkout.php` applies. A caller that believes it can name the account
must be told it cannot.

**99 is written down three times**: `CART_MAX_QTY` in `site.js`, the validation
here, and the `chk_cart_qty` CHECK on the table. The client's copy stops the
request being made, this one stops the request, and the CHECK stops a
hand-written `INSERT`.

The client writes optimistically — the drawer redraws first and this call
follows — and rolls the line back with a toast if it is refused.

---

### GET `shop/dashboard.php`

Requires a customer session. Everything the account dashboard draws, in **one**
request: order counts, the tracking timeline, recent orders and payment history.

**Why one endpoint and not four.** Assembled from the existing endpoints this
would be four round trips (`my-orders` twice over, `my-payments`, `profile`),
four loading states to choreograph, and four ways for the page to be
half-drawn. It would also give a *wrong* order count — `my-orders.php` pages
its results, and a count taken from a page is a count of that page.

It does **not** replace `my-orders.php` or `my-payments.php`. Those are the
full, paged, filterable lists; this returns the five most recent of each plus
the totals.

**`counts`** — `pending`, `active`, `total`, `lifetimeSpend`.

`pending` and `active` are **disjoint**, so the two tiles never count the same
order twice: `pending` is `pending` + `on-hold` (placed, not moving yet, still
cancellable), `active` is `accepted` + `shipping` + `delivered`. `delivered`
stays active because the order is not finished until it auto-completes an hour
later. `lifetimeSpend` uses `Revenue::clause()` — the one revenue definition
(D2), not a second opinion about what counts.

**`tracking`** — the most recent unfinished order, or `null`. Carries a `steps`
array (`pending → accepted → shipping → delivered → completed`) with `done` and
`now` already decided. The sequence is sent from the server so it lives beside
the statuses it describes; a step order hardcoded in a template is a step order
nobody updates when a status is added. `on-hold` is reported through `held`
rather than as a step — it is a pause on the first one, not a stage the order
passes through.

**`payments` + `paymentsKind`** — two different things behind one heading:

| | `paymentsKind` | contents |
|---|---|---|
| Retailer | `credit` | `payment_accounts` rows: scheme, balance, due date, penalty, standing |
| Regular customer | `orders` | what they actually paid: method, reference number, amount, **and whether staff have verified it** |

A regular customer has no credit accounts and never will, so the retailer query
would return an empty list for ever. Their payment history is the one thing the
site could not previously answer: *did my GCash transfer go through?*

`credit` is `null` for a regular customer rather than an object of zeroes — a
zeroed summary reads as "you owe nothing on the terms you hold", which is a
different and wrong statement.

**Credit standing is `Payments::accountStanding()`** — the same call
`shop/my-payments.php` and portal `payments/list.php` make. A retailer shown a
total here that differs by a peso from their Payment Schemes page will not
assume a rounding rule.

Every query is bound to the session's customer id; there is no parameter that
could carry one.

---

### GET `shop/my-orders.php`

Requires a customer session.

**Takes no id parameter, by design.** The order list is scoped to
`$_SESSION['eb_customer_id']` and nothing else. An `?id=` here would be a broken
object level authorisation hole: change the number, read somebody else's orders.

---

### GET `shop/trace.php`

**Public** — the batch traceability lookup a customer runs from the product
label.

**Query:** `code` (lot code).

Returns `{ found, code, product, category, harvestDate, productionDate,
expiryDate, qualityGrade, labStatus, labPassed, origin }`. Deliberately exposes
no stock figures, costs or customer data — it answers "what is in this jar", not
"how is the business doing".

**An unknown code answers 200 with `found: false`, not 404.** "We have no record
of that code" is a legitimate answer to a legitimate question, and the page
renders it as a result rather than as an error — a 404 would send the client
down its failure path for a normal outcome. A missing `code` parameter *is* an
error and answers 422.

---

## System

### GET `system/dates.php`

Any signed-in staff member. No permission gate: it exposes the calendar, not
business data, and every portal screen needs it.

Returns `{ today, timezone, ranges: {name: {from, to}}, mysqlAgrees, drift }`.

**The client formats dates; it does not compute them** (D1). Range boundaries
used to be worked out in JavaScript *and* in PHP, in parallel, and the two
disagreed: `strtotime('monday this week')` against
`d.setDate(d.getDate() - d.getDay())` put the start of "This Week" a day apart,
so the Sales Report headline and the table beneath it measured different
periods. `api/core/Dates.php` is now the only place a range is defined, and this
endpoint hands the answer to the browser at start-up.

Ranges offered: `today`, `yesterday`, `week`, `lastweek`, `month`, `lastmonth`,
`year`, `lastyear`, `all`. **The week begins Monday** — ISO, and what the server
already used.

`mysqlAgrees` compares PHP's date under Asia/Manila with MySQL's `CURDATE()`.
They should match, but any endpoint mixing `CURDATE()` with a PHP date straddles
a day boundary if they do not, so it is reported rather than assumed. When it is
false the portal logs the drift and warns the operator.

---

## Permissions

The 17 permission keys, from the `permissions` table. A role's grants live in
`role_permissions`, which the Roles & Permissions screen edits — so changing a
grant there changes real access, immediately, without a code change.

| Area | Keys |
|---|---|
| Maintenance | `users.manage`, `b2b.review`, `landing.manage`, `products.manage` |
| System | `rbac.manage` |
| Inventory | `inventory.report`, `inventory.manage` |
| Reports | `sales.report`, `batches.manage` |
| Finance | `payments.manage`, `transactions.view`, `audit.view` |
| Point of Sale | `pos.use` |
| Online Orders | `orders.view`, `orders.accept`, `orders.status`, `orders.returns` |

A role flagged `is_system` (Super Admin) holds every permission unconditionally
and owns no `role_permissions` rows.

---

## Writing a new endpoint

```php
<?php
declare(strict_types=1);
require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('products.manage');      // auth + permission, or it stops here

$in = Response::input();                        // JSON body, or form-encoded
$data = Validate::check($in)
    ->required('name', 'Product name')
    ->decimal('price', 'Price', 0)
    ->int('stock', 'Stock', 0)
    ->values();                                 // 422 with field errors, or clean values

Database::run('INSERT INTO products (name, price, stock) VALUES (?, ?, ?)',
              [$data['name'], $data['price'], $data['stock']]);

Response::created(['id' => Database::pdo()->lastInsertId()]);
```

Rules, all non-negotiable:

- **Prepared statements only.** No string-concatenated SQL, ever. Where an
  identifier genuinely cannot be bound (sort columns, table names), resolve it
  through a whitelist.
- `Rbac::require()` before any work, not after.
- Validate everything from the client, including ids and prices.
- Never echo warnings or `var_dump` into the body — it corrupts the JSON.
  `bootstrap.php` buffers output and converts warnings to exceptions to make
  that hard to do by accident.
- Compute money server-side.

---

## Front-end client

`assets/js/core/api.js` is the only place in the project that calls `fetch()`.
It resolves the base path, unwraps the envelope, normalises errors and applies a
15-second timeout.

```js
const { data, meta } = await EbApi.get("products/list.php", { page: 1, search: "pesto" });

try {
  await EbApi.post("products/save.php", { name, category_id, price });
} catch (err) {
  if (err.isValidation) showFieldErrors(err.fields);
  else if (err.isForbidden) toast(err.message);
  else throw err;
}
```

`assets/js/core/session.js` wraps the auth endpoints and caches the current user
and permissions for the life of the page: `EbSession.bootstrap()`,
`.login(email, password, portalRole)`, `.logout()`, `.user`, `.can(permission)`.

**Note on module format:** these are classic scripts publishing `window.EbApi`
and `window.EbSession`, not ES modules. `engine.js` and its three companions are
classic scripts sharing globals, and an `import` cannot reach them. Converting
all four is Phase 5's work; it was not a prerequisite for getting passwords out
of the browser. The surface is deliberately import-shaped so the change is one
line per caller.
