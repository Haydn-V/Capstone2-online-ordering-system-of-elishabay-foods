#!/usr/bin/env python3
"""
verify-structure.py — structural checks for the staff portal.

Run from the project root:   python tools/verify-structure.py .
Or point it anywhere:        python tools/verify-structure.py C:\\xampp\\htdocs\\elishabay

Implements the checks in section 7 of docs/RBAC-MIGRATION-PLAN.md. Re-run after
every structural change; anything green that turns red is a regression.

Paths updated for the Phase 1 restructure:
    StuffModule/<Role>Module/<role>.html  ->  portal/<role>/index.html
    StuffModule/Core/portal-shell.html    ->  portal/shell.html
    StuffModule/Modules/                  ->  portal/views/
    StuffModule/AdminModule/admin.js      ->  assets/js/portal/engine.js
    per-portal gate files                 ->  assets/js/portal/gates/

Exit code 0 = all checks pass, 1 = at least one failure.
"""

import os
import pathlib
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."

# Portal folders are named for the role they accept. Note that portal/admin/ is
# the Admin role and portal/super-admin/ is Super Admin — the old AdminModule/
# (which confusingly held Super Admin) no longer exists.
PORTALS = [
    (os.path.join("portal", "super-admin"), "index.html"),
    (os.path.join("portal", "admin"), "index.html"),
    (os.path.join("portal", "cashier"), "index.html"),
    (os.path.join("portal", "inventory"), "index.html"),
    (os.path.join("portal", "orders"), "index.html"),
]
ENGINE = os.path.join("assets", "js", "portal", "engine.js")
MODULES_DIR = os.path.join("portal", "views")
SHELL = os.path.join("portal", "shell.html")
GATES_DIR = os.path.join("assets", "js", "portal", "gates")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    GREEN = RED = YELLOW = DIM = RESET = ""

failures = []


def read(*parts):
    path = os.path.join(ROOT, *parts)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def report(ok, label, detail=""):
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{mark}] {label}")
    if detail:
        for line in detail.splitlines():
            print(f"         {DIM}{line}{RESET}")
    if not ok:
        failures.append(label)


def skip(label, why):
    print(f"  [{YELLOW}SKIP{RESET}] {label}")
    print(f"         {DIM}{why}{RESET}")


# ---------------------------------------------------------------- check 1
def check_assembly():
    """Shell + partials must assemble into a DOM with a populated <main>."""
    print("\n1. Shell + partials assemble")
    shell = read(SHELL)
    if shell is None:
        skip("assembly", f"{SHELL} not present yet (pre-migration)")
        return
    mdir = os.path.join(ROOT, MODULES_DIR)
    if not os.path.isdir(mdir):
        skip("assembly", f"{MODULES_DIR}/ not present yet (pre-migration)")
        return
    parts = sorted(f for f in os.listdir(mdir) if f.endswith(".html"))
    report(bool(parts), f"{len(parts)} partials found in {MODULES_DIR}/")
    if 'id="main-content"' not in shell:
        report(False, "shell contains #main-content injection target")
    else:
        report(True, "shell contains #main-content injection target")
    stray = [p for p in parts if "<section" not in (read(MODULES_DIR, p) or "")]
    report(not stray, "every partial contains a <section>",
           "" if not stray else "missing <section>: " + ", ".join(stray))


# ---------------------------------------------------------------- check 2
def check_duplicate_ids():
    print("\n2. Duplicate id attributes")
    for folder, fname in PORTALS:
        src = read(folder, fname)
        if src is None:
            continue
        ids = re.findall(r'\sid="([^"]+)"', src)
        dups = sorted({i for i in ids if ids.count(i) > 1})
        report(not dups, f"{folder}/{fname}",
               "" if not dups else "duplicated: " + ", ".join(dups))

    mdir = os.path.join(ROOT, MODULES_DIR)
    if os.path.isdir(mdir):
        seen, clash = {}, []
        for p in sorted(os.listdir(mdir)):
            if not p.endswith(".html"):
                continue
            for i in re.findall(r'\sid="([^"]+)"', read(MODULES_DIR, p) or ""):
                if i in seen and seen[i] != p:
                    clash.append(f"{i} in {seen[i]} and {p}")
                seen[i] = p
        report(not clash, "no id collisions across partials",
               "\n".join(clash[:10]))


# ---------------------------------------------------------------- check 3
def _pairing(label, navs, secs):
    missing = sorted(navs - secs)
    orphan = sorted(secs - navs)
    detail = ""
    if missing:
        detail += "nav item with no section: " + ", ".join(missing) + "\n"
    if orphan:
        detail += "section with no nav item: " + ", ".join(orphan)
    report(not missing and not orphan, label, detail)


