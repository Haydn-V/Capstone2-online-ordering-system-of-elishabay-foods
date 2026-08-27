# Build prompt — product images in Maintenance

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Two problems in the portal's **Maintenance → Products** screen, plus a server-side blocker
behind the second one. I have traced each to its cause; read the surrounding code before
changing it and tell me if any diagnosis is wrong.

## Files

- `assets/js/portal/engine.js` — the portal script (`renderProductAdmin` ~line 2526,
  `productModalBody` ~line 2567, `attachImagePreview` ~line 2672)
- `assets/css/portal/portal.css` — portal styles (`.pac-thumb` ~line 1418)
- `api/products/save.php` — the product write endpoint
- `api/uploads/image.php` — the upload endpoint

## Conventions

- Use the existing portal tokens (`--surface`, `--bg-soft`, `--border`, `--border-lift`,
  `--text`, `--text-muted`, `--gold-ink`, `--ok`, `--out`, `--r-sm/md/lg`, `--shadow-md`,
  `--t`). **No new colour literals.** Everything must hold up in both portal themes.
- Non-GET calls go through `EbApi`. Never hand-roll a `fetch()` for a write.
- Match the house comment style — explain **why** a change exists. Several of the comments
  you will be working next to are load-bearing history; do not delete them.
- Respect `prefers-reduced-motion` on anything you animate.

---

# Task 1 — The catalog cards never show the product photo

**The data is fine.** `api/products/list.php` returns `'image' => $r['image_url']`, and the
same photo renders correctly in Point of Sale, on the Best Sellers table, in the Edit Product
modal, and on the public landing page. Only this one grid is blank.

**Cause.** In `renderProductAdmin()` (~line 2526) the thumbnail is a **hardcoded camera SVG**.
The template never looks at `p.image` at all:

```js
<div class="pac-thumb">
  <svg viewBox="0 0 24 24" …><path d="M23 19a2 2 0 0 1-2 2H3…"/><circle cx="12" cy="13" r="4"/></svg>
</div>
```

That is the whole bug — every card shows a camera whether or not a photo exists.

**Fix.** Render the photo when there is one and keep the camera as the empty state. The
pattern is already in this same file — see the Best Sellers row at ~line 2281, which does
`const src = imageUrl(p);` then `${src ? '<img …>' : placeholder}`. Follow it exactly:

- `imageUrl(p)` (the local wrapper at line 468 around `EbFormat.imageUrl`) resolves the
  stored path for this page. Escape the result into the `src`.
- Give the `<img>` a real `alt` — the product name.
- Add `loading="lazy"`; this grid renders the whole catalogue at once.
- Make sure `installImageFallback()` is active on the portal document so a path whose file
  has gone degrades to the placeholder instead of a broken-image icon. Check whether it is
  already installed; if not, install it once rather than per-card.

**CSS.** `.pac-thumb` is a 120px-tall flex box and `.pac-thumb svg { width:40px; height:40px }`
sizes the camera. Add a `.pac-thumb img` rule — `width:100%; height:100%; object-fit:cover;
display:block` — so a real photo fills the frame instead of sitting at its intrinsic size.
`.product-admin-card` already sets `overflow:hidden`, so the corners will clip correctly.

*Done when:* the Products catalog grid shows the same photos as the Point of Sale grid, and
products with no photo still show the camera.

---

# Task 2 — The server cannot clear a product image

**Do this before Task 3.** Without it, a Remove button in the interface will appear to work
and silently change nothing.

**Cause.** In `api/products/save.php` (~line 117):

```php
/* Leaving the image field empty means "keep the current one", not "clear
   it" — the edit form only sends an image when a new one was chosen. */
$newImage = $image ?? $existing['image_url'];
```

and at ~line 79, `$image = $in['image'] ?? null;` — which conflates *"the client did not send
the field"* with *"the client sent null"*. Under those two lines there is no request an
administrator can make that clears `image_url`. The comment describes a client that no longer
exists: `engine.js` at lines 2618 and 2655 **always** sends the field
(`image: $("#m-prod-preview").dataset.path || null`).

**Fix.** Distinguish absent from explicitly-null, using `array_key_exists('image', $in)`:

