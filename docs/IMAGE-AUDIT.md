# Image pipeline audit — Phase 1

Diagnosis only. Nothing in this document has been fixed.

Environment as observed: XAMPP on Windows, project served at
`http://localhost/elishabay/`, MySQL and Apache started for this audit
(neither was running). Live reads against `elisha_bay_db` on **2026-08-22**.

*(Correction: this line first said 2026-08-18. That was the date on the most
recent order rows, not the date of the audit — the two walk-in orders quoted in
§7 were placed on the 18th and read on the 22nd.)*

---

## 0. The headline

**There is no upload pipeline. There is no server-side upload code of any kind.**

```
grep -rn '$_FILES'            --include=*.php .   -> 0 matches
grep -rn 'move_uploaded_file' --include=*.php .   -> 0 matches
grep -rn 'enctype'            --include=*.html .  -> 0 matches
ls uploads/                                       -> No such file or directory
```

Every "upload" in this system is a `FileReader` in the browser. Two of the four
controls encode the file to a base64 data URL and post it as a JSON string; two
send nothing at all.

That single fact explains four of the five reported defects. They are not four
bugs — they are one absent subsystem observed from four screens.

---

## 1. Every upload control in the UI

| # | Screen | Control | File:line | Handler | Sends | To |
|---|---|---|---|---|---|---|
| U1 | Admin → Products → Add/Edit Product modal | `<input type="file" id="m-prod-image">` | [engine.js:2557](../assets/js/portal/engine.js:2557) | `attachImagePreview()` [engine.js:2645](../assets/js/portal/engine.js:2645) | JSON `{ image: "<raw data URL>" }` | `api/products/save.php` |
| U2 | Admin → Landing Page → Hero image cards | `<input type="file" data-hero-file="N">` | [engine.js:2259](../assets/js/portal/engine.js:2259) | `wireLandingImages()` → `handleUpload()` → `storeImage()` [engine.js:2358](../assets/js/portal/engine.js:2358) | **nothing** — writes `SITE_CONTENT.hero[i].img` in memory | *(nowhere)* |
| U3 | Admin → Landing Page → Best Sellers table, per-product photo | `<input type="file" data-prod-file="ID">` | [engine.js:2294](../assets/js/portal/engine.js:2294) | same `handleUpload()` | **nothing** — writes `SITE_CONTENT.productImages[id]` in memory | *(nowhere)* |
| U4 | Storefront → Checkout → GCash/Bank proof | `<div class="upload-mock" id="upload-mock">` | [site.js:746](../assets/js/public/site.js:746) | click handler [site.js:785](../assets/js/public/site.js:785) | **nothing** — sets `uploaded = true`, prints `"✓ payment-proof.jpg attached (mock)"` | *(nowhere)* |

**U4 is not a file input.** There is no `<input type="file">` anywhere on the
storefront. The control is a `div` with `role="button"`; clicking it never opens
a file picker, never touches a file, and the string `payment-proof.jpg` is
hardcoded. The label directly beneath it reads *"Proof-of-payment only — this
demo does not process real payments via any API."*

### Two different client-side encoders

U1 and U2/U3 do not encode the same way, and this matters:

- **U2/U3** call `storeImage()` ([engine.js:2137](../assets/js/portal/engine.js:2137)):
  downscale to 1200px longest edge, re-encode JPEG q0.72, ~150–250KB.
- **U1** does **not** call `storeImage()`. `attachImagePreview()` runs a bare
  `reader.readAsDataURL(file)` and posts `preview.src` verbatim — the
  **full-resolution original**, base64-inflated by 33%.

The database confirms it: the three stored product images are 414KB, 519KB and
**918KB** of base64 — none went through the downscaler the schema comment claims
they did (§3).

---

## 2. Every PHP file that touches an upload or writes a file

**None.**

