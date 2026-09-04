# Build prompt — the profile-page modal bug, and customer product ratings

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

One bug that explains two reported symptoms, then a new feature. I could not pull the latest
files while writing this, so **treat every line number as a starting point** — read the
current code and tell me if any diagnosis is wrong.

## Conventions

- Non-GET calls go through `EbApi`, which attaches the CSRF token. Never hand-roll a `fetch()`
  for a write.
- Customer endpoints call `Auth::requireCustomer()` and scope every query by the session's
  customer id — never by an id taken from the request body. `api/shop/checkout.php` states the
  rule: *"Always the session's address. Never read from the request."*
- Hiding a control is presentation, not security — `api/core/Rbac.php` says so in its header.
  Every endpoint decides for itself.
- Use the existing tokens. **No new colour literals.** Both themes.
- Match the house comment style: explain **why** a change exists.
- Update `docs/API.md` for every new endpoint.

---

# Task 1 — Sign In and Proceed to Checkout do nothing on the profile pages

**Both reported symptoms are the same bug, and it is one unguarded line.**

`openModal()` in `assets/js/public/site.js` (~line 683):

```js
function openModal(title, bodyHTML, {wide=false, onOpen}={}){
  lastFocus = document.activeElement;
  $("#modal-title").textContent = title;      // <- line 685
  $("#modal-body").innerHTML = bodyHTML;
  …
}
```

The pages under `public/profile/` — `dashboard.html`, `profile.html`, `my-orders.html`,
`my-payments.html` — carry `#modal`, `#modal-body`, `#modal-close` and `#modal-scrim`, but
**none of them has `#modal-title`**. So on those pages `$("#modal-title")` is `null`, line 685
throws `TypeError: Cannot set properties of null`, and the function dies before it opens
anything.

That is why:

- the signed-out guard's **SIGN IN** button appears to do nothing — it calls `openLogin()`,
  which calls `openModal()`, which throws; and
- **Proceed to Checkout** in the cart drawer appears to do nothing — `openCheckout()` calls
  `openModal("Checkout", …)`, which throws.

Both work on `index.html` and `shop.html`, which do have `#modal-title`. Open the browser
console on a profile page and click either control; you should see the TypeError.

**This is a repeat of a bug this codebase already documented.** Read the header comment on
`showToast()` — it explains that `#toast-wrap` does not exist on the profile pages, which
declare `#toast-root`, so every toast on those pages threw and the customer was told nothing.
Same cause, different element: the modal shell is copy-pasted across five-plus pages and the
copies have drifted.

**Fix all three layers:**

1. **Add `#modal-title` to every page under `public/profile/`**, matching the markup in
   `index.html` exactly. A dialog with no visible heading is worse UX regardless of the crash.
2. **Guard `openModal()` and `closeModal()`** so a missing node degrades instead of throwing —
   the same defensive shape `showToast()` now uses.
3. **Give the dialog an accessible name.** `#modal` is a `role="dialog"`; with no title element
   it has none. Wire `aria-labelledby` to the title once it exists on every page.

**Then look for the next one.** Grep `site.js` for every unguarded `$("#…")` that is
dereferenced immediately, and check each id against all five public pages. Any element present
on `index.html` but missing from a profile page is the same bug waiting to fire.

**And stop it recurring.** The real problem is that the modal, cart drawer and toast container
are duplicated in five files. Extract them into one shared shell injected at load — or, if you
judge that too large a change right now, add a documented checklist and say so. Do not leave
five hand-maintained copies with no note.

*Done when:* signing out on the dashboard and clicking SIGN IN opens the login modal, and
Proceed to Checkout opens the checkout from every profile page.

---

# Task 2 — Customer product ratings

## The design, and the reasoning behind it

**Only a verified purchase can produce a rating.** The control lives in **My Orders**, on the
items of a **completed** order. The product page in the shop displays reviews but has no star
input. This is deliberate: a system where any registered account can rate a product it never
bought has no answer to "how do you prevent fake ratings", and building careful text
moderation while leaving that door open would be inconsistent.

**Stars plus an optional short comment.** 1–5 stars required, comment optional.

**Moderation triggers on the text, not on the score.** A review is held for staff review only
when it trips the keyword filter. Everything else publishes immediately, including one-star
reviews.

**A low rating raises a staff notification instead of blocking publication.** A 1–2 star
review is not a safety problem — it is a signal that something went wrong with a real order,
and staff should hear about it quickly so they can follow up with that customer. Holding it
back would delay the business learning about a genuine defect while making the product look
better than it is. So it publishes like any other review *and* notifies staff, who get the
early warning without anything appearing suppressed.

Staff can still unpublish an already-published review after the fact. Rejection and
unpublishing are for abuse and policy only — **never because a review is negative.** Make the
reason a required field, write it to the audit log, and say so in the staff interface.

**Be accurate about what the filter is.** It is a keyword list, not content classification.
Store the list in the `settings` table — the same table already holds `penalty_rate` for
exactly this reason, and a hard-coded list cannot be updated without a deploy. Match
case-insensitively on word boundaries so a short flagged word does not trip on a longer
innocent one.

## Schema