def check_nav_section_pairing():
    """The check that catches the orders.html / subadmin.html class of bug."""
    print("\n3. data-mod <-> id=\"mod-*\" pairing")

    mdir = os.path.join(ROOT, MODULES_DIR)
    shell = read(SHELL)

    # Nav lives in the shared shell, sections in portal/views/.
    # This is the pairing that actually governs every portal now, so it must
    # be checked directly rather than skipped.
    if shell is not None and os.path.isdir(mdir):
        navs = set(re.findall(r'data-mod="([^"]+)"', shell))
        secs = set()
        for p in sorted(os.listdir(mdir)):
            if not p.endswith(".html"):
                continue
            body = read(MODULES_DIR, p) or ""
            found = re.findall(r'id="mod-([^"]+)"', body)
            secs |= set(found)
            stem = os.path.splitext(p)[0]
            if stem not in found:
                report(False, f"{MODULES_DIR}/{p}",
                       f'filename does not match its section id (found: {found})')
        _pairing(f"{SHELL} nav <-> {MODULES_DIR}/", navs, secs)

    for folder, fname in PORTALS:
        src = read(folder, fname)
        if src is None:
            continue
        navs = set(re.findall(r'data-mod="([^"]+)"', src))
        secs = set(re.findall(r'id="mod-([^"]+)"', src))
        if not navs and not secs:
            skip(f"{folder}/{fname}", "thin portal — checked via shell/views above")
            continue
        _pairing(f"{folder}/{fname}", navs, secs)


# ---------------------------------------------------------------- check 4/5
def check_permissions():
    print("\n4/5. Permission wiring")
    js = read(ENGINE)
    if js is None:
        report(False, f"{ENGINE} readable")
        return

    perms = set(re.findall(r'"([\w.]+)":\s*\{\s*area:', js))
    report(bool(perms), f"PERMISSIONS parsed ({len(perms)} defined)")

    block = re.search(r"const MOD_PERM = \{(.*?)\n\};", js, re.S)
    if not block:
        report(False, "MOD_PERM block found")
        return
    mod_perm = dict(re.findall(r'([\w"-]+)\s*:\s*"([\w.]+)"', block.group(1)))
    bad = {k: v for k, v in mod_perm.items() if v not in perms}
    report(not bad, f"every MOD_PERM value exists ({len(mod_perm)} entries)",
           "" if not bad else "unknown: " + ", ".join(f"{k} -> {v}" for k, v in bad.items()))

    used = set()
    for folder, fname in PORTALS:
        src = read(folder, fname)
        if src:
            used |= set(re.findall(r'data-perm="([\w.]+)"', src))
    mdir = os.path.join(ROOT, MODULES_DIR)
    for extra in ([SHELL] if read(SHELL) else []):
        used |= set(re.findall(r'data-perm="([\w.]+)"', read(SHELL)))
    if os.path.isdir(mdir):
        for p in os.listdir(mdir):
            if p.endswith(".html"):
                used |= set(re.findall(r'data-perm="([\w.]+)"', read(MODULES_DIR, p) or ""))

    unknown = sorted(used - perms)
    report(not unknown, "every data-perm is a real permission",
           "" if not unknown else "unknown: " + ", ".join(unknown))

    unused = sorted(perms - used)
    report(not unused, "every permission is used in markup",
           "" if not unused else "never referenced: " + ", ".join(unused))


# ---------------------------------------------------------------- check 6
def check_identifier_collisions():
    """Gate files must not redeclare anything engine.js already defines."""
    print("\n6. Top-level identifier collisions with engine.js")
    js = read(ENGINE)
    if js is None:
        return
    pattern = r"^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)"
    admin_ids = set(re.findall(pattern, js, re.M))

    for folder, fname in [(GATES_DIR, "cashier.js"),
                          (GATES_DIR, "inventory.js"),
                          (GATES_DIR, "orders.js"),
                          (GATES_DIR, "admin.js"),
                          (GATES_DIR, "super-admin.js")]:
        src = read(folder, fname)
        if src is None:
            skip(fname, "not present")
            continue
        clash = sorted(admin_ids & set(re.findall(pattern, src, re.M)))
        preview = ", ".join(clash[:12]) + (" ..." if len(clash) > 12 else "")
        report(not clash, f"{folder}/{fname} ({len(clash)} collisions)", preview)