| Endpoint | Reads `$_FILES` | Writes to disk | Stores |
|---|---|---|---|
| `api/products/save.php` | no | no | validates the posted data URL against `^data:image/(png\|jpe?g\|webp\|gif);base64,…$`, caps at 8MB, writes it whole into `products.image_url` (LONGTEXT) |
| `api/content/save.php` | no | no | `about`, `vision`, `mission`, `contact_*`, `faqs` **only** |
| `api/shop/checkout.php` | no | no | `proof_ref_num` (text), `proof_uploaded` (derived) |
| `api/pos/checkout.php` | no | no | same |
| everything else | no | no | — |

Two findings fall straight out of this table.

**F1 — `content/save.php` accepts no image keys at all.**
It handles `about`, `vision`, `mission`, `contact`, `faqs`. It does **not**
accept `hero`, `featured` or `productImages`. Meanwhile `content/get.php` *does*
read and return `hero_slides.image_data` and `featured_products`. The reader and
the writer are asymmetric: `get.php` can return a hero image, and nothing in the
system can ever put one there.

This answers Phase 1 question 6 directly, and it is **not** the previously
reported "never wired" defect (W3/W5 in `REMEDIATION.md`). `content/save.php`
**is** called — [engine.js:2429](../assets/js/portal/engine.js:2429) posts to it
on every Save, and the text round trip was verified in Phase 4. The endpoint is
wired; it is *incomplete*. The image half of the payload is dropped by the
client (`saveLanding()` never puts `hero` in the body) and would be ignored by
the server if it were sent.

**F2 — `proof_uploaded` is a lie.** In both checkout endpoints it is set from
whether a *reference number string* was supplied: `$refNum !== null ? 1 : 0`
([shop/checkout.php:185](../api/shop/checkout.php:185),
[pos/checkout.php:152](../api/pos/checkout.php:152)). No file is involved. The
Payment Verification screen renders `✓ Proof Uploaded`
([orders.js:767](../assets/js/portal/orders.js:767)) for orders where nothing
was ever uploaded.

---

## 3. Image-bearing columns, and what is actually in them

### `products.image_url` — LONGTEXT NULL

```
mysql> SELECT id, name, CHAR_LENGTH(image_url) len, LEFT(image_url,45) sample FROM products ORDER BY id;
bg-adobo    Pinoy Adobo Bangus             NULL     (NULL)
bg-bayo     Ba-yo (Bangus & Tuyo)        519491     data:image/jpeg;base64,/9j/4QEIRXhpZgAATU0AKg
bg-hawaii   Hawaiian Style Bangus          NULL     (NULL)
bg-pesto    Bangus in Pesto Sauce        414255     data:image/jpeg;base64,/9j/4QEIRXhpZgAATU0AKg
bg-portu    Portuguese Style Bangus        NULL     (NULL)
...
db-steak    Asian Steak Bangus           918459     data:image/jpeg;base64,/9j/4QEIRXhpZgAATU0AKg
```

**Format: base64 data URLs.** 3 of 15 rows populated, 12 NULL. Not filenames,
not paths, not URLs. 1.81 MB of base64 in one column.

The `EXIF` / `TU0AKg` prefix (`MM\0*`, TIFF big-endian) confirms these are
untouched camera originals with EXIF intact, not canvas re-encodes. The schema
comment at [schema.sql:51](../db/schema.sql:51) asserts they are downscaled by
`IMG_MAX_EDGE 1200 / quality .72`; they are not. The comment describes U2's
encoder; the column is filled by U1's.

**Measured cost:** `GET api/shop/products.php` returns **1,856,279 bytes** — a
public, unauthenticated endpoint the storefront calls on every page load, 98% of
which is base64 that nothing renders (§4).

### `hero_slides.image_data` — LONGTEXT NULL

```
mysql> SELECT id, title, CHAR_LENGTH(image_data) len FROM hero_slides;
1  Pesto Bangus      NULL
2  Adobo Bangus      NULL
3  Asian Steak       NULL
4  Tuyo Delizioso    NULL
5  Ba-yo Signature   NULL
```

**5 rows, all NULL, and structurally unfillable** — no code path writes this
column. That is defect 3.3 in one line.

### `featured_products` — 0 rows

