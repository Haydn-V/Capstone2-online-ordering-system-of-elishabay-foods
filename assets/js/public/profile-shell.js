/* =================================================================
   PROFILE SHELL — the sidebar and the auth gate, once
   -----------------------------------------------------------------
   WHY THIS FILE EXISTS

   Four pages live in public/profile/ and every one of them carried its own
   copy of the same three things:

     - the account sidebar: avatar, name, role tag, four nav links, sign out.
       Roughly forty lines of markup, repeated. Adding "Dash Board" to it meant
       editing it in three places and hoping.
     - the sign-in gate: show #mp-guard or #mp-content, wire the guard's own
       Sign In button, re-apply when the session changes.
     - the Payment Schemes link toggle, which is retailer-only.

   Three copies is how the "revealed link never re-hides" defect existed in
   three files at once, and it is the same duplicate-implementation drift
   REMEDIATION.md catalogues for the toast pair. One copy cannot drift.

   WHAT IT DOES NOT DO

   It owns the frame, not the contents. Each page still writes its own main
   panel: My Orders keeps its filter tabs and order cards, Payment Schemes its
   account table, My Profile its forms. This renders the sidebar into an empty
   <aside> and tells the page when it may draw.

   LOADED AS A CLASSIC SCRIPT, AFTER site.js — it uses `state`, `signOut()`
   and `whenAuthReady()` from there, and publishes EbProfileShell as a global
   the way core/index.js publishes EbApi and EbFormat. Both tags carry `defer`,
   which makes them run in document order.
   ================================================================= */
"use strict";