def check_live_reload_safety():
    """Dev servers inject a live-reload script before the closing body tag.

    Two ways that goes wrong, both of which produced a blank
    "Portal failed to load" page during the migration:

      1. A fragment with no body element at all — Live Server falls back to
         injecting before the first closing svg tag, landing inside the
         Elisha Bay logo mark and corrupting the parse.
      2. A comment mentioning a literal closing body/head/svg tag — Live
         Server matches raw text, injects inside the comment, and everything
         after it is swallowed.
    """
    print("\n7. Live-reload injection safety")
    targets = []
    if read(SHELL) is not None:
        targets.append(SHELL)
    mdir = os.path.join(ROOT, MODULES_DIR)
    if os.path.isdir(mdir):
        targets += [os.path.join(MODULES_DIR, p)
                    for p in sorted(os.listdir(mdir)) if p.endswith(".html")]
    if not targets:
        skip("injection safety", "no shell or partials yet (pre-migration)")
        return

    no_body, in_comment = [], []
    for rel in targets:
        src = read(*rel.split(os.sep)) or read(*rel.split("/")) or ""
        if "</body>" not in src.lower():
            no_body.append(rel)
        for c in re.findall(r"<!--.*?-->", src, re.S):
            if any(t in c.lower() for t in ("</body>", "</head>", "</svg>")):
                in_comment.append(rel)
                break

    report(not no_body, f"all {len(targets)} fragments are complete documents",
           "" if not no_body else "missing a body element: " + ", ".join(no_body[:6]))
    report(not in_comment, "no comment contains a literal closing body/head/svg tag",
           "" if not in_comment else "offending files: " + ", ".join(in_comment[:6]))



def check_brief_frontend_rules():
    """Three rules from the brief that nothing else was enforcing.

    Each of these was violated in the delivered code and found only by reading
    it, which means they will drift again unless something checks. All three are
    cheap to verify mechanically.
    """
    print("\n8. Front-end rules from the brief")

    # --- no inline event handlers in markup ------------------------------
    # Only this project's own markup. .agents/ and .claude/ hold third-party
    # skill templates whose HTML is not ours to police.
    EXCLUDED_DIRS = {"_archive", ".agents", ".claude", "node_modules", ".git"}
    offenders = []
    for f in sorted(pathlib.Path(ROOT).rglob("*.html")):
        if EXCLUDED_DIRS & set(f.parts):
            continue
        txt = f.read_text(encoding="utf-8", errors="replace")
        for attr in ("onclick=", "onchange=", "onsubmit=", "oninput=", "onload="):
            if attr in txt:
                offenders.append(f"{f.relative_to(ROOT)} ({attr.rstrip('=')})")
    # Template strings in JS build markup too, and a grep of .html files can
    # never see them. Three lived there: a filter input, the product-image
    # dropzone, and the empty-cart button in pos.js.
    for f in sorted(pathlib.Path(ROOT, "assets/js").rglob("*.js")):
        rel = f.relative_to(ROOT).as_posix()
        in_block = False
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            st = line.strip()
            if in_block:
                if "*/" in line:
                    in_block = False
                continue
            if "/*" in line and "*/" not in line:
                in_block = True
                continue
            if st.startswith(("*", "//", "/*")):
                continue
            if re.search(r'\son(click|change|input|submit|load)\s*=\s*"', line.split("//")[0]):
                offenders.append(f"{rel}:{n} (template string)")

    report(not offenders, "no inline event handlers in markup or template strings",
           "" if not offenders else "found: " + ", ".join(offenders[:6]))

    # --- raw fetch() only where it is documented as intentional ----------
    ALLOWED_FETCH = {
        "assets/js/core/api.js",          # the wrapper itself
        "assets/js/portal/module-loader.js",  # HTML fragments, pre-bootstrap
    }
    raw = []
    for f in sorted(pathlib.Path(ROOT, "assets/js").rglob("*.js")):
        rel = f.relative_to(ROOT).as_posix()
        if rel in ALLOWED_FETCH:
            continue
        # Track block comments properly. A first pass only skipped lines
        # STARTING with * or //, so prose inside a /* ... */ block that happened
        # to mention fetch() was reported as a call.
        in_block = False
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if in_block:
                if "*/" in line:
                    in_block = False
                continue
            if "/*" in line and "*/" not in line:
                in_block = True
                continue
            if stripped.startswith(("*", "//", "/*")):
                continue
            code = line.split("//")[0]
            if re.search(r"(?<![.\w])fetch\s*\(", code):
                raw.append(f"{rel}:{n}")
    report(not raw, f"raw fetch() appears only in {len(ALLOWED_FETCH)} documented places",
           "" if not raw else "unexpected: " + ", ".join(raw[:6]))

    # --- no user input reaches a SQL string ------------------------------
    # Interpolation into SQL is allowed only for values the server authored:
    # a whitelisted ORDER BY fragment, an integer LIMIT/OFFSET, a run of "?"
    # placeholders, or a pre-built clause. Anything reading a request
    # superglobal inside a SQL string is the thing this forbids.
    danger = re.compile(r'"[^"]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"]*'
                        r'\$(_GET|_POST|_REQUEST|_COOKIE)', re.I)
    hits = []
    for f in sorted(pathlib.Path(ROOT, "api").rglob("*.php")):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if danger.search(line):
                hits.append(f"{f.relative_to(ROOT)}:{n}")
    report(not hits, "no request superglobal is interpolated into SQL",
           "" if not hits else "found: " + ", ".join(hits[:6]))



