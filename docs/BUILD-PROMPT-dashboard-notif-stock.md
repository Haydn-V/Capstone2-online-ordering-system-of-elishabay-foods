# Build prompt — dashboard shortcut, notification hierarchy, identity in the header, stock quantities, shop sorting

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Five changes requested by the capstone adviser. I have traced the current behaviour of each;
read the surrounding code before changing it and tell me if any diagnosis is wrong.

## Conventions

- Non-GET calls go through `EbApi`, which attaches the CSRF token. Never hand-roll a `fetch()`
  for a write.
- Hiding a control is presentation, not security — `api/core/Rbac.php` says so in its header.
  Every endpoint decides for itself.
- Use the existing tokens in `assets/css/portal/portal.css` and
  `assets/css/public/styles.css`. **No new colour literals.** Everything must hold up in both
  themes, light and dark.
- Never signal state with colour alone — pair every colour with a label or an icon.
- Match the house comment style: explain **why** a change exists, not what the line does.
- Respect `prefers-reduced-motion` on anything you animate.
- Update `docs/API.md` for any endpoint change.

---

# Task 1 — Make the Critical Stock card a shortcut

**Where:** `renderDashboard()` in `assets/js/portal/engine.js`, the `$("#dash-stats").innerHTML`
block (~line 1555).

The dashboard's four stat cards are plain `<div>`s. The third one reads **Critical Stock**
with a count and a sub-line "N product(s) out of stock", and nothing happens when you click
it — so an administrator who sees "3 critical" has to navigate to Inventory by hand and filter
it themselves.

**Make it a real control.**

- Turn the Critical Stock card into a `<button>` (not a div with a click handler — it must be
  keyboard-reachable and announce itself). Give it `cursor:pointer`, a hover state, and a
  visible `:focus-visible` ring.
- Clicking it opens the inventory list **already filtered to critical stock**, so the
  administrator lands on exactly the products that need restocking.
- The "N product(s) out of stock" sub-line is a second, separate target — clicking it filters
  to out-of-stock rather than critical.

**Where it should navigate.** There are two candidate destinations and they need different
permissions, so route by what the signed-in role actually holds:

- Holds `inventory.manage` → **Inventory Management → Stock Overview** (`navigate("inventory-manage", "overview")`),
  because that screen can actually restock. Its query already reads
  `adminState.invOverviewLevel`, so set that before navigating.
- Holds only `inventory.report` → **Inventory Report** (`navigate("inventory")`), setting
  `#filter-inventory` to the level and re-rendering.
- Holds neither → the card must not be clickable at all. Do not offer a control that
  `navigate()`'s permission guard will bounce. The "View All" button on the Recent
  Transactions panel carries a `data-perm` for exactly this reason and its comment explains
  the rule — follow it.

**Don't bolt on a one-off.** `navigate(mod, tab)` takes no filter argument, and the existing
deep-link mechanism (`[data-goto]` ~line 1421, `.dash-shortcut-btn[data-mod]` in
`initSidebar()`) only carries mod and tab. Decide how a filter travels with a navigation —
extending the `data-goto` convention with an optional filter attribute is cleaner than setting
`adminState` from the click handler and hoping the destination reads it — and say which you
chose and why. Whatever you pick, the destination screen must show its filter as *active* in
its own filter control, so the administrator can see why the list is short and can clear it.

*Done when:* an administrator clicks Critical Stock on the dashboard and lands on a filtered
inventory list, the filter control shows "Critical" selected, and a Cashier sees a
non-interactive card.

---

# Task 2 — A hierarchy of notification urgency

Right now every notification is equal: `api/notifications/list.php` returns them newest-first
and the bell shows a plain count. There is no way to tell an expired batch from a completed
order.

**The `notifications` table** has `type ENUM('new-order','payment','hold','completed','return','inventory','audit')`,
`is_read`, `created_at`, and no notion of priority.

## The levels

Use three, and name them in the interface:

- **Critical** — needs action now, money or stock is at risk.
- **Warning** — needs attention today.
- **Info** — a record of something that happened.

