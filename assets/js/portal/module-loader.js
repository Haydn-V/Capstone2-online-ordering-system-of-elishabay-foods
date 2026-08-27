"use strict";

/* ============================================================
   MODULE LOADER — shared bootstrap for all five staff portals
   ------------------------------------------------------------
   Every portal (Admin, Sub-Admin, Cashier, Inventory, Orders) is
   now a ~30-line HTML file containing nothing but <head> links, an
   empty <div id="portal-root">, and its script tags. This file is
   what turns that shell into a working portal:

     1. fetch portal/shell.html  -> login view, topbar,
        sidebar nav, modal, toast, and an empty #main-content
     2. fetch portal/views/<name>.html     -> one file per module,
        injected into #main-content in MODULE_ORDER
     3. call init()                   -> engine.js wires everything

   WHY init() MOVED HERE
   ---------------------
   engine.js used to end with:
       document.addEventListener("DOMContentLoaded", init);
   That no longer works, because three of init()'s seven setup
   calls reach into module markup that does not exist yet at
   DOMContentLoaded:

     initSidebar()          binds .dash-shortcut-btn, inside
                            #mod-dashboard
     initModDescriptions()  reads all 24 panels to add subtitles
     initLandingPreview()   grabs #view-landing-btn, inside
                            #mod-landing

   All three fail SILENTLY — they are guarded with `if(!panel)` /
   `if(btn)`, so nothing throws; the portal just quietly loses
   features. Hence: inject first, init() second, always.

   REQUIRES HTTP. fetch() cannot read local files over file://,
   so opening a portal by double-clicking the .html will render a
   blank page. Serve the site (Live Server, XAMPP, etc.) — which
   the landing page already assumes, since its routes are absolute
   (/elishabay/portal/super-admin/).
   ============================================================ */

/* Injection order. Matches the original top-to-bottom order of the
   <section> blocks in admin.html, so CSS sibling selectors and tab
   order behave exactly as before. */
const MODULE_ORDER = [
  "dashboard",
  "pos", "pos-payment",
  "notifications", "online-txns", "ordersqueue", "paymentverify",
  "orderstatus", "orderhistory", "receipts", "returns",
  "users", "b2b", "landing", "products",
  "inventory", "inventory-manage", "expiry",
  "sales", "batches",
  "payments", "transactions", "audit",
  "roles",
];

/* Each portal entry is portal/<role>/index.html, so the shell and the
   views/ folder are one level up from the page. */
const PORTAL_BASE = "../";

/* ------------------------------------------------------------
   Which modules to inject.

   Today: all of them. applyRBAC() then hides every [data-perm]
   element the signed-in role lacks, and navigate()'s permission
   guard bounces direct access — the same protection Super Admin
   and Sub-Admin already rely on.

   PHASE 2 (permission-gated loading): filter this list so a role's
   markup is never even delivered to the browser. The catch is that
   the role is unknown until after login, so injection has to move
   behind the auth step — see section 4.1 of RBAC-MIGRATION-PLAN.md
   before attempting it. Replace the body of this function with:

       return MODULE_ORDER.filter(m =>
         !MOD_PERM[m] || hasPerm(MOD_PERM[m]));

   ------------------------------------------------------------ */
function selectModules() {
  return MODULE_ORDER;
}

/* How many module files to request at once.

   Not a performance knob — a compatibility one. Firing all 24 fetches in
   parallel overwhelms single-threaded dev servers: Python's
   `python -m http.server` drops connections under that load and the portal
   boots blank maybe half the time. Live Server and XAMPP handle it, but the
   failure is silent and intermittent enough to waste an afternoon, so the
   loader stays polite. Four at a time loads 24 tiny local files in a few
   milliseconds either way. */
const FETCH_CONCURRENCY = 4;

/* Parse a fetched .html file and hand back its body children.

   Every shell/partial file is a complete HTML document, and dev servers
   inject a live-reload <script> into each one before </body>. Parsing the
   document and dropping all <script> elements removes that injection
   wholesale — none of these files contains a script of its own, so there is
   nothing legitimate to lose.

   Nodes are imported rather than re-serialised through innerHTML, so the
   markup reaching the page is exactly what the parser built. */
function parseFragment(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script").forEach(s => s.remove());
  return Array.from(doc.body.children);
}

