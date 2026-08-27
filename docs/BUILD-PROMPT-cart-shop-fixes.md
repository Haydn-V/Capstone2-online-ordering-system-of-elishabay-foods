# Build prompt — storefront cart and product-card fixes

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Five defects on the public storefront, all in the cart and product-card area. I have already
traced each one to its cause; the cause is stated so you do not have to re-find it, but read
the surrounding code before you change it and tell me if I got any of them wrong.

## Files you will be working in

- `assets/js/public/site.js` — the storefront script (classic script, not a module; it reads
  `EbFormat` and `EbApi` as globals)
- `assets/css/public/styles.css` — storefront styles
- `public/index.html`, `public/shop.html` — the two pages that carry the cart drawer
- `api/shop/` — the customer-side endpoints

## Conventions to follow

- Non-GET calls go through `EbApi` (`assets/js/core/api.js`), which attaches the CSRF token.
  Never hand-roll a `fetch()` for a write.
- Customer endpoints call `Auth::requireCustomer()` and scope every query by the session's
  customer id — never by an id taken from the request body.
- New endpoints start with `require __DIR__ . '/../core/bootstrap.php';`, then
  `Response::requireMethod(...)`, then auth, then `Validate::check(...)`.
- Match the house comment style: each file opens with a comment explaining **why** it exists
  and what it replaces.
- Update `docs/API.md` for any new endpoint.

---

# Task 1 — "Browse the Shop" button does nothing

**Where:** `assets/js/public/site.js`, in `renderCart()`, the empty-cart branch.

**Cause:** the handler is

```js
$("#cart-shop")?.addEventListener("click", ()=>{ closeCart(); scrollToId("#shop"); });
```

`scrollToId()` starts with `const el = $(sel); if(!el) return;` — and **there is no element
with `id="shop"` anywhere in this project.** The shop is a separate page, `public/shop.html`;
`index.html` links to it with `<a href="shop.html">`. So the selector never matches, the
function returns silently, and the button appears dead on every page.

**Fix:** navigate to the shop page instead of scrolling to a non-existent anchor.

- The cart drawer appears on `public/index.html` and `public/shop.html` (both in `public/`),
  and the profile pages under `public/profile/` also carry a cart button — so a bare
  `"shop.html"` will 404 from the profile pages. Resolve the URL against the application
  root rather than the current directory. `EbFormat.APP_BASE` is already derived for exactly
  this purpose (see the comment above it in `assets/js/core/format.js`); check whether it is
  exported on the `EbFormat` global and use it, or derive the same way.
- If the current page *is* the shop page, close the drawer and scroll the product grid
  (`#product-grid`) into view instead of reloading the page.
- Do the same for any other control that tries to reach the shop through `scrollToId("#shop")`
  — search the file for `"#shop"` and fix every occurrence.

*Done when:* the button opens the shop from the landing page, from the shop page, and from
`public/profile/my-orders.html`.

---

# Task 2 — Add-to-cart button has no highlight

**Cause:** the button is rendered as

```js
<button class="btn btn-primary btn-add" data-add="…">
```

but **`.btn-primary` does not exist in `assets/css/public/styles.css`.** The stylesheet
defines `.btn`, `.btn-gold`, `.btn-red`, `.btn-ghost`, `.btn-ghost-ink`, `.btn-block`,
`.btn:disabled` and `.btn-add` (padding and font-size only) — no `.btn-primary`. So the
button falls back to the bare `.btn` base: no fill, no hover, no lift. That is why it reads
as plain text with a cart icon in the screenshots.

The same undefined class is on four other controls, which are all equally flat:

- **Proceed to Checkout** in the cart footer (`btn btn-primary btn-block`)
- **Add to Cart** in the product-detail modal (`openProductDetail`)
- the **Done** button on the receipt
- and one more — search `site.js` for `btn-primary`; there are five in total.

**Fix:**

1. Define `.btn-primary` in `styles.css`, in the button block alongside `.btn-gold` and
   `.btn-red` (around lines 202–240), following those rules' shape exactly. Use the existing
   design tokens (`--gold`, `--gold-soft`, `--red`, `--red-deep`, `--surface`, `--border`) —
   do not introduce new colour values. It must read as the primary action on the card without
   competing with the gold hero CTAs.