- **Field absent** → keep `$existing['image_url']`. Preserves any other caller.
- **Field present and a valid path** → store it. Unchanged behaviour: the client re-sends the
  existing path when nothing was touched, and the existing regex and `is_file()` checks
  already validate it.
- **Field present and null or empty string** → store `NULL`. This is the new case.

Leave the data-URL refusal, the `/uploads/products/<32 hex>.webp` regex and the `is_file()`
existence check exactly as they are — they are the security boundary and the reason this
column is a path rather than 918KB of base64. Update the stale comment to describe the new
three-way rule.

**Orphaned files.** Clearing or replacing `image_url` leaves the `.webp` in
`/uploads/products/` with nothing pointing at it. Handle it deliberately: either delete the
now-unreferenced file inside the same save (only after confirming no other product row
references that path — check before unlinking), or, if you judge that unsafe, leave the file
and record the cleanup requirement in `docs/API.md`. Do not leave orphans undocumented.

*Done when:* posting `products/save.php` with `image: null` for a product that has a photo
clears `image_url`, and posting without the field at all leaves it untouched.

---

# Task 3 — Click to zoom, plus explicit Change and Remove

**Where:** `productModalBody()` (~line 2567) and `attachImagePreview()` (~line 2672).

**Cause.** The whole dropzone is one click target:

```js
if(zone) zone.addEventListener("click", ()=> input.click());
```

`#m-img-zone` wraps both the preview image and the empty-state placeholder, so clicking the
photo opens the file picker. There is no remove control anywhere — the only way out of a
wrong image is to upload a different one, and per Task 2 even that cannot get you back to
*no* image.

**Build this.**

**When the product has an image:** show the preview with two controls beneath or over it —
**Change** (opens the file picker) and **Remove**. Clicking the *image itself* opens a zoom
view, not the file picker. Scope the existing zone-wide click handler so it only fires on the
empty placeholder; the image and the two buttons get their own handlers.

**When the product has no image:** the current placeholder and its click-to-upload behaviour
stay exactly as they are.

**The zoom view.** There is no lightbox anywhere in this project — you are building the first
one, so build it as something reusable rather than as a one-off inside this modal:

- Full-viewport scrim over the product modal, the image at its natural size up to
  `max-width:90vw; max-height:90vh; object-fit:contain`.
- Close on the × button, on scrim click, and on Escape.
- Trap focus while open and restore focus to the image when it closes. The product modal
  underneath is itself a dialog — make sure Escape closes the lightbox first and does not
  also close the product modal in the same keypress.
- Give the trigger image `cursor:zoom-in`, a visible `:focus-visible` ring, and make it
  keyboard-operable (Enter and Space), since it is now a control.

**What Remove must do.** Clear `preview.dataset.path` (this is the value the save reads — see
the comment at line 2578 explaining why it reads `data-path` and never `src`), clear
`preview.src`, hide the preview, show the placeholder again, clear `#m-img-status`, and show
the two controls only when an image is present. **Removal is not saved until the
administrator presses Save Changes** — say so in the status line, matching the existing
`"Uploaded (… KB). Save to attach it to the product."` wording. Cancel must leave the stored
image alone.

**While you are in there,** the image field is built from a template string carrying long
inline `style=` attributes on five elements. Move those into real classes in `portal.css`
alongside `.pac-thumb`. The modal will need them anyway once it has buttons and a zoom
affordance, and the inline styles cannot express hover or focus states.

**Do the same for Add Product.** `productModalBody(null)` builds both modals; the Add path
starts with no image, so Remove and zoom simply stay hidden until one is uploaded. Verify
both.

*Done when:* an administrator can open Edit Product, click the photo to see it full size,
close the zoom, press Remove, press Save Changes, and find the card back to the camera
placeholder in the grid, on the storefront, and in the database.

---

# Order of work

1. Task 1 — self-contained, and it gives you an immediate visual check that `p.image` is
   populated.
2. Task 2 — the server rule. Test it with a direct request before touching the interface.
3. Task 3 — the modal, now that Remove has something to talk to.

Test each against the real XAMPP database with the seeded data before moving on. Do not batch
all three and test at the end.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