**I did not get confirmation on which events sit where, so use this mapping and flag it in
your summary so the group can take it to the adviser:**

| Level | Events |
|---|---|
| Critical | A product hitting out-of-stock or critical level; a batch already expired but still counted as sellable; a retailer payment past its due date |
| Warning | A batch expiring within 30 days; an order on hold; a new online order or payment awaiting verification; a return request received |
| Info | Order completed; audit entries; application submitted |

## Storage

Add a `priority` column to `notifications` via a migration in `db/migrations/`, numbered after
the highest one present, and **copy the exact structure of `db/migrations/005-customer-profile.sql`**:
a header comment explaining why, a `DELIMITER //` stored procedure guarded by
`information_schema` lookups so it is safe to run twice, `CALL` then `DROP PROCEDURE`, no
`USE` statement, and a verification query in a trailing comment. Fold the column into
`db/schema.sql` too, and backfill existing rows from their `type` using the table above.

Store the level rather than deriving it in JavaScript: the bell, the dashboard panel and the
notifications module all read the same rows, and a rule that lives in one screen's script
drifts from the others — `REMEDIATION.md` catalogues exactly that failure elsewhere in this
codebase.

## Producers

Grep for `INSERT INTO notifications` and set a priority at every site — `api/shop/checkout.php`,
`api/orders/status.php`, the returns endpoints, `api/b2b/apply.php` and the inventory
endpoints among them. Put the type→priority default in **one** PHP helper so a new producer
cannot invent its own scale.

**A gap you will find:** nothing currently creates a notification when stock crosses into
critical or out-of-stock, even though the `inventory` type exists. Without a producer the
whole Critical level stays empty and Task 1's shortcut points at a number nobody was told
about. Add it at the point stock actually moves — `Stock::sell()` in `api/core/Stock.php` is
the natural hook, since every path that reduces stock goes through it. Fire only on the
**transition** into a band, not on every sale of an already-critical product, or the bell
becomes noise and staff stop reading it. Do the same for expiry if you can do it without a
scheduler; if you cannot, say so rather than inventing one.

## Consumers

- `api/notifications/list.php` — order by unread first, then priority, then newest. Return
  the priority and a per-level unread count.
- The bell (`#nd-list` in `portal/shell.html`), the dashboard panel (`#dash-notifs`,
  engine.js ~line 1665) and the notifications module must all use that same order and show
  the level with **a label or icon as well as colour**.
- The bell's red dot should reflect unread *critical* items specifically, with the total count
  still visible. Someone glancing at the topbar should be able to tell "3 things happened"
  from "something is on fire".

*Done when:* an out-of-stock product raises a Critical notification that sorts above an older
completed-order notice in all three places, and the level is legible without relying on colour.

---

# Task 3 — Move "Signed in as …" into the header

**Where:** `assets/js/portal/engine.js` ~line 1129:

```js
$("#topbar-role-label").textContent = "Signed in as " + user.role;
```

Find where `#topbar-role-label` currently lives in `portal/shell.html` — it is not in the
`<header class="app-topbar">` block, so it is sitting somewhere else in the shell.

**What the adviser asked for:** it belongs in the header, beside the profile avatar, sized so
it reads as a quiet identity line rather than a heading — its job is to make plain *who is
using the system*.

- Place it immediately before `#topbar-avatar` inside `.topbar-user`.
- Show **the user's name and their role**, not the role alone — "who is using the system" is
  the point, and `Signed in as Super Admin` names a role while telling you nothing about the
  person. The avatar already renders initials, and the dropdown already carries `#ud-name`
  and `#ud-role`; the header line should agree with them.
- Two lines, name above role, or one line with the role in a smaller muted weight — your call,
  but it must be visibly subordinate to the page heading and must not push the avatar or the
  theme toggle off the bar.
- Keep the avatar and its dropdown working exactly as they do now.
- **Responsive:** below roughly 900px the text collapses and only the avatar remains. Verify
  at 390px that the topbar does not wrap or overflow.
- Remove the old element and its styles rather than hiding them, so there is one identity
  line and not two.