2. Give it a **clear, distinct highlight on `:hover`, `:active` and `:focus-visible`** — this
   is the part I actually want. `:focus-visible` matters: the card is keyboard-reachable and
   right now there is no focus ring at all.
3. Honour `prefers-reduced-motion` if you add a transform, the way the existing button rules
   should (check and match).
4. Confirm `.btn:disabled` still wins for the Sold Out state — the add button is rendered
   `disabled` when a product is out of stock, and it must not look clickable.
5. The card add button carries `.btn-add` as well, and `.btn-add` only sets padding and
   font-size — make sure your new rule and `.btn-add` do not fight over specificity.

Verify on both the homepage best-sellers carousel (`.bsc-slide .btn-add` has its own sizing
override at line ~964) and the shop grid.

*Done when:* the ADD button on both pages has an obvious resting fill, an obvious hover
state, a visible focus ring, and Sold Out still looks disabled.

---

# Task 3 — Cart: minus at quantity 1 will not remove the item

**Where:** `setQty()` in `site.js`.

**Cause:**

```js
function setQty(id, qty){
  qty = Math.max(1, Math.min(qty, CART_MAX_QTY));   // <- clamps the floor to 1
  …
}
```

Pressing minus at quantity 1 asks for 0, the clamp turns it back into 1, and the line stays.
There *is* a separate remove control (`.cl-remove`, the trash button on the right of each
cart line) but a customer's instinct is to press minus down to nothing.

**Fix:**

- In the cart stepper's minus handler (the `#cart-body` click listener, around line 2306),
  when the current quantity is 1, call `removeFromCart(id)` instead of `setQty(id, 0)`.
  Leave `setQty()`'s clamp alone — it protects the typed number input, where 0 really is
  invalid.
- Show an undo affordance rather than a confirmation dialog: remove the line immediately and
  raise a toast with an Undo action that puts it back. `showToast()` already exists; extend it
  or add a variant if it cannot carry an action. Do **not** use `confirm()` — the rest of this
  storefront does not.
- Give the same treatment to the typed input: if the customer clears it or types 0 and blurs,
  treat it as a remove rather than snapping back to 1.

**While you are in there — the trash button's icon has no size rule.** `.cl-remove` is styled
at line ~1389 but is not a `.btn`, and the only SVG sizing rule in the stylesheet is
`.btn svg { width:16px; height:16px }`. There is no global `svg` rule. Check how
`.cl-remove svg` actually renders in the browser and add explicit sizing so the icon is
visibly a small trash can, aligned with the row.

*Done when:* pressing minus on a single-quantity line removes it, an Undo toast restores it,
and the trash icon is correctly sized.

---

# Task 4 — Cart lines never show the product photo

**Cause:** `jarSVG()` takes four arguments — `jarSVG(tint, label, cls, img)` — and returns a
real `<img>` when `img` is truthy, a camera placeholder otherwise. The product card passes
the image correctly:

```js
${jarSVG(p.tint, p.name, 'jar', imageUrl(p))}      // product card — correct
```

but the cart line and the product-detail modal both call it **without the image argument**:

```js
<div class="thumb">${jarSVG(p.tint, p.name)}</div>            // renderCart()
<div class="pd-media">${jarSVG(p.tint, p.name)} …</div>       // openProductDetail()
```

so `img` is `""` and the placeholder always wins.

**Fix:** pass `imageUrl(p)` as the fourth argument in both places, matching the product card.
Check `.cart-line .thumb` styling (line ~1383) still frames a real photo correctly — it sets
`overflow:hidden` and a fixed 62×62 box, so the `<img>` inside likely needs
`width:100%;height:100%;object-fit:cover`. Add that rule if it is missing.

**Important — do not chase this further.** The product cards in the screenshots also show the
placeholder, but that is **not a code bug**: `api/shop/products.php` returns
`'image' => $r['image_url']`, and `imageUrl()` handles it correctly. Those products simply
have no image uploaded yet. That is a data task for the administrator in Product
Maintenance, not something to fix in JavaScript. Say so if you notice it; do not add
fallback image logic.

*Done when:* a product that has an uploaded photo shows that photo in the cart line and in
the product-detail modal, and one that does not still shows the camera placeholder.

---

# Task 5 — The cart is lost on reload and on re-login, and the badge shows 0

