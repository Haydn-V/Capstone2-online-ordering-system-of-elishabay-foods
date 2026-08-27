/* ============================================================
 API CLIENT — the only place in the project that calls fetch()
 ------------------------------------------------------------
 Every request goes through here so that base-path resolution,
 envelope unwrapping, error shape, timeouts and 401 handling are
 decided once instead of per caller.

 A NOTE ON MODULE FORMAT
 -----------------------
 The brief asks for ES modules. This file is a classic script that
 publishes `window.EbApi` instead, because engine.js (3,300 lines)
 and its three companions are classic scripts sharing globals — an
 `import` cannot reach them, and converting all four is Phase 5's
 job, not a prerequisite for removing plaintext passwords from the
 browser. The surface below is deliberately import-shaped, so the
 conversion is a one-line change per caller when that happens.
 ============================================================ */


/* Project root, derived from this module's own URL.

   `import.meta.url`, not `document.currentScript` — the latter is null inside a
   module script, so the old derivation silently fell back to "/" the moment
   this file became a module, pointing every request at the web root instead of
   /elishabay/api/. The classic scripts still use currentScript, which is
   correct for them. */
const BASE = (() => {
  const src = import.meta.url;
  const i = src.indexOf("assets/js/core/");
  return i >= 0 ? src.slice(0, i) : "/";
})();

const API_ROOT = BASE + "api/";

/* A request that never resolves leaves a spinner running forever. */
const TIMEOUT_MS = 15000;

/* Uploads get longer: a phone photo over a slow uplink genuinely takes more
   than 15 seconds, and aborting a nearly-finished upload is worse than
   waiting for it. */
const UPLOAD_TIMEOUT_MS = 60000;

/**
 * Error carrying the envelope's own code/message/fields, so callers can
 * branch on `code` and render `fields` against a form without parsing
 * strings.
 */
class ApiError extends Error {
  constructor(code, message, fields, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields || {};
    this.status = status;
  }
  get isAuth()       { return this.code === "UNAUTHENTICATED"; }
  get isForbidden()  { return this.code === "FORBIDDEN"; }
  get isValidation() { return this.code === "VALIDATION"; }
  /* A distinct code, not just a 403. The server answers 403 with code "CSRF"
     rather than "FORBIDDEN" precisely so this is distinguishable: a CSRF
     failure is a stale page, not a permission problem, and telling someone
     they lack access when they simply need to reload sends them to the wrong
     person for help. */
  get isCsrf()       { return this.code === "CSRF"; }
}

/* Fetch a fresh CSRF token after a rejection. Deliberately not a retry: an
   automatic replay of a state-changing request that was just refused is how one
   click becomes two orders. This only makes the NEXT deliberate attempt work. */
function refreshCsrf() {
  fetch(`${API_ROOT}auth/me.php`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
    .then(r => (r.ok ? r.json() : null))
    .then(j => { if (j && j.ok && j.data && j.data.csrf) csrfToken = j.data.csrf; })
    .catch(() => { /* offline or signed out; the reload prompt still stands */ });
}

/* Called when any request comes back 401. Set by session.js so the portal
   can drop to its login view rather than rendering an empty dashboard. */
let onUnauthenticated = null;

/* CSRF token for the current session, handed over by login.php / me.php.
   Attached to every state-changing request; a cross-origin page cannot read
   it, which is the whole point. */
let csrfToken = null;

async function request(path, options = {}) {
  const { method = "GET", body = null, query = null, signal = null } = options;

  let url = API_ROOT + path.replace(/^\/+/, "");
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== "")
    ).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort());

  let res;
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      /* The session cookie is the entire authentication story, so it has
         to ride along. */
      credentials: "same-origin",
      headers: {
        "Accept": "application/json",
        ...(body !== null ? { "Content-Type": "application/json" } : {}),
        /* GET is exempt server-side, so only send it where it counts. */
        ...(csrfToken && method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new ApiError("TIMEOUT", "The server took too long to respond. Try again.", {}, 0);
    }
    throw new ApiError("NETWORK", "Cannot reach the server. Is Apache running?", {}, 0);
  }
  clearTimeout(timer);

  /* A PHP fatal or a 404 on the endpoint itself returns HTML, not JSON.
     Saying so beats "Unexpected token < in JSON at position 0". */
  let payload;
  const text = await res.text();
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ApiError(
      "BAD_RESPONSE",
      `The server returned something that is not JSON (HTTP ${res.status}). Check the PHP error log.`,
      {},
      res.status
    );
  }

  if (payload && payload.ok === true) {
    return { data: payload.data, meta: payload.meta || null };
  }

  const err = (payload && payload.error) || {};
  const apiError = new ApiError(
    err.code || "SERVER",
    err.message || `Request failed (HTTP ${res.status}).`,
    err.fields || {},
    res.status
  );

  if (apiError.isAuth && typeof onUnauthenticated === "function") {
    onUnauthenticated(apiError);
  }

  /* A CSRF rejection almost always means the page is older than the session —
     someone signed in again in another tab, or the server restarted. The token
     is refreshed here so the next attempt works, and the message says what to
     do rather than reporting a bare "Request failed (HTTP 403)". */
  if (apiError.isCsrf) {
    apiError.message =
      "This page is out of date with your session — reload and try again.";
    refreshCsrf();
  }

  throw apiError;
}

