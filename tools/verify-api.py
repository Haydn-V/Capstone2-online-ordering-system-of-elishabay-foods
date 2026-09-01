#!/usr/bin/env python3
"""
verify-api.py — behavioural checks against a running Elisha Bay install.

    python tools/verify-api.py
    python tools/verify-api.py http://localhost/elishabay

Complements verify-structure.py, which only reads files. This one drives the
live API: it signs in as each role and checks that every endpoint allows and
refuses exactly what it should, that validation rejects bad input, and that
writes actually persist.

Requires Apache and MySQL running, and the seeded database. It creates a few
records and deletes them again; if it is interrupted, rows prefixed "VERIFY-"
may be left behind.

Exit code 0 = all checks pass, 1 = at least one failure.
"""

import json
import os
import shutil
import sys
import urllib.parse
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost/elishabay").rstrip("/")
API = BASE + "/api"

# The project root is this file's parent's parent — tools/ sits inside it.
# Derived rather than hardcoded, so a checkout can live on any drive.
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_exe(name, subdir):
    """Locate mysql.exe / php.exe without assuming C:\\xampp.

    This used to be a hardcoded C:\\xampp path, which made the whole suite
    unrunnable on an install anywhere else — the first MySQL call died with
    WinError 2 before a single check ran. Order: an explicit XAMPP_ROOT
    override, then the XAMPP dir that actually contains this checkout, then
    PATH, then the common install locations.
    """
    roots = []
    env_root = os.environ.get("XAMPP_ROOT")
    if env_root:
        roots.append(env_root)

    # .../<xampp>/htdocs/elishabay -> .../<xampp>
    roots.append(os.path.dirname(os.path.dirname(PROJECT_DIR)))

    for cand in roots:
        exe = os.path.join(cand, subdir, name)
        if os.path.isfile(exe):
            return exe

    found = shutil.which(name)
    if found:
        return found

    for cand in (r"C:\xampp", r"D:\xampp", r"C:\xamp", r"D:\xamp"):
        exe = os.path.join(cand, subdir, name)
        if os.path.isfile(exe):
            return exe

    # Fall through to the bare name and let the caller's error surface.
    return name


MYSQL_EXE = _find_exe("mysql.exe", os.path.join("mysql", "bin"))
PHP_EXE = _find_exe("php.exe", "php")

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"
try:
    import os
    if os.name == "nt" and not os.environ.get("WT_SESSION"):
        GREEN = RED = DIM = RESET = ""
except Exception:
    pass

passed, failed = 0, []


# Bumped deliberately when assertions are added, so a drop is a failure
# rather than an unnoticed gap.
CUST_HASH = "$2y$10$Ifp09DtbhlYyOWyOzma5ReusH/8v.hsZBfAjZOKhPh2/04vCBqCxO"   # bcrypt of Test@Cust1, matches db/seed.sql

EXPECTED_CHECKS = 168


def check(ok, label, detail=""):
    global passed
    if ok:
        passed += 1
        print(f"  [{GREEN}PASS{RESET}] {label}")
    else:
        failed.append(label)
        print(f"  [{RED}FAIL{RESET}] {label}")
        if detail:
            print(f"         {DIM}{detail}{RESET}")


class Session:
    """One signed-in (or anonymous) API client."""

    def __init__(self, label):
        self.label = label
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def call(self, path, method="GET", body=None):
        """Query strings are encoded here — a test payload containing spaces or
        quotes (the SQL-injection probes do) is not a valid raw URL."""
        path = path.lstrip("/")
        if "?" in path:
            base, _, query = path.partition("?")
            pairs = urllib.parse.parse_qsl(query, keep_blank_values=True)
            path = base + "?" + urllib.parse.urlencode(pairs)
        url = f"{API}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data:
            req.add_header("Content-Type", "application/json")
        if self.csrf and method != "GET":
            req.add_header("X-CSRF-Token", self.csrf)
        try:
            with self.opener.open(req, timeout=20) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw or "{}")
            except json.JSONDecodeError:
                return e.code, {"_raw": raw[:200]}
        except urllib.error.URLError as e:
            print(f"\n{RED}Cannot reach {url} — is Apache running?{RESET}\n{e}")
            sys.exit(2)

    def login(self, email, password):
        status, payload = self.call("auth/login.php", "POST",
                                    {"email": email, "password": password})
        if status == 200:
            self.csrf = payload["data"].get("csrf")
        return status, payload

    def login_customer(self, email, password):
        status, payload = self.call("shop/login.php", "POST",
                                    {"email": email, "password": password})
        if status == 200:
            self.csrf = payload["data"].get("csrf")
        return status, payload

    def code(self, path, method="GET", body=None):
        return self.call(path, method, body)[0]


ROLES = {
    "Super Admin":         ("admin@elishabay.ph", "Admin@123"),
    "Admin":               ("subadmin@elishabay.ph", "SubAdm@2025"),
    "Cashier":             ("cashier@elishabay.ph", "Cash@2025"),
    "Inventory Staff":     ("inventory@elishabay.ph", "Inv@2025"),
    "Online Orders Staff": ("orders@elishabay.ph", "Ord@2025"),
}

# endpoint -> {role: expected status}. 200/201 = allowed, 403 = refused.
MATRIX = {
    "products/list.php":         {"Super Admin": 200, "Admin": 200, "Cashier": 200, "Inventory Staff": 200, "Online Orders Staff": 200},
    "categories/list.php":       {"Super Admin": 200, "Admin": 200, "Cashier": 200, "Inventory Staff": 200, "Online Orders Staff": 200},
    "users/list.php":            {"Super Admin": 200, "Admin": 200, "Cashier": 403, "Inventory Staff": 403, "Online Orders Staff": 403},
    "customers/list.php":        {"Super Admin": 200, "Admin": 200, "Cashier": 403, "Inventory Staff": 403, "Online Orders Staff": 403},
    "roles/list.php":            {"Super Admin": 200, "Admin": 403, "Cashier": 403, "Inventory Staff": 403, "Online Orders Staff": 403},
    "audit/list.php":            {"Super Admin": 200, "Admin": 200, "Cashier": 403, "Inventory Staff": 200, "Online Orders Staff": 403},
    "batches/list.php":          {"Super Admin": 200, "Admin": 200, "Cashier": 403, "Inventory Staff": 200, "Online Orders Staff": 403},
    "inventory/adjustments.php": {"Super Admin": 200, "Admin": 200, "Cashier": 403, "Inventory Staff": 200, "Online Orders Staff": 403},
    "orders/list.php":           {"Super Admin": 200, "Admin": 200, "Cashier": 200, "Inventory Staff": 403, "Online Orders Staff": 200},
}


