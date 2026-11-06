# Build prompt — Philippine address picker, plus a layout and cleanup pass

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Twelve items across the storefront and the staff portal. **Task 1 is a real feature with new
database tables; everything after it is layout, cleanup and one dashboard change.** Do Task 1
first and on its own.

## Conventions

- Non-GET calls go through `EbApi`, which attaches the CSRF token. Never hand-roll a `fetch()`
  for a write.
- Customer endpoints call `Auth::requireCustomer()` and scope by the session's customer id —
  never by an id taken from the request body.
- Use the existing tokens in `assets/css/portal/portal.css` and `assets/css/public/styles.css`.
  **No new colour literals.** Both themes, light and dark, on everything you touch.
- Never signal state with colour alone.
- No inline `onclick` handlers, and no inline `style="…"` for anything that needs a hover or
  focus state.
- Respect `prefers-reduced-motion`.
- **Do not write PHP with `cat`, heredocs or `echo`** — this is Git Bash on Windows and it
  breaks on the apostrophes and `$` signs these files are full of. Use the editor.
- Match the house comment style: explain **why** a change exists.
- Update `docs/API.md` for every endpoint you add or change.

---

# Task 1 — A proper Philippine address picker

Right now the delivery address is a single free-text box, so people type whatever they like and
the data is unusable for anything. Replace it with a guided picker.

## What was decided

**Four cascading dropdowns: Region → Province → City or Municipality → Barangay**, each one
filtering the next. **House number, street and ZIP are typed by the customer** in their own
fields, because those are not in any published list.

**The location data lives in the database, not in the code.** Roughly 17 regions, 82 provinces,
1,600 cities and municipalities, and 42,000 barangays.

**Why the database and not the JavaScript.** 42,000 barangay rows is about 4 MB with indexes —
a small table by any measure, and with an index on the parent column the lookup time barely
moves as the table grows. The customer never receives the table: picking a city fetches that one
city's barangays, which is a few dozen names and a couple of kilobytes. Putting the same list in
a JavaScript file would mean every visitor downloading all 4 MB on every page load whether they
need it or not, which is the thing that would actually hurt. That is the whole reason this is a
database job.

## Getting the data — read this before you start

The official list is the **PSGC** (Philippine Standard Geographic Code), published by the
Philippine Statistics Authority. Get it from there.

- **If this machine has internet**, fetch the current PSGC publication and convert it into the
  seed file. Say where you got it and what date it covers.
- **If it does not**, stop and tell me. Ask me to download the file and say exactly what format
  you want it in and where to put it.
- **Do not write the city, municipality or barangay lists from your own knowledge.** Regions and
  provinces you can probably get right; 1,600 municipalities and 42,000 barangays you cannot,
  and a wrong or missing town is the kind of thing a panelist finds by typing their own
  hometown. An incomplete list presented as complete is worse than asking me for the file.

## Schema

Add a migration in `db/migrations/`, numbered after `014-vat.sql`, and **copy the exact
structure of `db/migrations/005-customer-profile.sql`**: a header comment explaining why, a
`DELIMITER //` stored procedure guarded by `information_schema` lookups so the file is safe to
run twice, `CALL` then `DROP PROCEDURE`, no `USE` statement, and a verification query in a
trailing comment.

Four reference tables, keyed by their real PSGC codes rather than invented ids — the codes are
stable, and using them means the data can be refreshed later without renumbering everything:

```
ph_regions        code, name
ph_provinces      code, region_code, name
ph_cities         code, province_code, name, type ('City' | 'Municipality')
ph_barangays      code, city_code, name
```

**Index every child table on its parent code** — `ph_barangays.city_code` especially. That index
is what keeps the lookup fast regardless of the table's size, so do not skip it.

**One province wrinkle to handle, not to ignore:** cities in Metro Manila and a few other
highly urbanised cities do not belong to a province. Decide how you represent that — a nullable
`province_code` with the region as the parent, or a synthetic province row per the PSGC's own
convention — and make the dropdowns behave sensibly for those cities rather than stranding an
NCR address halfway through. Say what you chose.

Put the seed data in its own file — `db/seed-ph-locations.sql` — rather than swelling
`seed.sql`, so ordinary database dumps of the project stay small and easy to pass around.

