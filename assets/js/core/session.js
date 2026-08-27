import { EbApi } from "./api.js";
/* ============================================================
 SESSION — who is signed in, according to the server
 ------------------------------------------------------------
 Replaces the sessionStorage["eb-staff"] hand-off and the
 client-side STAFF_ACCOUNTS comparison. The browser no longer
 holds credentials or decides identity; it asks the server and
 caches the answer for the life of the page.

 Permissions arrive with the user, so hasPerm() can consult what
 the database actually grants rather than a hardcoded table.
 ============================================================ */


const api = EbApi;

let current = null;      // { id, name, email, avatar, role }
let permissions = [];    // permission keys granted to that role
let catalogue = null;    // full permission list, for the Roles screen

/**
 * Ask the server who is signed in.
 *
 * Returns null when nobody is, rather than throwing — an anonymous visitor
 * is an expected state on a login page, not an error.
 */
async function bootstrap() {
  try {
    const { data } = await api.get("auth/me.php");
    current     = data.user;
    permissions = data.permissions || [];
    catalogue   = data.catalogue || null;
    api.setCsrf(data.csrf);
    return current;
  } catch (err) {
    /* D8: fail closed on ANY error, not just 401.

       This used to clear identity only when the server said "not signed in"
       and rethrow everything else with `current` and `permissions` untouched.
       bootstrap() is re-called after a roles save — so a 500 on that call left
       the browser holding a permission set the server may have just revoked,
       and applyRBAC() would keep showing controls for it.

       A request that did not clearly succeed tells us nothing about who this
       is, and "nobody" is the only safe reading of nothing. */
    current = null;
    permissions = [];
    catalogue = null;
    if (err.isAuth) return null;
    throw err;
  }
}

/**
 * Sign in.
 *
 * `portalRole` makes the server enforce that this account belongs at this
 * entry point. role-gate.js used to do that alone, in the browser, against
 * an array of plaintext passwords — which stopped nobody from posting
 * directly to the endpoint.
 */
async function login(email, password, portalRole) {
  const body = { email, password };
  if (portalRole) body.portal_role = portalRole;

  const { data } = await api.post("auth/login.php", body);
  current     = data.user;
  permissions = data.permissions || [];
  api.setCsrf(data.csrf);
  return current;
}

async function logout() {
  try {
    await api.post("auth/logout.php", {});
  } finally {
    /* Clear locally even if the request failed — the user asked to leave,
       and a stale in-memory identity is worse than a stale server session. */
    current = null;
    permissions = [];
    api.setCsrf(null);
  }
}

export const EbSession = {
  bootstrap,
  login,
  logout,
  get user()        { return current; },
  get permissions() { return permissions.slice(); },
  get catalogue()   { return catalogue; },
  isSignedIn()      { return current !== null; },
  /* Super Admin holds everything; the server says so by sending the full
     permission list, so no special case is needed here. */
  can(permission)   { return permissions.includes(permission); },
};

