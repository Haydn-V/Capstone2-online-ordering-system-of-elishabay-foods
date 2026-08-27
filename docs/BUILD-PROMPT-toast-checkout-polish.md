# Build prompt — toast icons, cart count, and the checkout redesign

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Six items on the public storefront: three small corrections, then a redesign of the checkout
modal and its payment-screenshot upload. I have traced each defect to its cause; read the
surrounding code before changing it and tell me if any diagnosis is wrong.

## Files

- `assets/js/public/site.js` — the storefront script (classic script; reads `EbFormat` and
  `EbApi` as globals)
- `assets/css/public/styles.css` — storefront styles
- `assets/js/core/ui.js` — the portal's twin toast implementation (see Task 1)
- `api/uploads/image.php` — the existing upload endpoint

## Conventions

- Use the existing design tokens (`--gold`, `--gold-dim`, `--gold-soft`, `--red`, `--ink-card`,
  `--cream`, `--surface`, `--surface-2`, `--border`, `--border-lift`, `--text`,
  `--text-muted`, `--ok`, `--warn`, `--out`, `--r-sm/md/pill`, `--t`, `--ease`,
  `--shadow-*`). **Do not introduce new colour literals.** Everything must work in both the
  light and dark themes this stylesheet already supports.
- Non-GET calls go through `EbApi`, which attaches the CSRF token. Never hand-roll a `fetch()`
  for a write.
- Match the house comment style: explain **why** a change exists, not what the line does.
- Respect `prefers-reduced-motion` on anything you animate.

---

# Task 1 — Toast icons are not centred in their circle

**Where:** `showToast()` in `site.js` (~line 595) and `.toast .ic` in `styles.css` (~line 1611).

**Cause.** The icon well is a 22px circle:

```css
.toast .ic { display:grid; place-items:center; width:22px; height:22px; border-radius:50%; flex:none; }
```

Into it goes a raw `<svg viewBox="0 0 24 24">` with **no width or height attribute**, and
there is no `.toast .ic svg` rule and no global `svg` rule anywhere in the stylesheet — the
only SVG sizing rule in the file is `.btn svg`. So the glyph is unsized and the grid cell
squeezes it.

It is worse for the cart glyph specifically. Compare the two paths in `ICONS`:

- `ICONS.check` — `M20 6 9 17l-5-5` — inset well inside the 24×24 box, so it still looks
  acceptable. That is why the green "Welcome, Juan!" toast looks fine.
- `ICONS.cart` — starts at `M1 1` and runs out to `x=23`, filling the box corner to corner,
  with its two wheel circles down at `cy=21`. In a 22px circle with no padding it touches the
  edge and reads as bottom-left heavy. That is the misalignment in the add-to-cart, remove,
  and sign-out toasts.

**Fix — do both parts.**

1. **Size every toast glyph.** Add a `.toast .ic svg` rule with an explicit width and height
   (around 12px) and `display:block`. The existing `place-items:center` then centres it
   properly. This alone fixes the check mark and any other icon a toast ever carries.
2. **Replace the cart glyph with a dot for the non-success toasts.** Even correctly sized,
   a shopping-cart mark is bottom-heavy inside a circle and carries no meaning on a
   "Signed out." message. In `showToast()`, the icon is chosen as
   `type==="success" ? ICONS.check : ICONS.cart` — change the non-success branch to render a
   plain dot instead of an SVG: an empty `.ic` styled with a small centred disc (a
   `::before` with a fixed width/height and `border-radius:50%`, or an inner `<span>`).
   Keep the check for `success`. The existing `.toast.info .ic { background:var(--gold) }`
   should become the dot's colour treatment — decide whether the ring stays filled with the
   dot inside it or the well becomes just the dot, and make it look deliberate either way.

**Then check the twin.** `assets/js/core/ui.js` has its own `EbUI.toast()` used by the portal
and the profile pages. `REMEDIATION.md` documents this duplicate-implementation drift as a
known problem — apply the same fix there so the two do not diverge again, and note in a
comment that they are twins.

