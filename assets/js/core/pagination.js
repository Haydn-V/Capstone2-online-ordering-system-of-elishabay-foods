/* EbPaginate: server-side pagination driven by the API's meta block, using the same markup ids as the old array-based Paginate. */


const $ = id => document.getElementById(id);

/* Windowed page numbers (first, last, current and neighbours, with gaps). */
function pageWindow(page, pages, span = 2) {
  const out = [];
  const push = v => { if (out[out.length - 1] !== v) out.push(v); };
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= span) push(i);
    else push("…");
  }
  return out;
}

/** Render pagination controls for one list (prefix finds #prefix-showing and #prefix-pagination). */
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

/** Changing the page size returns to page 1. */
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

/** Run one server-paged list end to end (loading, fetch, error, empty, rows, controls); set asTable false when mounting cards instead of table rows. */
async function list(prefix, state, mount, fetchPage, rowHtml, opts = {}) {
  const colspan = opts.colspan || 6;
  const tbody = typeof mount === "function" ? mount() : mount;
  if (!tbody) return null;

  const asTable = opts.asTable !== false;
  const stateHtml = {
    loading: () => asTable
      ? (window.EbUI ? EbUI.loadingRow(colspan) : "")
      : (window.EbUI ? EbUI.skeletonBlock(5) : ""),
    empty: (t, h) => asTable
      ? (window.EbUI ? EbUI.emptyRow(colspan, t, h) : "")
      : `<div class="state-cell"><strong>${t}</strong>${h ? `<br><small>${h}</small>` : ""}</div>`,
    error: m => asTable
      ? (window.EbUI ? EbUI.errorRow(colspan, m) : "")
      : `<div class="state-cell state-error"><strong>Could not load this.</strong><br><small>${m}</small></div>`,
  };

  /* Show a loading row so loading never looks like an empty list. */
  tbody.innerHTML = stateHtml.loading();

  let res;
  try {
    /* Named fetchPage so it does not shadow the global fetch. */
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

  /* Map the select's limit to the pager's pageSize. */
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

