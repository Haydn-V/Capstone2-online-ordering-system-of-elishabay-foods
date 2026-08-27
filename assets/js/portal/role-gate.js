"use strict";

/* ============================================================
   ROLE GATE — declares which role a portal entry point accepts
   ------------------------------------------------------------
   WHAT THIS USED TO DO, AND WHY IT NO LONGER DOES IT
   --------------------------------------------------
   The previous version did two things, both in the browser:

     1. Replaced engine.js's checkSessionAuth() so it accepted only
        this portal's role out of sessionStorage["eb-staff"].
     2. Intercepted the login form in the capture phase, searched
        STAFF_ACCOUNTS for the submitted email and password, and
        refused the sign-in when the matched account's role did not
        match this portal.

   Step 2 required a plaintext password list in a file served to
   every visitor. Neither step stopped anybody: sessionStorage is
   editable by hand, and a refusal in the browser does nothing about
   a direct POST to the endpoint.

   Both jobs now belong to the server. engine.js sends this portal's
   role along with the credentials, api/auth/login.php answers 403 on
   a mismatch, and api/auth/me.php is the only source of identity.
   What is left here just records which role the entry point is for.
   ============================================================ */

function installRoleGate(portalRole) {
  const root = document.getElementById("portal-root");
  if (root && !root.dataset.portalRole) {
    root.dataset.portalRole = portalRole;
  }
  /* engine.js reads it back through portalRole() and sends it to the API on
     login. Nothing more belongs here — anything else this file decided would
     be running on the client, and therefore would not count. */
}

/* Portals declare their role in the HTML:
     <div id="portal-root" data-portal-role="Cashier"></div>
   The per-portal gate files pass it explicitly for readability; this fallback
   covers a page that calls the installer with no argument. */
function installRoleGateFromDOM() {
  const root = document.getElementById("portal-root");
  const role = root && root.dataset.portalRole;
  if (role) installRoleGate(role);
}