def check_control_gate_parity():
    """Every control that jumps to a gated module must carry that module's gate.

    D9: the endpoint's permission is authoritative and the UI conforms to it.
    A jump control without data-perm is shown to roles that navigate() will
    bounce — the Archive-tab defect in miniature. Found one live instance: the
    dashboard's "View All" pointing at sales (sales.report) with no gate.
    """
    print("\n10. Control/permission parity")

    eng = read("assets/js/portal/engine.js")
    blk = re.search(r"const MOD_PERM = \{(.*?)\n\};", eng, re.S)
    if not blk:
        report(False, "MOD_PERM block found")
        return
    mod_perm = dict(re.findall(r'"?([\w-]+)"?\s*:\s*"([\w.]+)"', blk.group(1)))
    report(len(mod_perm) > 0, f"MOD_PERM parsed ({len(mod_perm)} modules)")

    gaps = []
    for f in sorted(pathlib.Path(ROOT, "portal").rglob("*.html")):
        for tag in re.findall(r"<(?:button|a)\b[^>]*>", f.read_text(encoding="utf-8")):
            mod = re.search(r'data-(?:mod|goto)="([\w-]+)"', tag)
            if not mod:
                continue
            need = mod_perm.get(mod.group(1))
            if not need:
                continue
            has = re.search(r'data-perm="([\w.]+)"', tag)
            if not has or has.group(1) != need:
                gaps.append(f"{f.name}: -> {mod.group(1)} needs {need}, "
                            f"carries {has.group(1) if has else 'nothing'}")
    report(not gaps, "every control jumping to a gated module carries that gate",
           "" if not gaps else "; ".join(gaps[:6]))


def check_date_discipline():
    """D1: no UTC conversion and no frozen dates in application JavaScript.

    Three separate bugs came from this one area:
      * dAgo() read a hardcoded new Date("2026-06-17"), so every relative range
        was anchored to a constant;
      * isOverdue() and batchRow() each compared against that same constant, so
        payment-overdue status and days-to-expiry stopped moving in June 2026;
      * toISOString() formats UTC while new Date("Y-m-dTH:i:s") parses local,
        and mixing them made addDays("2026-06-17", 30) return 16 July.

    Dates are resolved by the server now (api/core/Dates.php, Asia/Manila). This
    check stops the banned forms coming back.
    """
    print("\n11. Date discipline (D1)")

    banned_iso, banned_frozen = [], []
    for f in sorted(pathlib.Path(ROOT, "assets/js").rglob("*.js")):
        rel = f.relative_to(ROOT).as_posix()
        in_block = False
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if in_block:
                if "*/" in line:
                    in_block = False
                continue
            if "/*" in line and "*/" not in line:
                in_block = True
                continue
            if stripped.startswith(("*", "//", "/*")):
                continue
            code = line.split("//")[0]
            if "toISOString" in code:
                banned_iso.append(f"{rel}:{n}")
            if re.search(r'new Date\(\s*["\']20\d\d-', code):
                banned_frozen.append(f"{rel}:{n}")

    report(not banned_iso, "no toISOString() in application JavaScript (it formats UTC)",
           "" if not banned_iso else "found: " + ", ".join(banned_iso[:6]))
    report(not banned_frozen, "no hardcoded date literal in application JavaScript",
           "" if not banned_frozen else "found: " + ", ".join(banned_frozen[:6]))

    # The server must own the range definitions.
    dates_php = read("api/core/Dates.php")
    report(bool(dates_php) and "Asia/Manila" in (dates_php or ""),
           "api/core/Dates.php exists and pins Asia/Manila")
    eng = read(ENGINE) or ""
    report("SERVER_DATES" in eng and "system/dates.php" in eng,
           "the client reads ranges from api/system/dates.php rather than computing them")


