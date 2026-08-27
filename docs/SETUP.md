# Setup — Elisha Bay

Getting the project running on a fresh machine. Assumes XAMPP with PHP 8.2 and
MariaDB 10.4 (what this was built and tested against).

---

## 1. Put the project where Apache can see it

The project must live inside the XAMPP web root:

```
C:\xampp\htdocs\elishabay\
```

Served at **http://localhost/elishabay/**. The folder name matters — nothing is
hardcoded to it (paths are derived at runtime), but the rest of this document
assumes `elishabay`.

---

## 2. Start Apache and MySQL

Open the XAMPP Control Panel and press **Start** next to both **Apache** and
**MySQL**. Wait until both show a green "Running" state.

If Apache refuses to start, something else is on port 80 — usually IIS, Skype,
or another web server. Check with:

```bash
netstat -ano | findstr :80
```

Verify Apache is serving the project:

```bash
curl -o NUL -w "%{http_code}\n" http://localhost/elishabay/
```

`200` means you are good.

---

## 3. Create the database

Two ways. Either is fine.

### Option A — phpMyAdmin (click-through)

1. Open <http://localhost/phpmyadmin>
2. **Import** tab → **Choose File** → `C:\xampp\htdocs\elishabay\db\schema.sql` → **Go**
   The file creates the `elisha_bay_db` database itself, so do not create it first.
3. **Import** again → this time `db/seed.sql` → **Go**

Order matters. `seed.sql` only inserts rows; it will fail against an empty
server if the schema has not been imported first.

### Option B — command line (faster, and shows real errors)

```bash
C:\xampp\mysql\bin\mysql.exe -u root < C:\xampp\htdocs\elishabay\db\schema.sql
```

```bash
C:\xampp\mysql\bin\mysql.exe -u root < C:\xampp\htdocs\elishabay\db\seed.sql
```

Confirm it worked — expect 21 tables and 15 products:

```bash
C:\xampp\mysql\bin\mysql.exe -u root elisha_bay_db -e "SHOW TABLES; SELECT COUNT(*) AS products FROM products;"
```

### 3c. Run the migrations

```bash
C:\xampp\mysql\bin\mysql.exe -u root elisha_bay_db < db\migrations\001-unify-batch-codes.sql
```

**Not optional after a fresh seed.** `seed.sql` reproduces the original JS
arrays faithfully, defects included: it carries three batch-code formats, and
none of the order or return codes match a real lot. Migration 001 resolves them
to real batches of the same product, and NULLs the ones no batch can justify.
It is idempotent and prints a before/after count.

### Re-importing

`schema.sql` begins with `DROP TABLE IF EXISTS` for every table, so re-running
it **destroys all data** and gives you a clean slate. That is intended for
development. Run `seed.sql` again afterwards to repopulate.

---

## 4. Configure credentials

```bash
copy C:\xampp\htdocs\elishabay\api\config\config.example.php C:\xampp\htdocs\elishabay\api\config\config.php
```

Open `api/config/config.php` and set `db.user` / `db.pass` if your MySQL root
account is not the XAMPP default (user `root`, empty password).

- **`config.php` is gitignored.** It holds real credentials and must never be
  committed. `config.example.php` is the template that does get committed —
  keep the two in sync when you add a key.
- `.htaccess` returns 404 for `api/config/`, `db/*.sql`, `docs/`, `tools/` and
  `_archive/`. The project sits inside the web root, so anything not explicitly
  refused is downloadable by anyone who can reach the site.

---

## 5. Test logins

