/* ===== THEME: Light, Dark or System (default, follows the device), stored in localStorage["eb-theme"]; loaded non-deferred in <head> to avoid a white flash, and fires eb-theme-change so charts can redraw ===== */
(function () {
  const KEY = "eb-theme";
  /* Inside the admin preview iframe, follow the top window's device setting. */
  const host = (() => { try { return window.top.matchMedia ? window.top : window; } catch (_) { return window; } })();
  const media = host.matchMedia ? host.matchMedia("(prefers-color-scheme: dark)") : null;

  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" || v === "system" ? v : "system";
    } catch (_) { return "system"; }
  };
  let pref = read();

  const resolved = () => pref === "system" ? (media && media.matches ? "dark" : "light") : pref;

  function apply() {
    const t = resolved();
    const root = document.documentElement;
    const changed = root.getAttribute("data-theme") !== t;
    root.setAttribute("data-theme", t);
    root.style.colorScheme = t;   /* native scrollbars / form controls match */
    if (changed) window.dispatchEvent(new CustomEvent("eb-theme-change", { detail: { theme: t, pref } }));
  }

  function set(p) {
    pref = p;
    try { localStorage.setItem(KEY, p); } catch (_) {}
    apply();
    syncMenu();
  }

  apply();
  if (media) {
    const onOS = () => { if (pref === "system") apply(); };
    media.addEventListener ? media.addEventListener("change", onOS) : media.addListener(onOS);
  }

  /* ---------- the dropdown ---------- */
  const OPTIONS = [
    { v: "light",  label: "Light",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>' },
    { v: "dark",   label: "Dark",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' },
    { v: "system", label: "System default",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>' },
  ];

  let menu = null, openBtn = null;

  function css() {
    if (document.getElementById("eb-theme-css")) return;
    const s = document.createElement("style");
    s.id = "eb-theme-css";
    s.textContent = `
      .eb-theme-menu{position:fixed;z-index:10000;min-width:180px;padding:6px;border-radius:14px;
        background:var(--glass-bg-overlay,var(--surface,#fff));-webkit-backdrop-filter:var(--glass-blur-lg,none);backdrop-filter:var(--glass-blur-lg,none);color:var(--text,#1e1a0e);border:1px solid var(--glass-border,var(--border,rgba(0,0,0,.1)));
        box-shadow:0 12px 32px rgba(0,0,0,.18);font-family:inherit;animation:ebThemeIn .14s ease-out}
      @keyframes ebThemeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
      .eb-theme-opt{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:10px;
        background:none;color:inherit;font:inherit;font-size:.88rem;font-weight:600;text-align:left;cursor:pointer}
      .eb-theme-opt svg{width:17px;height:17px;flex:none;opacity:.8}
      .eb-theme-opt:hover,.eb-theme-opt:focus-visible{background:var(--gold-dim,rgba(232,163,23,.14));outline:none}
      .eb-theme-opt[aria-checked="true"]{color:var(--gold-ink,var(--gold,#b87800))}
      .eb-theme-opt .eb-check{margin-left:auto;opacity:0}
      .eb-theme-opt[aria-checked="true"] .eb-check{opacity:1}
      .eb-theme-note{padding:4px 10px 6px;font-size:.72rem;color:var(--text-muted,#777)}
      @media (prefers-reduced-motion:reduce){.eb-theme-menu{animation:none}}`;
    document.head.appendChild(s);
  }

  function syncMenu() {
    if (!menu) return;
    menu.querySelectorAll(".eb-theme-opt").forEach(b =>
      b.setAttribute("aria-checked", String(b.dataset.v === pref)));
    const note = menu.querySelector(".eb-theme-note");
    if (note) note.textContent = pref === "system"
      ? `Following your device (${resolved()})`
      : "";
  }

  function close() {
    if (!menu) return;
    menu.remove(); menu = null;
    if (openBtn) { openBtn.setAttribute("aria-expanded", "false"); openBtn.focus({ preventScroll: true }); }
    openBtn = null;
  }

  function open(btn) {
    css();
    menu = document.createElement("div");
    menu.className = "eb-theme-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Theme");
    menu.innerHTML = OPTIONS.map(o => `
      <button type="button" class="eb-theme-opt" role="menuitemradio" data-v="${o.v}">
        ${o.icon}<span>${o.label}</span>
        <svg class="eb-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><path d="M20 6 9 17l-5-5"/></svg>
      </button>`).join("") + `<div class="eb-theme-note"></div>`;
    document.body.appendChild(menu);

    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top  = Math.round(r.bottom + 8) + "px";
    menu.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + "px";

    openBtn = btn;
    btn.setAttribute("aria-expanded", "true");
    syncMenu();
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector(".eb-theme-opt")).focus({ preventScroll: true });

    menu.addEventListener("click", e => {
      const b = e.target.closest(".eb-theme-opt");
      if (!b) return;
      set(b.dataset.v);
      close();
    });
    menu.addEventListener("keydown", e => {
      const items = [...menu.querySelectorAll(".eb-theme-opt")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp")   { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
  }

  document.addEventListener("click", e => {
    const btn = e.target.closest("#theme-btn");
    if (btn) {
      e.preventDefault();
      const same = menu && openBtn === btn;
      close();
      if (!same) {
        btn.setAttribute("aria-haspopup", "menu");
        open(btn);
      }
      return;
    }
    if (menu && !menu.contains(e.target)) close();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && menu) close(); });
  window.addEventListener("resize", close);
  window.addEventListener("scroll", () => { if (menu) close(); }, { passive: true });

  window.EbTheme = { get: () => pref, resolved, set };
})();

/* Required-field marker: wrap " *" in .req-star (red), and add a star to labels of required controls, including forms added later. */
(function () {
  const css = document.createElement("style");
  css.textContent = ".req-star{color:#d62828 !important;font-weight:700;margin-left:2px}";
  document.head.appendChild(css);

  const star = () => { const s = document.createElement("span"); s.className = "req-star"; s.textContent = "*"; s.setAttribute("aria-hidden", "true"); return s; };

  function mark(el) {
    if (el.dataset.reqDone) return;
    el.dataset.reqDone = "1";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let found = false, n;
    const hits = [];
    while ((n = walker.nextNode())) if (/\s\*\s*$|^\s*\*\s*$|\s\*\s/.test(n.nodeValue)) hits.push(n);
    hits.forEach(t => {
      const i = t.nodeValue.lastIndexOf("*");
      const after = t.splitText(i);
      after.nodeValue = after.nodeValue.slice(1);
      t.nodeValue = t.nodeValue.replace(/\s+$/, "");
      t.parentNode.insertBefore(star(), after);
      found = true;
    });
    if (found || el.tagName !== "LABEL") return;
    const id = el.getAttribute("for");
    const ctl = id ? document.getElementById(id) : el.querySelector("input,select,textarea");
    if (ctl && ctl.type !== "checkbox" && ctl.type !== "radio" && (ctl.required || ctl.getAttribute("aria-required") === "true"))
      el.appendChild(star());
  }
  const scan = root => root.querySelectorAll && root.querySelectorAll("label:not([data-req-done]),legend:not([data-req-done])").forEach(mark);
  const start = () => {
    scan(document.body);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(nd => { if (nd.nodeType === 1) { if (/^(LABEL|LEGEND)$/.test(nd.tagName)) mark(nd); scan(nd); } })))
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();

/* Preview iframe: hide the account and cart controls before first paint. */
(function () {
  try {
    const on = new URLSearchParams(location.search).get("preview") === "1"
      || (window.name.split("|")[0] === "eb-preview" && window.top !== window);
    if (!on) return;
    document.documentElement.classList.add("eb-preview");
    const css = document.createElement("style");
    css.textContent = "html.eb-preview #account-slot,html.eb-preview #cart-btn,html.eb-preview #cart-btn-mob,html.eb-preview #login-btn{display:none !important}";
    document.head.appendChild(css);
  } catch (_) {}
})();

/* Hidden scrollbars on every page (scrolling still works), so pages never jump when a modal locks scrolling. */
(function () {
  const css = document.createElement("style");
  css.textContent = `
    * { scrollbar-width: none; }
    ::-webkit-scrollbar { display: none; width: 0; height: 0; }`;
  document.head.appendChild(css);
})();

/* Textareas have no drag handle and grow with their text up to a cap (field-sizing: content where supported). */
(function () {
  const MAX = 200;
  const css = document.createElement("style");
  css.textContent = `
    textarea {
      resize: none !important;
      /* field-sizing: content sizes the WIDTH to the text too — one long
         unbroken word ("wwww…") widened the box past its form. Width is the
         container's; long words break onto the next line instead. */
      width: 100%;
      max-width: 100% !important;
      overflow-wrap: anywhere;
      word-break: break-word;
      box-sizing: border-box;
      min-height: 72px;
      max-height: ${MAX}px !important;
      overflow-y: auto;
      field-sizing: content;
    }`;
  document.head.appendChild(css);

  const native = window.CSS && CSS.supports && CSS.supports("field-sizing", "content");
  if (native) return;
  const fit = t => {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, MAX) + "px";
  };
  document.addEventListener("input", e => { if (e.target.tagName === "TEXTAREA") fit(e.target); });
  document.addEventListener("focusin", e => { if (e.target.tagName === "TEXTAREA") fit(e.target); });
})();
