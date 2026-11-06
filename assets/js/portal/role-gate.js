"use strict";

/* ===== ROLE GATE: only records which role this portal entry accepts; the server enforces it on login (api/auth/login.php) and me.php is the only identity source ===== */

function installRoleGate(portalRole) {
  const root = document.getElementById("portal-root");
  if (root && !root.dataset.portalRole) {
    root.dataset.portalRole = portalRole;
  }
  /* engine.js reads this through portalRole() and sends it on login. */
}

/* Fallback: read the role from data-portal-role on #portal-root. */
function installRoleGateFromDOM() {
  const root = document.getElementById("portal-root");
  const role = root && root.dataset.portalRole;
  if (role) installRoleGate(role);
}