Six seeded staff accounts. Passwords are stored as bcrypt hashes and verified
with `password_verify()`.

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@elishabay.ph` | `Admin@123` |
| Admin | `subadmin@elishabay.ph` | `SubAdm@2025` |
| Inventory Staff | `inventory@elishabay.ph` | `Inv@2025` |
| Cashier | `cashier@elishabay.ph` | `Cash@2025` |
| Online Orders Staff | `orders@elishabay.ph` | `Ord@2025` |
| Super Admin *(archived — should be refused)* | `admin2@elishabay.ph` | `Adm2@2025` |

These are development credentials for a capstone demo. Change them before this
is ever reachable from outside your machine.

Authentication is server-side: `api/auth/login.php` verifies against these
bcrypt hashes with `password_verify()`. **No plaintext password exists anywhere
in the project** — confirm with `grep -r "Admin@123" assets/ public/ portal/`,
which should return nothing.

Customers have their own accounts and their own session key, separate from
staff. Registering with a seeded customer's email claims that record, so their
existing orders follow them in.

---

## 6. Where things are

| Path | What it is |
|---|---|
| `public/` | Customer-facing storefront |
| `portal/` | Staff portal — `shell.html`, one folder per role, `views/` partials |
| `assets/` | CSS, JS, images. `js/portal/engine.js` is the shared engine for all five portals |
| `api/` | PHP endpoints. The only code that touches MySQL |
| `db/` | `schema.sql`, `seed.sql`, `schema-additions.sql`, and `migrations/` |
| `docs/` | Audit, progress log, this file |
| `tools/` | `verify-structure.py` (files) and `verify-api.py` (live behaviour) |
| `_archive/` | Dead files kept rather than deleted |

Portal folders are named for the **role** they accept. Note that
`portal/admin/` is the *Admin* role and `portal/super-admin/` is Super Admin.

---

## 7. Optional schema additions

`db/schema-additions.sql` adds three things the audit found the UI needs:
`order_status_history` (who moved an order and when), `audit_logs.actor_user_id`
(a real FK, so renaming an employee does not orphan their history), and
`login_attempts` (without it, login throttling is inert). **All three are in
use — apply them on a fresh install:**

```bash
C:\xampp\mysql\bin\mysql.exe -u root elisha_bay_db < C:\xampp\htdocs\elishabay\db\schema-additions.sql
```

---

## 8. Verify the structure

After any change, run both suites — the first reads files and needs no server,
the second drives the live API and needs Apache, MySQL and the seeded database:

```bash
python tools/verify-structure.py . && python tools/verify-api.py
```

All checks must pass. Anything that turns red is a regression — the nav↔section
pairing check in particular catches a whole class of broken-module bug.

---

## 9. Known gotchas

**Portals render blank when opened as a file.** The module loader uses
`fetch()`, which browsers block on `file://`. Always go through
`http://localhost/elishabay/`, never by double-clicking an HTML file.

**MySQL is not in strict mode by default.** XAMPP ships without
`STRICT_TRANS_TABLES`, which turns real constraint violations into warnings —
during setup this silently wrote empty strings into a `NOT NULL` column. The
app pins `sql_mode` per connection via `db.sql_mode` in `config.php`, so it does
not depend on server configuration. If you import SQL by hand and want the same
protection:

```bash
C:\xampp\mysql\bin\mysql.exe -u root --init-command="SET SESSION sql_mode='STRICT_ALL_TABLES'" elisha_bay_db
```

**The seed data is dated around 2026-06-17.** The application no longer has a
frozen clock — expiry, overdue payments and report ranges are computed against
the server's `CURDATE()`. But the seeded rows sit at fixed dates, so those
figures drift further from "today" as real time passes. Reseed, or shift the
dates, if the demo data starts looking stale.

**The `views/` partials are wrapped as complete HTML documents on purpose.**
Live Server injects its reload script before `</body>`; a fragment without one
gets that script injected inside the logo `<svg>` instead, which corrupts the
parse and boots a blank portal. `verify-structure.py` check 7 enforces this.
Do not "tidy" those wrappers away.

---

## 10. Before this is reachable from anywhere but your machine

The defaults in this repository are development defaults. They are deliberate,
and they are wrong for anything else. In order of severity:

1. **`security.cookie_secure` → `true`** (`api/config/config.php`). While false
   the session cookie travels over plain HTTP and can be read by anything on
   the network path — the entire session, including a Super Admin's. This needs
   HTTPS to be in place first.
2. **`app.debug` → `false`.** While true, the text of an unhandled exception —
   file paths, SQL fragments, table names — is returned to the caller rather
   than only written to the error log.
3. **Change every seeded password.** They are published in this file. Six known
   accounts with known credentials is not a demo risk once the host is public.
4. **Remove the development no-cache block from `.htaccess`** and replace it
   with real caching plus versioned filenames. It exists so that editing a JS
   file does not mean testing the previous one.
5. **Set a MySQL password.** `root` with an empty password is the XAMPP
   default and is assumed by `config.example.php`.
6. **Consider a foreign key on `orders.batch_code_hint`** (see the note at the
   end of `db/migrations/001-unify-batch-codes.sql`) so batch references cannot
   drift out of sync again.

None of these are code changes. All of them are things a working local install
will happily let you forget.

---

## Strict SQL mode (required)

`sql_mode` is pinned in **two** places, deliberately.