**Tell me how to load it, in `docs/SETUP.md`.** The file will be several megabytes, and
**phpMyAdmin on XAMPP refuses uploads over 2 MB by default**, so importing it there fails with a
confusing error. It has to go in from the command line:

```
C:\xampp\mysql\bin\mysql -u root elisha_bay_db < db\seed-ph-locations.sql
```

Write that down in SETUP.md alongside the existing steps, because the next person to install
this project will hit the same wall.

**Then check something before you design the customer columns.** `db/migrations/005-customer-profile.sql`
added `addr_street`, `addr_city`, `addr_province`, `addr_zip` and `addr_region` to `customers`
— but those columns **do not appear in the current `db/schema.sql`**. Find out whether the live
database has them and `schema.sql` is simply out of date, or whether something removed them. A
fresh install and a migrated install disagreeing is a problem in its own right; fix it and say
what you found.

The address a customer saves should end up as: region code, province code, city code, barangay
code, plus typed house number/street and ZIP. Keep a composed single-line version for printing
on receipts, invoices and courier labels so nothing downstream has to reassemble it — and store
the **names** alongside the codes on the order, not just the codes. An order is a historical
record; if a barangay is renamed or recoded in a future PSGC release, last year's invoice must
still print what it was actually shipped to.

**Do not lose what is already stored.** `orders.address` is free text and existing rows have
real addresses in it. Old orders keep showing what they were shipped to; only new addresses go
through the picker.

## Endpoints

One read-only endpoint is enough — `api/locations/list.php`, taking a level and an optional
parent code, returning that level's children ordered by name. No authentication needed; this is
public reference data.

**It must only ever return one parent's children.** No endpoint anywhere should be able to
return the whole barangay table — that is the one query that would be slow, and nothing needs
it. Validate the parent code and refuse a request without one for the lower levels.

Cache each response client-side for the page's lifetime, so flipping between two provinces does
not re-fetch the same city list. Since this data changes at most every few years, sending a long
`Cache-Control` header on the response is worth doing too.

## Where it goes

Apply the same component in all three places, built once and reused:

1. **Customer registration** — the Create Account tab of the sign-in modal.
2. **Become a Retailer Partner** — the business address.
3. **Checkout** — the delivery address.

In each: every dropdown stays empty and disabled until its parent is chosen, and **changing a
parent clears all its children** rather than leaving a stale selection that no longer belongs —
picking a new city must not leave the previous city's barangay sitting in the field. Show a
brief loading state while a list is fetched, since barangay lists come from the server.

Every dropdown must be keyboard-operable and must use the custom dropdown component already in
the project — do not introduce a second style of select. **Barangay lists can run to a hundred
entries in a large city, so type-ahead matters here**: typing the first few letters must jump to
the match, exactly as the product picker does.

**Prefill still has to behave.** The checkout already fills a signed-in customer's saved address
and follows a documented rule: only empty fields are filled, nothing is disabled, and editing a
prefilled field does not write back to the profile unless the save checkbox is ticked. Read that
comment block in `openCheckout()` and keep all of it working through the new fields.

---

# Task 2 — Checkout payment method layout

The payment area is the worst-looking part of the storefront right now.

- **The method buttons overlap the QR image.** Cash, GCash, Bank Transfer and the Net 30 / 60 /
  90 tiles are colliding with the QR code panel. Give them their own row that cannot run into
  the QR block — the two are separate steps and should read that way.
- **The QR image is too small to scan.** Someone is meant to point a phone at it. Make it large
  enough to actually work, keep it square, and let it scale sensibly at phone width.
- Tidy the block around it: the account name and number beside the QR, a clear instruction, and
  the reference-number and screenshot fields following on afterwards rather than fighting for
  the same space.

Check it at 390px as well as desktop — a QR that only works on a laptop is the wrong way round,
since the person scanning is holding the phone.

---

# Task 3 — VAT Maintenance: remove the explanatory paragraphs

Four blocks of explanation should come out. They read as documentation embedded in the screen,
and the screen is for people who already know what they are doing.

Remove the paragraph under each of:

- **Rules** — the one beginning "Changes apply to sales made after you save…"
- **Product tax types** — "A VAT-exempt product's shelf price has no VAT in it…"
- **Withholding agents** — "A withholding agent keeps part of what it pays…"
- **VAT summary** — "Every order not cancelled, dated by its invoice…"

Keep the counts that sit at the end of two of them — "0 of 15 products exempt" and "0
withholding agents" are live figures, not explanation, and they belong on screen. Move them
somewhere they still read naturally, such as beside the section heading.

**Remove only the prose. Do not touch the behaviour** — the rules themselves, the exempt-product
flags, the withholding rates and the summary query all stay exactly as they are.

One thing worth saying out loud: one of those paragraphs told the user to confirm the senior and
PWD rules with the business's accountant. Removing it removes a caveat, not just some text. If
your group wants that caution kept somewhere, the sensible home is your written documentation
rather than the screen.

**Then fix the VAT summary's date range.** The From and To fields are visibly out of line with
each other. Put them on one row with matching widths, aligned labels and equal heights, and make
them stack cleanly on a narrow screen.

---

# Task 4 — Landing Page module: two overlapping controls

Both problems are in the portal's Landing Page screen.

**Best Sellers — the stock badge looks clipped.** The Safe / Out of Stock marker renders as a
cut-off rectangle rather than a finished pill. Most likely a fixed height fighting the line
height, or a parent with `overflow:hidden` shaving the corners. Find the actual cause rather
than padding around it, and make the badge match the stock pills used elsewhere in the portal so
there is one treatment, not two.

**Payment Accounts — the buttons sit on top of the image.** The Upload QR button overlaps the
image container, and once an image is present the Replace QR and Remove buttons overlap it too.
**This affects both the GCash and the Bank Transfer cards.** Give the image its own bounded area
and put the controls below or beside it — never on top. The two states should share a layout, so
the card does not jump when an image is added or removed.

While you are there, make sure Remove actually clears the stored image and that the empty state
returns properly — the product image field had exactly this bug and it is the same shape.

---

# Task 5 — Sidebar: remove the "ADMIN PANEL" label

There is a small "ADMIN PANEL" caption under the Elisha Bay logo at the top of the sidebar,
shown to every signed-in user regardless of role. Remove it — an Inventory Staff member is not
in an admin panel, and the header already says who is signed in. Take out the markup and its
styles rather than hiding it, and close the gap it leaves so the logo block still sits correctly.

---

# Task 6 — POS Payment: the senior citizen checkbox

In the Payment Details section, the senior citizen / PWD checkbox is hard to see and sits
awkwardly in its row.

Make it a proper, deliberate control: a real checkbox with a large enough hit area, a clearly
associated label, a visible focus ring, and a distinct checked state that a cashier can confirm
at a glance from standing height. When it is ticked, the discount it applies should be visible
in the totals immediately — a cashier should never have to guess whether it took effect.

Style only. **Do not change the discount calculation**, which belongs to the VAT rules.

---

# Task 7 — Walk-In Order: centre the quantity buttons

The quantity popup that appears when a cashier picks a product has its buttons off-centre.
Centre them, give the minus, the number and the plus equal weight and spacing, and make the
number field wide enough for three digits without the buttons shifting. Use tabular figures so
the width does not change as the number changes.

---

# Task 8 — Sales Report: three fixes

**Remove the "Payment Methods in Period" panel.** Take the panel out of the view and stop
rendering it. The endpoint also computes this as `byMethod` in `api/reports/sales.php` — you may
leave that in the response harmlessly, but if nothing else reads it, removing the query is
tidier. Say which you did.

**Fix the four summary tiles.** Total Revenue, Orders, Average Order and Online Orders overflow
once a figure reaches six digits before the decimal point — the number runs into its
neighbour. Two things to do:

- Let the tiles use the empty space on the right. They are currently crowded into part of the
  width while the rest sits unused. Widen or redistribute them so each number has room.
- Make the numbers robust regardless: tabular figures, no wrapping mid-number, and a sensible
  minimum width so a tile does not resize as its value changes. Test with a value in the
  millions, not just with your seeded data.

