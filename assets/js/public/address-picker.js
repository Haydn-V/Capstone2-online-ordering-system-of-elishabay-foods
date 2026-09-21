/* ============================================================
   EbAddress — the Philippine address picker
   ------------------------------------------------------------
   ONE COMPONENT, FOUR FORMS

   Checkout (delivery), the Create Account tab, the retailer
   application (business address) and Profile > Delivery Address
   all ask for the same thing. Each used to have its own free-text
   box, and each stored whatever came back. This is built once and
   mounted into each.

     Region → Province → City / Municipality → Barangay
     House no. and street, ZIP        typed — they are in no list

   Codes from the PSA's PSGC, served one parent at a time by
   api/locations/list.php. What this posts is CODES: the server
   (api/core/Address.php) looks the names up itself and checks each
   level belongs to the one above. Nothing here is trusted beyond
   "this is what the person picked".

   THE CASCADE RULES
   - Every dropdown is empty and disabled until its parent is chosen.
   - Changing a parent CLEARS every child below it. A new city must
     never leave the previous city's barangay sitting in the field —
     that is an address that does not exist, submitted with confidence.
   - A list being fetched says so ("Loading barangays…") and stays
     disabled until it lands.
   - A late response for a parent that is no longer selected is
     thrown away (see `ticket`), so fast clicking cannot put Cebu's
     cities under a Pangasinan province.

   CITIES WITH NO PROVINCE — Metro Manila, Pateros, and highly
   urbanised cities such as Cebu City — arrive in the Province list
   under their own names, marked kind "city". Choosing one fills the
   City step with that one city and goes straight to its barangays.
   Nobody is stranded at a Province step with nothing to pick.

   THE DROPDOWNS ARE EbSelect. Native <select class="control"> /
   "auth-input" elements, which core/select.js enhances on sight:
   the site's one listbox, with its keyboard handling and its
   type-ahead — typing the first letters of a barangay jumps to it,
   which matters in a city with a hundred of them. Disabling a
   select is not something EbSelect observes, so every state change
   here ends with EbSelect.sync().

   BEFORE THE LOCATION DATA IS LOADED — db/seed-ph-locations.sql is
   generated from the PSA file and loaded separately — the lists
   come back empty with meta.loaded = false. The picker then shows
   the single free-text box the forms used to have, and the server
   accepts it (Address::checkLegacyLine). A shop that cannot take
   an address cannot sell; this keeps it selling until the seed lands.

   Classic script, loaded before site.js on every public page: the
   Create Account tab and the checkout can both open from any of them.
   ============================================================ */