*Done when:* the header shows who is signed in beside the avatar at desktop width, collapses
cleanly on a phone, and no stale label remains where the old one was.

---

# Task 4 — Show the available quantity on the storefront

**The adviser asked for the quantity available to be shown, not just "In Stock".**

**The blocker:** `api/shop/products.php` never sends the number. It returns

```php
'inStock'     => (int) $r['stock'] > 0,
'stockLevel'  => $b['level'],
'stockLabel'  => $b['label'],
```

— a boolean and two derived strings. The storefront cannot display a quantity it was never
given, so the endpoint changes first.

- Add `'stock' => (int) $r['stock']` to the response.
- Show the quantity wherever the storefront currently shows only a stock label: the product
  card in the shop grid, the product detail modal, and the best-sellers carousel on the
  landing page. Keep the existing level styling — the pill stays green/amber/red — and put
  the number in it: "In Stock · 160 available", "Only 6 left", "Out of Stock".
- Keep the wording honest at the boundaries. Zero must read as Out of Stock and never
  "0 available" beside an enabled Add button.
- **While you are here:** clamp Add to Cart to the available quantity, and say so in the
  quantity stepper. Publishing an exact figure and then letting someone add 99 of a product
  with 6 left makes the number look wrong. The server already re-checks availability at
  checkout — this is about not inviting a failure the customer can see coming.

**One caution to raise, not to act on:** publishing exact inventory to a public storefront
also publishes it to competitors, which is why most shops show an exact count only when stock
is low. Build what the adviser asked for, but mention this in your summary so the group can
make the call deliberately — it is a one-line change to switch to "exact only when low" later.

*Done when:* every product on the landing page and the shop shows its real available quantity,
sourced from the database rather than inferred.

---

# Task 5 — Best-seller sorting and Top 5 / Top 10 in the shop

**Where:** the `#sort-select` control in `public/shop.html` (~line 111), `state.filter.sort`
and `renderProducts()` in `assets/js/public/site.js`, and the sort map in
`api/shop/products.php` (~line 42), which currently offers `featured`
(`p.is_best DESC, p.sold DESC`), `price-asc`, `price-desc`, `rating` and `name`.

**Add:**

- A **Best Selling** sort — `p.sold DESC` — as a first-class option. `featured` is not the
  same thing: it ranks the manually-flagged products first.
- **Top 5** and **Top 10** options that limit the grid to that many best sellers, so the
  adviser's "top 5 / top 10" is something a customer can actually select.
- When a category filter is active, Top 5 / Top 10 must mean *within that category* — the
  five best-selling Deboned Bangus, not the global five filtered down to whatever happens to
  be in that category. This is the case most likely to be got wrong; test it explicitly.

**Check where the limiting has to happen.** Determine whether the shop grid is server-paged
through `shop/products.php` or filtered client-side from a loaded array, and apply the limit
on that side — do not fetch fifty rows and hide forty-five, and do not limit client-side if
the server is paging, or page two will contradict page one. Say which it is in your summary.

**Raise this with the group.** The adviser's phrasing was "Top 5 / Top 10 **categories** of
products". The database has exactly **two** categories — Deboned Bangus and Bottled Gourmet
Bangus — so a top-five ranking *of categories* cannot exist. I have read it as top-selling
**products**, which is the only version that works with this catalogue. Build that, and flag
the ambiguity in your summary so the group can confirm with the adviser rather than discover
it at the defense.

*Done when:* a customer can sort by Best Selling and narrow to the Top 5 or Top 10, the limit
respects the active category, and the ranking matches the Best Sellers table in the portal.

---

# Order of work

1. Task 3 — self-contained, no schema, quick visible win.
2. Task 4 — the endpoint change first, then the three storefront surfaces.
3. Task 5 — same endpoint and the same storefront file; do it while that code is in your head.
4. Task 1 — the dashboard shortcut.
5. Task 2 — the largest piece: migration, producers, then the three consumers.

Test each against the real XAMPP database with the seeded data before moving on. Do not batch
all five and test at the end.

Two things I want stated back in your summary: the notification priority mapping you
implemented, and whether the shop grid pages server-side or client-side.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