**Change "Compare with" from a checkbox to a toggle.** It is an on/off choice, and a switch
reads as one far better than a tickbox. Keep it keyboard-operable with proper on/off semantics —
a styled `<div>` that only responds to clicks is not acceptable. The comparison period selector
beside it should disable itself when the toggle is off.

---

# Task 9 — A dashboard built for Inventory Staff

An inventory user currently sees a dashboard designed for management: total revenue, today's
sales, customer counts, a weekly sales graph and recent transactions. None of it is their job.

**Give them their own dashboard.**

| Instead of | Show |
|---|---|
| Total Revenue, Today's Sales, Customers | **Critical Stock**, **Total Products**, **Total Stock on Hand**, **Out of Stock** |
| Sales This Week graph | **Stock Overview** — stock levels across products |
| System Notifications (everything) | System Notifications, **inventory-related only** |
| Recent Transactions | **Product Rankings, top 1–5 by units sold this week** |

**Decide it by permission, not by role name.** Roles in this system are editable from the Roles
& Permissions screen, so a dashboard keyed to the literal name "Inventory Staff" breaks the
moment somebody makes a new role or renames that one. Pick the panels from the permissions the
signed-in user actually holds — someone with inventory permissions and no `sales.report` gets
the inventory view. Say in your summary exactly what rule you used.

The Critical Stock and Out of Stock tiles should be shortcuts to the filtered inventory list,
like the existing ones, and must not leave their filter behind when the user navigates away
afterwards.

For the rankings: **units sold this week**, Sunday to Saturday, matching how the Sales Report
already defines a week so the two never disagree. Show the product, the units, and its current
stock level — the useful question for this user is "what is selling fast and do we have enough
of it".

---

# Task 10 — Landing page: dark mode and section order

**Dark mode colour.** The "Verify Your Product Batch & Traceability" section keeps its light
appearance when the site switches to dark, so it sits in the page like a lit panel. Bring it
into the dark theme and give it the gold treatment the rest of the dark storefront uses.
Define the colours as tokens that change with the theme rather than as fixed values on the
section, or this will drift again the next time the palette moves.

**Section order.** Swap the positions of the batch traceability section and the About Us
section, so About Us comes first. Move the markup, not just the visual order — reordering with
CSS alone leaves the reading order wrong for anyone using a keyboard or a screen reader.

---

# Task 11 — Footer: remove the social icons

Remove the Facebook, Instagram and Email icon shortcuts from the footer. Take out the markup and
the styles rather than hiding them, and rebalance whatever row they were in so it does not leave
a hole.

**Check what else uses those details before deleting anything.** The About Us section and the
Landing Page maintenance screen both carry contact information, including a Facebook page link
that an administrator can edit. Removing the footer icons must not remove the ability to
maintain those, or break the About Us block that displays them.

---

# Task 12 — Retailer registration form

**Fix the spacing.** The fields, labels and sections are inconsistently spaced and the form
reads as untidy. Give it one rhythm: equal gaps between fields, aligned labels, consistent field
heights, and clear separation between the sections. Match the storefront's existing form
styling rather than inventing a new one — the checkout form is the closest reference.

**Remove the Wholesale Volume / Expected Monthly Volume field.** Take it out of the form and
stop sending it.

**Leave the `monthly_volume` column in the database.** Existing applications have values in it,
and dropping the column deletes that history to save nothing. Stop writing to it, and remove it
from the staff-facing B2B applications screen only if that screen currently shows it — check
before you remove anything there.

---

# Order of work

1. **Task 1**, alone, tested, before anything else. It is the only item with new tables, and it
   touches three separate forms.
2. Tasks 5, 11, 3 and 12's field removal — small deletions, quick to verify.
3. Tasks 2, 4, 6, 7 and the Task 8 layout work — the layout pass.
4. Task 10.
5. **Task 9** last — it is the largest behavioural change after Task 1.

Test each against the real XAMPP install with the seeded data, in both themes, at desktop and
phone widths, before moving on. Do not batch them and test at the end.

Five things I want stated back in your summary: where you got the PSGC data and what date it
covers; how you handled cities that have no province, such as those in Metro Manila; whether the
live `customers` table has the `addr_*` columns that `schema.sql` is missing; the exact rule you
used to decide who sees the inventory dashboard; and anything in this list you could not do as
described.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
