"use strict";

/* Module loader for all five staff portals: fetches portal/shell.html, then each portal/views/<name>.html into #main-content in MODULE_ORDER, then calls init() (which needs the module markup); requires HTTP, not file://. */

/* Injection order matches the original section order. */
const MODULE_ORDER = [
  "dashboard",
  "pos", "pos-payment",
  "notifications", "online-txns", "ordersqueue", "paymentverify",
  "orderstatus", "orderhistory", "receipts", "returns",
  "users", "b2b", "landing", "products", "reviews", "vat", "shipping",
  "inventory", "inventory-manage", "expiry",
  "sales", "batches",
  "payments", "transactions", "audit",
  "roles",
  /* Last, matching its place in the sidebar. */
  "profile",
];

/* Shell and views are one folder up from portal/<role>/index.html. */
const PORTAL_BASE = "../";

/* Inject every module for now; applyRBAC() hides what the role lacks and navigate() guards access (permission-gated loading is a later step). */
function selectModules() {
  return MODULE_ORDER;
}

/* Fetch four module files at a time, since some dev servers drop connections under 24 parallel requests. */
const FETCH_CONCURRENCY = 4;

/* Parse a fetched HTML file and return its body children, dropping any <script> (e.g. a dev server's live-reload). */
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

/* The one deliberate raw fetch(): it loads HTML fragments (not JSON API calls) before core/index.js runs. */
async function fetchText(url, attempt = 0) {
  try {
    /* cache: "no-store" so the portal never runs a stale cached view. */
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    /* Retry once in case the dev server dropped the connection. */
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
    /* 1. shell — provides #admin-app, sidebar, #main-content */
    root.textContent = "";
    appendFragment(root, await fetchText(PORTAL_BASE + "shell.html"));

    const main = document.getElementById("main-content");
    if (!main) throw new Error("shell.html is missing #main-content");

    /* Fetch modules a few at a time and insert them in declared order. */
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
