/* API client: the only place that calls fetch(), handling base path, envelope unwrapping, errors, timeouts and 401s in one place (published as window.EbApi for the classic scripts). */


/* Project root from this module's own URL (import.meta.url, since document.currentScript is null in modules). */
const BASE = (() => {
  const src = import.meta.url;
  const i = src.indexOf("assets/js/core/");
  return i >= 0 ? src.slice(0, i) : "/";
})();

const API_ROOT = BASE + "api/";

/* A request that never resolves leaves a spinner running forever. */
const TIMEOUT_MS = 15000;

/* Uploads get a longer timeout because phone photos on slow connections take time. */
const UPLOAD_TIMEOUT_MS = 60000;

/** Error carrying the envelope's code, message and fields, so callers can branch on code and show field errors. */
class ApiError extends Error {
  constructor(code, message, fields, status, retryAfter) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields || {};
    this.status = status;
    /* Seconds to wait from a 429, kept outside fields so it is never treated as a form input. */
    this.retryAfter = Number(retryAfter) || 0;
  }
  get isAuth()       { return this.code === "UNAUTHENTICATED"; }
  get isForbidden()  { return this.code === "FORBIDDEN"; }
  get isValidation() { return this.code === "VALIDATION"; }
  /* A lockout, not a wrong password (see api/core/Lockout.php). */
  get isRateLimited(){ return this.code === "RATE_LIMITED"; }
  /* A CSRF failure (code "CSRF") means the page is stale, not that access is denied. */
  get isCsrf()       { return this.code === "CSRF"; }
}

/* Fetch a fresh CSRF token after a rejection, but never retry automatically (that could place an order twice). */
function refreshCsrf() {
  fetch(`${API_ROOT}auth/me.php`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
    .then(r => (r.ok ? r.json() : null))
    .then(j => { if (j && j.ok && j.data && j.data.csrf) csrfToken = j.data.csrf; })
    .catch(() => { /* offline or signed out; the reload prompt still stands */ });
}

/* Called on any 401; set by session.js so the portal shows its login view. */
let onUnauthenticated = null;

/* CSRF token for this session (from login.php/me.php), sent with every state-changing request. */
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
      /* Send the session cookie with every request. */
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

  /* An HTML response (PHP fatal or 404) gets a clear message instead of a JSON parse error. */
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
    res.status,
    err.retryAfter
  );

  if (apiError.isAuth && typeof onUnauthenticated === "function") {
    onUnauthenticated(apiError);
  }

  /* On a CSRF rejection, refresh the token and tell the user to try again. */
  if (apiError.isCsrf) {
    apiError.message =
      "This page is out of date with your session — reload and try again.";
    refreshCsrf();
  }

  throw apiError;
}

/** Upload a file to api/uploads/image.php; returns { path, bytes, width, height }. */
async function upload(file, purpose, { signal = null } = {}) {
  const form = new FormData();
  form.append("file", file);
  form.append("purpose", purpose);
  return postForm("uploads/image.php", form, { signal, timeoutMessage: "The upload took too long. Try a smaller image." });
}

/** POST a FormData (multipart, e.g. a file) without setting Content-Type (fetch adds the boundary), with CSRF and the
    longer upload timeout; returns the payload's data or throws ApiError like request(). */
async function postForm(path, form, { signal = null, timeoutMessage = "The upload took too long. Try a smaller file." } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort());

  let res;
  try {
    res = await fetch(`${API_ROOT}${path}`, {
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
      throw new ApiError("TIMEOUT", timeoutMessage, {}, 0);
    }
    throw new ApiError("NETWORK", "Cannot reach the server. Is Apache running?", {}, 0);
  }
  clearTimeout(timer);

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    /* An empty 200 means the upload exceeded post_max_size, so report it as too large. */
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
    res.status,
    err.retryAfter
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
  postForm,
  get:  (path, query)      => request(path, { method: "GET", query }),
  post: (path, body)       => request(path, { method: "POST", body }),
  put:  (path, body)       => request(path, { method: "PUT", body }),
  del:  (path, body)       => request(path, { method: "DELETE", body }),
  request,
  onUnauthenticated(fn) { onUnauthenticated = fn; },
  setCsrf(token) { csrfToken = token || null; },
  get csrf() { return csrfToken; },
};