(function () {

  /* The nav, in one place. `key` is what a page passes to mount() to say which
     link is its own; `retailerOnly` is the Payment Schemes rule, which used to
     be a classList call repeated in three files. */
  const NAV = [
    {
      key: "dashboard", href: "dashboard.html", label: "Dashboard",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    },
    {
      key: "orders", href: "my-orders.html", label: "My Orders",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/></svg>',
    },
    {
      key: "payments", href: "my-payments.html", label: "Payment Schemes",
      retailerOnly: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
    },
    {
      /* Past orders and refunds, and every notification including read ones. */
      key: "history", href: "history.html", label: "History",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
    },
    {
      key: "profile", href: "profile.html", label: "My Profile",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    },
  ];

  const SIGNOUT_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>';

  const esc = v => EbFormat.escHtml(v == null ? "" : v);

  const initials = name => String(name || "")
    .split(" ").filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";

  function render(activeKey) {
    const host = document.getElementById("mp-sidebar");
    if (!host) return;

    const isRetailer = state.auth.status === "retailer";
    /* The tag was hardcoded per page — "CUSTOMER" on My Orders and "Retail
       Partner" on Payment Schemes — so the same person had two different
       labels depending on where they were standing. Derived from the status
       now, which is the thing that decides it. */
    const tag = isRetailer ? "Retail Partner" : "Customer";

    const links = NAV
      /* The retailer-only link is not rendered at all rather than rendered and
         hidden. A control that exists in the DOM behind a class is a control
         somebody can un-hide from the console; not building it is one less
         thing to be careful about. It is presentation either way —
         shop/my-payments.php refuses a non-retailer regardless. */
      .filter(item => !item.retailerOnly || isRetailer)
      .map(item => `
        <a href="${item.href}" class="mpas-link${item.key === activeKey ? " active" : ""}"
           ${item.key === activeKey ? 'aria-current="page"' : ""}>
          ${item.icon}${item.label}
        </a>`)
      .join("");

    /* The foot of the rail. Partly useful, partly structural: a sticky column
       that stops in mid-air reads as something that failed to load, and this
       is pushed to the bottom with margin-top:auto so the rail has an end.

       What it says depends on who is reading it. A retail partner has a person
       to call about terms; an ordinary customer wants the shop. */
    const foot = isRetailer
      ? `<span class="mpas-foot-label">Partner support</span>
         <p class="mpas-foot-body">
           Questions about your terms or a balance?<br>
           <a href="../index.html#contact">Contact the B2B team</a>
         </p>`
      : `<span class="mpas-foot-label">Elisha Bay</span>
         <p class="mpas-foot-body">
           Every mouthful is delightful.<br>
           <a href="../shop.html">Browse the shop</a>
         </p>`;

    host.innerHTML = `
      <div class="mpas-avatar">${esc(initials(state.auth.name))}</div>
      <div class="mpas-name">${esc(state.auth.name || "Your account")}</div>
      <div class="mpas-tag${isRetailer ? " mpas-tag-retailer" : ""}">${tag}</div>
      <nav class="mpas-nav">
        ${links}
        <button type="button" class="mpas-link mpas-signout" id="mpas-signout">
          ${SIGNOUT_ICON}Sign Out
        </button>
      </nav>
      <div class="mpas-foot">${foot}</div>`;

    wireSignout(host);
    /* Snapshot for the next account page: it paints this at once instead of
       a blank page while shop/me.php answers (see mount). */
    try { sessionStorage.setItem(SNAP_KEY, host.innerHTML); } catch (_) {}
  }

  const SNAP_KEY = "eb-acct-sidebar";
  function wireSignout(host) {
    host.querySelector("#mpas-signout")?.addEventListener("click", () => {
      try { sessionStorage.removeItem(SNAP_KEY); } catch (_) {}
      signOut();
      window.location.href = "../index.html";
    });
  }

  /**
   * Mount the shell on an account page.
   *
   * @param {object} opts
   * @param {string} opts.page      which NAV key is this page
   * @param {function} opts.onReady called when the server confirms a session,
   *                                and again if one begins later. The page
   *                                draws its own content here.
   * @param {function} [opts.onSignedOut]
   */
  function mount(opts) {
    const activeKey = opts.page;
    const guard   = () => document.getElementById("mp-guard");
    const content = () => document.getElementById("mp-content");

    /* `applied` stops a repeated announcement of the SAME state re-running the
       page's fetches. bootstrapCustomer() and the load handler below can both
       arrive at "signed in" within a few milliseconds of each other. */
    let applied = null;

    /* Optimistic first paint. If the previous account page was signed in,
       show the page and its sidebar now (active link moved to this page),
       and let the server's answer below confirm or take it back. This is
       what removes the blank-then-pop on every page change. */
    try {
      const snap = sessionStorage.getItem(SNAP_KEY);
      const host = document.getElementById("mp-sidebar");
      if (snap && host && content()) {
        host.innerHTML = snap;
        const href = (NAV.find(n => n.key === activeKey) || {}).href;
        host.querySelectorAll(".mpas-link").forEach(a => {
          const on = a.getAttribute("href") === href;
          a.classList.toggle("active", on);
          on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
        });
        wireSignout(host);
        if (guard()) guard().style.display = "none";
        content().style.display = "block";
      }
    } catch (_) {}

    const apply = (loggedIn) => {
      if (!loggedIn) { try { sessionStorage.removeItem(SNAP_KEY); } catch (_) {} }
      if (guard())   { guard().style.display   = loggedIn ? "none" : "block"; }
      if (content()) { content().style.display = loggedIn ? "block" : "none"; }

      if (applied === loggedIn) {
        /* Same state, but the sidebar may still need redrawing: a status that
           arrived after the first paint changes the tag and the Payment
           Schemes link. Cheap, and it is the fix for the link that was
           revealed once and never re-hidden. */
        if (loggedIn) render(activeKey);
        return;
      }
      applied = loggedIn;

      if (loggedIn) {
        render(activeKey);
        if (typeof opts.onReady === "function") opts.onReady();
      } else if (typeof opts.onSignedOut === "function") {
        opts.onSignedOut();
      }
    };

    /* Waits for the SERVER's answer, never for a flag.

       state.auth.loggedIn is fail-closed `false` until shop/me.php replies
       (D8), and sampling it once at load is the defect that showed a signed-in
       customer the "please sign in" panel over their own order history. */
    const check = async () => {
      if (typeof state === "undefined" || typeof whenAuthReady !== "function") {
        setTimeout(check, 50);
        return;
      }
      apply(await whenAuthReady());
    };
    check();

    /* And again whenever it changes. eb:auth-ready fires once per page load;
       this is what makes the guard panel's own Sign In button work, and what
       clears the page when somebody signs out without navigating. */
    window.addEventListener("eb:auth-changed", e => apply(e.detail.loggedIn));

    document.getElementById("guard-login-btn")
      ?.addEventListener("click", () => openLogin());
  }

  window.EbProfileShell = { mount, render, NAV };
})();