def section(title):
    print(f"\n{title}")


def main():
    # MySQL helpers, defined once for the whole run. These used to be two
    # byte-identical closures declared in two different sections, so a section
    # could only use the copy in its own scope — a cleanup assertion in
    # section 6 could not call the helper defined in section 6b. They also
    # disagreed on path escaping.
    import subprocess

    def sql_scalar(q):
        """One value out of MySQL, as a string. Empty string when there is none."""
        r = subprocess.run([MYSQL_EXE, "-u", "root", "elisha_bay_db",
                            "-N", "-B", "-e", q], capture_output=True, text=True)
        return r.stdout.strip()

    def sql(stmt):
        """Fire-and-forget statement, used for fixture setup and teardown."""
        subprocess.run([MYSQL_EXE, "-u", "root", "elisha_bay_db", "-e", stmt],
                       capture_output=True)

    sql_get = sql_scalar   # historical name, kept so section 6c reads unchanged

    # ---------------------------------------------------------------- 1
    section("1. Authentication")

    # This section signs in wrongly on purpose, and Auth::throttle() locks an
    # account after 5 failures in 15 minutes. That control is real and worth
    # keeping — but it also meant a second run of this suite inside the window
    # failed three checks that had nothing to do with the code under test.
    # Clear the FAILED attempts for the accounts the suite uses (successful
    # ones are left alone), then test the lockout deliberately at the end.
    import subprocess as _sp
    _test_emails = "','".join([e for e, _ in ROLES.values()] +
                              ["admin2@elishabay.ph", "nobody@nowhere.ph",
                               "throttle-probe@example.com"])
    _sp.run([MYSQL_EXE, "-u", "root", "elisha_bay_db", "-e",
             "DELETE FROM login_attempts WHERE successful = 0 "
             "AND email IN ('" + _test_emails + "');"], capture_output=True)

    anon = Session("anonymous")
    check(anon.code("auth/me.php") == 401, "me.php without a session returns 401")

    s = Session("t")
    check(s.login("admin@elishabay.ph", "wrongpass")[0] == 401, "wrong password returns 401")
    st, pl = s.login("nobody@nowhere.ph", "wrongpass")
    check(st == 401, "unknown email returns 401")
    st2, pl2 = Session("t").login("admin@elishabay.ph", "wrongpass")
    # Both messages must EXIST and match. Comparing two absent keys gives
    # None == None, which passed even if login stopped returning errors at all.
    msg1 = pl.get("error", {}).get("message")
    msg2 = pl2.get("error", {}).get("message")
    check(bool(msg1) and msg1 == msg2,
          "unknown email and wrong password give the same message (no user enumeration)",
          f"unknown-email={msg1!r} wrong-password={msg2!r}")
    check(Session("t").login("admin2@elishabay.ph", "Adm2@2025")[0] == 403,
          "archived account is refused (403)")

    sessions = {}
    for role, (email, pw) in ROLES.items():
        sess = Session(role)
        st, pl = sess.login(email, pw)
        ok = st == 200 and pl.get("data", {}).get("user", {}).get("role") == role
        check(ok, f"{role} signs in")
        sessions[role] = sess

    # A mismatched portal_role login is refused AND ends the session it just
    # created, so this is run on a throwaway client rather than on the Cashier's
    # own session — otherwise the rest of the suite runs signed out.
    # Brute-force lockout, proven rather than assumed. Uses an address that
    # matches no account, so nobody real is locked out by running the suite.
    probe = "throttle-probe@example.com"
    codes = [Session("throttle").login(probe, "wrong-%d" % i)[0] for i in range(7)]
    check(401 in codes and 429 in codes,
          "repeated failed sign-ins are throttled (401 then 429)",
          "got %s" % codes)
    _sp.run([MYSQL_EXE, "-u", "root", "elisha_bay_db", "-e",
             "DELETE FROM login_attempts WHERE email = '" + probe + "';"],
            capture_output=True)

    throwaway = Session("portal-check")
    check(throwaway.call("auth/login.php", "POST", {
        "email": "cashier@elishabay.ph", "password": "Cash@2025",
        "portal_role": "Super Admin"})[0] == 403,
        "portal_role mismatch is refused server-side")

    # ---------------------------------------------------------------- 2
    section("2. CSRF")
    admin = sessions["Super Admin"]
    saved, admin.csrf = admin.csrf, None
    check(admin.code("products/save.php", "POST", {"name": "x"}) == 403,
          "state-changing request without a CSRF token is refused")
    admin.csrf = "not-the-real-token"
    check(admin.code("products/save.php", "POST", {"name": "x"}) == 403,
          "wrong CSRF token is refused")
    admin.csrf = saved
    check(admin.code("products/list.php") == 200, "GET needs no CSRF token")

    # ---------------------------------------------------------------- 3
    section("3. Permission matrix (role x endpoint)")
    check(anon.code("shop/products.php") == 200, "shop/products.php is public")
    for path in ("products/list.php", "orders/list.php", "users/list.php"):
        check(anon.code(path) == 401, f"{path} requires a session")
    for path, expected in MATRIX.items():
        wrong = []
        for role, want in expected.items():
            got = sessions[role].code(path)
            if got != want:
                wrong.append(f"{role}: expected {want}, got {got}")
        # `not wrong` is empty-is-good, which also passes if the loop never
        # ran. Assert every role was actually exercised.
        check(len(expected) > 0 and not wrong, f"{path}",
              "\n".join(wrong) or "no roles were tested for this path")

    # ---------------------------------------------------------------- 4
    section("4. Validation")
    st, pl = admin.call("products/save.php", "POST", {})
    check(st == 422 and "name" in pl.get("error", {}).get("fields", {}),
          "empty form returns 422 with field errors")
    check(admin.code("products/save.php", "POST",
          {"name": "x" * 300, "category_id": "cat-db", "price": 10}) == 422,
          "over-long string is rejected")
    check(admin.code("products/save.php", "POST",
          {"name": "Neg", "category_id": "cat-db", "price": -5}) == 422,
          "negative price is rejected")
    inv = sessions["Inventory Staff"]
    check(inv.code("inventory/adjust.php", "POST",
          {"product_id": "db-pesto", "qty": -5, "type": "disposal", "reason": "r"}) == 422,
          "negative quantity is rejected")
    check(admin.code("categories/save.php", "POST", {"name": "Deboned Bangus"}) == 409,
          "duplicate unique value returns 409")
    check(admin.code("products/save.php", "POST",
          {"name": "XSS", "category_id": "cat-db", "price": 10,
           "image": "data:text/html,<script>alert(1)</script>"}) == 422,
          "non-image data URL is rejected")
    # Three payloads, each checked against a known-good baseline. Asserting
    # only "the probe returned 0 rows" cannot tell a blocked injection from an
    # endpoint that returns nothing for any input, so the unfiltered count is
    # taken first and asserted to be non-zero.
    baseline = admin.call("products/list.php?limit=1")[1]["meta"]["total"]
    check(baseline > 0, "SQLi baseline: the unfiltered catalogue is non-empty",
          f"total={baseline}")
    for payload in ["' OR '1'='1", "'; DROP TABLE products; --", "1' UNION SELECT NULL--"]:
        st, pl = admin.call("products/list.php?search=" + payload)
        got = pl.get("meta", {}).get("total")
        check(st == 200 and got == 0,
              f"SQL injection treated as a literal string: {payload!r}",
              f"status={st} total={got} (baseline {baseline}) — "
              f"a total equal to the baseline means the WHERE clause was bypassed")
    check(sql_scalar("SELECT COUNT(*) FROM products") != "0",
          "SQLi probes left the products table intact")

    # ---------------------------------------------------------------- 5
    section("5. Business rules")
    # A disposal now has to name the lot it came from, so these post a real one.
    # Looked up rather than hardcoded: the lot codes move when the seed is
    # re-imported, and a test that fails because a fixture was renamed teaches
    # nothing.
    steak_lot = sql_scalar("SELECT lot_code FROM batches WHERE product_id='db-steak' "
                           "AND remaining_qty > 0 ORDER BY expiry_date LIMIT 1")
    other_lot = sql_scalar("SELECT lot_code FROM batches WHERE product_id <> 'db-steak' "
                           "AND remaining_qty > 0 ORDER BY expiry_date LIMIT 1")
    check(bool(steak_lot) and bool(other_lot), "fixture: lots exist to adjust against",
          f"steak_lot={steak_lot!r} other_lot={other_lot!r}")

    check(inv.code("inventory/adjust.php", "POST",
          {"product_id": "db-steak", "qty": 99999, "type": "disposal",
           "reason": "over", "batch_code": steak_lot}) == 409,
          "cannot dispose more stock than exists")

    # The lot is REQUIRED for a disposal or return. It used to be optional, which
    # left the disposal untraceable and put free text in front of a foreign key.
    check(inv.code("inventory/adjust.php", "POST",
          {"product_id": "db-steak", "qty": 1, "type": "disposal", "reason": "no lot"}) == 422,
          "a disposal without a lot code is refused")

    # A lot that exists but belongs to another product satisfies the foreign key
    # and still means nothing.
    check(inv.code("inventory/adjust.php", "POST",
          {"product_id": "db-steak", "qty": 1, "type": "disposal",
           "reason": "wrong lot", "batch_code": other_lot}) == 422,
          "a lot belonging to another product is refused")
    cash = sessions["Cashier"]

    # SELF-CALIBRATING, and it has to be.
    #
    # This check used to post db-steak x5 twice and expect 409. db/seed.sql sets
    # that product's stock to 9, so 5+5=10 exceeding it was what proved the two
    # lines had been MERGED before the stock check.
    #
    # Real walk-in sales on 18 Aug drove that stock to 0. At 0, every quantity
    # is refused, so the check passed while proving nothing about merging — a
    # trivial pass of exactly the kind the Phase 1 assertion audit was about,
    # arrived at from a new direction: not a broken assertion, but a fixture
    # consumed by ordinary business activity.
    #
    # Resetting the stock in setup was the obvious fix and is the wrong one:
    # db-steak is a real product in real orders, not a dedicated test fixture
    # like cus-t01, and a suite that overwrites live inventory to suit itself is
    # worse than the trivial pass.
    #
    # So the quantity is derived from whatever the stock actually is:
    # q = floor(stock/2) + 1 means ONE line always fits and TWO always exceed,
    # at every stock level from 1 upward. The check can no longer pass for the
    # wrong reason regardless of what the shop has sold today.
    steak_stock = int(sql_scalar("SELECT stock FROM products WHERE id='db-steak'") or 0)
    check(steak_stock >= 1,
          "fixture: db-steak has stock for the oversell check",
          f"stock={steak_stock} — at 0 every quantity is refused and the check "
          f"below would pass without testing anything. Restock it.")
    if steak_stock >= 1:
        half = steak_stock // 2 + 1
        check(cash.code("pos/checkout.php", "POST",
              {"items": [{"id": "db-steak", "qty": half}, {"id": "db-steak", "qty": half}],
               "order_type": "pickup", "customer_type": "regular", "pay_method": "cash"}) == 409,
              "POS merges duplicate cart lines before the stock check (no oversell)",
              f"stock={steak_stock}, posted {half}+{half}={half*2} — one line fits, "
              f"the merged pair must not")
        # A single line of the same quantity MUST still be accepted, or the 409
        # above proves only that the quantity was too big, not that merging
        # happened. Without this the check has a second way to pass wrongly.
        # Rolled back immediately: this is a real sale endpoint.
        st_single = cash.code("pos/checkout.php", "POST",
              {"items": [{"id": "db-steak", "qty": half}],
               "order_type": "pickup", "customer_type": "regular", "pay_method": "cash"})
        check(st_single == 201,
              "a single line of that quantity is accepted (so the 409 above was the merge)",
              f"got {st_single} — if this is also 409 the quantity alone was too big "
              f"and the merge was never demonstrated")
        if st_single == 201:
            # The suite has no teardown for POS orders — its cleanup deletes the
            # two customer-checkout orders by id and nothing else. This one is
            # removed here, with its stock and `sold` movement reversed, because
            # an untracked walk-in sale skews revenue and inventory for ever.
            sql("DELETE oi FROM order_items oi JOIN orders o ON o.id = oi.order_id "
                "  WHERE o.type='walk-in' AND o.cashier IS NOT NULL "
                "    AND o.datetime >= NOW() - INTERVAL 2 MINUTE "
                "    AND o.customer_name='Walk-In Customer'; "
                "DELETE FROM orders WHERE type='walk-in' AND cashier IS NOT NULL "
                "  AND datetime >= NOW() - INTERVAL 2 MINUTE "
                "  AND customer_name='Walk-In Customer'; "
                f"UPDATE products SET stock = stock + {half}, "
                f"       sold = GREATEST(sold - {half}, 0) WHERE id='db-steak';")
            check(sql_scalar("SELECT stock FROM products WHERE id='db-steak'") == str(steak_stock),
                  "the oversell check leaves db-steak stock where it found it",
                  f"expected {steak_stock}")
    orders = sessions["Online Orders Staff"]
    pending = orders.call("orders/list.php?status=pending&limit=1")[1]["data"]
    check(bool(pending), "fixture: a pending order exists to transition")
    if pending:
        oid = pending[0]["id"]
        check(orders.code("orders/status.php", "POST", {"id": oid, "status": "completed"}) == 409,
              "illegal status transition (pending -> completed) is refused")
        check(orders.code("orders/status.php", "POST", {"id": oid, "status": "on-hold"}) == 422,
              "on-hold without a reason is refused")
    check(sessions["Admin"].code("users/save.php", "POST",
          {"name": "Escalate", "email": "esc@elishabay.ph", "role_id": 1,
           "password": "Valid@1234"}) == 403,
          "Admin cannot create a Super Admin (privilege escalation blocked)")
    check(admin.code("users/archive.php", "POST", {"id": "emp-01", "archived": True}) == 403,
          "cannot archive your own account")
    check(admin.code("roles/save.php", "POST",
          {"id": 1, "name": "Super Admin", "permissions": []}) == 403,
          "system role cannot be edited")

    # ---------------------------------------------------------------- 6
    section("6. Writes persist (create -> read back -> delete)")
    st, pl = admin.call("products/save.php", "POST",
                        {"name": "VERIFY Temp Product", "category_id": "cat-db", "price": 123.45})
    if st != 201:
        check(False, "create a product", json.dumps(pl)[:200])
    else:
        pid = pl["data"]["id"]
        check(pl["data"]["price"] == 123.45, "created product returns the stored price")
        found = admin.call(f"products/list.php?search=VERIFY&status=all")[1]["data"]
        check(any(p["id"] == pid for p in found), "created product is readable afterwards")
        check(admin.call("products/save.php", "POST",
              {"id": pid, "name": "VERIFY Temp Product", "category_id": "cat-db",
               "price": 200, "stock": 99999})[1]["data"]["stock"] == 0,
              "update ignores client-supplied stock")
        admin.call("products/archive.php", "POST", {"id": pid, "archived": True})
        after = admin.call(f"products/list.php?search=VERIFY&status=archived")[1]["data"]
        check(any(p["id"] == pid for p in after), "archive persists")

        # Archiving accepts products.manage OR inventory.manage. Inventory Staff
        # hold the latter, whose label reads "Restock, adjust & archive
        # inventory" — taking a discontinued line off the shelf is stock work.
        # Cashier and Online Orders Staff hold neither and are still refused, so
        # the widening is to one role rather than to everybody signed in.
        check(sessions["Inventory Staff"].code(
              "products/archive.php", "POST", {"id": pid, "archived": False}) == 200,
              "Inventory Staff may archive (inventory.manage)")
        check(sessions["Cashier"].code(
              "products/archive.php", "POST", {"id": pid, "archived": True}) == 403,
              "Cashier still may not archive")
        check(sessions["Online Orders Staff"].code(
              "products/archive.php", "POST", {"id": pid, "archived": True}) == 403,
              "Online Orders Staff still may not archive")
        # cleanup
        import subprocess
        subprocess.run([MYSQL_EXE, "-u", "root", "elisha_bay_db",
                        "-e", f"DELETE FROM products WHERE id='{pid}'; "
                              f"DELETE FROM audit_logs WHERE description LIKE '%VERIFY Temp%';"],
                       capture_output=True)
        # Was check(True, ...) — a label with no assertion behind it.
        check(sql_scalar("SELECT COUNT(*) FROM products WHERE id='%s'" % pid) == "0",
              "product test rows cleaned up")

    # ---------------------------------------------------------------- 6b
    section("6b. Customer authentication and order attribution")
    import time as _t

    # Every write below leaves an audit row, and filtering those by message
    # text was guesswork that missed most of them — the suite grew the audit
    # log by seven rows on every run. Take the highest existing id now and
    # delete anything above it at the end of 6c instead. Wording-independent,
    # and it cannot touch a row that predates the suite.
    audit_mark = int(sql_scalar("SELECT COALESCE(MAX(id),0) FROM audit_logs") or 0)

    # D16: fixed seeded accounts. Nothing is created here — cus-t01 and cus-t02
    # are seeded rows, and setup resets their state rather than making new ones.
    cust_email = "test.shopper@elishabay.ph"
    cust_pw    = "Test@Cust1"
    cust_id    = "cus-t01"
    claim_email = "test.claimant@elishabay.ph"

    check(sql_scalar("SELECT COUNT(*) FROM customers WHERE id IN ('cus-t01','cus-t02')") == "2",
          "fixture: seeded test customers cus-t01 and cus-t02 exist",
          "run db/seed.sql — the customer-auth tests need them")

    # Reset the fixtures to their known state: t01 has the test password,
    # t02 has none so the register-claim path can run again.
    sql("UPDATE customers SET password='%s', status='active' WHERE id='cus-t01'; "
        "UPDATE customers SET password=NULL, status='active' WHERE id='cus-t02'; "
        "DELETE FROM login_attempts WHERE email IN ('%s','%s');"
        % (CUST_HASH, cust_email, claim_email))

    shopper = Session("customer")

    # Registering with an address that already has a customer row claims that
    # row rather than creating a duplicate — so past guest orders follow the
    # person. cus-t02 has no password, which is the claimable state.
    st, pl = shopper.call("shop/register.php", "POST",
                          {"name": "Test Claimant", "email": claim_email,
                           "password": "Cl@imed123", "contact": "09171234567",
                           "address": "1 Test St, Dagupan"})
    check(st == 201 and pl.get("data", {}).get("claimedExistingRecord") is True,
          "shop/register: an existing record is claimed, not duplicated",
          json.dumps(pl)[:200])
    check(sql_scalar("SELECT COUNT(*) FROM customers WHERE email='%s'" % claim_email) == "1",
          "shop/register: claiming created no duplicate row")
    shopper.call("auth/logout.php", "POST", {})

    if True:

        check(shopper.login_customer(cust_email, "wrong-password")[0] == 401,
              "customer login rejects a wrong password")
        check(shopper.code("shop/me.php") == 401,
              "a rejected login leaves no session behind")
        # A seeded customer has password NULL and must not be loggable-in with
        # an empty or arbitrary password.
        check(Session("x").login_customer("plim@gmail.com", "anything")[0] == 401,
              "a customer with no password set cannot sign in")

        st, pl = shopper.login_customer(cust_email, cust_pw)
        check(st == 200, "customer login accepts the correct password")
        check(shopper.call("shop/me.php")[1]["data"]["customer"]["id"] == cust_id,
              "the session carries the right customer id")

        # D7: one identity endpoint, reporting which kind of session this is.
        me_c = shopper.call("auth/me.php")[1].get("data", {})
        check(me_c.get("type") == "customer" and me_c.get("customer", {}).get("id") == cust_id,
              "auth/me.php reports type=customer for a shopper session",
              json.dumps(me_c)[:140])
        check("permissions" not in me_c,
              "a customer session carries no permissions key at all")
        me_s = admin.call("auth/me.php")[1].get("data", {})
        check(me_s.get("type") == "staff" and me_s.get("user", {}).get("role") == "Super Admin",
              "auth/me.php reports type=staff for a staff session",
              json.dumps(me_s)[:140])
        check(shopper.code("users/list.php") in (401, 403),
              "a customer session cannot reach a staff endpoint")

        pid = admin.call("products/list.php?limit=1")[1]["data"][0]["id"]
        cart = {"items": [{"id": pid, "qty": 1}], "name": "Test Shopper",
                "contact": "09171234567", "order_type": "pickup",
                "pay_method": "cash"}

        # D6: an identity in the body is REFUSED, not ignored. Two shapes,
        # because ignoring one and honouring the other is the failure mode.
        for field, value in [("email", "plim@gmail.com"), ("customer_id", "cus-01")]:
            st, pl = shopper.call("shop/checkout.php", "POST", {**cart, field: value})
            check(st == 422 and field in pl.get("error", {}).get("fields", {}),
                  f"checkout refuses an identity in the body: {field}",
                  f"status={st} {json.dumps(pl)[:140]}")

        st, pl = shopper.call("shop/checkout.php", "POST", cart)
        signed_order = pl["data"]["id"] if st in (200, 201) else None
        check(signed_order is not None, "signed-in checkout succeeds", json.dumps(pl)[:200])
        mine = shopper.call("shop/my-orders.php?limit=20")[1]["data"]
        check(any(o["id"] == signed_order for o in mine),
              "the order lands in the signed-in customer's own history")
        owner = admin.call(f"orders/list.php?search={signed_order}&limit=1")[1]["data"]
        check(len(owner) == 1 and owner[0].get("customerId") == cust_id,
              "the order is attributed to the session's customer, not the form",
              f"customerId={owner[0].get('customerId') if owner else 'no row'}")

        # D6: guest checkout is gone. It is not enough that a guest order claims
        # nobody — the attempt must be refused, or the suite would keep passing
        # if guest checkout were reintroduced.
        guest = Session("guest")
        st, pl = guest.call("shop/checkout.php", "POST", cart)
        check(st == 401, "guest checkout is refused outright (no guest orders)",
              f"status={st} {json.dumps(pl)[:140]}")
        guest_order = "-none-"
        check(sql_scalar("SELECT COUNT(*) FROM orders WHERE customer_name='Test Shopper' "
                         "AND customer_id IS NULL") == "0",
              "the refused guest attempt wrote no order row")

        # Orders made during the test are removed; the ACCOUNTS are reset, not
        # deleted — they are seeded fixtures and must survive the run (D16).
        sql(f"DELETE FROM order_items WHERE order_id IN ('{signed_order}','{guest_order}'); "
            f"DELETE FROM orders WHERE id IN ('{signed_order}','{guest_order}'); "
            f"UPDATE customers SET password=NULL WHERE id='cus-t02'; "
            # The checkout audit row records the buyer in `actor`, not in the
            # description — filtering on description alone left every test run's
            # rows behind, and the audit log grew by two on each pass.
            f"DELETE FROM audit_logs WHERE actor IN ('Verify Shopper','Stranger') "
            f"   OR description LIKE '%{signed_order}%' "
            f"   OR description LIKE '%{guest_order}%';")
        # Was check(True, ...). Verify both the customer and its orders are gone.
        # cus-t01 is a seeded fixture and must REMAIN, so it is not counted
        # here. Only the orders created during the run should be gone.
        leftover = sql_scalar(
            "SELECT COUNT(*) FROM orders WHERE id IN ('%s','%s')"
            % (signed_order, guest_order))
        check(leftover == "0", "customer test rows cleaned up",
              f"{leftover} row(s) remain")
        check(sql_scalar("SELECT COUNT(*) FROM customers WHERE id IN ('cus-t01','cus-t02')") == "2",
              "seeded test accounts survive the run (test data does not grow or shrink)")

    # ---------------------------------------------------------------- 6c
    section("6c. Remaining write endpoints - round-trip and validation")
    # Phase 6 items 3 and 5 ask that every create/update round-trips and that
    # bad input fails cleanly. Sections 4-6 covered products, users, roles,
    # inventory adjustments, orders, POS and customer auth. These are the ten
    # write endpoints that had no coverage at all. Every mutation is undone
    # afterwards so the suite can run repeatedly against seed data.

    # --- batches/save.php -------------------------------------------------
    inv = sessions["Inventory Staff"]
    check(inv.code("batches/save.php", "POST", {}) == 422,
          "batches/save: empty body returns 422")
    check(inv.code("batches/save.php", "POST", {
          "lot_code": "VERIFY-LOT-1", "product_id": "bg-pesto",
          "production_date": "2026-06-01", "expiry_date": "2026-05-01",
          "lab_status": "passed", "total_qty": 10}) == 422,
          "batches/save: expiry before production is refused")
    st, pl = inv.call("batches/save.php", "POST", {
        "lot_code": "VERIFY-LOT-1", "product_id": "bg-pesto",
        "production_date": "2026-06-01", "expiry_date": "2027-06-01",
        "lab_status": "passed", "total_qty": 10})
    bid = pl.get("data", {}).get("id")
    check(st == 201 and bid, "batches/save: creates a batch", json.dumps(pl)[:160])
    if bid:
        back = inv.call("batches/list.php?search=VERIFY-LOT-1")[1]["data"]
        check(any(b["id"] == bid for b in back), "batches/save: reads back from MySQL")
        check(inv.code("batches/save.php", "POST", {
              "lot_code": "VERIFY-LOT-1", "product_id": "bg-pesto",
              "production_date": "2026-06-01", "expiry_date": "2027-06-01",
              "lab_status": "passed", "total_qty": 10}) == 409,
              "batches/save: duplicate lot code returns 409")
        sql("DELETE FROM batches WHERE id='%s';" % bid)

    # --- customers/save.php -----------------------------------------------
    check(admin.code("customers/save.php", "POST", {}) == 422,
          "customers/save: empty body returns 422")
    check(admin.code("customers/save.php", "POST",
          {"name": "X" * 300, "email": "verify-cust@example.com"}) == 422,
          "customers/save: over-long name is refused")
    check(admin.code("customers/save.php", "POST",
          {"name": "Bad Email", "email": "not-an-email"}) == 422,
          "customers/save: malformed email is refused")
    st, pl = admin.call("customers/save.php", "POST",
                        {"name": "VERIFY Customer", "email": "verify-c@example.com",
                         "contact": "09171234567"})
    cid = pl.get("data", {}).get("id")
    check(st == 201 and cid, "customers/save: creates a customer", json.dumps(pl)[:160])
    if cid:
        check(sql_get("SELECT name FROM customers WHERE id='%s'" % cid) == "VERIFY Customer",
              "customers/save: persisted to MySQL")
        check(admin.code("customers/save.php", "POST",
              {"name": "Clash", "email": "verify-c@example.com"}) == 409,
              "customers/save: duplicate email returns 409")
        st2, _ = admin.call("customers/save.php", "POST",
                            {"id": cid, "name": "VERIFY Renamed",
                             "email": "verify-c@example.com", "contact": "09171234567"})
        check(st2 == 200 and sql_get("SELECT name FROM customers WHERE id='%s'" % cid) == "VERIFY Renamed",
              "customers/save: update round-trips")
        sql("DELETE FROM customers WHERE id='%s';" % cid)

        # Retailer status unlocks wholesale pricing and credit terms and must
        # come from b2b/decide.php. The endpoint's own comment said so while
        # its whitelist still accepted it, so a plain POST created a retailer.
        check(admin.code("customers/save.php", "POST",
              {"name": "VERIFY Promote", "email": "verify-promote@example.com",
               "status": "retailer"}) == 422,
              "customers/save: cannot create a retailer directly")
        check(admin.code("customers/save.php", "POST",
              {"id": cid, "name": "VERIFY Renamed", "email": "verify-c@example.com",
               "status": "retailer"}) == 422,
              "customers/save: cannot promote a customer to retailer")
        existing_retailer = sql_get("SELECT id FROM customers WHERE status='retailer' LIMIT 1")
        check(bool(existing_retailer), "fixture: a seeded retailer exists")
        if existing_retailer:
            row = sql_get("SELECT CONCAT(name,'|',email) FROM customers WHERE id='%s'"
                          % existing_retailer).split("|")
            check(admin.code("customers/save.php", "POST",
                  {"id": existing_retailer, "name": row[0], "email": row[1],
                   "status": "retailer"}) == 200,
                  "customers/save: an existing retailer is still editable")

    # --- categories/archive.php -------------------------------------------
    # cat-bg holds active products, so archiving it must be refused rather than
    # leaving those products filed under a variety no filter shows.
    check(admin.code("categories/archive.php", "POST",
          {"id": "cat-bg", "archived": True}) in (409, 422),
          "categories/archive: refuses a variety that still has active products")
    check(sql_get("SELECT archived FROM categories WHERE id='cat-bg'") == "0",
          "categories/archive: the refused variety is untouched")
    st, pl = admin.call("categories/save.php", "POST", {"name": "VERIFY Variety"})
    tmp_cat = pl.get("data", {}).get("id")
    check(bool(tmp_cat), "fixture: throwaway category created")
    if tmp_cat:
        check(admin.code("categories/archive.php", "POST",
              {"id": tmp_cat, "archived": True}) == 200,
              "categories/archive: an empty variety archives")
        check(sql_get("SELECT archived FROM categories WHERE id='%s'" % tmp_cat) == "1",
              "categories/archive: persisted to MySQL")
        sql("DELETE FROM categories WHERE id='%s';" % tmp_cat)

    # --- settings/save.php ------------------------------------------------
    original_rate = sql_get("SELECT value_text FROM settings WHERE key_name='penalty_rate'")
    check(admin.code("settings/save.php", "POST", {"penalty_rate": -5}) == 422,
          "settings/save: a negative penalty rate is refused")
    check(admin.code("settings/save.php", "POST", {"penalty_rate": 3.5}) == 200,
          "settings/save: accepts a valid rate")
    check(sql_get("SELECT value_text FROM settings WHERE key_name='penalty_rate'") == "3.5",
          "settings/save: persisted to MySQL")
    check(admin.call("payments/list.php?limit=1")[1]["meta"].get("penaltyRate") == 3.5,
          "settings/save: payments/list reports the new rate back")
    admin.call("settings/save.php", "POST", {"penalty_rate": float(original_rate)})

    # --- content/save.php -------------------------------------------------
    before = admin.call("content/get.php")[1]["data"]
    check(admin.code("content/save.php", "POST", {"about": "VERIFY about copy."}) == 200,
          "content/save: accepts a partial save")
    after = admin.call("content/get.php")[1]["data"]
    check(after.get("about") == "VERIFY about copy.", "content/save: round-trips")
    # Must be non-empty as well as equal: two missing keys compare equal.
    check(bool(before.get("vision")) and after.get("vision") == before.get("vision"),
          "content/save: a partial save does not blank the other panels",
          f"before={before.get('vision')!r} after={after.get('vision')!r}")
    admin.call("content/save.php", "POST", {"about": before.get("about") or ""})

    # --- notifications/read.php -------------------------------------------
    nid = sql_get("SELECT id FROM notifications WHERE is_read=0 ORDER BY created_at DESC LIMIT 1")
    check(bool(nid), "fixture: an unread notification exists")
    if nid:
        check(inv.code("notifications/read.php", "POST", {"id": nid}) == 200,
              "notifications/read: marks one read")
        check(sql_get("SELECT is_read FROM notifications WHERE id='%s'" % nid) == "1",
              "notifications/read: persisted to MySQL")
        sql("UPDATE notifications SET is_read=0 WHERE id='%s';" % nid)

    # --- orders/verify-payment.php ----------------------------------------
    # Ordered and status-filtered, deliberately.
    #
    # This was `... WHERE proof_uploaded=1 AND pay_verified=0 LIMIT 1` with no
    # ORDER BY and no status filter, so it took whatever row MySQL happened to
    # return first. When that row turned out to be a CANCELLED order,
    # verify-payment.php correctly refused it and two checks failed for a reason
    # that had nothing to do with the endpoint.
    #
    # A fixture picked non-deterministically is a test that fails on Tuesdays.
    # Only pending/on-hold orders can be verified — that is what the Payment
    # Verification screen lists — so the query now asks for one of those, oldest
    # first so the same row is chosen on every run.
    oid = sql_get("SELECT id FROM orders "
                  " WHERE proof_uploaded=1 AND pay_verified=0 "
                  "   AND status IN ('pending','on-hold') "
                  " ORDER BY datetime ASC LIMIT 1")
    ords = sessions["Online Orders Staff"]
    check(bool(oid), "fixture: an order with payment proof awaiting verification exists",
          "needs an online order with proof, unverified, still pending or on-hold")
    if oid:
        check(ords.code("orders/verify-payment.php", "POST",
              {"id": "ORD-DOES-NOT-EXIST", "verified": True}) in (404, 422),
              "orders/verify-payment: unknown order is refused")
        check(ords.code("orders/verify-payment.php", "POST",
              {"id": oid, "verified": True}) == 200,
              "orders/verify-payment: verifies an order that has proof")
        check(sql_get("SELECT pay_verified FROM orders WHERE id='%s'" % oid) == "1",
              "orders/verify-payment: persisted to MySQL")
        sql("UPDATE orders SET pay_verified=0 WHERE id='%s';" % oid)

    # --- payments/settle.php ----------------------------------------------
    pay = sql_get("SELECT id FROM payment_accounts WHERE paid=0 LIMIT 1")
    check(bool(pay), "fixture: an unsettled payment account exists")
    if pay:
        check(admin.code("payments/settle.php", "POST", {"id": pay, "paid": True}) == 200,
              "payments/settle: settles an account")
        check(sql_get("SELECT paid FROM payment_accounts WHERE id='%s'" % pay) == "1",
              "payments/settle: persisted to MySQL")
        sql("UPDATE payment_accounts SET paid=0 WHERE id='%s';" % pay)

    # --- returns/advance.php ----------------------------------------------
    ret = sql_get("SELECT id FROM product_returns WHERE status='received' LIMIT 1")
    check(bool(ret), "fixture: a return at status=received exists")
    if ret:
        check(ords.code("returns/advance.php", "POST",
              {"id": ret, "status": "processed"}) in (409, 422),
              "returns/advance: refuses a jump straight to processed")
        check(ords.code("returns/advance.php", "POST",
              {"id": ret, "status": "validated"}) == 200,
              "returns/advance: allows the next legal step")
        check(sql_get("SELECT status FROM product_returns WHERE id='%s'" % ret) == "validated",
              "returns/advance: persisted to MySQL")
        sql("UPDATE product_returns SET status='received' WHERE id='%s';" % ret)

    # --- b2b/decide.php ---------------------------------------------------
    # app_id in the request body is app_id_code ("APP-2026-007"), not the
    # numeric primary key. Pick an applicant who is NOT already a retailer,
    # otherwise the promotion check passes without the endpoint doing anything.
    app = sql_get("SELECT a.app_id_code FROM b2b_applications a "
                  "JOIN customers c ON c.id = a.customer_id "
                  "WHERE a.status='pending' AND c.status <> 'retailer' LIMIT 1")
    check(bool(app), "fixture: a pending B2B application from a non-retailer exists")
    if app:
        app_cust = sql_get("SELECT customer_id FROM b2b_applications "
                           "WHERE app_id_code='%s'" % app)
        prev_status = sql_get("SELECT status FROM customers WHERE id='%s'" % app_cust)
        check(prev_status != "retailer",
              "b2b/decide: the test applicant starts as a non-retailer")
        check(admin.code("b2b/decide.php", "POST",
              {"app_id": app, "decision": "sideways"}) == 422,
              "b2b/decide: an unknown decision is refused")
        check(admin.code("b2b/decide.php", "POST",
              {"app_id": app, "decision": "approved", "tier": "Silver"}) == 200,
              "b2b/decide: approves an application")
        check(sql_get("SELECT status FROM b2b_applications WHERE app_id_code='%s'" % app) == "approved",
              "b2b/decide: persisted to MySQL")
        check(sql_get("SELECT status FROM customers WHERE id='%s'" % app_cust) == "retailer",
              "b2b/decide: approval promotes the customer to retailer")
        check(admin.code("b2b/decide.php", "POST",
              {"app_id": app, "decision": "rejected"}) in (409, 422),
              "b2b/decide: a settled application cannot be re-decided")
        # `assigned_tier`, not `tier`. Naming the wrong column made mysql
        # reject the whole batch, so the approval was never rolled back.
        sql("UPDATE b2b_applications SET status='pending', assigned_tier=NULL "
            "  WHERE app_id_code='%s'; "
            "UPDATE customers SET status='%s' WHERE id='%s';"
            % (app, prev_status, app_cust))

    # --- audit sweep -------------------------------------------------------
    sql("DELETE FROM audit_logs WHERE id > %d;" % audit_mark)
    check(int(sql_scalar("SELECT COALESCE(MAX(id),0) FROM audit_logs") or 0) == audit_mark,
          "6b/6c leave no audit rows behind")

    # ---------------------------------------------------------------- 6d
    section("6d. Money — revenue definition and historical amounts")

    # D2: one definition, and it excludes anything not paid and fulfilled.
    rep = admin.call("reports/sales.php?range=all")[1]["data"]
    check(rep.get("revenueStatuses") == ["completed"],
          "reports/sales declares its revenue statuses",
          json.dumps(rep.get("revenueStatuses")))
    sql_rev = sql_scalar("SELECT ROUND(COALESCE(SUM(total),0),2) FROM orders "
                         "WHERE status='completed'")
    check(abs(float(rep["totals"]["revenue"]) - float(sql_rev)) < 0.01,
          "revenue equals SUM(total) over completed orders only",
          f"api={rep['totals']['revenue']} sql={sql_rev}")
    not_counted = sql_scalar("SELECT ROUND(COALESCE(SUM(total),0),2) FROM orders "
                             "WHERE status IN ('pending','on-hold','accepted','shipping','delivered')")
    check(float(not_counted) > 0,
          "fixture: unpaid/unfulfilled orders exist to be excluded", f"={not_counted}")
    check(abs(float(rep["totals"]["revenue"]) - (float(sql_rev) + float(not_counted))) > 0.01,
          "pending / on-hold / in-flight orders are NOT counted as revenue",
          "revenue equals the everything-but-cancelled figure, so the old rule is back")

    # D2: refunds are their own line, never netted into revenue.
    ref = rep.get("refunds", {})
    check("amount" in ref and "net" in ref,
          "refunds are reported as a separate line")
    check(abs(float(ref["net"]) - (float(rep["totals"]["revenue"]) - float(ref["amount"]))) < 0.01,
          "net is revenue minus refunds, and revenue itself is left gross")

    # D3: historical money is read, not recomputed.
    old_price = sql_scalar("SELECT price FROM products WHERE id='bg-pesto'")
    before_rev = float(rep["totals"]["revenue"])
    sql("UPDATE products SET price = price * 3 WHERE id='bg-pesto';")
    after = admin.call("reports/sales.php?range=all")[1]["data"]
    check(abs(float(after["totals"]["revenue"]) - before_rev) < 0.01,
          "tripling a product price does not move historical revenue",
          f"before={before_rev} after={after['totals']['revenue']}")
    line = admin.call("orders/list.php?limit=1&sort=oldest")[1]["data"][0]
    pesto = next((i for i in line["items"] if i["id"] == "bg-pesto"), None)
    check(pesto is None or abs(float(pesto["price"]) - float(old_price)) < 0.01,
          "order line items report price_at_purchase, not the current price",
          f"line={pesto['price'] if pesto else 'n/a'} current={float(old_price)*3}")
    sql(f"UPDATE products SET price = {old_price} WHERE id='bg-pesto';")
    check(sql_scalar("SELECT price FROM products WHERE id='bg-pesto'") == old_price,
          "product price restored")

    # ---------------------------------------------------------------- 6e
    section("6e. Dates (D1) - one resolver, Asia/Manila, no UTC")

    st, pl = admin.call("system/dates.php")
    d = pl.get("data", {})
    check(st == 200 and d.get("timezone") == "Asia/Manila",
          "system/dates.php reports Asia/Manila", json.dumps(d)[:140])
    check(d.get("today") == sql_scalar("SELECT CURDATE()"),
          "PHP's today matches MySQL CURDATE()",
          f"php={d.get('today')} mysql={sql_scalar('SELECT CURDATE()')}")
    check(d.get("mysqlAgrees") is True,
          "the endpoint itself confirms PHP and MySQL agree", json.dumps(d.get("drift")))

    ranges = d.get("ranges", {})
    for name in ["today", "yesterday", "week", "lastweek", "month",
                 "lastmonth", "year", "lastyear", "all"]:
        check(name in ranges, f"range '{name}' is resolved server-side")
    check(ranges.get("week", {}).get("from") ==
          sql_scalar("SELECT DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)"),
          "the week starts Monday, and both ends agree on which Monday",
          f"server={ranges.get('week', {}).get('from')}")
    check(ranges.get("lastmonth", {}).get("to") ==
          sql_scalar("SELECT LAST_DAY(CURDATE() - INTERVAL 1 MONTH)"),
          "last month ends on the real last day of that month")

    # Boundary arithmetic - month ends, year wraps, leap day, and the
    # off-by-one that made every NET-30 due date land a day early.
    php_cases = [
        ("2026-01-31", 1, "2026-02-01", "month end"),
        ("2026-02-28", 1, "2026-03-01", "non-leap February"),
        ("2028-02-28", 1, "2028-02-29", "leap year"),
        ("2028-02-29", 1, "2028-03-01", "leap day"),
        ("2026-12-31", 1, "2027-01-01", "year wrap"),
        ("2027-01-01", -1, "2026-12-31", "year wrap backwards"),
        ("2028-03-01", -1, "2028-02-29", "back into a leap day"),
        ("2026-06-17", 30, "2026-07-17", "NET-30 (the UTC off-by-one)"),
    ]
    for ymd, n, want, label in php_cases:
        out = subprocess.run(
            [PHP_EXE, "-r",
             'require "api/core/Dates.php"; echo Dates::addDays("%s", %d);' % (ymd, n)],
            capture_output=True, text=True, cwd=PROJECT_DIR)
        check(out.stdout.strip() == want, f"addDays: {label}",
              f"{ymd} {n:+d} gave {out.stdout.strip()!r}, expected {want!r}")

    # ---------------------------------------------------------------- 7
    section("7. Envelope shape")
    st, pl = admin.call("products/list.php?limit=1")
    check(pl.get("ok") is True and "data" in pl and "meta" in pl,
          "success envelope has ok/data/meta")
    st, pl = admin.call("products/save.php", "POST", {})
    check(pl.get("ok") is False and set(pl.get("error", {})) >= {"code", "message", "fields"},
          "error envelope has ok/error{code,message,fields}")

    # Silent coverage loss guard. Every assertion above is unconditional or
    # preceded by a fixture check, so the total is fixed. If this number drops,
    # assertions stopped running rather than started passing — which is exactly
    # how 29 skipped checks hid behind "All checks passed".
    # Teardown: the suite's own sign-ins leave rows in login_attempts (a success
    # inserts a row, and the deliberate failures in section 1 insert more). Setup
    # cleared the FAILED ones so the lockout does not trip on a repeat run, but
    # nothing removed the successes, so the table grew by six per run. D16 says
    # test data must not grow — that includes audit-shaped tables, not just
    # accounts. Removes only rows belonging to the fixed test accounts.
    _accounts = "','".join([e for e, _ in ROLES.values()] +
                           ["admin2@elishabay.ph", "nobody@nowhere.ph",
                            "throttle-probe@example.com",
                            "test.shopper@elishabay.ph", "test.claimant@elishabay.ph"])
    sql("DELETE FROM login_attempts WHERE email IN ('" + _accounts + "');")
    check(sql_scalar("SELECT COUNT(*) FROM login_attempts WHERE email IN ('"
                     + _accounts + "')") == "0",
          "the suite leaves no login_attempts rows behind")

    # ---- payment-proof consistency -------------------------------------
    # `proof_uploaded` means "the customer supplied something for staff to
    # check" — a reference number, an image, or both. It used to be set from
    # whether a reference NUMBER was typed, and 30 seeded rows carried it with
    # neither, so Payment Verification and the Order Detail modal reported
    # "Proof Uploaded" over nothing at all.
    #
    # Both directions are asserted. A flag with no evidence tells staff to
    # verify something that does not exist; evidence with no flag hides a real
    # payment from the screen that exists to check it.
    check(sql_scalar(
        "SELECT COUNT(*) FROM orders WHERE proof_uploaded = 1 "
        "  AND (proof_ref_num IS NULL OR proof_ref_num = '') "
        "  AND (proof_image_path IS NULL OR proof_image_path = '')") == "0",
        "no order claims a payment proof it does not have")
    check(sql_scalar(
        "SELECT COUNT(*) FROM orders WHERE proof_uploaded = 0 "
        "  AND ((proof_ref_num IS NOT NULL AND proof_ref_num <> '') "
        "       OR (proof_image_path IS NOT NULL AND proof_image_path <> ''))") == "0",
        "no order hides a payment proof it does have")

    ran = passed + len(failed)          # count before this guard is itself counted
    check(ran == EXPECTED_CHECKS,
          f"all {EXPECTED_CHECKS} assertions ran",
          f"ran {ran}, expected {EXPECTED_CHECKS} — assertions stopped running, "
          f"which is not the same as starting to pass")

    print()
    if failed:
        print(f"{RED}{len(failed)} of {passed + len(failed)} checks failed:{RESET}")
        for f in failed:
            print(f"  - {f}")
        sys.exit(1)
    print(f"{GREEN}All {passed} checks passed.{RESET}")
    sys.exit(0)


if __name__ == "__main__":
    main()