**1. `C:\xampp\mysql\bin\my.ini`, under `[mysqld]`:**

```ini
sql_mode=STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION
```

**2. Per connection**, in `api/config/db.php`, via `MYSQL_ATTR_INIT_COMMAND`.

The second alone is not enough. It covers the application and nothing else —
not a phpMyAdmin import, not the `mysql` CLI, not a script run by hand. Without
strict mode MariaDB **silently coerces** bad data instead of refusing it, and
that is not hypothetical here: `db/seed.sql` passed `NULL` for
`b2b_applications.business_address`, which is `NOT NULL`, and a non-strict
server quietly wrote `''` and reported success. The rows looked fine and were
wrong.

The first alone is not enough either: the defence panel will run this on a
machine whose `my.ini` you did not write.

After editing `my.ini`, **restart MySQL from the XAMPP control panel.** To
confirm it took:

```sql
SELECT @@GLOBAL.sql_mode;
```

`STRICT_ALL_TABLES` must appear. A backup of the original file is saved beside
it as `my.ini.bak-<date>`.

---

## Import order, and one trap that will bite you

```
db/schema.sql
db/schema-additions.sql
db/seed.sql
db/migrations/001-unify-batch-codes.sql
db/migrations/002-batch-code-foreign-keys.sql
```

Run them in that order. `002` adds foreign keys on the batch-code columns and
will fail unless `001` has repaired the data first.

### The trap: every file hardcodes `USE elisha_bay_db;`

`schema.sql`, `schema-additions.sql`, `seed.sql` and `001` all begin with
`USE elisha_bay_db;`. That means:

> **Selecting a different database on the command line does nothing.** The file
> switches back to `elisha_bay_db` and runs there instead.

```bash
# This does NOT do what it looks like it does:
mysql -u root some_other_db < db/schema.sql     # writes to elisha_bay_db
```

This cost real damage during remediation. An attempt to test a clean install in
a throwaway database ran `schema.sql` against the **live** one, which recreated
`audit_logs` without the `actor_user_id` column that `schema-additions.sql`
adds. Every write endpoint then failed with
`Unknown column 'a.actor_user_id'` — from a command that appeared to be operating
on a scratch database.

**To install into a differently-named database**, strip the header first:

```bash
sed -E '/^\s*(CREATE DATABASE|USE )/Id' db/schema.sql | mysql -u root your_db
```

### Re-running is safe now

`schema-additions.sql` was **not** re-runnable: `CREATE TABLE` was guarded with
`IF NOT EXISTS` but the `CREATE INDEX` and `ALTER TABLE` statements after it
were not. A second run aborted at the first duplicate index — and every
statement below that point silently never ran, including the one adding
`audit_logs.actor_user_id`. The result was a database that looked installed and
was missing a column.

All `CREATE INDEX` and `ADD COLUMN` statements now carry `IF NOT EXISTS`, and
the one `ADD CONSTRAINT` (which has no such form) is applied through a
conditional. Verified by running the file three times in a row with no errors.

`seed.sql` is deliberately **not** re-runnable — it aborts on a duplicate
primary key rather than double-seeding. To reseed, drop and recreate the
database.

---

## Keeping the demo data current

`db/seed.sql` carries a fixed era. Run this whenever the demo looks empty:

```bash
mysql -u root < db/refresh-demo-dates.sql
```

It measures the gap between today and the newest order, then shifts **every
business date** by exactly that delta — orders, batches, returns, adjustments,
credit accounts, applications, customers, notifications and the audit log.
Relative spacing is preserved: an order still precedes its batch's expiry, a
return still follows its purchase, a NET-60 account still falls due sixty days
out. Nothing is invented and no row is added or removed.

**Idempotent.** The delta comes from the data, so a second run computes zero.

`created_at` / `updated_at` are deliberately *not* shifted — they are import
metadata recording when a row entered this database, not business dates.

### Why it matters beyond appearances

The stale era was not cosmetic. It is why the client once pinned `dAgo()` to a
hardcoded `2026-06-17` — to make the demo look populated — and that constant
leaked into payment-overdue status and batch expiry, where a lot showed 336 days
of shelf life against a true 275. The code now reads the real clock; this script
fixes the other half by moving the data to the present instead.

It also corrects one seed inconsistency: `cus-04` was a `retailer` whose only
B2B application sat at `pending` — a state the enforced rules cannot produce.
Fixed by approving the application rather than demoting the customer, because he
holds a live credit account that demotion would orphan.
