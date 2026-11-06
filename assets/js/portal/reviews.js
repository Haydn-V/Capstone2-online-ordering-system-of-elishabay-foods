/* ===== PRODUCT REVIEWS moderation queue: moderates abuse and policy only, never the score; the Pending tab is filled by a keyword list (each row shows the matched word), and rejecting or unpublishing needs a reason shown to the customer ===== */

/* Server data only; starts empty. */
let REVIEWS = [];
let REVIEW_COUNTS = { all: 0, pending: 0, published: 0, rejected: 0 };
let reviewsLoaded = false;

const REVIEW_TABS = [
  /* Pending is first and selected by default. */
  { id: "pending",   label: "Pending" },
  { id: "published", label: "Published" },
  { id: "rejected",  label: "Not published" },
  { id: "all",       label: "All" },
];

function reviewFilter(){ return adminState.reviewFilter || "pending"; }

/* Client-side paging, back to page 1 whenever tab, search, sort or page size changes. */
const REV_PG = { page: 1, limit: 10, key: "" };

async function loadReviews(){
  const host = $("#rev-content");
  if(host) host.innerHTML = `<p class="field-hint" style="padding:18px">Loading reviews…</p>`;
  try{
    const { data, meta } = await EbApi.get("reviews/list.php", {
      status: reviewFilter(),
      search: ($("#rev-search")?.value || "").trim(),
      limit: 100,
    });
    REVIEWS = data || [];
    const key = reviewFilter() + "|" + ($("#rev-search")?.value || "").trim();
    if(key !== REV_PG.key){ REV_PG.key = key; REV_PG.page = 1; }
    REVIEW_COUNTS = meta?.counts || REVIEW_COUNTS;
    reviewsLoaded = true;
    renderReviews();
  }catch(err){
    reviewsLoaded = false;
    if(host){
      /* Say which kind of failure happened. */
      host.innerHTML = err.isForbidden
        ? emptyState("No access", "You do not have permission to moderate reviews.")
        : emptyState("Reviews could not be loaded", escHtml(err.message));
    }
    if(!err.isForbidden) toast(err.message, "err");
  }
}

function renderReviewTabs(){
  const el = $("#rev-tabs");
  if(!el) return;
  const active = reviewFilter();
  el.innerHTML = REVIEW_TABS.map(t=>{
    /* Only the Pending tab shows a count (from WORK_TABS). */
    const b = tabBadge(t.id, t.label, REVIEW_COUNTS[t.id] || 0, "waiting");
    /* Use the shared .tab-btn pill. */
    return `<button class="tab-btn${active===t.id?" active":""}" role="tab"
      aria-selected="${active===t.id}" aria-label="${escHtml(b.aria)}"
      data-rev-tab="${t.id}">${b.html}</button>`;
  }).join("");

  el.querySelectorAll("[data-rev-tab]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      adminState.reviewFilter = btn.dataset.revTab;
      loadReviews();
    });
  });
}

/* Print the rating as "2/5" beside the stars, so it does not rely on colour. */
function reviewStarsRow(n){
  return `<span class="rev-row-stars" aria-label="${n} out of 5">` +
    [1,2,3,4,5].map(i=>`<svg viewBox="0 0 24 24" fill="${i<=n?"currentColor":"none"}"
      stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3
      5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>`).join("") +
    `<b class="rev-row-num" aria-hidden="true">${n}/5</b></span>`;
}

/* Strip the "keyword: " prefix for display only (the stored value keeps it). */
function holdNote(reason){
  const m = /^keyword:\s*(.+)$/i.exec(String(reason).trim());
  return m
    ? `<p class="rev-card-hold"><b>Held by the keyword list:</b> the word
       “${escHtml(m[1])}”. A word match, not a judgement — read the review
       before deciding.</p>`
    : `<p class="rev-card-hold"><b>Held:</b> ${escHtml(reason)}.</p>`;
}

const REVIEW_STATUS_LABEL = {
  pending:   "Waiting to be checked",
  published: "Published",
  rejected:  "Not published",
};