Also never written. `content/save.php` accepts no `featured` key, even though
`saveLanding()` computes the ticked list at
[engine.js:2416](../assets/js/portal/engine.js:2416).

### Reference / proof image — **no column exists**

`orders` has `proof_uploaded TINYINT(1)`, `proof_ref_num VARCHAR(100)`,
`proof_amount DECIMAL(10,2)`. There is no column that could hold an image or a
path to one, on `orders` or anywhere else. There is no `payments` table at all —
"Payment History" is a view over `orders` (§7).

---

## 4. Front-end render sites, lined up against the columns

| # | Where | File:line | Field read | Source of that field | Verdict |
|---|---|---|---|---|---|
| R1 | **Storefront product card** (Shop grid + Best Sellers) | [site.js:256](../assets/js/public/site.js:256) → `jarSVG(..., p.img)` | **`p.img`** | `shop/products.php` sends **`image`** | ❌ **MISMATCH — defect 3.2** |
| R2 | Storefront hero accordion | [site.js:1558](../assets/js/public/site.js:1558), [:1596](../assets/js/public/site.js:1596) | `panel.img` | `HERO_PANELS`, patched from `content/get.php` `hero[].img` | ✅ key matches — source column always NULL |
| R3 | Storefront product-image override | [site.js:1841](../assets/js/public/site.js:1841) | `c.productImages[p.id]` | **nothing** — `content/get.php` never returns `productImages` | ❌ dead key |
| R4 | POS product tile | [pos.js:99](../assets/js/portal/pos.js:99) | `p.image` | `products/list.php` sends `image` | ✅ |
| R5 | Product Add/Edit modal preview | [engine.js:2551](../assets/js/portal/engine.js:2551) | `p.image` | `products/list.php` sends `image` | ✅ |
| R6 | Landing editor hero cards | [engine.js:2252](../assets/js/portal/engine.js:2252) | `slide.img` | `content/get.php` `hero[].img`, or in-memory after upload | ✅ key matches — never persists |
| R7 | Landing editor best-seller photos | [engine.js:2279](../assets/js/portal/engine.js:2279) | `SITE_CONTENT.productImages[id]` | in-memory only | ❌ orphan store |
| R8 | Payment Verification | [orders.js:761–767](../assets/js/portal/orders.js:761) | `o.proof.refNum`, `o.proof.uploaded` | `orders/list.php` | ⚠ renders a *reference number* and the words "Proof Uploaded" — **no image element exists** |
| R9 | Order Detail modal | [orders.js:1566](../assets/js/portal/orders.js:1566) | same | same | ⚠ same |

### R1 proven live, not inferred

```
$ curl -s http://localhost/elishabay/api/shop/products.php   # keys of data[0]
['best','cat','desc','id','image','inStock','name','price','rating','sold','stockLabel','stockLevel','tint']
```

There is **no `img` key**. `loadShopCatalog()`
([site.js:1909](../assets/js/public/site.js:1909)) pushes the API objects into
`PRODUCTS` verbatim — there is no mapping step — and `createProductCard()` reads
`p.img`, which is `undefined` for every product, so `jarSVG()` takes the
placeholder branch every time.

**That is the whole of defect 3.2.** Not caching, not a path base, not a second
column: one endpoint spells it `image`, one renderer spells it `img`, and the
1.8MB payload carrying the images is downloaded and discarded on every page
load. The staff screens (R4, R5) read `image` and therefore work — exactly the
asymmetry the defect report describes.

The only thing that ever assigns `p.img` is R3, from `c.productImages`, which is
never populated by anything. Two broken halves that were presumably meant to
meet.

**One correction to the defect report.** It says edited images appear "on the
dashboard". They do not — `portal/views/dashboard.html` contains zero `img`
elements and `renderDashboard()` renders no product image. The two staff
surfaces that show a product photo are the POS tile grid and the product-edit
modal.

---

## 5. Disk and Apache