(function () {
  "use strict";

  /* Every list fetched, for the life of the page. Keyed by level and
     parent, holding the PROMISE — so two controls asking for the same
     province at once share one request instead of racing two. The
     server also sends a week's Cache-Control; this is the in-page half. */
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

  /* The picker's level names are singular; the endpoint's are the plural of
     what it returns. Spelled out rather than built from a suffix rule, because
     "city" does not pluralise by adding an s. */
  const API_LEVEL = { region: "regions", province: "provinces", city: "cities", barangay: "barangays" };

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const ICON = {
    pin:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    home:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    mail:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  };

  /* The four dropdown levels, in cascade order. `placeholder` is the
     empty option once a parent is chosen; `waiting` is what the box says
     before that — a disabled control should say what it is waiting FOR.

     SHORT ON PURPOSE. These strings set the narrowest the picker can be laid
     out two-across: a trigger has to hold the longest of them plus a 44px icon
     well and an arrow, and "Choose a city or municipality" alone asked for
     ~199px of text, which pushed the pairing off any container under ~560px.
     Every one of them sits directly under a <label> that names the field, so
     the field name does not need saying twice — "City / Municipality" above
     "Choose a city", "Province" above "Region first". Measured, not trimmed by
     eye: the longest is now "Choose a barangay" at 130px. */
  const LEVELS = [
    { key: "region",   label: "Region",               placeholder: "Choose a region",    waiting: "Choose a region",  loading: "Loading regions…" },
    { key: "province", label: "Province",             placeholder: "Choose a province",  waiting: "Region first",     loading: "Loading provinces…" },
    { key: "city",     label: "City / Municipality",  placeholder: "Choose a city",      waiting: "Province first",   loading: "Loading cities…" },
    { key: "barangay", label: "Barangay",             placeholder: "Choose a barangay",  waiting: "City first",       loading: "Loading barangays…" },
  ];

  /* ------------------------------------------------------------
     Markup. Two host styles:
       "field" — checkout and profile: .field > label + .control
       "auth"  — Create Account and the retailer form:
                 .auth-field > label + .auth-input-group(icon + input)
     Same ids either way: `${prefix}-addr-<part>`, so a server error
     keyed addr_barangay lands on `${prefix}-addr-barangay`.
     ------------------------------------------------------------ */
  function markup(prefix, opts) {
    const o = Object.assign({ variant: "field", required: false }, opts || {});
    /* The asterisk follows the same three modes validate() does: the four
       dropdowns are required in both "location" and full mode, street and ZIP
       only in full. Marking a field required that is not is its own bug. */
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

    /* The fallback box, hidden until the lists come back empty. Rendered up
       front so switching to it is a class flip, not a rebuild that would lose
       whatever the host form has already bound. */
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

  /* ------------------------------------------------------------
     Behaviour.
     ------------------------------------------------------------ */
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

    /* Rises every time the PERSON changes something. A prefill in flight
       checks it before each step and stops if it has moved — so a customer
       who starts picking before their saved address arrives is never
       overwritten mid-choice. */
    let generation = 0;
    /* One per level: a response only applies if it is still the latest
       request for that level. */
    const ticket = { region: 0, province: 0, city: 0, barangay: 0 };
    let legacyMode = false;

    const sync = s => { if (window.EbSelect) EbSelect.sync(s); };

    function setOptions(level, rows, placeholder) {
      const s = sel[level];
      s.innerHTML = `<option value="">${esc(placeholder)}</option>` + rows.map(r => {
        /* Manila's numbered barangays read as "Barangay 105 · Tondo I" —
           the district is how a resident finds theirs among ~900. */
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

    /* Fetch a level's list into its select. Resolves true when the list is in
       place and still wanted, false when it was superseded. */
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

    /* A province entry that is really a CITY (no province above it): the City
       step gets exactly that one city, already chosen. */
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

    /* ZIP is four digits in the Philippines. Stripping anything else as it is
       typed is kinder than refusing a submitted "2400 " later. */
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

    /* Server errors arrive keyed addr_region, addr_barangay, … (Address::FIELD).
       Returns true if any of them belonged to this picker, so a host form can
       tell whether it still has something of its own to show. */
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
        /* Focus the FIRST field in error, and on a dropdown that means
           EbSelect's trigger — the native <select> is clipped to 1px and taken
           out of the tab order, so focusing it puts the cursor nowhere a person
           can see. A touch device keeps the native control, hence the fallback. */
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

    /* Nothing chosen and nothing typed. Optional addresses (Create Account,
       Profile) are allowed to be entirely empty; the server refuses a
       half-finished one, and so does validate() below. */
    function isEmpty() {
      const v = value();
      return legacyMode ? !v.line : !(v.region || v.street || v.zip);
    }

    /* Client-side courtesy only — the same rules Address::check applies, so
       an incomplete address is flagged without a round trip. The server
       decides. Returns true when the form may submit.

       `required` takes the same three values the server does:
         true        everything, street and ZIP included (checkout, business)
         "location"  region through barangay; street and ZIP optional
                     (Create Account)
         false       nothing — but anything started must be finished (Profile) */
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

    /* ---------------- prefill ----------------
       THE CHECKOUT'S RULE, applied to four dropdowns instead of one box
       (see the PREFILL block in openCheckout):
         - only EMPTY fields are filled — if the person has already chosen a
           region, the saved address is not forced over it;
         - each step waits for its list, and stops the moment the person
           changes anything (the generation check);
         - nothing is disabled or made read-only by prefilling;
         - it writes nothing back. The host form's save checkbox does that.
       `saved` is the codes-and-text shape shop/profile.php returns. */
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

    /* Start: the region list. Everything else waits for a choice. */
    const regionsReady = load("region", null);

    return { value, validate, showErrors, clearErrors, prefill, isEmpty,
             get legacy() { return legacyMode; } };
  }

  window.EbAddress = { markup, mount };
})();