def check_contact_field_naming():
    """The API spells one concept two ways, and a screen read the wrong one.

    orders/get.php and pos/checkout.php return `contact`; b2b/list.php and
    returns/list.php return `phone`. The Order Detail modal read `o.phone` and
    printed a literal "Phone undefined" to the operator.

    Both names are in use and 7 of the 9 client reads were correct, so renaming
    the API would break more than it fixed. This check records which endpoints
    use which, so the next person reads it here instead of finding out from a
    modal.
    """
    print("\n12. contact/phone field naming")

    uses_contact, uses_phone = [], []
    for f in sorted(pathlib.Path(ROOT, "api").rglob("*.php")):
        rel = f.relative_to(pathlib.Path(ROOT, "api")).as_posix()
        src = f.read_text(encoding="utf-8")
        if re.search(r"'contact'\s*=>", src):
            uses_contact.append(rel)
        if re.search(r"'phone'\s*=>", src):
            uses_phone.append(rel)

    report(bool(uses_contact) or bool(uses_phone),
           f"endpoints returning 'contact': {len(uses_contact)}, 'phone': {len(uses_phone)}",
           "contact: " + ", ".join(uses_contact) + "\nphone: " + ", ".join(uses_phone))

    # The specific bug: a client reading .phone off an order.
    bad = []
    for f in sorted(pathlib.Path(ROOT, "assets/js/portal").glob("*.js")):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r'\bo\.phone\b', line) and "o.contact" not in line:
                bad.append(f"{f.name}:{n}")
    report(not bad, "no order object is read for .phone without a .contact fallback",
           "" if not bad else "found: " + ", ".join(bad[:6]))


def check_element_ids_exist():
    """Every #id the portal JS looks up must exist in the markup.

    Registering a production batch was DEAD: the handler read
    $("#m-batch-qty") while the input is id="m-batch-total", so it threw
    "Cannot read properties of null" inside an async handler, which surfaced as
    an unhandled rejection and therefore as nothing at all. The modal stayed
    open, no row was written, and no error appeared anywhere. batches/save.php
    passed every test aimed at it the whole time.

    A second id in the same handler, #m-batch-lab against a select of
    id="m-batch-qa", was masked by optional chaining: the QA status an inspector
    chose was silently discarded and every batch saved as "pending".

    A dangling selector is invisible until someone uses the feature. This makes
    it visible now.
    """
    print("\n13. Element ids referenced by JS exist in markup")

    markup = ""
    for f in list(pathlib.Path(ROOT, "portal").rglob("*.html")):
        markup += f.read_text(encoding="utf-8", errors="replace")
    declared = set(re.findall(r'id="([\w-]+)"', markup))

    # ids the JS builds into markup itself, then queries back
    for f in pathlib.Path(ROOT, "assets/js/portal").glob("*.js"):
        src = f.read_text(encoding="utf-8")
        declared |= set(re.findall(r'id="([\w-]+)"', src))
        declared |= set(re.findall(r"id='([\w-]+)'", src))

    missing = []
    for f in sorted(pathlib.Path(ROOT, "assets/js/portal").glob("*.js")):
        src = f.read_text(encoding="utf-8")
        in_block = False
        for n, line in enumerate(src.splitlines(), 1):
            st = line.strip()
            # Track block comments properly. Skipping only lines that START with
            # * or // missed continuation lines, so this check flagged an id
            # mentioned inside its own explanatory comment.
            if in_block:
                if "*/" in line:
                    in_block = False
                continue
            if "/*" in line and "*/" not in line:
                in_block = True
                continue
            if st.startswith(("*", "//", "/*")):
                continue
            for m in re.finditer(r'\$\(\s*"#([\w-]+)"\s*\)', line.split("//")[0]):
                if m.group(1) not in declared:
                    missing.append(f"{f.name}:{n} #{m.group(1)}")

    report(not missing, f"every #id queried by portal JS exists ({len(declared)} declared)",
           "" if not missing else "dangling: " + ", ".join(sorted(set(missing))[:10]))