| Question | Answer |
|---|---|
| Does the code claim to write to a directory? | No. No PHP file writes any file. |
| Does `uploads/` exist? | No. |
| Any image files on disk? | One: `assets/img/bgfish.png` (decorative background, 1.0MB). Nothing product-, content- or proof-related. |
| Can Apache write to the project root? | **Yes.** PHP probe: `mkdir` ok, `file_put_contents` ok, running as user `rain`, docroot `C:\xampp\htdocs\elishabay`. Probe file created, read, deleted. |
| Is a project subfolder web-reachable? | Yes — the root `.htaccess` 404s only `.claude`, `.agents`, `_archive`, `db/*.sql`, `docs/`, `tools/` and `api/config/`. A new `/uploads/` is served with no rule needed. |
| `file_uploads` | `1` |
| `upload_max_filesize` / `post_max_size` | 40M / 40M |
| `fileinfo` (needed for the I5 MIME check) | **loaded** |
| `exif` | loaded |
| **`gd`** (needed for the I5 re-encode) | **NOT LOADED** |

### Blocker for I5

`extension=gd` is commented out at `C:\xampp\php\php.ini:931`. The DLL is present
(`C:\xampp\php\ext\php_gd.dll`); it is one uncommented line plus an Apache
restart. Without it `imagecreatefrom*` / `imagewebp` do not exist, so neither the
"re-encode through GD to strip anything embedded" half of I5 nor I1's `.webp`
output can be implemented. Enabling it is the first step of Phase 2 — flagged
here because it edits a file outside the project.

---

## 6. `content/save.php` — called, and persisting to MySQL

- **Called:** yes, by `saveLanding()`
  ([engine.js:2429](../assets/js/portal/engine.js:2429)).
- **Persists to MySQL:** yes — `site_content` and `faqs`, in one transaction,
  with an audit row.
- **`localStorage` is also written**
  ([engine.js:2444](../assets/js/portal/engine.js:2444)), documented as a preview
  mirror, and read back by the public page at
  [site.js:1739](../assets/js/public/site.js:1739) as a first-paint cache.

So the landing-image defect is **not** an unwired endpoint. It is:

1. `saveLanding()` never puts `hero` in the request body, and
2. `content/save.php` would ignore it if it did, and
3. the in-portal preview reads `localStorage`, which **is** written with the
   images — so the preview shows them.

That is precisely the reported symptom: *shows in preview, gone after logout*.
The preview reads the browser's mirror; the public page reads the server, where
the image never arrived. Same browser and same session make it look saved.

### Two related problems found in the same function

- **I7 violation.** `saveLanding()` fires `toast("Landing page changes saved.")`
  **synchronously** at [engine.js:2448](../assets/js/portal/engine.js:2448),
  outside the promise, in addition to the `.then()` toast. A failed POST shows an
  error toast *and* a success toast. The screen claims a save it did not get.
- **Storage meter.** `updateStorageMeter()` measures the payload against a 5MB
  `localStorage` ceiling — a UI built entirely around the client-side store this
  work removes.

---

## 7. Preliminary note on defect 3.1 (walk-in payment)

Not Phase 1's scope, but it changes what Phase 3.1 may assume.

**There is no `payments` table.** `SHOW TABLES` returns 24 tables; none is
`payments`. `api/payments/list.php` serves `payment_accounts` — retailer *credit
accounts* (Net 30/60/90), a different concept. "Payment History" is
`portal/views/transactions.html`, rendered by `renderTransactions()`
([engine.js:3503](../assets/js/portal/engine.js:3503)), which reads
`api/orders/list.php` with no type filter.

Walk-in orders **are** being written. Two placed by `emp-03` through
`pos/checkout.php` on 18 August:

```
EB-08FA2F-697  walk-in  cash  completed  1794.00  pay_verified=1  cashier=emp-03  2026-08-18 14:13:36
EB-37C8EF-351  walk-in  cash  completed   897.00  pay_verified=1  cashier=emp-03  2026-08-18 14:10:33
```

So I8's premise — "a second payment code path" — does not hold as literally
stated: there is one order-writing path per channel, and no payment table for
either to write to. `pos/checkout.php` writes order, line items, stock
decrements and the audit row in a single transaction and looks complete on
inspection.

