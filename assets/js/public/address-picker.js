/* ===== EbAddress: one Philippine address picker (Region, Province, City/Municipality, Barangay, then street and ZIP) for checkout, sign-up, the retailer form and Profile; posts PSGC codes that api/core/Address.php verifies, clears children when a parent changes, and falls back to a free-text box until the location data is loaded ===== */
(function () {
  "use strict";

  /* Cache each fetched list (as a promise) for the page's life, so identical requests are shared. */
  const cache = new Map();

  function fetchLevel(level, parent) {
    const key = level + ":" + (parent || "");
    if (!cache.has(key)) {
      const p = EbApi.get("locations/list.php", parent ? { level, parent } : { level })
        .then(({ data, meta }) => ({ rows: data || [], loaded: !meta || meta.loaded !== false }))
        .catch(err => { cache.delete(key); throw err; });   /* a failure is not cached */
      cache.set(key, p);
    }
    return cache.get(key);
  }

  /* Map each level name to the endpoint's plural. */
  const API_LEVEL = { region: "regions", province: "provinces", city: "cities", barangay: "barangays" };

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const ICON = {
    pin:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    home:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    mail:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  };

  /* Dropdown levels in cascade order, with short placeholders so two fit side by side. */
  const LEVELS = [
    { key: "region",   label: "Region",               placeholder: "Choose a region",    waiting: "Choose a region",  loading: "Loading regions…" },
    { key: "province", label: "Province",             placeholder: "Choose a province",  waiting: "Region first",     loading: "Loading provinces…" },
    { key: "city",     label: "City / Municipality",  placeholder: "Choose a city",      waiting: "Province first",   loading: "Loading cities…" },
    { key: "barangay", label: "Barangay",             placeholder: "Choose a barangay",  waiting: "City first",       loading: "Loading barangays…" },
  ];

  /* Markup for two host styles ("field" and "auth"), with ids ${prefix}-addr-<part> so server errors land on the right field. */
  function markup(prefix, opts) {
    const o = Object.assign({ variant: "field", required: false }, opts || {});
    /* Required stars follow the same three modes as validate(). */
    const reqLoc  = o.required ? " *" : "";
    const reqFull = o.required === true ? " *" : "";
    const auth = o.variant === "auth";
    const id = part => `${prefix}-addr-${part}`;

    const wrap = (part, label, control, icon, extraClass) => auth
      ? `<div class="auth-field addr-cell addr-${part}${extraClass || ""}" data-addr-field="${part}">
           <label for="${id(part)}">${label}${part === "street" || part === "zip" ? reqFull : reqLoc}</label>
           <div class="auth-input-group">
             <span class="auth-input-icon" aria-hidden="true">${icon}</span>
             ${control}
           </div>
           <span class="field-error" data-err></span>
         </div>`
      : `<div class="field addr-cell addr-${part}${extraClass || ""}" data-addr-field="${part}">
           <label for="${id(part)}">${label}${part === "street" || part === "zip" ? reqFull : reqLoc}</label>
           ${control}
           <span class="field-error" data-err></span>
         </div>`;

    const cls = auth ? "auth-input" : "control";

    const selects = LEVELS.map(L => wrap(
      L.key, L.label,
      `<select class="${cls}" id="${id(L.key)}" disabled ${o.required ? 'aria-required="true"' : ""}>
         <option value="">${esc(L.waiting)}</option>
       </select>`,
      ICON.pin
    )).join("");

    const street = wrap("street", "House no. and street",
      `<input class="${cls}" id="${id("street")}" type="text" maxlength="160"
              placeholder="e.g. 148 Rizal Street" autocomplete="address-line1"
              ${o.required === true ? 'aria-required="true"' : ""}/>`,
      ICON.home);

    const zip = wrap("zip", "ZIP code",
      `<input class="${cls}" id="${id("zip")}" type="text" inputmode="numeric" maxlength="4"
              pattern="[0-9]{4}" placeholder="2400" autocomplete="postal-code"
              ${o.required === true ? 'aria-required="true"' : ""}/>`,
      ICON.mail);

    /* The fallback box is rendered up front and shown by toggling a class. */
    const legacy = wrap("line", "Full address",
      `<textarea class="${cls}${auth ? " auth-textarea" : ""}" id="${id("line")}" rows="2" maxlength="300"
                 placeholder="House no., street, barangay, city, province, ZIP"
                 autocomplete="street-address"></textarea>`,
      ICON.pin, " addr-legacy");

    return `<div class="addr-picker addr-picker--${auth ? "auth" : "field"}" id="${prefix}-addr" data-addr-prefix="${prefix}">
      ${selects}${street}${zip}${legacy}
      <p class="addr-status" id="${prefix}-addr-status" aria-live="polite"></p>
    </div>`;
  }

  /* Behaviour. */
  function mount(root, prefix) {
    const $ = part => root.querySelector(`#${prefix}-addr-${part}`);
    const box = root.querySelector(`#${prefix}-addr`);
    if (!box) {
      console.warn("[EbAddress] no picker markup for", prefix);
      return null;
    }

    const sel = {};
    LEVELS.forEach(L => { sel[L.key] = $(L.key); });
    const street = $("street");
    const zip    = $("zip");
    const line   = $("line");
    const status = root.querySelector(`#${prefix}-addr-status`);

    /* Increments on every user change, so a slow prefill stops instead of overwriting the user's choice. */
    let generation = 0;
    /* One ticket per level; only the latest response applies. */
    const ticket = { region: 0, province: 0, city: 0, barangay: 0 };
    let legacyMode = false;

    const sync = s => { if (window.EbSelect) EbSelect.sync(s); };

    function setOptions(level, rows, placeholder) {
      const s = sel[level];
      s.innerHTML = `<option value="">${esc(placeholder)}</option>` + rows.map(r => {
        /* Manila barangays show their district ("Barangay 105 · Tondo I"). */
        const label = r.district ? `${r.name} · ${r.district}` : r.name;
        return `<option value="${esc(r.code)}" data-kind="${esc(r.kind || "")}">${esc(label)}</option>`;
      }).join("");
      s.disabled = rows.length === 0;
      sync(s);
    }

    /* Empty and disabled, saying what it is waiting for. */
    function reset(level) {
      const L = LEVELS.find(x => x.key === level);
      const s = sel[level];
      ticket[level]++;                         /* orphan any fetch in flight */
      s.innerHTML = `<option value="">${esc(L.waiting)}</option>`;
      s.disabled = true;
      s.classList.remove("is-prefilled");
      s.closest("[data-addr-field]")?.removeAttribute("aria-busy");
      sync(s);
    }

    function resetBelow(level) {
      const i = LEVELS.findIndex(x => x.key === level);
      LEVELS.slice(i + 1).forEach(L => reset(L.key));
    }

    /* Fetch a level's list into its select; true if applied, false if superseded. */
    async function load(level, parent) {
      const L = LEVELS.find(x => x.key === level);
      const s = sel[level];
      const mine = ++ticket[level];
      const cell = s.closest("[data-addr-field]");

      s.innerHTML = `<option value="">${esc(L.loading)}</option>`;
      s.disabled = true;
      cell?.setAttribute("aria-busy", "true");
      sync(s);

      let res;
      try {
        res = await fetchLevel(API_LEVEL[level], parent);
      } catch (err) {
        if (mine !== ticket[level]) return false;
        cell?.removeAttribute("aria-busy");
        s.innerHTML = `<option value="">Could not load — try again</option>`;
        s.disabled = true;
        sync(s);
        setStatus(`Could not load the ${L.label.toLowerCase()} list: ${err.message}`);
        return false;
      }
      if (mine !== ticket[level]) return false;     /* a newer choice won */
      cell?.removeAttribute("aria-busy");

      if (level === "region" && !res.loaded) {
        enterLegacy();
        return false;
      }
      setOptions(level, res.rows, L.placeholder);
      setStatus("");
      return true;
    }

    function setStatus(msg) { if (status) status.textContent = msg; }

    /* No location data on this server yet: show the one box, hide the rest. */
    function enterLegacy() {
      legacyMode = true;
      box.classList.add("is-legacy");
      setStatus("");
    }

    /* A province entry that is really a city fills the City step with that city. */
    function fillIndependentCity(opt) {
      const s = sel.city;
      ticket.city++;
      s.innerHTML = `<option value="${esc(opt.value)}" data-kind="city" selected>${esc(opt.textContent)}</option>`;
      s.disabled = false;
      sync(s);
    }

    /* ---------------- the person's own changes ---------------- */

    sel.region.addEventListener("change", () => {
      generation++;
      unmark(sel.region);
      resetBelow("region");
      if (sel.region.value) load("province", sel.region.value);
    });

    sel.province.addEventListener("change", async () => {
      generation++;
      unmark(sel.province);
      resetBelow("province");
      const opt = sel.province.selectedOptions[0];
      if (!sel.province.value) return;
      if (opt && opt.dataset.kind === "city") {
        fillIndependentCity(opt);
        await load("barangay", opt.value);
      } else {
        await load("city", sel.province.value);
      }
    });

    sel.city.addEventListener("change", () => {
      generation++;
      unmark(sel.city);
      resetBelow("city");
      if (sel.city.value) load("barangay", sel.city.value);
    });

    sel.barangay.addEventListener("change", () => { generation++; unmark(sel.barangay); });

    [street, zip, line].forEach(el => el && el.addEventListener("input", () => unmark(el)));

    /* ZIP keeps only digits (four in the Philippines). */
    zip.addEventListener("input", () => {
      const v = zip.value.replace(/\D/g, "").slice(0, 4);
      if (v !== zip.value) zip.value = v;
    });

    function unmark(el) {
      el.classList.remove("is-prefilled");
      clearError(el.closest("[data-addr-field]"));
    }

    /* ---------------- errors ---------------- */

    function clearError(cell) {
      if (!cell) return;
      cell.classList.remove("has-error");
      const e = cell.querySelector("[data-err]");
      if (e) e.textContent = "";
    }

    function clearErrors() {
      box.querySelectorAll("[data-addr-field]").forEach(clearError);
    }

    /* Show server errors keyed addr_*; returns true if any belonged to this picker. */
    function showErrors(fields) {
      let any = false;
      Object.entries(fields || {}).forEach(([k, msg]) => {
        const m = /^addr_(\w+)$/.exec(k);
        if (!m) return;
        const cell = box.querySelector(`[data-addr-field="${m[1]}"]`);
        if (!cell) return;
        cell.classList.add("has-error");
        const e = cell.querySelector("[data-err]");
        if (e) e.textContent = msg;
        any = true;
      });
      if (any) {
        /* Focus the first field in error (EbSelect's trigger, or the native select on touch). */
        const cell = box.querySelector("[data-addr-field].has-error");
        (cell?.querySelector(".ebs-trigger:not([disabled])")
          || cell?.querySelector("select:not([disabled]), input, textarea"))?.focus();
      }
      return any;
    }

    /* ---------------- reading it out ---------------- */

    function value() {
      if (legacyMode) return { line: line.value.trim() };
      return {
        region:   sel.region.value,
        province: sel.province.value,
        city:     sel.city.value,
        barangay: sel.barangay.value,
        street:   street.value.trim(),
        zip:      zip.value.trim(),
      };
    }

    /* Nothing chosen or typed at all. */
    function isEmpty() {
      const v = value();
      return legacyMode ? !v.line : !(v.region || v.street || v.zip);
    }

    /* Client-side check mirroring Address::check (true = everything, "location" = region to barangay, false = optional but finish what you start); returns true when the form may submit. */
    function validate(required) {
      clearErrors();
      if (required === false && isEmpty()) return true;
      const full = required === true;
      const v = value();
      const errs = {};
      if (legacyMode) {
        if (!v.line) errs.addr_line = "Enter your full address.";
      } else {
        if (!v.region)   errs.addr_region   = "Choose your region.";
        else if (!v.province) errs.addr_province = "Choose your province.";
        else if (!v.city)     errs.addr_city     = "Choose your city or municipality.";
        else if (!v.barangay) errs.addr_barangay = "Choose your barangay.";
        if (full && !v.street) errs.addr_street = "Enter your house number and street.";
        if (full && !v.zip)    errs.addr_zip    = "Enter the 4-digit ZIP code.";
        else if (v.zip && !/^\d{4}$/.test(v.zip)) errs.addr_zip = "A Philippine ZIP code is 4 digits.";
      }
      showErrors(errs);
      return Object.keys(errs).length === 0;
    }

    /* Prefill from the saved address: only empty fields, step by step, stopping if the user changes anything, never locking fields or saving. */
    async function prefill(saved) {
      if (!saved) return false;
      const gen = generation;
      const still = () => gen === generation && root.isConnected;
      let touched = false;

      const typed = (el, v) => {
        if (!el || !v || el.value.trim() !== "") return;
        el.value = v;
        el.classList.add("is-prefilled");
        touched = true;
      };

      if (legacyMode) {
        typed(line, saved.line);
        return touched;
      }

      typed(street, saved.street);
      typed(zip, saved.zip);

      /* The dropdowns only if the person has not started on them. */
      if (!saved.region_code || sel.region.value) return touched;

      const choose = (s, code) => {
        if (![...s.options].some(o => o.value === code)) return false;   /* no longer in the list */
        s.value = code;
        s.classList.add("is-prefilled");
        sync(s);
        return true;
      };

      /* Wait for the region list if it is still loading. */
      await regionsReady;
      if (!still() || !choose(sel.region, saved.region_code)) return touched;
      touched = true;

      if (!(await load("province", saved.region_code)) || !still()) return touched;

      /* No province: the picker offered the CITY in the province slot. */
      const provSlot = saved.province_code || saved.city_code;
      if (!choose(sel.province, provSlot)) return touched;

      if (!saved.province_code) {
        fillIndependentCity(sel.province.selectedOptions[0]);
        sel.city.classList.add("is-prefilled");
      } else {
        if (!(await load("city", saved.province_code)) || !still()) return touched;
        if (!choose(sel.city, saved.city_code)) return touched;
      }

      if (!(await load("barangay", saved.city_code)) || !still()) return touched;
      choose(sel.barangay, saved.barangay_code);
      return touched;
    }

    /* Start by loading the region list. */
    const regionsReady = load("region", null);

    return { value, validate, showErrors, clearErrors, prefill, isEmpty,
             get legacy() { return legacyMode; } };
  }

  window.EbAddress = { markup, mount };
})();
