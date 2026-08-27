# UI wiring tests

Open **http://localhost/elishabay/tools/ui-test/** and press Run.

Local machine only — `tools/ui-test/.htaccess` carries `Require local`, because
this page holds the seeded test-account passwords and signs in as each role. It
is development tooling and must not ship.

## Why this exists

The defining bug in this project is **green endpoint, dead UI**: an endpoint that
works perfectly and a screen that never calls it. The Roles & Permissions screen
silently discarded every edit for weeks while `roles/save.php` passed every test
aimed at it. Customer login was a mock while `shop/login.php` sat there, correct
and unreferenced.

`tools/verify-api.py` cannot catch that. It talks to the API directly — the half
that already works. Something has to drive the actual interface.

This runner does. It loads a portal in an iframe, drives the real DOM, and
checks the result against what the API says the database holds.

## Why not Playwright

D15 of the remediation brief specifies Playwright. It is not used because this
project is XAMPP-only: no npm, no build step, no bundler. This runner does the
same job with what the stack already has — vanilla JS, served by Apache.

## What it catches, and what it does not

**Catches**
- a control wired to nothing
- a list that renders but does not match the database
- a write that appears to succeed and does not persist
- console errors on load
- a screen rendering invented data when a fetch fails

**Cannot catch**
- anything visual: layout, overlap, contrast, z-index
- real cross-browser differences — it runs in whatever browser you opened
- CSS-driven interaction: `:hover`, focus rings, transitions
- anything needing a genuine OS-level input event. It dispatches synthetic
  events, which some widgets treat differently from real ones
- timing races that only appear on a slow connection

It is a **wiring** test, not a UI test. Do not read a green run as "the
interface is good".

## Known side effect: audit rows

The specs perform real writes, and per D13 audit entries are written server-side
inside the same transaction and are not client-erasable. So a run leaves audit
rows behind — the roles spec leaves two per execution.

This is a genuine tension between two decisions: D13 says the audit trail is
immutable and server-written; D16 says test data must not grow. **The audit trail
winning is the right outcome** — a test that could erase its own audit rows would
mean the application could too, which is the opposite of what an audit trail is
for. Building a purge endpoint would create exactly that capability, and it would
be reachable attack surface.

So the rows are left, and reset manually when the baseline matters:

```sql
DELETE FROM audit_logs WHERE id > 28;   -- 28 = seed baseline
```

Everything else the specs touch is restored by the spec itself. Verified: orders,
customers, role_permissions and login_attempts are unchanged after a full run.

## Adding a spec

`specs.js`, one per screen per role. Keep to the D15 shape:

1. console clean on load
2. the list renders rows that match the database
3. one write round-trips, confirmed by re-reading the server

Restore whatever you change. A spec that leaves the system altered makes the
next spec's result meaningless.