**Marked `INFERRED` and deliberately not concluded.** I have read the code and
the rows; I have not yet driven the Cashier UI. Remaining candidates: the
Cashier portal's rendering of the Transactions module, or the reporter meaning a
different screen. Phase 3.1 opens with the browser click-through, not a fix.

---

## 8. Preliminary note on defect 3.5 (checkout prefill)

Also outside Phase 1, and it materially changes 3.5's scope, so it is recorded
now rather than discovered mid-fix.

**`customers` has no address column.**

```sql
CREATE TABLE customers (
  id, name, email, username, password, contact, status, joined, created_at
);
```

`contact` exists. Address does not — not one column, not an address table. The
only address the system stores is `orders.address`, per order.

Consequently:

- **Phone** can be prefilled today: `customers.contact` exists, and
  `shop/me.php` already returns it. `auth/me.php` does not.
- **Address** has no source. The brief's "state which of these the schema
  actually supports" answer is: **none**. Not one saved address, not multiple —
  zero.
- The storefront's own **Profile → Delivery Address** form
  ([profile.html:163](../public/profile/profile.html:163)) is a **complete
  mock**: submit validates that street is non-empty, calls
  `showToast("Address saved!")`, and writes nothing. Same for Personal Info and
  the password form on that page. No endpoint exists for any of them.
- The checkout form prefills only `#co-name`, from `state.auth.name`
  ([site.js:729](../assets/js/public/site.js:729)). `#co-contact` and
  `#co-address` have no prefill at all.

3.5 as written therefore requires a schema addition and a customer-profile write
endpoint, not just a read. Both are named in Phase 2's list below.

---

## 9. Root cause, stated once

> **Nothing in this system ever writes a file.** Every image is a base64 string
> in a JSON body, stored in LONGTEXT or in `localStorage`, and the screens that
> "work" work only because writer and reader happen to agree on a key name
> inside one browser.

| Defect | Immediate cause | Underlying |
|---|---|---|
| 3.2 product cards | `shop/products.php` sends `image`; `createProductCard` reads `img` | data URLs in the API payload; no path to agree on |
| 3.3 landing images | `saveLanding()` omits `hero`; `content/save.php` ignores it; preview reads `localStorage` | no upload endpoint to POST the file to |
| 3.4 checkout proof | the control is a `<div>`, not a file input; no column to store it | no upload endpoint, so the control was never built |
| — Landing per-product photos (R3/R7, **unreported**) | `SITE_CONTENT.productImages` has no table, no endpoint, no reader | same |

R3/R7 is a **fifth image defect nobody reported**: the Landing Page editor's
per-product photo picker writes to an object with no table behind it, no save
path, and whose only consumer is a `content/get.php` key that does not exist. It
fails exactly like 3.3 and is closed by the same pipeline.

---

## 10. What Phase 2 has to build, confirmed against this audit

1. Enable `gd` in `php.ini` — prerequisite, currently blocking I5.
2. `api/uploads/image.php` — the first `$_FILES` handler in the codebase.
3. `/uploads/{products,content,references}/` plus an `.htaccess` disabling PHP.
4. `imageUrl()` in `assets/js/core/format.js`, adopted by R1–R7.
5. Schema work:
   - `products.image_url` LONGTEXT → path
   - `hero_slides.image_data` LONGTEXT → path
   - **new** column for the checkout reference image (none exists)
   - a home for landing per-product photos (R7), or a decision to fold them into
     `products.image_url`
   - **new** address storage on `customers` (for 3.5)
6. Migration: 3 rows of base64 → files on disk + root-relative paths. The 5 hero
   rows and 0 featured rows need only a type change.
7. Client rewrites: `attachImagePreview()` (U1), `handleUpload()`/`storeImage()`
   (U2/U3), and **build** U4, which does not exist.
8. Remove `updateStorageMeter()`'s 5MB `localStorage` ceiling and the duplicate
   synchronous success toast in `saveLanding()`.

---

*Phase 1 ends here. No source file was modified.*
