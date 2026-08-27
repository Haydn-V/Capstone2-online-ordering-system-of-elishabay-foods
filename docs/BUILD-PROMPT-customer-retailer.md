# Build prompt — customer records, partner application prefill, and retailer credit terms

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

Three changes: one policy change in the portal, one convenience in the partner application,
and one feature the manuscript promises that is half-built. I have traced the current
behaviour of each; read the surrounding code before changing it and tell me if any diagnosis
is wrong.

## Conventions

- Non-GET calls go through `EbApi`, which attaches the CSRF token. Never hand-roll a `fetch()`
  for a write.
- Customer endpoints call `Auth::requireCustomer()` and scope every query by the session's
  customer id — never by an id or an email taken from the request body. `api/shop/checkout.php`
  states the rule outright: *"Always the session's address. Never read from the request."*
- Hiding a control is presentation, not security. `api/core/Rbac.php` says so in its header:
  every endpoint decides for itself. Any rule you add to the interface must also be enforced
  server-side.
- Use the existing tokens; no new colour literals. Match the house comment style — explain
  **why** a change exists.

---

# Task 1 — An administrator must not edit customer information

**Where:** `renderCustomers()` in `assets/js/portal/engine.js` (~line 1743),
`openEditCustomerModal()` (~line 1830), and `api/customers/save.php`.

Customer records belong to the customer. The administrator's legitimate need is to *archive*
an account, not to rewrite someone's name, email or contact number — and the customer can
already maintain those themselves through Profile.

**Interface.** Remove the Edit button from the Customer Accounts row actions (~line 1763),
along with its click binding (~line 1777). Leave Archive exactly as it is. `openEditCustomerModal()`
then has no caller — delete it rather than leaving dead code behind. **Check the Employee
Accounts tab is untouched:** staff records are a different thing and the administrator must
still be able to edit those.

**Server — and read this before you touch `customers/save.php`.** Archive currently reuses
that same endpoint, posting the whole record back with a changed status:

```js
await EbApi.post("customers/save.php", {
  id: c.id, name: c.name, email: c.email, contact: c.contact, status: "archived",
});
```

So simply locking the update path breaks archiving. Do it in this order:

1. Add `api/customers/archive.php`, modelled on the existing `api/products/archive.php` and
   `api/users/archive.php` — `Rbac::require('users.manage')`, body `{ id, archived }`, and it
   changes **only** `customers.status` between `archived` and its previous value. Note that
   restoring must not clobber a retailer back to `active`; decide how you recover the prior
   status (the simplest correct answer is to record it, rather than guess) and say what you did.
2. Point `archiveCustomer()` (~line 1859) at the new endpoint and stop it sending the identity
   fields.
3. In `customers/save.php`, make the update path reject changes to `name`, `email` and
   `contact` — the create path stays as it is, since Add Customer still uses it. Keep the
   `$alreadyRetailer` guard; retailer status is granted by `api/b2b/decide.php` and must not
   become editable here by the back door.
4. Update `docs/API.md`.

*Done when:* Customer Accounts shows only Archive, archiving still works, and a hand-crafted
POST to `customers/save.php` cannot rename an existing customer.

---

# Task 2 — Prefill the partner application for a signed-in customer

**Where:** `public/become-partner.html` and `api/b2b/apply.php`.

A customer who already has an account and wants to upgrade currently retypes everything the
system already knows, **including a username and password they already have.** The form
(`#pf-company`, `#pf-type`, `#pf-tin`, `#pf-address`, `#pf-contact-name`, `#pf-contact-phone`,
`#pf-email`, `#pf-username`, `#pf-password`, `#pf-credit`, `#pf-volume`, `#pf-notes`) marks
username and password `required`, and `apply.php` refuses a username with no password.

**Prefill, on the same rules the checkout already follows.** `openCheckout()` in
`assets/js/public/site.js` carries a long comment block for decision I9 — read it and apply the
same rules here: identity comes from the session; **only empty fields are filled**, because the
request is asynchronous and a customer who starts typing must not have it overwritten
mid-keystroke; every prefilled field stays editable, nothing disabled or readonly; and a
failed request logs and leaves the form alone.

- Fetch the profile with `EbApi.get("shop/profile.php")` when a customer session exists, and
  fill contact name, phone, email and business address from it. The saved address on
  `customers` is five columns (`addr_street`, `addr_city`, `addr_province`, `addr_zip`,
  `addr_region`) — join whatever exists, and leave the field empty and usable when there is
  nothing saved. Partial is a legitimate state.
- **Hide the credentials block entirely for a signed-in customer** and drop its `required`
  flags. They already have a username and password; asking again invites a collision, and
  `api/b2b/decide.php` already uses `COALESCE(username, ?)` so an existing credential
  survives approval untouched. Show a short line saying the application will be attached to
  the account they are signed in as, naming it.
- Business name, type, TIN, requested terms, volume and notes are the only things a returning
  customer should actually have to type. Make that obvious in the layout.

**Server — bind the identity to the session.** `apply.php` currently takes `email` from the
request body and links the application by looking that email up in `customers` (~line 173).
That was fine while every applicant was a stranger. Once a signed-in customer can apply, an
authenticated user could file an application against **somebody else's** email address and,
on approval, `decide.php` would promote that person's account. Fix it:

- If a customer session exists, take the email from the session and ignore any email in the
  body, exactly as `checkout.php` does with the address. Resolve `customer_id` from the
  session rather than by email lookup.
- If there is no session, keep the current behaviour — a stranger applying is still the
  normal case.
- Accept an application with no username and no password when it is linked to an existing
  customer, and keep refusing one that is not.
- Leave the "that email already has an active wholesale account" conflict check in place.

*Done when:* a signed-in customer opens Become a Retailer Partner and finds their name, phone,
email and address already filled, no credentials asked for, and the resulting application row
carries the right `customer_id`.

---

# Task 3 — Retailer credit terms: make them visible, then make them usable

This is one feature in two halves. The Payment Schemes page already exists
(`api/shop/my-payments.php`, `public/profile/my-payments.html`) — the reason you cannot see
it is a bug, not a missing build.

## 3a — The Payment Schemes link never appears after signing in

**Cause.** `profile.html` (~line 296) reveals the link with:

```js
if (state.auth.status === "retailer") { … }
```

and `state.auth` is set in two different places with two different shapes:

```js
/* page-load restore, ~line 1977 — correct */
state.auth = { loggedIn:true, name:data.customer.name, email:data.customer.email,
               id:data.customer.id, status:data.customer.status || null };

/* signIn(), ~line 1917 — status is missing entirely */
function signIn(name, email, id){
  state.auth = { loggedIn:true, name, email: email || "", id: id || null };
```

`signIn()` is what runs when someone signs in through the modal, and it takes only three
arguments. So for the whole of that session `state.auth.status` is `undefined`, the link stays
hidden, and the retailer sees nothing. Reload the page and the restore path fills it in —
which is why this looks intermittent.

**Fix.** Carry the status through `signIn()`. Both call sites (~lines 1840 and 1888) already
hold the full `data.customer` object, so pass the object rather than adding a fourth
positional argument — three positional strings is already one too many. Make the two
assignments produce the same shape, and consider building `state.auth` in one helper so they
cannot drift again. `api/shop/me.php` already returns `status`; nothing server-side needs
changing for this half.

## 3b — A retailer cannot choose credit terms at checkout

**Cause.** The storefront offers three payment methods and no more. `api/shop/checkout.php`
(~line 102) validates against:

```php
/* Payments::methods(false) — the storefront has no retailer selection and
   no cashier to authorise terms, so credit methods are not on offer here. */
->in('pay_method', Payments::methods(false), 'Payment method')
```

That comment is now out of date: the storefront *does* know who the customer is, and whether
they are a retailer. Everything else is already built — `Payments::CREDIT`
(`net30`/`net60`/`net90`), `Payments::isCredit()`, `Payments::termDays()`,
`Payments::schemeLabel()`, `Payments::orderFields()` (which already sets `pay_verified = 0`
for any credit method) and `Payments::openCreditAccount()`, which inserts the
`payment_accounts` row with the due date computed by the database.

**Server.**

- Re-derive the customer's status from the database inside the request — never trust a flag
  from the client — and pass that to `Payments::methods($isRetailer)`.
- A credit order needs **no reference number and no screenshot**; make sure the existing
  proof validation does not demand them when `Payments::isCredit($method)`.
- After the order row is inserted, call `Payments::openCreditAccount()` **inside the same
  transaction** that creates the order, so a failure cannot leave an order with no credit line
  or a credit line with no order.
- **Decide and tell me what you chose:** what happens when a retailer with an overdue unpaid
  balance places another credit order. My recommendation is to refuse it with a message naming
  the overdue amount and due date, and to let them order on cash/GCash/bank instead — an
  unbounded credit line is not something Juris Bay asked for. If you disagree, say why.

**Interface.**

- Add Net 30 / Net 60 / Net 90 tiles to the `#co-payment` group in `openCheckout()`, rendered
  **only** when the signed-in customer is a retailer. Label each with what it means — "Pay
  within 30 days" — rather than the bare code.
- Hide the proof block for a credit method, the same way it is hidden for Cash today.
- **Watch this line (~1448) — it is a trap:**

  ```js
  pay_method: payment === "Cash" ? "cash" : (payment === "GCash" ? "gcash" : "bank"),
  ```

  A chained ternary whose final branch is `"bank"`. Add a Net 30 tile without touching it and
  the order silently posts as a bank transfer. Put the API key directly in `data-pay`
  (`cash`, `gcash`, `bank`, `net30`, `net60`, `net90`) and delete the mapping, so the tile and
  the payload cannot disagree.
- On success, tell the retailer what they just committed to — the scheme and the due date
  the server returned — on the receipt.

*Done when:* a retailer signs in, sees Payment Schemes in their profile without reloading,
checks out on Net 30, and finds the new balance and due date on that page and on the cashier's
Payment Schemes screen, with both showing the same figures.

---

# Order of work

1. Task 1 — self-contained. Test that archiving still works before moving on.
2. Task 3a — a small fix, and it unblocks your ability to test 3b as a retailer.
3. Task 2.
4. Task 3b — the largest piece.

Test each against the real XAMPP database with the seeded data. There are two seeded retailer
customers (Danilo Mercado and Fernando Castro) to test with. Do not batch all three and test
at the end.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