Add a migration in `db/migrations/`, numbered after the highest present, and **copy the exact
structure of `db/migrations/005-customer-profile.sql`**: a header comment explaining why, a
`DELIMITER //` stored procedure guarded by `information_schema` lookups so it is safe to run
twice, `CALL` then `DROP PROCEDURE`, no `USE` statement, and a verification query in a trailing
comment. Fold the table into `db/schema.sql` so a fresh install matches a migrated one.

```
product_reviews
  id            INT AUTO_INCREMENT PK
  product_id    VARCHAR(50) NOT NULL   -- FK products(id)
  customer_id   VARCHAR(50) NOT NULL   -- FK customers(id) ON DELETE CASCADE
  order_id      VARCHAR(50) NOT NULL   -- FK orders(id); the purchase that earned the right
  rating        TINYINT NOT NULL       -- 1..5, enforced in PHP
  comment       TEXT NULL
  status        ENUM('published','pending','rejected') NOT NULL
  hold_reason   VARCHAR(80) NULL       -- 'keyword' today; leave room for more
  reject_reason TEXT NULL              -- required when status = rejected
  moderated_by  VARCHAR(50) NULL       -- FK users(id) ON DELETE SET NULL
  moderated_at  DATETIME NULL
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

**One rating per customer per product, editable** — enforce it with a unique key on
`(customer_id, product_id)`. A customer who buys the same product three times should not get
three votes on its average. `order_id` records the purchase that verified the rating; keep the
earliest one when they edit. Editing re-runs the keyword check, so an edit that introduces a
flagged word returns the review to `pending`.

Index `(product_id, status)` and `(status, created_at)`.

**`products.rating` already exists** as `DECIMAL(3,2) DEFAULT 5.00`, is seeded with invented
values, and is read by the shop cards, the product detail, the `rating` sort option and the
portal's Best Sellers table. Recompute it from published reviews whenever one is published,
edited or unpublished, and keep the column so every existing reader keeps working.

**One honesty point that matters:** a product with no reviews must not show 4.9 stars. Today
every seeded product displays a rating it never earned. Add a review count alongside the
average and render "No ratings yet" at zero, everywhere a rating appears — cards, detail,
carousel and the portal tables.

## Endpoints

- `POST api/shop/review-save.php` — `Auth::requireCustomer()`. Body: `product_id`, `rating`,
  optional `comment`, `order_id`. **Verify from the database** that the order belongs to the
  session customer, is `completed`, and contains that product. Never accept the client's claim
  that a purchase happened. Upsert against the unique key so a second submission edits rather
  than duplicates. Run the keyword check to set `status`, and return that status so the
  customer is told plainly whether their review is live or awaiting checking.
  - When the rating is 1 or 2, insert a `notifications` row at the **Warning** level naming the
    product, the order and the customer, so staff can follow up. Use the priority scale already
    built rather than inventing a second signal.
- `GET api/shop/reviews.php` — published reviews for one product, paged, newest first, with the
  average and the count.
- `GET api/reviews/list.php` and `POST api/reviews/moderate.php` — the staff queue. Gate both
  on a new permission key, `reviews.moderate`. Add it to the `permissions` table in the same
  migration and grant it in the `role_permissions` seed to the roles that should hold it; the
  Roles & Permissions screen reads that table, so it appears there with no extra work.
  Moderating writes an `audit_logs` row naming the actor, the review and the decision.

## Interface

- **My Orders** — a "Rate this product" control on each item of a completed order, opening a
  modal with the star input and comment box. If the customer already rated that product, show
  their rating with an Edit action instead. **This depends on Task 1 being fixed first** —
  modals do not open on that page today.
- **Product detail in the shop** — the published reviews list with the average and count, each
  marked "Verified purchase" (all of them are, and saying so is the point). No star input here.
  A visitor who has not bought it sees the reviews and the normal Add to Cart path.
- **Product cards** — average and review count, or "No ratings yet".
- **Portal** — a Reviews module in the sidebar: the pending queue with the keyword that held
  each one, actions to publish or reject, and a list of published reviews with an unpublish
  action. Rejection and unpublishing both require a reason. Gate the nav item on
  `reviews.moderate`.

The star input must be a real fieldset of radio inputs, or carry full `role="radiogroup"`
semantics — keyboard operable, focus visible, announcing "3 of 5 stars". A row of clickable
spans is not acceptable.

*Done when:* a customer can rate a product from a completed order and edit that rating later,
a one-star review publishes immediately and raises a staff notification, a review containing a
flagged word lands in the queue, and a product with no reviews says so instead of showing an
invented score.

---

# Order of work

1. **Task 1 first, on its own.** It blocks checkout from four pages and it blocks the My Orders
   half of Task 2. Verify in the browser console that the TypeError is gone.
2. Migration, then the customer endpoints.
3. The customer interface — My Orders, then the shop's review list.
4. The staff queue and the low-rating notification.

Test each against the real XAMPP install with the seeded data, in both themes, before moving
on. Do not batch it all and test at the end.

Two things I want stated back in your summary: any *other* element missing from the profile
pages that `site.js` dereferences unguarded, and how you handled a customer editing a rating
whose original order has since been archived or refunded.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