/**
 * Upload a file to api/uploads/image.php.
 *
 * A separate function rather than a flag on request(), because a multipart body
 * needs the exact opposite of what request() does: the Content-Type header must
 * NOT be set. `fetch` derives it from the FormData along with the multipart
 * boundary, and a hand-set "multipart/form-data" arrives with no boundary at
 * all — PHP then parses nothing and $_FILES is empty. That is one of the shapes
 * the brief lists for "the upload doesn't work", so it is worth being explicit:
 * there is no Content-Type here on purpose.
 *
 * The CSRF header still applies. Uploads are state-changing.
 *
 * Timeout is longer than the standard 15s: a phone photo over a slow uplink is
 * a real case, and aborting a nearly-complete upload is worse than waiting.
 *
 * Returns { path, bytes, width, height }.
 */
async function upload(file, purpose, { signal = null } = {}) {
  const form = new FormData();
  form.append("file", file);
  form.append("purpose", purpose);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort());

  let res;
  try {
    res = await fetch(`${API_ROOT}uploads/image.php`, {
      method: "POST",
      signal: controller.signal,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: form,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new ApiError("TIMEOUT", "The upload took too long. Try a smaller image.", {}, 0);
    }
    throw new ApiError("NETWORK", "Cannot reach the server. Is Apache running?", {}, 0);
  }
  clearTimeout(timer);

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    /* A body over post_max_size makes PHP return an empty 200 with no JSON at
       all. Reporting it as a size problem beats "not JSON". */
    throw new ApiError(
      "BAD_RESPONSE",
      res.status === 200
        ? "The server rejected the upload without an explanation — the file is probably too large."
        : `The server returned something that is not JSON (HTTP ${res.status}).`,
      {},
      res.status
    );
  }

  if (payload && payload.ok === true) return payload.data;

  const err = (payload && payload.error) || {};
  const apiError = new ApiError(
    err.code || "SERVER",
    err.message || `Upload failed (HTTP ${res.status}).`,
    err.fields || {},
    res.status
  );
  if (apiError.isAuth && typeof onUnauthenticated === "function") onUnauthenticated(apiError);
  if (apiError.isCsrf) {
    apiError.message = "This page is out of date with your session — reload and try again.";
    refreshCsrf();
  }
  throw apiError;
}

export const EbApi = {
  ApiError,
  base: BASE,
  root: API_ROOT,
  upload,
  get:  (path, query)      => request(path, { method: "GET", query }),
  post: (path, body)       => request(path, { method: "POST", body }),
  put:  (path, body)       => request(path, { method: "PUT", body }),
  del:  (path, body)       => request(path, { method: "DELETE", body }),
  request,
  onUnauthenticated(fn) { onUnauthenticated = fn; },
  setCsrf(token) { csrfToken = token || null; },
  get csrf() { return csrfToken; },
};