Verify against every toast the storefront raises: added to cart, removed with Undo, sold out,
sign-out, upload failure, order placed.

*Done when:* every toast's icon sits centred and proportionate in its circle at every toast
type, in both themes.

---

# Task 2 — The cart count reports units, not products

**Where:** `cartCount()` in `site.js` (~line 676), used at ~line 866 (`updateCartBadge`) and
~line 905 (the subtotal row).

**Cause.**

```js
const cartCount = () => state.cart.reduce((n,i)=>n+i.qty, 0);
```

Two products at quantity 2 each gives 4, so the drawer says "Subtotal (4 items)" and the
header badge shows 4 — when only two products have been added.

**Fix.** Add a second helper beside it — `cartLineCount()` returning `state.cart.length` —
and use it for both the badge and the subtotal label. Reword the label so the number is
unambiguous: `Subtotal (2 products)`, singular `1 product`. Keep `cartCount()` where a true
unit total is genuinely wanted, if anywhere still needs it; delete it if nothing does.

**Keep the server and client agreed.** `GET api/shop/cart.php` returns a `count` that the
client also reads (`loadServerCart()` uses `cart.count`). Whatever definition you choose,
make the endpoint return the same one, so the badge cannot disagree with itself depending on
whether the cart came from the server or from local state. One definition, one place.

*If the group later decides the header badge should show total units after all, that is a
one-line change — but the drawer's label must still say products.*

*Done when:* two products at quantity 2 show `2` on the badge and "Subtotal (2 products)" in
the drawer, and the total price is still ₱1,068.

---

# Task 3 — Drop the cart reminder toast on sign-in

**Where:** `signIn()` in `site.js`, the async block at ~line 1694.

Right now signing in raises two stacked toasts: "Welcome, Juan!" and "You have 4 items
waiting in your cart". The second one is unwanted — the badge already communicates it.

**Fix.** Remove only the reminder `showToast(...)` call and its `const n = cart ? cart.count : 0;`
guard. Keep `Welcome, ${name}!`.

**Do not remove `loadServerCart()`.** The cart must still load on sign-in so the badge shows
the count and the drawer has the lines — that is the whole feature. Only the toast goes.
Leave the `pendingCartAdd` replay and the comment explaining its ordering exactly as they are.

*Done when:* signing in shows one toast, and the header badge still shows the restored count.

---

# Task 4 — Redesign the payment screenshot upload

**Where:** the `#proof-block` markup in `openCheckout()` (~line 1010) and the
`proofInput.addEventListener("change", …)` handler (~line 1132).

**What is wrong.** The control is a bare browser file input carrying the generic form class:

```html
<input class="control" id="co-proof" type="file" accept="image/png,image/jpeg,image/webp">
<div id="upload-name" style="font-weight:600;margin-top:6px"></div>
<img id="co-proof-preview" alt="" style="display:none;max-height:140px;margin-top:8px;border-radius:8px">
```

So the shopper gets Chrome's grey "Choose File" button sitting inside a styled text field,
a status line whose colour is set from JavaScript with inline styles, and an unframed preview
image. **And there is no way to remove an attached screenshot.** `proofPath` is cleared only
at the top of the `change` handler, so the single escape from a wrong image is to open the
file picker again and pick a different one. There is no remove control anywhere.

**Build a proper upload field.**

- Hide the native input and drive it from a styled label/dropzone — an outlined area with an
  icon, a "Choose an image" action and a hint line naming the accepted types and the size
  limit. Read the actual limit out of `api/uploads/image.php` rather than inventing one.
- Support drag-and-drop onto the zone, with a visible drag-over state. Keep the click path
  working — drag-and-drop is an addition, not a replacement.
- Validate type and size **client-side before uploading**, so an obviously wrong file is
  refused instantly instead of after a round trip. The server check stays as the real gate.
- While uploading, show a determinate or at least clearly-animated busy state on the zone
  itself, not a text line that says "Uploading…".
- Once attached, replace the zone with a **thumbnail card**: framed preview, the file name,
  the size, and two controls — **Remove** and **Replace**. This is the part I actually need.
