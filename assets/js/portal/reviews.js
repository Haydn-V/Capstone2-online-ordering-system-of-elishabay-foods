/* ============================================================
   PRODUCT REVIEWS — the staff moderation queue
   ------------------------------------------------------------
   WHAT THIS SCREEN DECIDES, AND WHAT IT MUST NOT

   Abuse and policy: advertising, contact details, somebody else's
   dispute pasted in, language that has no place on the shop page.

   NOT the score. A 1- or 2-star review publishes the moment it is
   written and never reaches the Pending tab; it raises a Warning
   notification instead, so the team hears about a real problem with
   a real order quickly. Nothing here reads `rating` to decide
   anything, and api/reviews/moderate.php does not either. If a
   rating could be moderated away, the average on every product page
   would quietly become a measure of which reviews staff liked.

   THE PENDING QUEUE IS FILLED BY A KEYWORD LIST. One list, in
   settings.review_flag_words, matched case-insensitively on word
   boundaries. It is not content classification: it misses abuse and
   it flags ordinary sentences. That is why every held row prints the
   word that caught it — a moderator who cannot see what the machine
   objected to is guessing, and guessing safely means rejecting
   innocent text.

   A REASON IS REQUIRED TO TAKE ANYTHING DOWN, for reject and for
   unpublish alike. The customer is shown it on their own review
   (api/shop/reviews.php returns it in `mine`), and a removal with no
   stated cause is indistinguishable from one made because staff
   disliked the score — including to the staff member who has to
   explain it later. Publishing needs no reason: it is the outcome the
   customer already asked for.
   ============================================================ */

/* Server-owned. Empty until the first load, so a failed request shows an
   empty screen and its error rather than invented rows. */
let REVIEWS = [];
let REVIEW_COUNTS = { all: 0, pending: 0, published: 0, rejected: 0 };
let reviewsLoaded = false;

const REVIEW_TABS = [
  /* Pending first and selected by default: this screen exists to be cleared,
     and the work belongs at the front of it. */
  { id: "pending",   label: "Pending" },
  { id: "published", label: "Published" },
  { id: "rejected",  label: "Not published" },
  { id: "all",       label: "All" },
];

function reviewFilter(){ return adminState.reviewFilter || "pending"; }

/* Client-side paging over the loaded (sorted) list. Back to page 1 whenever
   the tab, search, sort or page size changes; kept after a moderation reload. */
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
      /* Says which failure it was. "Could not load" over a 403 sends a
         moderator hunting for a network problem they do not have. */
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
    /* tabBadge gates on WORK_TABS, which already holds "pending" — so the
       queue carries a count and the three record tabs do not. One table
       decides that for every screen; this one does not get its own idea. */
    const b = tabBadge(t.id, t.label, REVIEW_COUNTS[t.id] || 0, "waiting");
    /* .tab-btn is the shared pill — glass.css frosts it and portal.css owns
       the badge. A screen-local class would have drifted from the other five
       within a release. */
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

/* THE NUMBER IS PRINTED, not just drawn.

   Measured: --gold on the glass card is 2.17:1, under the 3:1 WCAG asks of a
   graphic that carries meaning — and on this card the stars were the only
   thing carrying the score. Darkening the fill fixes the ratio (see
   .rev-row-stars in portal.css); printing "2/5" beside it removes the
   question, because the rating no longer depends on counting shapes or
   separating two golds. Same rule the rest of this portal follows: never
   signal state with colour alone. */
function reviewStarsRow(n){
  return `<span class="rev-row-stars" aria-label="${n} out of 5">` +
    [1,2,3,4,5].map(i=>`<svg viewBox="0 0 24 24" fill="${i<=n?"currentColor":"none"}"
      stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3
      5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>`).join("") +
    `<b class="rev-row-num" aria-hidden="true">${n}/5</b></span>`;
}

