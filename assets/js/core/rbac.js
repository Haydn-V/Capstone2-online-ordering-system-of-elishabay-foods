import { EbSession } from "./session.js";
import { EbUI } from "./ui.js";
/* RBAC in the browser only shows or hides controls using permissions from the server session; real security is Rbac::require() in PHP on every endpoint. */


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

/** Hide every [data-perm] element the user lacks and collapse nav groups left empty. */
function apply(root = document) {
  root.querySelectorAll("[data-perm]").forEach(el => {
    /* "a|b" means any of the listed permissions. */
    el.style.display = el.dataset.perm.split("|").some(p => can(p)) ? "" : "none";
  });

  root.querySelectorAll(".nav-group").forEach(group => {
    const anyVisible = [...group.querySelectorAll(".nav-item")]
      .some(item => item.style.display !== "none");
    group.style.display = anyVisible ? "" : "none";
  });
}

/** Check permission before opening a module (true if allowed); the server enforces it anyway. */
function guard(permission) {
  if (!permission || can(permission)) return true;
  if (EbUI) EbUI.toast("You don't have access to that section.", "err");
  return false;
}

export const EbRbac = { can, canAll, canAny, apply, guard };

