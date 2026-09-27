/* =================================================================
   ORDER TRACKING DROPDOWN — shared by Dashboard and My Orders
   -----------------------------------------------------------------
   Clicking an order number drops its tracking open underneath it.
   One at a time: opening another order closes the one already open,
   and clicking the open one again closes it.

   The steps arrive decided by the server (Orders::trackingSteps in
   api/core/Orders.php); this only draws them, using the .db-steps
   stepper from profile.css.

   Markup contract, inside the root passed to bind():
     <button data-track="ORDER-ID" aria-expanded="false">…</button>
     <div class="ot-drop" data-track-panel="ORDER-ID"><div class="ot-drop-inner"></div></div>

   Needs core/index.js (EbFormat).
   ================================================================= */
(function () {
  const esc  = v => EbFormat.escHtml(v == null ? "" : v);

  const STEP_LABEL = {
    pending: "Placed", accepted: "Accepted", shipping: "Shipping",
    delivered: "Delivered", completed: "Completed",
  };

  /* What the customer should know about where the order is now. */
  const STATUS_NOTE = {
    pending:   "We have your order and will confirm it shortly.",
    accepted:  "Your order is confirmed and being prepared.",
    shipping:  "Your order is on its way.",
    delivered: "Your order has been delivered.",
    completed: "This order is complete. Thank you!",
  };

  /** The dropdown's contents for one order. */
  function html(o) {
    const cancelled = o.status === "cancelled";
    const held = o.held || o.status === "on-hold";
    const steps = (o.steps || []).map(s => `
      <li class="db-step${s.done ? " is-done" : ""}${s.now ? " is-now" : ""}">
        <span class="db-step-dot" aria-hidden="true"></span>
        <span class="db-step-label">${esc(STEP_LABEL[s.key] || s.key)}</span>
      </li>`).join("");

    return `
      <div class="ot-body">
        <div class="ot-title">Order Tracking</div>
        ${cancelled ? "" : `<ol class="db-steps">${steps}</ol>`}
        ${cancelled ? `
          <div class="db-note db-note-warn">
            This order was <strong>cancelled</strong>.${o.cancelReason ? `<br><small>Reason: ${esc(o.cancelReason)}</small>` : ""}
          </div>` : held ? `
          <div class="db-note db-note-warn">
            This order is <strong>on hold</strong>. Our team will contact you — it has not been cancelled.
          </div>` : STATUS_NOTE[o.status] ? `
          <div class="db-note">${STATUS_NOTE[o.status]}</div>` : ""}
        ${o.trackingNumber ? `
          <div class="db-note">
            <strong>Tracking number:</strong> <span class="mono">${esc(o.trackingNumber)}</span><br>
            <small>Track it on your courier's own site — we do not read updates from their system.</small>
          </div>` : ""}
      </div>`;
  }

  function setOpen(btn, panel, open) {
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("is-open", open);
    panel.classList.toggle("is-open", open);
  }

  /**
   * Wire every [data-track] button under `root`.
   * @param {Element} root
   * @param {(id:string) => object|undefined} findOrder
   */
  function bind(root, findOrder) {
    root.querySelectorAll("[data-track]").forEach(btn => {
      const id = btn.dataset.track;
      const panel = root.querySelector(`[data-track-panel="${CSS.escape(id)}"]`);
      if (!panel) return;
      btn.setAttribute("aria-expanded", "false");
      btn.addEventListener("click", () => {
        const opening = !panel.classList.contains("is-open");
        /* One open at a time. */
        root.querySelectorAll("[data-track].is-open").forEach(other => {
          const p = root.querySelector(`[data-track-panel="${CSS.escape(other.dataset.track)}"]`);
          if (p) setOpen(other, p, false);
        });
        if (!opening) return;
        const inner = panel.querySelector(".ot-drop-inner") || panel;
        inner.innerHTML = html(findOrder(id) || {});
        setOpen(btn, panel, true);
      });
    });
  }

  window.EbOrderTrack = { bind, html };
})();