function renderReviews(){
  renderReviewTabs();
  const host = $("#rev-content");
  if(!host) return;

  if(!REVIEWS.length){
    const f = reviewFilter();
    /* An empty queue reads as good news (shared emptyState()). */
    host.innerHTML = f === "pending"
      ? emptyState("Nothing is waiting",
          "Reviews reach this queue only when the keyword list catches something in the wording.")
      : emptyState("No reviews match this view", "Try another tab or search term.");
    return;
  }

  /* One table row per review, with the text and any notes under the product. */
  /* Client-side sort, ties broken by newest first. */
  const sortKey = $("#rev-sort")?.value || "newest";
  if(!$("#rev-sort")?.dataset.wired && $("#rev-sort")){
    $("#rev-sort").dataset.wired = "1";
    $("#rev-sort").addEventListener("change", ()=>{ REV_PG.page = 1; renderReviews(); });
  }
  const sizeSel = $("#rev-page-size");
  if(sizeSel && !sizeSel.dataset.wired){
    sizeSel.dataset.wired = "1";
    sizeSel.value = String(REV_PG.limit);
    sizeSel.addEventListener("change", ()=>{ REV_PG.limit = Number(sizeSel.value) || 10; REV_PG.page = 1; renderReviews(); });
  }
  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  const cmp = {
    newest:   byDate,
    oldest:   (a, b) => -byDate(a, b),
    high:     (a, b) => (b.rating - a.rating) || byDate(a, b),
    low:      (a, b) => (a.rating - b.rating) || byDate(a, b),
    product:  (a, b) => String(a.product_name).localeCompare(String(b.product_name)) || byDate(a, b),
    customer: (a, b) => String(a.customer_name).localeCompare(String(b.customer_name)) || byDate(a, b),
  }[sortKey] || byDate;
  const sorted = [...REVIEWS].sort(cmp);
  const pages = Math.max(1, Math.ceil(sorted.length / REV_PG.limit));
  if(REV_PG.page > pages) REV_PG.page = pages;
  const rows = sorted.slice((REV_PG.page - 1) * REV_PG.limit, REV_PG.page * REV_PG.limit);

  host.innerHTML = `<div class="table-wrap rev-table-wrap"><table class="data-table rev-table">
    <thead><tr>
      <th>Rating</th><th>Product &amp; review</th><th>Customer</th><th>Order</th>
      <th>Date</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>` + rows.map(r=>{
    /* Show the order's current status (e.g. cancelled later). */
    const orderOdd = r.order_status && r.order_status !== "completed";
    return `
    <tr data-rev="${r.id}">
      <td class="rev-td-rating">${reviewStarsRow(r.rating)}</td>
      <td class="rev-td-main">
        <div class="rev-card-product">${escHtml(r.product_name)}
          ${r.product_archived ? `<span class="rev-chip">Archived product</span>` : ""}</div>
        ${r.comment
          ? `<div class="rev-td-comment">${escHtml(r.comment)}</div>`
          : `<div class="rev-card-nocomment">Rating only — no comment was left.</div>`}
        ${r.hold_reason ? holdNote(r.hold_reason) : ""}
        ${r.reject_reason ? `<p class="rev-card-reason">
          <b>Reason given:</b> ${escHtml(r.reject_reason)}
          ${r.moderator ? ` — ${escHtml(r.moderator)}, ${EbFormat.fmtDateTime(r.moderated_at)}` : ""}
        </p>` : ""}
      </td>
      <td><div class="td-name">${escHtml(r.customer_name)}</div><div class="muted rev-td-email">${escHtml(r.customer_email)}</div></td>
      <td><span class="mono">${escHtml(r.order_id)}</span>
        ${orderOdd ? `<div><span class="rev-chip rev-chip-warn">Order is now ${escHtml(r.order_status)}</span></div>` : ""}</td>
      <td class="muted">${EbFormat.fmtDateTime(r.date)}${r.edited ? "<div>edited</div>" : ""}</td>
      <td><span class="rev-card-status rev-card-status-${r.status}">${REVIEW_STATUS_LABEL[r.status]}</span></td>
      <td><div class="td-actions">
        ${r.status === "pending" ? `
          <button class="btn btn-sm btn-gold" data-rev-act="publish" data-id="${r.id}">Publish</button>
          <button class="btn btn-sm btn-ghost" data-rev-act="reject" data-id="${r.id}">Reject…</button>` : ""}
        ${r.status === "published" ? `
          <button class="btn btn-sm btn-ghost" data-rev-act="unpublish" data-id="${r.id}">Unpublish…</button>` : ""}
        ${r.status === "rejected" ? `
          <button class="btn btn-sm btn-gold" data-rev-act="publish" data-id="${r.id}">Publish</button>` : ""}
      </div></td>
    </tr>`;
  }).join("") + `</tbody></table></div>
    <div class="table-toolbar" style="margin-top:14px">
      <span class="muted" id="rev-showing" style="font-size:.82rem"></span>
      <div class="pagination" id="rev-pagination" style="margin-left:auto"></div>
    </div>`;
  EbPaginate.render("rev", { page: REV_PG.page, limit: REV_PG.limit, total: sorted.length, pages },
    p => { REV_PG.page = p; renderReviews(); });

  host.querySelectorAll("[data-rev-act]").forEach(btn=>{
    btn.addEventListener("click", ()=> moderateReview(btn.dataset.revAct, Number(btn.dataset.id), btn));
  });
}

