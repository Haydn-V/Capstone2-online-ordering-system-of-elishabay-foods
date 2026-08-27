import { EbSession } from "./session.js";
import { EbUI } from "./ui.js";
/* ============================================================
 RBAC — showing and hiding by permission
 ------------------------------------------------------------
 Consolidates what used to be spread across three places:
 hasPerm() and applyRBAC() in engine.js, the entry-point check in
 role-gate.js, and admin-gate.js.

 THE THING TO KEEP IN MIND
 -------------------------
 Everything in this file is presentation. Hiding a button does not
 protect the endpoint behind it — anyone can open a terminal. Real
 enforcement is Rbac::require() in PHP, on every endpoint, and it
 is tested: a Cashier session calling users/list.php gets 403 even
 though a Cashier's browser never renders that link.

 So this file exists to keep the interface honest and legible, not
 to keep anybody out.

 Permissions come from the server with the session (EbSession), so
 an edit on the Roles & Permissions screen changes what people see
 as soon as they reload — no hardcoded table to keep in sync.
 ============================================================ */


const session = () => EbSession;

/** Does the signed-in user hold this permission? */
function can(permission) {
  const s = session();
  return !!(s && s.isSignedIn() && s.can(permission));
}

/** Every permission in a list. */
const canAll = (...perms) => perms.every(can);

/** Any one of them. */
const canAny = (...perms) => perms.some(can);

/**
 * Hide every [data-perm] element the current user lacks, then collapse any
 * .nav-group left with nothing visible — otherwise a role sees an empty
 * section header with no items under it.
 *
 * Sets style.display rather than a class because the existing stylesheet
 * has no utility class for this and the sidebar's own rules would fight one.
 */
function apply(root = document) {
  root.querySelectorAll("[data-perm]").forEach(el => {
    el.style.display = can(el.dataset.perm) ? "" : "none";
  });

  root.querySelectorAll(".nav-group").forEach(group => {
    const anyVisible = [...group.querySelectorAll(".nav-item")]
      .some(item => item.style.display !== "none");
    group.style.display = anyVisible ? "" : "none";
  });
}

/**
 * Guard a module before navigating to it. Returns true when allowed.
 *
 * The server refuses the data regardless; this just avoids opening a screen
 * that would only fill with 403s.
 */
function guard(permission) {
  if (!permission || can(permission)) return true;
  if (EbUI) EbUI.toast("You don't have access to that section.", "err");
  return false;
}

export const EbRbac = { can, canAll, canAny, apply, guard };