def check_portal_script_tags():
    """Each portal loads each script once, and loads its own gate file.

    portal/admin/index.html carried a SECOND engine.js where gates/admin.js
    should have been. Two consequences, both silent to a casual look:
      * engine.js parsed twice; the second parse died with "Identifier 'CONFIG'
        has already been declared" — a real console error on every load;
      * gates/admin.js never loaded, so installRoleGate("Admin") never ran and
        that entry point declared no role at all.

    A phase-2 walk of this portal reported "zero JS errors" because the error
    hook was installed after the page had loaded, and a parse error fires during
    it. This check does not depend on timing.
    """
    print("\n14. Portal script tags")

    for folder, fname in PORTALS:
        src = read(folder, fname)
        if src is None:
            continue
        srcs = re.findall(r'<script[^>]+src="([^"]+)"', src)
        dups = sorted({x for x in srcs if srcs.count(x) > 1})
        report(not dups, f"{folder}/{fname}: no script loaded twice",
               "" if not dups else "duplicated: " + ", ".join(dups))

        role_dir = os.path.basename(folder)
        want = f"gates/{role_dir}.js"
        report(any(want in x for x in srcs),
               f"{folder}/{fname}: loads its own {want}",
               "" if any(want in x for x in srcs) else "scripts: " + ", ".join(srcs[-3:]))


def check_storefront_escaping():
    """The public storefront must escape database values before rendering them.

    assets/js/public/site.js builds its markup with template strings and had NO
    escaper at all: 31 innerHTML assignments and 0 escaping calls, while the
    portal made 107 escHtml() calls in engine.js alone.

    The result was a stored XSS. A product description saved through the normal
    Product Maintenance form — `<img src=x onerror=...>` — executed for every
    anonymous visitor to the shop. Reproduced before the fix; the payload ran.

    Escaping is invisible when it is present and invisible when it is missing,
    which is exactly why it needs a check rather than a comment. Two rules:

      1. site.js must define esc() and use it.
      2. No known database-backed field may be interpolated into a template
         string without passing through esc() or escAttr().

    The field list is deliberately explicit rather than a general heuristic — a
    heuristic that guesses wrong in either direction is worse than a list
    somebody has to extend when they add a rendered field.
    """
    print("\n15. Storefront output escaping")

    src = pathlib.Path(ROOT, "assets/js/public/site.js").read_text(
        encoding="utf-8", errors="replace")
    code = re.sub(r"/\*.*?\*/", "", src, flags=re.S)

    report("function esc(" in code, "site.js defines esc()",
           "the storefront has no escaper — every DB value reaches innerHTML raw")

    # Fields that come from the database and are rendered as markup.
    fields = [
        ("p.name", "product name"), ("p.desc", "product description"),
        ("p.cat", "product category"), ("qa.q", "FAQ question"),
        ("qa.a", "FAQ answer"), ("order.name", "customer name on the receipt"),
        ("order.contact", "contact on the receipt"),
        ("order.address", "address on the receipt"),
        ("order.notes", "notes on the receipt"),
    ]
    # showToast() escapes its own message — asserted separately below — so a
    # raw ${p.name} inside a showToast(...) call is correct, and wrapping it
    # here as well would render "&amp;" to the customer. Those calls are removed
    # before scanning rather than special-cased per site.
    scan = re.sub(r"showToast\(\s*`[^`]*`", "showToast(``", code)

    raw = []
    for field, label in fields:
        # ${p.name} with nothing wrapping it — an unescaped interpolation.
        if re.search(r"\$\{\s*" + re.escape(field) + r"\s*\}", scan):
            raw.append(f"{field} ({label})")

    report(not raw,
           f"no database field is interpolated unescaped ({len(fields)} checked)",
           "" if not raw else "raw: " + ", ".join(raw))

    # showToast renders its message as innerHTML; callers compose it from
    # product names.
    m = re.search(r"function showToast\([^)]*\)\s*\{(.*?)\n\}", code, re.S)
    if m:
        body = m.group(1)
        report("esc(msg)" in body, "showToast escapes its message",
               "callers build it from product names, and it goes in as innerHTML")
        report("if(!wrap)" in body or "if (!wrap)" in body,
               "showToast survives a missing toast container",
               "profile.html and my-orders.html declare #toast-root, not "
               "#toast-wrap — an unguarded appendChild threw on every toast")
    else:
        report(False, "showToast() found in site.js", "function not located")


