/* ============================================================
   SPECS — one per screen per role.

   Each spec follows the same shape, per D15:
     1. console clean on load
     2. the list renders rows that match the database
     3. one write round-trips, confirmed after a reload

   Keep them minimal. A spec that tries to cover everything is a
   spec nobody maintains.
   ============================================================ */

/* Wrapped in an IIFE. runner.js declares `spec`, `check` and friends as
   top-level functions, so destructuring them into consts at global scope
   threw "Identifier 'spec' has already been declared" and no spec registered
   at all — the runner reported zero specs rather than an error, which is
   exactly the silent-nothing failure this whole runner exists to catch. */
(function () {
"use strict";

const { spec, check, goto, clickIn, typeIn, $f, $$f, api, apiPost,
        waitFor, sleep, openPortal } = window.UITest;

/* Fixed seeded accounts (D16). Nothing here creates an account. */
const SUPER = { label: "Super Admin", email: "admin@elishabay.ph",
                password: "Admin@123", portalRole: "Super Admin", portal: "super-admin" };
const ADMIN = { label: "Admin", email: "subadmin@elishabay.ph",
                password: "SubAdm@2025", portalRole: "Admin", portal: "admin" };
const INV   = { label: "Inventory Staff", email: "inventory@elishabay.ph",
                password: "Inv@2025", portalRole: "Inventory Staff", portal: "inventory" };
const CASH  = { label: "Cashier", email: "cashier@elishabay.ph",
                password: "Cash@2025", portalRole: "Cashier", portal: "cashier" };
const ORD   = { label: "Online Orders Staff", email: "orders@elishabay.ph",
                password: "Ord@2025", portalRole: "Online Orders Staff", portal: "orders" };


/* ------------------------------------------------------------
   ROLES & PERMISSIONS

   This screen silently discarded every edit: roles/save.php was
   built and correct, and the checkbox grid called nothing. It is
   the canonical instance of the bug this runner exists to catch,
   so it is the first spec.
   ------------------------------------------------------------ */
spec("roles: permission edits persist", [SUPER], async (role) => {
  const { errors } = await openPortal(role.portal);
  await goto("roles");

  check(errors.length === 0, "console clean on load", errors.join(" | "));

  /* Super Admin's own checkboxes are `disabled` — it is an is_system role that
     holds everything unconditionally and owns no role_permissions rows, so
     toggling one proves nothing. Pick an editable box on another role.

     The first version of this spec read `data-perm` and clicked the FIRST
     button matching /save/i. The real attribute is `data-perm-key`, and there
     are five "Save Matrix" buttons — one per role card — so it saved a
     different role than the one it had edited and reported a false failure.
     The save button must come from the same card as the checkbox. */
  const target = $$f('#mod-roles input[type="checkbox"][data-perm-key]')
                   .find(b => !b.disabled);
  check(!!target, "an editable permission checkbox exists (non-system role)");
  if (!target) return;

  const roleName = target.dataset.role;
  const permKey  = target.dataset.permKey;
  const card     = target.closest(".role-card, .panel, section") || $f("#mod-roles");
  const saveBtn  = [...card.querySelectorAll("button")]
                     .find(b => /save matrix/i.test(b.textContent));
  check(!!saveBtn, `a Save Matrix control exists in the ${roleName} card`);
  if (!saveBtn) return;

  /* roles/list.php returns { roles: [...], permissions: [...] } — not a bare
     array. Assuming the array shape is what threw "(...).find is not a
     function" on the first attempt. */
  const permsOf = (body) => {
    const r = (body?.data?.roles || []).find(x => x.name === roleName);
    return r ? JSON.stringify([...(r.permissions || [])].sort()) : null;
  };

  const pre = await api("roles/list.php");
  check(pre.status === 200, "roles/list.php readable");
  const before = permsOf(pre.body);
  check(before !== null, `${roleName} present in roles/list.php`);

  const wasChecked = target.checked;
  target.checked = !wasChecked;
  target.dispatchEvent(new (frameWin()).Event("change", { bubbles: true }));
  await sleep(300);
  clickIn(saveBtn);
  await sleep(1500);

  const post = await api("roles/list.php");
  const after = permsOf(post.body);
  check(after !== before,
        "toggling a permission changed what the server returns",
        `role=${roleName} perm=${permKey} — an identical response means the ` +
        `screen discarded the edit (roles/save.php never called)`);

  /* Restore, so the suite leaves the permission matrix exactly as it found it. */
  target.checked = wasChecked;
  target.dispatchEvent(new (frameWin()).Event("change", { bubbles: true }));
  await sleep(300);
  clickIn(saveBtn);
  await sleep(1500);
  const restored = permsOf((await api("roles/list.php")).body);
  check(restored === before, `${roleName} permissions restored`,
        `expected ${before}, got ${restored}`);
});


/* ------------------------------------------------------------
   INVENTORY REPORT — list must match the database, not a page of it
   ------------------------------------------------------------ */
spec("inventory report: list matches DB", [SUPER, INV], async (role) => {
  const { errors } = await openPortal(role.portal);
  await goto("inventory");

  check(errors.length === 0, "console clean on load", errors.join(" | "));

  const showing = $f("#inv-report-showing");
  check(!!showing, "row-count label rendered");

  const { body } = await api("products/list.php?limit=1&status=active");
  const dbTotal = body?.meta?.total;
  check(typeof dbTotal === "number", "products/list.php reports a total");

  const shown = (showing?.textContent || "").match(/of (\d+) entries/);
  check(!!shown, "count label has the expected shape", showing?.textContent);
  if (shown && typeof dbTotal === "number") {
    check(Number(shown[1]) === dbTotal,
          "the count above the table equals the database count",
          `screen says ${shown[1]}, database says ${dbTotal}`);
  }

  const rows = $$f("#inventory-tbody tr").filter(r => !r.querySelector(".state-cell"));
  check(rows.length > 0, "table rendered product rows", `${rows.length} rows`);
});


/* ------------------------------------------------------------
   EXPIRY — a filter must filter the whole set, not the visible page
   ------------------------------------------------------------ */
spec("expiry: status filter queries the server", [SUPER, INV], async (role) => {
  const { errors } = await openPortal(role.portal);
  await goto("expiry");
  check(errors.length === 0, "console clean on load", errors.join(" | "));

  const label = () => ($f("#expiry-showing")?.textContent || "");
  const before = label();
  check(/entries|No entries/.test(before), "count label rendered", before);

  const sel = $f("#filter-expiry-status");
  check(!!sel, "status filter present");
  if (!sel) return;

  typeIn(sel, "gone", "change");
  await sleep(1200);
  const after = label();
  check(after !== before || /No entries/.test(after),
        "changing the status filter changed the result set",
        `before="${before}" after="${after}"`);

  typeIn(sel, "all", "change");
  await sleep(1000);
  check(label() === before, "clearing the filter restores the original count",
        `expected "${before}", got "${label()}"`);
});


/* ------------------------------------------------------------
   ACCESS CONTROL — the API must refuse, not just the button hide
   ------------------------------------------------------------ */
spec("access control: API refuses out-of-role calls", [CASH, INV, ORD], async (role) => {
  await openPortal(role.portal);

  const FORBIDDEN_FOR = {
    "Cashier":             ["users/list.php", "audit/list.php", "batches/list.php"],
    "Inventory Staff":     ["users/list.php", "orders/list.php", "roles/list.php"],
    "Online Orders Staff": ["users/list.php", "batches/list.php", "audit/list.php"],
  };

  for (const ep of FORBIDDEN_FOR[role.label] || []) {
    const { status } = await api(ep);
    check(status === 403, `${ep} refused with 403 for ${role.label}`,
          `got ${status} — a hidden button is not access control`);
  }
});


/* Small helper: the iframe's own window, needed to construct Events that
   the framed document will accept. */
function frameWin() {
  return document.querySelector(".stage-frame").contentWindow;
}

})();