**Cause:** `state.cart` is declared as a plain in-memory array (`site.js` line ~128,
`cart: []`) and is never persisted. Reload the page, or sign out and back in, and it is empty
— so `updateCartBadge()` correctly renders `0` and there is nothing to remind the customer
about. `signOut()` also clears `state.auth` without clearing `state.cart`, which is the
opposite of what you want once the cart belongs to an account.

**Build it server-side, not in localStorage.** This repo has already been burned by trusting
the browser — read the comment at `site.js` line ~110 explaining why the signed-in flag is
deliberately *not* restored from localStorage, and the header of `db/migrations/005`. A cart
tied to the account is also the only version that satisfies the manuscript, which describes
the cart as part of the customer's account rather than a browser convenience.

**Schema.** Add a migration in `db/migrations/`, numbered after the highest one present, and
**copy the exact structure of `db/migrations/005-customer-profile.sql`**: a header comment
explaining why the change exists, a `DELIMITER //` stored procedure guarded by
`information_schema` lookups so the file is safe to run twice, `CALL` then `DROP PROCEDURE`,
no `USE` statement, and a verification query in a trailing comment.

```
cart_items
  customer_id  VARCHAR(50)  NOT NULL   -- FK customers(id) ON DELETE CASCADE
  product_id   VARCHAR(50)  NOT NULL   -- FK products(id)  ON DELETE CASCADE
  qty          INT          NOT NULL
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  PRIMARY KEY (customer_id, product_id)
```

Fold the same table into `db/schema.sql` so a fresh install matches a migrated one.

**Endpoints.**

- `GET api/shop/cart.php` — the signed-in customer's cart lines, joined to `products` for
  name, price, image, tint and current stock. Drop any line whose product has been archived,
  and clamp any line whose quantity now exceeds available stock, reporting what changed so
  the page can tell the customer.
- `POST api/shop/cart-save.php` — upsert one line `{ product_id, qty }`; `qty` of 0 deletes
  the row. Validate `qty` between 0 and `CART_MAX_QTY` (99, matching the client constant).
  Use `INSERT … ON DUPLICATE KEY UPDATE`.
- Both `Auth::requireCustomer()`, both scoped by the session customer id.

**Client.**

- On page load, if a customer session exists (`shop/me.php`), fetch the cart and populate
  `state.cart` **before** the first `updateCartBadge()` / `renderCart()` call — see the
  existing calls around lines 1103 and 2236.
- `addToCart()`, `setQty()` and `removeFromCart()` write to the server after updating
  `state.cart`. Update the UI first and reconcile on the response so the drawer stays
  responsive; if the write fails, roll the line back and toast the error.
- In `signIn()` (line ~1477), load the account's cart after the welcome toast. If it is not
  empty, remind the customer — a toast such as *"You have 3 items waiting in your cart"* with
  an action that opens the drawer. This is the reminder you asked for.
- In `signOut()` (line ~1489), clear `state.cart` and call `updateCartBadge()`. Leave the
  server rows alone — the cart is meant to survive.
- `pendingCartAdd` (line ~640) already replays an add that happened before sign-in; make sure
  it still works once the add is asynchronous, and that it does not double-add on top of a
  cart just loaded from the server.
- The badge markup already exists on both pages (`#cart-badge`, `#cart-badge-mob` in
  `index.html` lines 122 and 145, `shop.html` lines 46 and 50) and `updateCartBadge()`
  already toggles a `.show` class — so once the cart loads, the number appears with no markup
  change. Verify `.cart-badge` and `.cart-badge.show` are actually styled; if the badge is
  hidden by default and `.show` does nothing, fix that too.
- Clear the server cart when an order is placed. `site.js` currently does `state.cart = []`
  inline in the receipt code (~line 1101); the checkout endpoint should delete that
  customer's `cart_items` rows inside the same transaction that creates the order, so a
  failed checkout does not lose the cart.

*Done when:* a customer adds items, signs out, signs back in on a fresh browser, and sees
both the badge count and a reminder toast, with the same items in the drawer.

---

# Order of work

1. Task 1 and Task 2 — small, independent, no schema.
2. Task 4 — one-line change plus a CSS rule.
3. Task 3 — needs the cart re-render path you will touch again in Task 5.
4. Task 5 — migration, endpoints, then the client wiring.

Test each against the real XAMPP database with the seeded data before moving on. Do not batch
all five and test at the end.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