def check_no_shadowed_symbols():
    """No top-level symbol may be declared in two of the classic portal scripts.

    engine.js, pos.js, orders.js and inventory.js are classic scripts sharing
    one global scope, loaded in that order. Two files declaring the same
    top-level name is not an error at parse time for `function` — the later
    file silently wins — and IS a fatal SyntaxError for `const`/`let`, which
    kills the whole portal.

    Both halves have bitten this project:

      * Two engines declaring the same `const` is the failure that made the
        pre-RBAC portals impossible to load side by side; it is why the shared
        helpers were moved behind EbFormat rather than left as bare globals.

      * `orderTotal` was declared in engine.js AND orders.js. orders.js loads
        later, so its copy won portal-wide — and its copy called itself:

            if(typeof orderTotal === "function") return orderTotal(o);

        an always-true guard recursing for ever. Reproduced live:
        orderTotal({total:"245.00"}) threw
        "RangeError: Maximum call stack size exceeded". A string is exactly what
        PDO returns for a DECIMAL column when an endpoint forgets its (float)
        cast, so one missed cast would have taken down Transaction History, the
        dashboard, Receipts and Payment Verification at once.

    Silent shadowing is the dangerous half: nothing fails, and the wrong
    implementation is simply the one that runs. Hence a check.
    """
    print("\n16. No shadowed top-level symbols in the portal scripts")

    files = ["engine.js", "pos.js", "orders.js", "inventory.js"]
    decls = {}
    for name in files:
        path = pathlib.Path(ROOT, "assets/js/portal", name)
        if not path.exists():
            continue
        src = path.read_text(encoding="utf-8", errors="replace")
        src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        src = re.sub(r"^\s*//[^\n]*", "", src, flags=re.M)
        found = set()
        for m in re.finditer(r"^(?:const|let|var)\s+([A-Za-z_$][\w$]*)", src, re.M):
            found.add(m.group(1))
        for m in re.finditer(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", src, re.M):
            found.add(m.group(1))
        for sym in found:
            decls.setdefault(sym, []).append(name)

    shadowed = sorted((s, v) for s, v in decls.items() if len(v) > 1)
    report(not shadowed,
           f"no symbol is declared twice ({len(decls)} top-level names across "
           f"{len(files)} files)",
           "" if not shadowed else "; ".join(
               f"{s} in {', '.join(v)}" for s, v in shadowed[:6]))

    # ---- the same hazard on the public pages ---------------------------
    # site.js is a classic script too, and every inline <script> on a public
    # page shares its global scope. Declaring `const peso` in one of those is
    # the identical SyntaxError, and it kills the inline block silently — the
    # page renders its empty shell with nothing on screen to say why.
    #
    # This was not hypothetical: my-payments.html did exactly that on its first
    # run and reported "Identifier 'peso' has already been declared".
    site_src = pathlib.Path(ROOT, "assets/js/public/site.js").read_text(
        encoding="utf-8", errors="replace")
    site_src = re.sub(r"/\*.*?\*/", "", site_src, flags=re.S)
    site_globals = set(re.findall(r"^(?:const|let|var)\s+([A-Za-z_$][\w$]*)", site_src, re.M))
    site_globals |= set(re.findall(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", site_src, re.M))

    def top_level_decls(js):
        """Names declared at brace depth 0 — the only ones that can clash.

        Depth matters. `var esc = ...` INSIDE a submit handler is
        function-scoped and shadows nothing; matching on indentation instead
        flagged exactly that in become-partner.html on the first run, and a
        check that cries wolf is a check somebody switches off.

        String and line-comment contents are skipped so a brace inside one does
        not throw the depth count off.
        """
        names, depth, i, n = [], 0, 0, len(js)
        line_start = True
        while i < n:
            c = js[i]
            if c in "\"'`":                       # skip a string literal whole
                quote, i = c, i + 1
                while i < n and js[i] != quote:
                    i += 2 if js[i] == "\\" else 1
                i += 1
                continue
            if c == "/" and i + 1 < n and js[i + 1] == "/":
                while i < n and js[i] != "\n":
                    i += 1
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth = max(0, depth - 1)
            elif c == "\n":
                line_start = True
                i += 1
                continue
            if depth == 0 and line_start:
                m = re.match(r"[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)", js[i:])
                if m:
                    names.append(m.group(1))
            if not c.isspace():
                line_start = False
            i += 1
        return names

    clashes = []
    for page in sorted(pathlib.Path(ROOT, "public").rglob("*.html")):
        html = page.read_text(encoding="utf-8", errors="replace")
        for block in re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S):
            block = re.sub(r"/\*.*?\*/", "", block, flags=re.S)
            for name in top_level_decls(block):
                if name in site_globals:
                    rel = page.relative_to(pathlib.Path(ROOT)).as_posix()
                    clashes.append(f"{name} in {rel}")

    report(not clashes,
           f"no public page redeclares a site.js global ({len(site_globals)} checked)",
           "" if not clashes else "; ".join(sorted(set(clashes))[:6]))


def check_js_page_paths():
    """Every .html path built in JavaScript must name a file that exists.

    The account menu in assets/js/public/site.js navigated to

        MyProfile/my-orders.html

    a directory left over from the layout before the restructure. Clicking
    "My Orders" or "Profile" gave Apache's 404 from every page on the site, for
    every signed-in customer. It survived because the broken-link sweep only
    read href and src ATTRIBUTES out of the HTML — a path assembled in a string
    and handed to window.location.href is invisible to that.

    Checked as a suffix match against the real file tree rather than by
    resolving each path: these are relative to whichever page is running and a
    resolver would have to model that. A literal that matches no file anywhere
    in the project cannot be right whatever it was relative to.
    """
    print("\n17. Page paths built in JavaScript")

    on_disk = [f.relative_to(pathlib.Path(ROOT)).as_posix()
               for f in pathlib.Path(ROOT).rglob("*.html")
               if not any(part in (".claude", ".agents", "_archive", "node_modules")
                          for part in f.parts)]

    js_files = sorted(pathlib.Path(ROOT, "assets", "js").rglob("*.js"))
    missing, checked = [], 0

    for jf in js_files:
        src = jf.read_text(encoding="utf-8", errors="replace")
        src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        src = re.sub(r"^\s*//[^\n]*", "", src, flags=re.M)

        for m in re.finditer(r"""["']([A-Za-z0-9_./-]*[A-Za-z0-9_-]\.html)["']""", src):
            path = m.group(1).lstrip("./")
            if not path:
                continue
            checked += 1
            # A template placeholder or a bare filename both count as found if
            # any real file ends with that path.
            if not any(f == path or f.endswith("/" + path) for f in on_disk):
                rel = jf.relative_to(pathlib.Path(ROOT)).as_posix()
                missing.append(f"{path} in {rel}")

    report(not missing,
           f"every .html path in JavaScript resolves to a real file ({checked} checked)",
           "" if not missing else "; ".join(sorted(set(missing))[:6]))


def check_api_docs_complete():
    """docs/API.md must list every endpoint, and no endpoint that is gone.

    The brief asks for this file to be written as the endpoints are built. It
    was not kept current: by the close-out audit it documented 26 of 45, and
    still described a products/create.php that had been merged into save.php.
    Documentation drifts silently because nothing fails when it does — so this
    check exists to make it fail.
    """
    print("\n9. API documentation")

    md = pathlib.Path(ROOT, "docs/API.md").read_text(encoding="utf-8", errors="replace")
    endpoints = [
        f.relative_to(pathlib.Path(ROOT, "api")).as_posix()
        for f in sorted(pathlib.Path(ROOT, "api").rglob("*.php"))
        if "core" not in f.parts and "config" not in f.parts
    ]
    missing = [e for e in endpoints if e not in md]
    report(not missing, f"all {len(endpoints)} endpoints appear in docs/API.md",
           "" if not missing else "undocumented: " + ", ".join(missing[:8]))

    # An endpoint path in the docs that no longer exists sends a reader looking
    # for a file that is not there.
    known_internal = {"core/bootstrap.php", "core/Response.php", "core/Auth.php",
                      "core/Rbac.php", "core/Validate.php", "core/Csrf.php",
                      "config/db.php", "config/config.php", "config/config.example.php"}
    mentioned = set(re.findall(r"([a-z0-9-]+/[a-z0-9-]+\.php)", md))
    # A mention that resolves to a real file from the project root is not a
    # ghost either: the image-clearing section points at tools/prune-uploads.php,
    # which is the CLI that collects the orphaned .webp a cleared image_url
    # leaves behind. The question this check asks is "does the file the reader
    # is sent to exist" — hardcoding another whitelist would answer it worse.
    ghosts = sorted(m for m in mentioned
                    if m not in endpoints and m not in known_internal
                    and not pathlib.Path(ROOT, m).is_file())
    report(not ghosts, "docs/API.md names no endpoint that has been removed",
           "" if not ghosts else "stale: " + ", ".join(ghosts[:8]))


if __name__ == "__main__":
    print(f"Verifying project at: {os.path.abspath(ROOT)}")
    check_assembly()
    check_duplicate_ids()
    check_nav_section_pairing()
    check_permissions()
    check_identifier_collisions()
    check_live_reload_safety()
    check_brief_frontend_rules()
    check_control_gate_parity()
    check_date_discipline()
    check_contact_field_naming()
    check_element_ids_exist()
    check_portal_script_tags()
    check_storefront_escaping()
    check_no_shadowed_symbols()
    check_js_page_paths()
    check_api_docs_complete()

    print()
    if failures:
        print(f"{RED}{len(failures)} check(s) failed:{RESET}")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print(f"{GREEN}All checks passed.{RESET}")
    sys.exit(0)
