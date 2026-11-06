/* ===== Shared public shell: makes sure every public page has the modal, cart drawer and toast container, injecting or repairing only what is missing (new pages just include this file and site.js) ===== */

(function () {
  "use strict";

  /* The shell elements site.js expects, kept as data. */
  const PARTS = [
    {
      /* The dialog (openModal()/closeModal()). */
      test: () => document.getElementById("modal-scrim"),
      html: `
<div class="modal-scrim" id="modal-scrim">
  <div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-head">
      <h3 id="modal-title"></h3>
      <button class="modal-close" id="modal-close" aria-label="Close dialog">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="butt" stroke-linejoin="round" width="20" height="20">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>`,
    },
    {
      /* The toast container (showToast()). */
      test: () => document.getElementById("toast-wrap") || document.getElementById("toast-root"),
      html: `<div class="toast-wrap" id="toast-wrap" aria-live="polite" aria-atomic="true"></div>`,
    },
  ];

  /* Repair a drifted shell by adding single missing nodes, so existing listeners survive. */
  function repair() {
    const modal = document.getElementById("modal");
    if (!modal) return;

    /* Add a missing modal title. */
    if (!document.getElementById("modal-title")) {
      const head = modal.querySelector(".modal-head");
      const h3 = document.createElement("h3");
      h3.id = "modal-title";
      if (head) {
        head.insertBefore(h3, head.firstChild);
      } else {
        /* No head at all: build one around the close button. */
        const wrap = document.createElement("div");
        wrap.className = "modal-head";
        wrap.appendChild(h3);
        const close = document.getElementById("modal-close");
        if (close) wrap.appendChild(close);
        modal.insertBefore(wrap, modal.firstChild);
      }
      console.warn("[shell] #modal-title was missing and has been injected — fix the page markup.");
    }

    /* The class, not the id: .modal-body carries the dialog's padding. */
    const body = document.getElementById("modal-body");
    if (body && !body.classList.contains("modal-body")) {
      body.classList.add("modal-body");
    }

    /* role="dialog" with no accessible name. */
    if (!modal.getAttribute("aria-labelledby") && document.getElementById("modal-title")) {
      modal.setAttribute("aria-labelledby", "modal-title");
    }
  }

  function install() {
    PARTS.forEach(part => {
      if (part.test()) return;
      const holder = document.createElement("div");
      holder.innerHTML = part.html.trim();
      while (holder.firstChild) document.body.appendChild(holder.firstChild);
    });
    repair();
  }

  /* Runs before site.js (both deferred, in document order) so the nodes exist when site.js looks. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