/* hold_reason is stored self-describing ("keyword: scam") so it reads
   correctly in the audit log and in a raw query. Under a heading that already
   says "keyword list" it would repeat itself, so the prefix is peeled off here
   and only here — the stored value is not weakened to suit one screen.

   The other shape it takes is "edited after rejection", which names no word;
   that one is printed as it stands. */
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
    /* An empty queue is good news and should read like it, not like a screen
       that failed to load. emptyState() is the shared one from orders.js. */
    host.innerHTML = f === "pending"
      ? emptyState("Nothing is waiting",
          "Reviews reach this queue only when the keyword list catches something in the wording.")
      : emptyState("No reviews match this view", "Try another tab or search term.");
    return;
  }

  /* One row per review, in the portal's standard table. The review text sits
     under the product in the same cell; hold / rejection notes follow it. */
  /* Sort (client-side: the whole filtered list is already loaded). Ties
     fall back to newest first so the order never looks random. */
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
    /* The evidence as it stands TODAY. A review whose order was later
       cancelled is not automatically wrong, but a moderator should not have
       to open another screen to find that out. */
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

/* Reject and unpublish ask for the reason BEFORE the request, so the refusal
   is not a round trip — the endpoint requires one either way.

   THE PORTAL'S openModal, NOT THE STOREFRONT'S. They share a name and take
   completely different arguments: this one is EbUI.openModal({title, body,
   confirmLabel, onConfirm}) and builds its own footer buttons; the storefront's
   is openModal(title, html, {onOpen}). A page carries one or the other, never
   both — the note on toast() in core/ui.js catalogues the same pair. */
function moderateReview(action, id, btn){
  if(action === "publish") return sendModeration(action, id, "", btn);

  const row = REVIEWS.find(r=>r.id === id);
  const what = action === "reject" ? "Reject this review" : "Unpublish this review";

  openModal({
    title: what,
    confirmLabel: what,
    /* Red, because both actions remove something a customer wrote. The
       colour is a warning, not the explanation — the body says what it does. */
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
        /* openModal's confirm handler does not close by itself, which is what
           makes refusing here possible without rebuilding the dialog. */
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
    /* Says what changed on the shop side too. Moderating a review moves a
       public average, and a moderator should see that happen rather than
       discover it later on the storefront. */
    toast(
      `${action === "publish" ? "Published" : action === "reject" ? "Rejected" : "Unpublished"}.` +
      (data.review_count
        ? ` That product now shows ${data.avg_rating.toFixed(1)} from ${data.review_count} review${data.review_count===1?"":"s"}.`
        : ` That product now shows no ratings.`),
      "ok"
    );
    await loadReviews();
    /* The queue badge in the sidebar and the notification list both count
       from server state, so they are refreshed rather than adjusted here. */
    if(typeof loadOpsData === "function") loadOpsData();
  }catch(err){
    restore();
    toast(err.message, "err");
  }
}

/* Shared button state — a second click while the first request is in flight
   is how one decision becomes two. */
function busyBtn(btn){
  const old = btn.textContent, wasDisabled = btn.disabled;
  btn.disabled = true; btn.textContent = "Working…";
  return ()=>{ btn.disabled = wasDisabled; btn.textContent = old; };
}

/* ============================================================
   Wiring. Called from engine.js init(), after module-loader.js has
   injected portal/views/reviews.html — the markup does not exist at
   DOMContentLoaded.

   THE SEARCH IS NOT ON data-refilters. That mechanism re-renders from
   data already in the browser on every keystroke, which is right for
   the screens that hold their rows client-side. This screen filters
   SERVER-side (the queue can outgrow what is worth shipping to the
   page), so every keystroke would be a request. Debounced instead.
   ============================================================ */
function initReviews(){
  const box = $("#rev-search");
  if(!box) return;
  let t = null;
  box.addEventListener("input", ()=>{
    clearTimeout(t);
    /* Long enough that typing a product name is one request, short enough
       that it still feels like search. */
    t = setTimeout(()=>{ if(reviewsLoaded || $("#mod-reviews")?.classList.contains("active")) loadReviews(); }, 300);
  });
}
