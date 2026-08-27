"use strict";

/* ============================================================
   Admin portal — role gate
   ------------------------------------------------------------
   Sub-Admin — every permission except rbac.manage.

   All the logic lives in Core/role-gate.js, shared by all five
   portals. This file exists only to name the role this entry
   point accepts. Which MODULES the role can then see is decided
   by ROLE_PERMISSIONS in admin.js and enforced by applyRBAC() —
   change permissions there, or from the Roles & Permissions
   screen, not here.
   ============================================================ */

installRoleGate("Admin");