- Errors render in the field's existing `[data-err]` span using `.field-error`, not by
  writing inline colours from JavaScript. Drop the `showToast` on upload failure — the
  message belongs in the field, and duplicating it in a toast is noise.

**What Remove must do.** Set `proofPath = null`, clear `proofInput.value` (without it, picking
the *same* file again fires no `change` event and the shopper is stuck), hide and clear the
preview `src`, restore the empty dropzone, and clear the field error. The submit gate at the
bottom of the form already refuses to place a non-cash order when `proofPath` is falsy — after
a Remove it must refuse again.

**The orphan-file problem.** `EbApi.upload()` writes the file to the server the moment it is
chosen, so every removed or replaced screenshot leaves a file behind in the references
folder that no order will ever point at. Fix it properly: add a small discard endpoint —
model it on `api/uploads/image.php`, `Auth::requireCustomer()`, accepting only a path that
endpoint itself issued in this session, refusing anything else — and call it from Remove and
from Replace. If you conclude that is unsafe to do cleanly, say so and instead leave a
documented note in `docs/API.md` that the folder needs periodic cleanup. Do not silently
leave orphans undocumented.

*Done when:* a shopper can attach a wrong screenshot, remove it, see the empty zone return,
be blocked from placing the order, attach the right one, and place it — and the discarded file
is not still on the server.

---

# Task 5 — Enhance the checkout modal design

**Where:** the `body` template inside `openCheckout()` (~line 963) and the `.co-*` rules in
`styles.css` (~lines 1585–1597).

The checkout is functional but visually unfinished next to the rest of the storefront: flat
sections, a native `<select>` for the payment method, an unstyled checkbox row with inline
`style=` attributes, and a submit button that scrolls away off the bottom of a long form.
Bring it up to the standard of the shop and cart, using the existing token palette.

Specific things to address:

- **Order summary** — give it more presence at the top: per-line quantity and unit price, not
  just `Name × 2`, and a clearer total. Consider keeping it visible while the rest of the form
  scrolls.
- **Payment method** — replace the native `<select>` with the same segmented card pattern the
  Order Type toggle already uses (`.toggle-group` / `.tg`, ~line 1587), so Cash, GCash and
  Bank Transfer read as three choices rather than a dropdown. Keep the underlying value
  handling intact — `payment` drives whether `#proof-block` is shown and whether the reference
  number is required.
- **Section rhythm** — the `.co-title` eyebrows are good; give the sections real separation
  and consistent internal spacing rather than the current uniform 22px gap.
- **The save-to-profile checkbox** — it currently carries a five-property inline `style`
  attribute. Move it into a proper class and style the checkbox to match the brand instead of
  leaving it as the browser default.
- **Submit** — make the Place Order button reachable without scrolling to the bottom of a long
  form: pin it to the modal footer, with the total beside it.
- **Field states** — visible focus, a real error state on `.control` when its `[data-err]` is
  populated, and disabled/busy styling on submit so a double-click cannot place two orders.
  Check whether double-submit is actually guarded in the submit handler; if it is not, guard it.
- **Mobile** — verify at 390px wide. The modal is `{wide:true}`; make sure the toggle groups
  wrap rather than squash.

**Do not change behaviour.** Specifically leave intact: the profile prefill rules and their
long comment block (decision I9 — suggestion not override, only empty fields, nothing
disabled, no write-back unless the box is ticked), the validation rules in the submit handler,
and the `proofPath` gate. This is a visual pass with one structural change (the payment
selector) — if you find yourself editing the prefill logic, stop.

*Done when:* the checkout looks like it belongs to the same site as the shop page, in both
themes, at both desktop and phone widths, and every existing test path still behaves the same.

---

# Order of work

1. Task 1, 2, 3 — small and independent. Do them first and verify each in the browser.
2. Task 4 — the upload field. It is inside the checkout modal you are about to redesign, so
   settle its markup before Task 5.
3. Task 5 — the wider checkout pass, absorbing the new upload field.

Test each against the real XAMPP database with the seeded data before moving on. Do not batch
all six and test at the end.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
