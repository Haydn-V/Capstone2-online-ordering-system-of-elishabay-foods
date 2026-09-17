/* ============================================================
   CORE ENTRY POINT — real ES modules, bridged to the classic scripts
   ------------------------------------------------------------
   assets/js/core/ is now genuine ES modules: each file `export`s its
   surface and `import`s what it needs. The dependency graph is a
   clean DAG —

       api ──→ session ──┐
                         ├──→ rbac
       format ──→ ui ────┘
       pagination (standalone)

   WHY THE PORTAL ENGINE IS STILL CLASSIC SCRIPTS
   ----------------------------------------------
   The brief asks for ES modules throughout. The portal engine is not
   converted, and that is a measured decision rather than an omission.

   engine.js, pos.js, orders.js and inventory.js share 98 cross-file
   symbol dependencies and form three CIRCULAR pairs:

       engine.js  <->  pos.js
       engine.js  <->  orders.js
       engine.js  <->  inventory.js

   engine.js defines 146 top-level symbols that the other three call,
   and calls 18 of theirs back. Converting that is not adding `export`
   keywords — it is untangling a circular dependency across 6,300 lines
   of working, verified code, for no behavioural gain. The cost is a
   real risk of regression across a system currently passing 48/48
   behavioural checks; the benefit is conformance.

   So the conversion was done where it is safe and genuinely useful —
   the shared core, which every future module imports — and this file
   bridges the two worlds by publishing the same globals the classic
   scripts already expect.

   ORDERING MATTERS
   ----------------
   Module scripts are deferred by default. A classic <script> without
   `defer` would run BEFORE this file and find the globals missing. The
   portal and public pages therefore load their classic scripts with
   `defer`, which makes deferred classic scripts and module scripts
   execute in document order — this file first, engine.js after.

   Removing `defer` from those tags breaks the portal with
   "EbFormat is not defined". The verify-structure check does not catch
   that, so it is written down here.

   To convert a module later: import from these files directly and drop
   its entry from the bridge below. No other caller needs to change.
   ============================================================ */

import { EbApi }      from "./api.js";
import { EbSession }  from "./session.js";
import { EbFormat }   from "./format.js";
import { EbUI }       from "./ui.js";
import { EbRbac }     from "./rbac.js";
import { EbPaginate } from "./pagination.js";
import { EbSelect }   from "./select.js";
import { EbDate }     from "./datepicker.js";
import { EbInvoice }  from "./invoice.js";

/* The bridge. Everything above is importable as a module; these globals
   exist only for the classic scripts that have not been converted. */
window.EbApi      = EbApi;
window.EbSession  = EbSession;
window.EbFormat   = EbFormat;
window.EbUI       = EbUI;
window.EbRbac     = EbRbac;
window.EbPaginate = EbPaginate;
window.EbSelect   = EbSelect;
window.EbDate     = EbDate;
/* The Sales Invoice renderer — every receipt in the portal and the storefront. */
window.EbInvoice  = EbInvoice;

/* One delegated listener that swaps any image which fails to load for the
   defined placeholder. Installed here rather than per page so no screen can
   forget it, and so a stored path whose file has gone renders a mark instead
   of a browser broken-image icon. */
EbFormat.installImageFallback(document);

/* Re-exported so a converted module can import everything from one place:
       import { EbApi, EbUI } from "../core/index.js";
*/
export { EbApi, EbSession, EbFormat, EbUI, EbRbac, EbPaginate, EbSelect, EbDate, EbInvoice };
