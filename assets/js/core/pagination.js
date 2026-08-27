/* ============================================================
 PAGINATION — server-side, driven by the API's meta block
 ------------------------------------------------------------
 The existing Paginate (assets/js/portal/pagination.js) slices an
 array the browser already holds. That works only while the whole
 dataset is in memory, which stops being true the moment lists come
 from the API — 42 orders is fine, 4,200 is not.

 This one never sees the rows. It reads the `meta` the server
 returns ({page, limit, total, pages}) and renders controls that
 ask for the next page. The markup contract is identical to the
 old engine, so the existing
     <span id="x-showing">, <div id="x-pagination">, <select id="x-page-size">
 markup keeps working untouched.

 Both exist during Phase 5: a module switches from Paginate to
 EbPaginate when it is converted to load from the API.
 ============================================================ */


const $ = id => document.getElementById(id);

/* Windowed page numbers. Rendering 200 buttons for 200 pages is unusable;
   this keeps first, last, current and its neighbours, with gaps marked. */
function pageWindow(page, pages, span = 2) {
  const out = [];
  const push = v => { if (out[out.length - 1] !== v) out.push(v); };
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= span) push(i);
    else push("…");
  }
  return out;
}

/**
 * Render controls for one list.
 *
 * @param prefix  id prefix — "orders" finds #orders-showing, #orders-pagination
 * @param meta    the API's meta block
 * @param onGo    called with the requested page number
 */
function render(prefix, meta, onGo) {
  const showing = $(`${prefix}-showing`);
  const total   = Number(meta?.total ?? 0);
  const page    = Number(meta?.page ?? 1);
  const limit   = Number(meta?.limit ?? 25);
  const pages   = Number(meta?.pages ?? Math.max(1, Math.ceil(total / limit)));

  if (showing) {
    const from = total ? (page - 1) * limit + 1 : 0;
    const to   = Math.min(page * limit, total);
    showing.textContent = total
      ? `Showing ${from} to ${to} of ${total} entries`
      : "No entries";
  }

  const nav = $(`${prefix}-pagination`);
  if (!nav) return;

  if (pages <= 1) { nav.innerHTML = ""; return; }

  const prevSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const nextSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  let html = `<button data-pg="prev" ${page <= 1 ? "disabled" : ""} aria-label="Previous page">${prevSvg}</button>`;
  for (const p of pageWindow(page, pages)) {
    html += p === "…"
      ? `<span class="pg-gap" aria-hidden="true">…</span>`
      : `<button data-pg="${p}" class="${p === page ? "active" : ""}" ${p === page ? 'aria-current="page"' : ""}>${p}</button>`;
  }
  html += `<button data-pg="next" ${page >= pages ? "disabled" : ""} aria-label="Next page">${nextSvg}</button>`;
  nav.innerHTML = html;

  nav.querySelectorAll("[data-pg]").forEach(btn => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.pg;
      const target = v === "prev" ? Math.max(1, page - 1)
                   : v === "next" ? Math.min(pages, page + 1)
                   : Number(v);
      if (target !== page) onGo(target);
    });
  });
}

/**
 * Wire the page-size select. Changing the size returns to page 1 —
 * staying on page 9 of a list that now has 3 pages shows nothing.
 */
function wirePageSize(prefix, state, reload) {
  const sel = $(`${prefix}-page-size`);
  if (!sel || sel.dataset.wired) return;
  sel.dataset.wired = "1";
  sel.value = String(state.limit || 25);
  sel.addEventListener("change", e => {
    state.limit = Number(e.target.value) || 25;
    state.page = 1;
    reload();
  });
}

/** Fresh paging state for a module. */
const state = (limit = 25) => ({ page: 1, limit });

/**
 * Drive one server-paged list end to end.
 *
 * Fifteen screens needed the same six steps — show a loading row, fetch a page,
 * handle the error, handle empty, draw the rows, wire the controls — and
 * writing that out fifteen times is fifteen chances to forget the error case.
 * This is that sequence once.
 *
 * @param prefix   id prefix: "audit" finds #audit-showing, #audit-pagination
 * @param state    { page, pageSize } — the module's own pager object
 * @param mount    () => Element        where rows go (a tbody)
 * @param fetchPage (page, limit) => Promise<{data, meta}>
 * @param rowHtml  (row, index) => string
 * @param opts     { colspan, empty:{title,hint}, after(rows, meta), asTable }
 *
 * `asTable` defaults true. Set false when the mount is a plain container of
 * cards rather than a tbody — a <tr> state row inside a <div> is dropped by the
 * parser, so the screen would show nothing at all while loading and nothing on
 * error, which is worse than the blank table this helper exists to replace.
 */
async function list(prefix, state, mount, fetchPage, rowHtml, opts = {}) {
  const colspan = opts.colspan || 6;
  const tbody = typeof mount === "function" ? mount() : mount;
  if (!tbody) return null;

  const asTable = opts.asTable !== false;
  const stateHtml = {
    loading: () => asTable
      ? (window.EbUI ? EbUI.loadingRow(colspan) : "")
      : `<div class="state-cell"><span class="spinner" aria-hidden="true"></span> Loading…</div>`,
    empty: (t, h) => asTable
      ? (window.EbUI ? EbUI.emptyRow(colspan, t, h) : "")
      : `<div class="state-cell"><strong>${t}</strong>${h ? `<br><small>${h}</small>` : ""}</div>`,
    error: m => asTable
      ? (window.EbUI ? EbUI.errorRow(colspan, m) : "")
      : `<div class="state-cell state-error"><strong>Could not load this.</strong><br><small>${m}</small></div>`,
  };

  /* A loading state rather than an empty container: empty is indistinguishable
     from "there is no data", which is exactly the ambiguity that makes a silent
     failure look like a working screen. */
  tbody.innerHTML = stateHtml.loading();

  let res;
  try {
    /* Named fetchPage, not fetch. As `fetch` it shadowed the global inside
       this function, so a grep for raw fetch() calls flagged this line and a
       reader had to check the signature to see it was a callback. */
    res = await fetchPage(state.page || 1, state.pageSize || state.limit || 10);
  } catch (err) {
    tbody.innerHTML = stateHtml.error(err.message);
    return null;
  }

  const rows = res.data || [];
  const meta = res.meta || {};

  tbody.innerHTML = rows.length
    ? rows.map(rowHtml).join("")
    : stateHtml.empty((opts.empty && opts.empty.title) || "Nothing here yet",
                      (opts.empty && opts.empty.hint) || "");

  render(prefix, meta, page => {
    state.page = page;
    list(prefix, state, mount, fetchPage, rowHtml, opts);
  });

  /* The page-size select reports `limit`; the portal's pagers historically
     call it `pageSize`. Bridged here so neither has to change. */
  wirePageSize(prefix, {
    get limit()  { return state.pageSize || state.limit || 10; },
    set limit(v) { state.pageSize = v; state.limit = v; },
    get page()   { return state.page; },
    set page(v)  { state.page = v; },
  }, () => list(prefix, state, mount, fetchPage, rowHtml, opts));

  if (typeof opts.after === "function") opts.after(rows, meta);
  return { rows, meta };
}

export const EbPaginate = { render, wirePageSize, state, pageWindow, list };

