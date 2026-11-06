/* Core entry point: assets/js/core/ are ES modules, and this file exposes them as globals for the portal's classic scripts (which must load with defer so this runs first, or you get "EbFormat is not defined"). */

import { EbApi }      from "./api.js";
import { EbSession }  from "./session.js";
import { EbFormat }   from "./format.js";
import { EbUI }       from "./ui.js";
import { EbRbac }     from "./rbac.js";
import { EbPaginate } from "./pagination.js";
import { EbSelect }   from "./select.js";
import { EbDate }     from "./datepicker.js";
import { EbInvoice }  from "./invoice.js";

/* The globals bridge for classic scripts that are not yet modules. */
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

/* Install the broken-image fallback once for every page. */
EbFormat.installImageFallback(document);

/* Re-exported so converted modules can import everything from here. */
export { EbApi, EbSession, EbFormat, EbUI, EbRbac, EbPaginate, EbSelect, EbDate, EbInvoice };
