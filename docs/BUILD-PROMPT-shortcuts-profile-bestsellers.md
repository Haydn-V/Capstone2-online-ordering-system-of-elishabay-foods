# Build prompt — dashboard shortcuts, a scroll bug, a staff profile, and best-seller records

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Five items. I could not pull the latest files while writing this, so **treat every line number
below as a starting point, not a promise** — read the current code and tell me if any
diagnosis is wrong.

## Conventions

- Non-GET calls go through `EbApi`, which attaches the CSRF token. Never hand-roll a `fetch()`
  for a write.
- Hiding a control is presentation, not security — `api/core/Rbac.php` says so in its header.
  Every endpoint decides for itself.
- Use the existing tokens in `assets/css/portal/portal.css`. **No new colour literals.** Both
  themes.
- No inline `onclick` handlers.
- Match the house comment style: explain **why** a change exists.
- Update `docs/API.md` for any new endpoint.

---

# Task 1 — The Critical Stock shortcut leaves its filter behind

The dashboard's Critical Stock card now jumps to the inventory list filtered to critical. The
problem: that filter **sticks**. Navigate to Stock Overview by any other route afterwards and
it is still filtered to critical, with no indication of why the list is short.

**The cause is that the filter was stored as durable state** — most likely
`adminState.invOverviewLevel`, set by the shortcut and never cleared — when what the shortcut
actually expresses is a one-shot intent: *open this screen showing critical items this time*.

**Fix it as a one-shot, not as state.**

- Reaching Stock Overview from the sidebar, from the tab pills, or from any route other than
  the shortcut must open it at its **default filter**.
- Reaching it from the dashboard shortcut opens it filtered, with the filter control visibly
  set to Critical so the administrator can see why the list is short and can clear it.
- Leaving the screen and coming back must not resurrect the filter.

Decide how the intent travels — consuming it once on arrival and resetting the stored value,
or carrying it as a navigation argument rather than as `adminState` — and say which you chose.
The second is the sounder shape: a value that lives in `adminState` will be found and reused
by the next feature, and this bug will come back.

Apply the same rule to the out-of-stock shortcut and to any other filtered jump you add in
Task 2.

*Done when:* clicking Critical Stock filters the list, and opening Stock Overview from the
sidebar immediately afterwards shows everything.

---

# Task 2 — Quick access on the other three dashboard tiles

Critical Stock is already a working shortcut. Give **Total Revenue**, **Today's Sales** and
**Customers** the same treatment, using the same mechanism — do not invent a second one.

| Tile | Opens |
|---|---|
| Total Revenue | Sales Report |
| Today's Sales | Sales Report, range set to Today |
| Customers | User Management, Customer Accounts tab |

**The rules that already apply to Critical Stock apply here:**

- Each becomes a real `<button>`, keyboard-reachable, with hover and a visible
  `:focus-visible` ring — not a `div` with a click handler.
- Each carries the `data-perm` of the module it opens: `sales.report` for the two sales
  tiles, `users.manage` for Customers. A role that cannot reach the destination must not be
  offered the control — `navigate()`'s permission guard would bounce them, and the "View All"
  button on Recent Transactions carries a comment explaining exactly this rule. Follow it.
- Today's Sales sets the report range on arrival. That is the same one-shot intent as Task 1 —
  use the same mechanism, and make sure it does not stick.
- The Customers tile's sub-line names a retailer count. If you make that its own target, it
  must set the status filter as a one-shot too.

*Done when:* all four dashboard tiles are shortcuts, a Cashier sees only the ones they can
actually use, and no shortcut leaves a filter behind.

---

# Task 3 — The product dropdown vanishes on mouse-wheel scroll

**Where:** Inventory Management → Restock (`#rs-product`) and Adjustment, both built in
`assets/js/portal/inventory.js` (`buildRestockForm()` ~line 284, `buildAdjustForm()` ~line 340)
as `<select class="control">` elements now enhanced by the custom dropdown component.

**I am fairly confident this is my fault, and you should check that first.** The brief for
that component asked it to "close on scroll or resize rather than leaving the popup floating
away from its trigger". If that was implemented as *close on any scroll event*, then:

- turning the wheel while the option list is open closes it, because the wheel event bubbles
  out of the popup and is treated as a page scroll; and
- if the popup is rendered in a fixed layer appended to the body, a wheel over it may not
  scroll the list at all before the close fires.

Either way the control is unusable with a mouse, which is how most people will use it.

**What it should do instead:**

- **A scroll that starts inside the popup never closes it.** The wheel scrolls the option
  list. Add `overscroll-behavior: contain` so reaching the end of the list does not chain the
  scroll to the page behind it.
- **A scroll of the page or a scrolling ancestor repositions the popup** to follow its
  trigger, throttled through `requestAnimationFrame`. Close it only when the trigger actually
  leaves its scroll container or the viewport — at which point there is nothing to attach to.
- Keyboard scrolling (Up/Down past the visible rows) must scroll the list into view rather
  than closing it.

**While you are in there:** these two pickers list every unarchived product, so the list is
long. Confirm it has a sensible `max-height` with internal scrolling, and that keyboard
type-ahead works — typing "chi" should reach Chili Garlic Bangus. A long list is exactly the
case that exposed this bug.

Check every other enhanced dropdown for the same fault, not just these two.