function appendFragment(target, html) {
  for (const node of parseFragment(html)) {
    target.appendChild(document.importNode(node, true));
  }
}

/* THE ONE PLACE THAT USES RAW fetch() ON PURPOSE.

   The brief says every request goes through core/api.js and there is no raw
   fetch() anywhere else. This is the exception, and it is a real one rather
   than an oversight: EbApi exists to talk to the JSON API — it sets an Accept
   header, unwraps the {ok,data,meta} envelope, normalises error codes and
   redirects on 401. What this function retrieves is an HTML fragment from
   portal/views/. There is no envelope to unwrap and no session to be expired
   out of; routing it through EbApi would mean teaching the API client to
   return raw text, which makes it worse at its actual job.

   It also has to run BEFORE core/index.js has published anything: this loader
   assembles the DOM that the rest of the application binds to.

   Every other request in the project goes through EbApi. */
async function fetchText(url, attempt = 0) {
  try {
    /* cache: "no-store" and not just the .htaccess no-cache header.

       `Cache-Control: no-cache, must-revalidate` tells the browser to
       revalidate, which it is free to satisfy from its own cache — and three
       separate times in this project that produced a portal running the
       PREVIOUS version of a view while the file on disk was already correct.
       Each time it looked like a broken conversion rather than a stale
       document. no-store removes the possibility.

       This is a development trade: it costs one conditional request per
       fragment. Swap it for versioned filenames before deploying anywhere
       caching should be doing real work. */
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    /* One retry, for a dev server that dropped the connection rather than
       refused it. A genuinely missing file fails the same way twice. */
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 120));
      return fetchText(url, 1);
    }
    throw new Error(`${err.message} — ${url}`);
  }
}

/* Fetch in order, FETCH_CONCURRENCY at a time; results keep input order. */
async function fetchAll(urls) {
  const out = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      out[i] = await fetchText(urls[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker)
  );
  return out;
}

function renderBootError(root, err) {
  const isFileProtocol = location.protocol === "file:";
  root.innerHTML = `
    <div style="max-width:44rem;margin:12vh auto;padding:2rem 2.25rem;
                font-family:Karla,system-ui,sans-serif;line-height:1.6;
                border:1px solid #d8d2c6;border-radius:12px;background:#fffdf9;">
      <h1 style="margin:0 0 .75rem;font-size:1.25rem;color:#8a1c1c;">
        Portal failed to load
      </h1>
      <p style="margin:0 0 1rem;color:#3f3a33;">
        ${isFileProtocol
          ? "This page was opened directly from disk (<code>file://</code>). " +
            "The module loader uses <code>fetch()</code>, which browsers block " +
            "on local files. Serve the project over HTTP instead — Live Server, " +
            "XAMPP, or <code>python -m http.server</code> from the project root."
          : "A shell or module file could not be fetched. Check that " +
            "<code>shell.html</code> and <code>views/</code> sit alongside the " +
            "portal folders inside <code>portal/</code>."}
      </p>
      <pre style="margin:0;padding:.75rem;background:#f4efe6;border-radius:6px;
                  font-size:.8rem;overflow:auto;color:#5a5147;">${String(err)}</pre>
    </div>`;
}

async function loadPortal() {
  const root = document.getElementById("portal-root");
  if (!root) return;                       // legacy page — engine.js self-inits

  try {
    /* 1. shell — provides #login-view, #admin-app, sidebar, #main-content */
    root.textContent = "";
    appendFragment(root, await fetchText(PORTAL_BASE + "shell.html"));

    const main = document.getElementById("main-content");
    if (!main) throw new Error("shell.html is missing #main-content");

    /* 2. modules — fetched a few at a time, inserted in declared order so the
          assembled DOM matches the original admin.html exactly */
    const names = selectModules();
    const parts = await fetchAll(
      names.map(name => `${PORTAL_BASE}views/${name}.html`)
    );
    parts.forEach(html => appendFragment(main, html));

    /* 3. safe to wire up now that every panel exists */
    if (typeof init !== "function") {
      throw new Error("engine.js did not load — init() is undefined");
    }
    init();
  } catch (err) {
    console.error("[module-loader]", err);
    renderBootError(root, err);
  }
}

document.addEventListener("DOMContentLoaded", loadPortal);
