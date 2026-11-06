import { EbApi } from "./api.js";
/* Session: asks the server who is signed in (with their permissions) and caches it for the page's life; the browser holds no credentials. */


const api = EbApi;

let current = null;      // { id, name, email, avatar, role }
let permissions = [];    // permission keys granted to that role
let catalogue = null;    // full permission list, for the Roles screen

/** Ask the server who is signed in; returns null for nobody instead of throwing. */
async function bootstrap() {
  try {
    const { data } = await api.get("auth/me.php");
    current     = data.user;
    permissions = data.permissions || [];
    catalogue   = data.catalogue || null;
    api.setCsrf(data.csrf);
    return current;
  } catch (err) {
    /* Fail closed: on any error, treat the visitor as signed out so stale permissions are never kept. */
    current = null;
    permissions = [];
    catalogue = null;
    if (err.isAuth) return null;
    throw err;
  }
}

/** Sign in; portalRole makes the server check the account belongs to this portal. */
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
    /* Clear local identity even if the logout request fails. */
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
  /* Super Admin gets the full permission list from the server, so no special case. */
  can(permission)   { return permissions.includes(permission); },
};