*Done when:* the product list scrolls with the wheel and stays open, and scrolling the page
behind an open dropdown moves the popup with its trigger instead of dismissing it.

---

# Task 4 — A profile screen for staff

Employees currently have no way to change their own name, email or password. Only an
administrator can edit an employee record, which means a staff member has to ask someone else
to change their own password — and that person then knows it.

**Add a Profile module to the portal**, reachable from a new sidebar entry.

## Sidebar

Add it in its own group at the bottom of the sidebar — the existing groups (Overview, Point of
Sale, Online Orders, Inventory, Maintenance, Reports, Finance & Logs, System) are all about
the business, and this is about the person.

**It carries no `data-perm`.** Every signed-in staff member owns their own account, so there
is no permission to check — confirm that `applyRBAC()` treats a nav item with no `data-perm`
as visible to everyone, and that `MOD_PERM` has no entry for this module so `navigate()`'s
guard does not bounce anyone. Also wire it from the topbar user dropdown, since that is where
people will look first.

## What it lets them change

The `users` table holds `id`, `role_id`, `name`, `email`, `password`, `avatar`, `status`.

- **Editable by the owner:** name, email, avatar initials.
- **Never editable here:** `role_id` and `status`. A staff member editing their own role is
  privilege escalation, and archiving themselves is a support call. Show them read-only, so
  they can see their role, and **enforce it in the endpoint** — not just by leaving the fields
  out of the form.

## Endpoints

Model these on the customer-side pair, which already solved these problems — read
`api/shop/profile.php` and especially the header comment of `api/shop/password.php`, which
explains why a profile save and a credential change are two endpoints and not one.

- `api/users/me.php` — GET the signed-in staff member's own record. `Auth::require()`, scoped
  to the session's user id, taking no id parameter.
- `api/users/me-save.php` — POST name / email / avatar. Scoped to the session. Rejects any
  attempt to set `role_id` or `status`. Re-checks that the new email is not already taken.
- `api/users/me-password.php` — POST current, new, confirm. Apply the same three rules the
  customer endpoint documents: **re-verify the current password** (a session cookie proves the
  browser was signed in at some point, not that the person at the keyboard is the account
  holder); **rate limit it** on the same counter sign-in uses; and **regenerate the session id**
  on success so any other session riding the old id is invalidated.

`Auth` has `reauthenticateCustomer()` but **no staff equivalent** — you will need to add one.
Put it beside the customer version so the two are read together, and keep the same failure
shape (401/429 handled inside, returning the user on success).

Write an audit log row for each change, and make sure a password change never records the
password.

*Done when:* a signed-in Inventory Staff member can change their own name and password from
the sidebar, cannot change their role by any means including a hand-crafted POST, and the
change appears in the audit log.

---

# Task 5 — Best-seller records in the Sales Report

**Good news: the data already exists and nothing renders it.** `api/reports/sales.php` (~line
113) already computes, for the selected period:

```sql
SELECT p.id, p.name, SUM(oi.qty) AS units,
       SUM(oi.qty * oi.price_at_purchase) AS revenue
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN products p ON p.id = oi.product_id
  $clause
 GROUP BY p.id, p.name
 ORDER BY revenue DESC
 LIMIT 10
```

and returns it as `topProducts` with `id`, `name`, `units` and `revenue`. Grep `topProducts`
in `assets/js/portal/engine.js` — it is never read. `byMethod` (the payment-method split) is
returned and unrendered too.

**So this is a rendering task, not a query task.** Add a panel below **Transactions in Period**
in `portal/views/sales.html`, rendered by `renderSales()`.

- Rank, product name, units sold, revenue. Right-align the numbers and use
  `font-variant-numeric: tabular-nums` so the columns line up.
- Follow the styling of the Transactions table beside it — same `.panel-header`,
  `.table-wrap`, `.data-table`.
- **State the ranking on screen.** The endpoint sorts by *revenue*, deliberately: its comment
  says ranking by units flatters cheap products, and a report used to decide what to make more
  of should rank by what earned. A reader who assumes it is ranked by units will misread it,
  so label the panel accordingly — "Best Sellers in Period · ranked by revenue".
- **Make clear it is period-scoped.** The Landing Page module has its own Best Sellers list
  ranked by lifetime `products.sold`. These two will disagree, correctly, and someone will
  file that as a bug unless the heading says which period it covers.
- Handle the empty case: a period with no sales must say so, not render an empty table.
- Consider rendering `byMethod` in the same pass while you are in this file — it is already in
  the response and is one small table. Your call; say whether you did.

*Done when:* the Sales Report shows the ten best-selling products for the selected range below
the transactions table, the figures change when the range changes, and the panel says what it
is ranked by.

---

# Order of work

1. Task 1 — small, and it is a correctness bug in something already shipped.
2. Task 3 — the scroll bug. It makes a form unusable, so it outranks the new features.
3. Task 2 — the remaining shortcuts, reusing whatever Task 1 settled.
4. Task 5 — rendering data that already exists.
5. Task 4 — the largest: new module, three endpoints, and a change to `Auth`.

Test each against the real XAMPP install with the seeded data, in both themes, before moving
on. Do not batch all five and test at the end.

Three things I want stated back in your summary: how the one-shot filter intent travels, what
was actually closing the dropdown on scroll, and whether you rendered `byMethod` as well.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
