# Build prompt — consistent tab pills and meaningful tab counts

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP. No
framework, no Composer, no npm build step — do not add any. **Staff portal only** — do not
touch the customer storefront; its category chips and sort control are a different visual
language and are working as intended.

Two related problems with the portal's tab rows. I could not pull the latest files while
writing this, so **treat every line number below as a starting point, not a promise** — read
the current code and tell me if any diagnosis is wrong.

## Conventions

- Use the existing tokens in `assets/css/portal/portal.css`. **No new colour literals.** Both
  themes, light and dark.
- Never signal state with colour alone — pair it with weight, a border, or an icon.
- No inline `onclick` handlers.
- Respect `prefers-reduced-motion` on anything you animate.
- Match the house comment style: explain **why** a change exists.

---

# Task 1 — One tab pill treatment across the portal

**The reference is Inventory Management.** `.inv-action-btn` — the Stock Overview / Restock /
Replenish (Bulk) / Adjustment / Adj. Log / Archive row — has the hover and active treatment we
want. The per-page and filter pills are also right. Everything else is inconsistent with them.

**The screens that are wrong**, all using `.tab-btn`:

- Notifications
- Online Transactions, Order Queue, Payment Verification, Return Module — the status filter
  rows built in `assets/js/portal/orders.js` (~lines 568, 697, 846, and the returns equivalent)
- User Management — Customer Accounts / Employee Accounts (`portal/views/users.html`)
- Products — Catalog / Varieties (`portal/views/products.html`)

**What to do.** Give `.tab-btn` the same resting, hover, active and focus treatment as
`.inv-action-btn`. **Match hover, highlight and focus only — do not add icons.** Status tabs
like Pending and Accepted have no natural icon and inventing one adds noise; the module tabs
that already have icons keep them.

Do it so the two cannot drift apart again: either give both selectors one shared rule block,
or define the treatment once in custom properties both consume. Two rule sets that happen to
match today is how this got inconsistent in the first place.

**A concrete gap to fix while you are there.** The focus-visible rule at portal.css ~line 198
reads:

```css
.inv-action-btn:focus-visible,
.range-btn:focus-visible,
.btn:focus-visible,
.icon-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--gold); }
```

`.tab-btn` is **not in that list**, so every tab in the portal is keyboard-focusable with no
visible focus ring at all. Add it.

**Check as you go:**

- The active tab must be distinguishable from a hovered inactive tab. If hover and active look
  the same, someone moving the mouse across the row cannot tell where they are.
- These rows are `role="tablist"` with `aria-selected` — confirm that is still correct after
  your change, and that `aria-selected` and the `.active` class never disagree.
- Tab rows sit inside the merged toolbar (tabs left, filters right). Verify the new pill height
  still lines up with the search box and the filter dropdowns beside it.
- Both themes, and at 390px where the rows wrap.

*Done when:* every tab row in the portal hovers, highlights and focuses identically to
Inventory Management, and no tab is focusable without a visible ring.

---

# Task 2 — A tab number should mean "this needs you"

The status tabs carry a `<span class="tab-count">` (orders.js ~568, ~697, ~846 and the returns
row). Today every tab gets one, including **All** and the finished states — so a number is
just "how many rows exist", which tells staff nothing about what to do next.

**Change the rule: a badge appears only on tabs that represent outstanding work, and
disappears at zero.**

- **Badge these:** Pending, On Hold, payments awaiting verification, open return requests,
  unread notifications — anything a staff member has to act on.
- **No badge:** All, Accepted, Shipping, Delivered, Completed, Cancelled, and any other tab
  that is a record rather than a queue.
- **Zero renders nothing.** Not a grey `0` — no badge at all. An empty queue should look empty.

A number then always means the same thing everywhere in the portal, and it visibly drops as
staff clear items — which is the behaviour you were after.

**Three things to verify, because any of them makes the number lie:**

1. **Does it refresh after an action?** Accept a pending order and the Pending badge must drop
   immediately, without a manual reload. Find the re-render path after a status change and
   confirm the counts are recomputed there, not only on first load.
2. **Is it counting the whole set or just the loaded page?** These screens page through
   `EbPaginate`. If the counts are derived from the rows currently rendered, then "Pending 10"
   really means "10 pending on this page" and the number is wrong the moment there is a page
   two. If that is what you find, the count has to come from the server as a total — say what
   you found and what you did.
3. **Does the same number appear twice?** If a tab badge and the notification bell can show
   different figures for the same thing, they must be reconciled to one source. Check before
   you assume they agree.

**Presentation.**

- Give `.tab-count` a proper rule of its own with `font-variant-numeric: tabular-nums`, so the
  badge does not change width as the number changes and shift the tabs beside it. There is
  already an `.alert-tab-count` rule doing exactly this — follow it.
- Style it once and use it on all five screens. It should read as subordinate to the tab
  label, not compete with it.
- **Accessibility:** a bare number in a span is announced as a stray digit. Give the tab an
  `aria-label` that says what it means — "Pending, 3 awaiting action" — so the tab is
  understandable without seeing the badge.
- Cap the display at some sensible maximum ("99+") so a large backlog cannot stretch the row.

*Done when:* a badge appears only where there is work waiting, drops the instant an item is
handled, shows nothing at zero, and reads the same on every screen that has one.

---

# Order of work

1. Task 1 — pure CSS, immediately visible, no behaviour risk. Check every screen in the list
   afterwards.
2. Task 2 — decide which tabs qualify, fix the refresh and the paging question, then style.

Test against the real XAMPP install with the seeded data, in both themes, at desktop and phone
widths. Do not do both tasks and test once at the end.

Two things I want stated back in your summary: whether the counts were computed from the
loaded page or from a server total, and which tabs you decided qualify as "work to do".

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