/* Ask for the reason before the request, using the portal's EbUI.openModal (not the storefront's openModal). */
function moderateReview(action, id, btn){
  if(action === "publish") return sendModeration(action, id, "", btn);

  const row = REVIEWS.find(r=>r.id === id);
  const what = action === "reject" ? "Reject this review" : "Unpublish this review";

  openModal({
    title: what,
    confirmLabel: what,
    /* Red button because both actions remove a customer's words. */
    confirmClass: "btn-red",
    body: `
      <p class="field-hint" style="margin-bottom:14px">
        ${escHtml(row ? row.customer_name : "The customer")} is shown this reason on
        their own review. Say what rule it breaks — a low rating is not one.
      </p>
      <div class="field">
        <label for="rev-reason">Reason</label>
        <textarea class="control" id="rev-reason" rows="3" maxlength="500"
          placeholder="e.g. Posts contact details for another business."></textarea>
        <span class="field-error" id="rev-reason-err"></span>
      </div>`,
    onConfirm: async () => {
      const ta  = document.querySelector("#rev-reason");
      const err = document.querySelector("#rev-reason-err");
      const reason = (ta?.value || "").trim();
      if(!reason){
        /* The confirm handler does not auto-close, so a missing reason can be refused in place. */
        err.textContent = "A reason is required to take a review down.";
        ta?.focus();
        return;
      }
      closeModal();
      await sendModeration(action, id, reason, btn);
    },
  });
}

async function sendModeration(action, id, reason, btn){
  const restore = btn ? busyBtn(btn) : ()=>{};
  try{
    const { data } = await EbApi.post("reviews/moderate.php", { id, action, reason });
    /* Mention the change to the public average too. */
    toast(
      `${action === "publish" ? "Published" : action === "reject" ? "Rejected" : "Unpublished"}.` +
      (data.review_count
        ? ` That product now shows ${data.avg_rating.toFixed(1)} from ${data.review_count} review${data.review_count===1?"":"s"}.`
        : ` That product now shows no ratings.`),
      "ok"
    );
    await loadReviews();
    /* Refresh the sidebar badge and notifications from the server. */
    if(typeof loadOpsData === "function") loadOpsData();
  }catch(err){
    restore();
    toast(err.message, "err");
  }
}

/* Disable the button while the request runs. */
function busyBtn(btn){
  const old = btn.textContent, wasDisabled = btn.disabled;
  btn.disabled = true; btn.textContent = "Working…";
  return ()=>{ btn.disabled = wasDisabled; btn.textContent = old; };
}

/* Wired from init() after views load; search is debounced and server-side (not data-refilters). */
function initReviews(){
  const box = $("#rev-search");
  if(!box) return;
  let t = null;
  box.addEventListener("input", ()=>{
    clearTimeout(t);
    /* Search debounce delay. */
    t = setTimeout(()=>{ if(reviewsLoaded || $("#mod-reviews")?.classList.contains("active")) loadReviews(); }, 300);
  });
}
