/* ============================================================
   UI TEST RUNNER — catches "green endpoint, dead UI"
   ------------------------------------------------------------
   WHY THIS EXISTS, AND WHY IT IS NOT PLAYWRIGHT

   The defining bug in this project is an endpoint that works
   perfectly and a screen that never calls it. The Roles screen
   silently discarded every edit for weeks while roles/save.php
   passed every test against it. Customer login was a mock while
   shop/login.php sat there, correct and unreferenced.

   tools/verify-api.py cannot catch that class of bug — it talks to
   the API directly, which is the half that already works. Something
   has to drive the actual interface.

   Playwright was the obvious answer and is not available: this
   project is XAMPP-only, no npm, no build step. So this runner does
   the same job with what the stack already has. It loads a portal
   into an iframe, drives the real DOM inside it, and checks the
   result against what the API says the database holds.

   WHAT IT CAN CATCH
     - a control that is wired to nothing
     - a list that renders but does not match the database
     - a write that appears to succeed and does not persist
     - a console error on load
     - a screen that renders invented data when a fetch fails

   WHAT IT CANNOT CATCH
     - anything visual: layout, overlap, contrast, z-index
     - real cross-browser differences (it runs in whatever browser
       you opened it in)
     - CSS-driven interaction (:hover, focus rings, transitions)
     - anything requiring a genuine OS-level input event; this
       dispatches synthetic events, which some widgets treat
       differently from real ones
     - timing races that only appear on a slow connection

   Those limits are real. This is a wiring test, not a UI test.
   ============================================================ */

"use strict";

const BASE = "/elishabay";

/* ---------- reporting ---------- */
const results = [];
let currentSpec = null;

function log(msg, cls = "") {
  const el = document.createElement("div");
  el.className = "line " + cls;
  el.textContent = msg;
  document.getElementById("out").appendChild(el);
  el.scrollIntoView({ block: "nearest" });
}

function check(ok, label, detail = "") {
  results.push({ spec: currentSpec, label, ok, detail });
  log(`  ${ok ? "PASS" : "FAIL"}  ${label}`, ok ? "pass" : "fail");
  if (!ok && detail) log(`        ${detail}`, "detail");
  return ok;
}

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll until fn() is truthy, or give up. Beats a fixed sleep, which is
    either too short (flaky) or too long (slow). */
async function waitFor(fn, { timeout = 8000, interval = 100, what = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() - started > timeout) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    }
    await sleep(interval);
  }
}

/** Call the API as whoever is currently signed in. */
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api/${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function apiPost(path, payload, csrf) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" },
    body: JSON.stringify(payload),
  });
}

/* ---------- session ---------- */
let csrfToken = null;

async function signInAs(email, password, portalRole) {
  await api("auth/logout.php", { method: "POST" });
  const { status, body } = await apiPost("auth/login.php", {
    email, password, ...(portalRole ? { portal_role: portalRole } : {}),
  });
  if (status !== 200) {
    throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 160)}`);
  }
  csrfToken = body.data.csrf || null;
  return body.data.user;
}

/* ---------- the iframe under test ---------- */
let frame = null;

/** Load a portal and wait until its modules have assembled the DOM.
    Console errors are captured from the moment the document exists. */
async function openPortal(role, { cacheBust = true } = {}) {
  const host = document.getElementById("stage");
  host.innerHTML = "";
  frame = document.createElement("iframe");
  frame.className = "stage-frame";
  /* Cache-busting because stale HTML fragments have misled this project
     three separate times, each looking like broken code. */
  frame.src = `${BASE}/portal/${role}/index.html${cacheBust ? "?uitest=" + Date.now() : ""}`;
  host.appendChild(frame);

  const errors = [];
  await new Promise(res => frame.addEventListener("load", res, { once: true }));

  const w = frame.contentWindow;
  w.addEventListener("error", e => errors.push(String(e.message)));
  const origError = w.console.error;
  w.console.error = (...a) => { errors.push(a.map(String).join(" ")); origError.apply(w.console, a); };

  /* The module loader injects the shell then 24 view fragments, so the
     document is "loaded" long before it is usable. */
  await waitFor(() => w.document.getElementById("mod-dashboard"),
                { what: "portal modules to finish injecting" });
  await waitFor(() => typeof w.navigate === "function",
                { what: "engine.js to define navigate()" });
  await sleep(600);   // let the initial data loads settle

  return { w, doc: w.document, errors };
}

/* ---------- DOM driving, inside the frame ---------- */
function $f(sel) { return frame.contentWindow.document.querySelector(sel); }
function $$f(sel) { return [...frame.contentWindow.document.querySelectorAll(sel)]; }

async function goto(mod) {
  frame.contentWindow.navigate(mod);
  await sleep(500);
}

function clickIn(el) {
  if (!el) throw new Error("clickIn: element not found");
  el.click();
}

function typeIn(el, value, evt = "input") {
  if (!el) throw new Error("typeIn: element not found");
  el.value = value;
  el.dispatchEvent(new frame.contentWindow.Event(evt, { bubbles: true }));
}

/* ---------- spec registration ---------- */
const SPECS = [];
function spec(name, roles, fn) { SPECS.push({ name, roles, fn }); }

/* ---------- run ---------- */
async function runAll(filter) {
  document.getElementById("out").innerHTML = "";
  results.length = 0;
  const started = Date.now();

  for (const s of SPECS) {
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase())) continue;
    for (const role of s.roles) {
      currentSpec = `${s.name} [${role.label}]`;
      log(`\n${currentSpec}`, "spec");
      try {
        await signInAs(role.email, role.password, role.portalRole);
        await s.fn(role);
      } catch (err) {
        check(false, "spec threw", String(err && err.message || err));
      }
    }
  }

  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`\n${fail === 0 ? "ALL PASSED" : fail + " FAILED"} — ${pass}/${results.length} in ${secs}s`,
      fail === 0 ? "summary-ok" : "summary-bad");
  if (fail) {
    log("Failures:", "fail");
    results.filter(r => !r.ok).forEach(r => log(`  ${r.spec} :: ${r.label}`, "fail"));
  }
}

window.UITest = { spec, check, goto, clickIn, typeIn, $f, $$f, api, apiPost, waitFor,
                  sleep, openPortal, runAll, SPECS, log,
                  get csrf() { return csrfToken; } };
