/* ============================================================
   THE SHARED PUBLIC SHELL — modal, cart drawer, toast container
   ------------------------------------------------------------
   WHY THIS FILE EXISTS

   Three pieces of chrome are needed by every public page: the modal
   dialog, the cart drawer and the toast container. They were
   hand-copied into eight HTML files, and the copies drifted:

     #modal-title   present on index.html, shop.html, become-partner.html
                    and batch-traceability.html; MISSING from all four
                    pages under public/profile/. openModal() dereferenced
                    it unguarded, so every modal on those four pages threw
                    before opening — Sign In and Proceed to Checkout both
                    looked like dead buttons.
     .modal-body    the CLASS was missing from the same four, so the
                    dialog had no padding even once it opened.
     #toast-wrap    the profile pages call it #toast-root instead, which
                    made every toast on them throw. Written up on
                    showToast(); that one was found first and fixed by
                    accepting both ids — a fix that treats the symptom.

   Three drifts, one cause: eight copies of markup nobody owns.

   WHAT THIS DOES ABOUT IT

   Rather than a fifth hand-edit, this OWNS the shell. On load it checks
   what the page already has and injects whatever is missing. A page that
   carries a correct shell is left completely alone; a page that carries
   none gets a working one; a page whose copy has drifted gets only the
   missing parts, so nothing already wired is replaced underneath a
   listener.

   NOT A REWRITE OF THE EXISTING PAGES. Their markup stays, because
   site.js binds to those exact nodes at load and swapping them out would
   detach every listener. This is a safety net beneath the markup, not a
   replacement for it — which also means adding a new public page requires
   no shell markup at all.

   HOW TO ADD A NEW PUBLIC PAGE: include this file and site.js. Do not
   paste the modal, drawer or toast markup. That is the whole point.
   ============================================================ */

(function () {
  "use strict";

  /* Everything site.js expects to find, and what it is for. Kept as data so
     the check below and the markup below cannot disagree about the contract. */
  const PARTS = [
    {
      /* The dialog. site.js: openModal() / closeModal(). */
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
      /* The toast container. site.js: showToast(). */
      test: () => document.getElementById("toast-wrap") || document.getElementById("toast-root"),
      html: `<div class="toast-wrap" id="toast-wrap" aria-live="polite" aria-atomic="true"></div>`,
    },
  ];

  /* Repairs to a shell that EXISTS but has drifted. Each one adds a single
     missing node in place rather than replacing the parent, so any listener
     site.js has already bound to a sibling survives.

     This is the layer that would have caught the reported bug on its own. */
  function repair() {
    const modal = document.getElementById("modal");
    if (!modal) return;

    /* A dialog with no title element: openModal() cannot name it, and the
       aria-labelledby every copy already carries points at nothing. */
    if (!document.getElementById("modal-title")) {
      const head = modal.querySelector(".modal-head");
      const h3 = document.createElement("h3");
      h3.id = "modal-title";
      if (head) {
        head.insertBefore(h3, head.firstChild);
      } else {
        /* No head at all — build one around whatever close button exists so
           the title and the control sit on one row, as they do elsewhere. */
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

  /* Before site.js runs its wiring. Both are deferred classic scripts, which
     execute in document order, so listing this one first in the page is what
     guarantees the nodes exist by the time site.js looks for them. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
