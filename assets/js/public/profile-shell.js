/* ===== PROFILE SHELL: the account sidebar, sign-in gate and retailer-only link for the four profile pages, in one place; loaded after site.js ===== */
"use strict";

(function () {

  /* The nav links; key marks the current page, retailerOnly marks Payment Schemes. */
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
    /* The account tag comes from the customer's status. */
    const tag = isRetailer ? "Retail Partner" : "Customer";

    const links = NAV
      /* The retailer-only link is not rendered at all for others (the server refuses them anyway). */
      .filter(item => !item.retailerOnly || isRetailer)
      .map(item => `
        <a href="${item.href}" class="mpas-link${item.key === activeKey ? " active" : ""}"
           ${item.key === activeKey ? 'aria-current="page"' : ""}>
          ${item.icon}${item.label}
        </a>`)
      .join("");

    /* Sidebar footer pushed to the bottom, with content depending on retailer or customer. */
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
    centerActive(host);
    /* Snapshot so the next account page paints immediately. */
    try { sessionStorage.setItem(SNAP_KEY, host.innerHTML); } catch (_) {}
  }

  /* On phones, scroll the current page's tab into view. */
  function centerActive(host) {
    const a = host.querySelector(".mpas-link.active");
    const row = host.querySelector(".mpas-nav");
    if (!a || !row || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2;
  }

  const SNAP_KEY = "eb-acct-sidebar";
  function wireSignout(host) {
    host.querySelector("#mpas-signout")?.addEventListener("click", () => {
      try { sessionStorage.removeItem(SNAP_KEY); } catch (_) {}
      signOut();
      window.location.href = "../index.html";
    });
  }

  /** Mount the shell on an account page; onReady runs when a session is confirmed (and again if one starts later). */
  function mount(opts) {
    const activeKey = opts.page;
    const guard   = () => document.getElementById("mp-guard");
    const content = () => document.getElementById("mp-content");

    /* Do not re-run the page's fetches for a repeated identical state. */
    let applied = null;

    /* Optimistic first paint from the snapshot, confirmed or undone by the server's answer. */
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
        centerActive(host);
      }
    } catch (_) {}

    const apply = (loggedIn) => {
      if (!loggedIn) { try { sessionStorage.removeItem(SNAP_KEY); } catch (_) {} }
      if (guard())   { guard().style.display   = loggedIn ? "none" : "block"; }
      if (content()) { content().style.display = loggedIn ? "block" : "none"; }

      if (applied === loggedIn) {
        /* Redraw the sidebar if the status changed after first paint. */
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

    /* Wait for the server's answer, never a one-time flag check. */
    const check = async () => {
      if (typeof state === "undefined" || typeof whenAuthReady !== "function") {
        setTimeout(check, 50);
        return;
      }
      apply(await whenAuthReady());
    };
    check();

    /* Re-apply whenever the auth state changes (sign in from the guard, or sign out). */
    window.addEventListener("eb:auth-changed", e => apply(e.detail.loggedIn));

    document.getElementById("guard-login-btn")
      ?.addEventListener("click", () => openLogin());
  }

  window.EbProfileShell = { mount, render, NAV };
})();
