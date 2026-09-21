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

**Every file in `db/migrations/`, in numeric order, naming the database each
time.** From Git Bash:

```bash
for f in db/migrations/*.sql; do /c/xampp/mysql/bin/mysql.exe -u root elisha_bay_db < "$f" || break; done
```

From `cmd`, one at a time:

```bash
C:\xampp\mysql\bin\mysql.exe -u root elisha_bay_db < db\migrations\001-unify-batch-codes.sql
```

**Not optional after a fresh seed.** `seed.sql` reproduces the original JS
arrays faithfully, defects included: it carries three batch-code formats, and
none of the order or return codes match a real lot. Migration 001 resolves them
to real batches of the same product, and NULLs the ones no batch can justify;
002 then puts foreign keys on those columns so it cannot happen again. Every
migration is safe to run twice. The full list, and why the order matters, is
under **Import order** below.

### 3d. Load the Philippine location list

The address picker (checkout, Create Account, the retailer application and
Profile) offers Region → Province → City/Municipality → Barangay from the PSA's
**Philippine Standard Geographic Code**. Migration 015 creates the four tables;
the rows are in their own file, `db/seed-ph-locations.sql`, kept out of
`seed.sql` so ordinary dumps of the project stay small.

**Load it from the command line — phpMyAdmin will refuse it.** The file is
several megabytes, and phpMyAdmin on XAMPP rejects uploads over **2 MB** by
default with an error that does not say that is the reason:

```bash
C:\xampp\mysql\bin\mysql -u root elisha_bay_db < db\seed-ph-locations.sql
```

It has no `USE` line, so it goes into the database you name, and it is safe to
re-run: it empties the four tables and reloads them in one transaction.

**Until it is loaded, nothing breaks.** Every address form falls back to a single
"Full address" box and the server accepts it, so the shop keeps taking orders.
Loading the seed switches all four forms to the dropdowns — no restart, no code
change.

**What is in there now.** 18 regions, 83 provinces, 1,642 cities and
municipalities, 42,010 barangays — PSGC as of 2026-07-13. The header of
`db/seed-ph-locations.sql` names the exact file it was built from and its
SHA-256.

It was **not** built from the PSA's own `.xlsx`. `psa.gov.ph` sits behind a
Cloudflare challenge that answers 403 to anything that is not a person clicking
through it, so the rows come from a published mirror of the same
classification (`tools/psgc-from-json.php`, see below). Rebuild from the
official publication when you can download it — same tables, same file, and the
header will then say so.

**Refreshing the list — from the PSA's publication (preferred).** The PSA
republishes the PSGC every quarter or so. Download the *PSGC Publication data
file* (`.xlsx`) from <https://psa.gov.ph/classification/psgc> — the site has a
"verify you are human" check, so this is a browser step — and save it
**unchanged** under `db/psgc/`. Do not open and re-save it in Excel: plain
"CSV" is not UTF-8, and a round trip turns "Las Piñas" and "Parañaque" into
garbage. Then:

```bash
C:\xampp\php\php.exe tools\psgc-convert.php db\psgc\<the file>.xlsx --check
C:\xampp\php\php.exe tools\psgc-convert.php db\psgc\<the file>.xlsx
C:\xampp\mysql\bin\mysql -u root elisha_bay_db < db\seed-ph-locations.sql
```

**Or from a flat JSON mirror**, which is how the current file was built. The
input is a list of `{name, type, psgc_id, parent_psgc_id}`:

```bash
C:\xampp\php\php.exe tools\psgc-from-json.php db\psgc\barangay_flat.json --check
C:\xampp\php\php.exe tools\psgc-from-json.php db\psgc\barangay_flat.json --source="..." --edition="..."
C:\xampp\mysql\bin\mysql -u root elisha_bay_db < db\seed-ph-locations.sql
```

`--check` prints the counts, the cities that have no province, and how many
barangays sit in a sub-municipality, and writes nothing. **Both importers
refuse to write a file they cannot vouch for** — a barangay with no city, a
duplicate code, a code that is not ten digits, a level neither has seen before
— because a seed with silent holes in it is worse than no seed. Neither needs
any PHP extension beyond XAMPP's defaults. Both record the source and its
SHA-256 in the generated file, so 42,000 rows are never a matter of memory.

`db/psgc/` is git-ignored: the inputs are large and are not ours to
redistribute. `db/seed-ph-locations.sql` (~2.4 MB) is the generated artefact —
commit it or regenerate it on each install, whichever your team prefers.

**Cities with no province.** Metro Manila's cities and Pateros, and highly
urbanised cities such as Cebu City, belong to no province. They are listed in
the Province dropdown under their own names, beside the real provinces, and
choosing one fills the City step with it — so "Cebu City" sits next to "Cebu",
and a Makati address never strands at a Province step with nothing to pick.

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

**MySQL will not start after the PC was shut down with it running.** XAMPP's
MariaDB is not a Windows service, so a shutdown or restart kills it mid-write.
The next start fails, and `C:\xampp\mysql\data\mysql_error.log` shows:

```
InnoDB: Missing MLOG_CHECKPOINT at … between the checkpoint … and the end …
Plugin 'InnoDB' registration as a STORAGE ENGINE failed.
```

**Prevent it:** press Stop on MySQL in the XAMPP Control Panel before shutting
the PC down, or run `C:\xampp\mysql\bin\mysqladmin.exe -u root shutdown`.

**If it has already happened** (recovered this way on 19 Sep 2026, no app data
lost):

1. Copy the whole `C:\xampp\mysql\data` folder somewhere safe first. Every step
   below is then undoable.
2. Rename `data\ib_logfile0` and `data\ib_logfile1` (do not delete them), then
   start MySQL. It rebuilds the redo log from the data files.
3. The error log will now say pages have a log sequence number "in the future".
   Write about 40 MB into a throwaway table to push the counter past them, then
   drop it. `SHOW ENGINE INNODB STATUS` shows the current number.
4. Check the grant tables — `mysqlcheck -u root --check mysql`. If `mysql.db` is
   corrupt, repairing it can empty it, and the app then fails with
   `Access denied for user 'elishabay_app'@'localhost' to database 'elisha_bay_db'`.
   Re-grant exactly what `api/config/config.example.php` documents:
   `GRANT SELECT, INSERT, UPDATE, DELETE ON elisha_bay_db.* TO 'elishabay_app'@'localhost';`
   and, for phpMyAdmin's control user,
   `GRANT SELECT, INSERT, UPDATE, DELETE ON phpmyadmin.* TO 'pma'@'localhost';`
   then `FLUSH PRIVILEGES`.
5. Stop MySQL cleanly and start it again. A start with no errors in the log is
   the proof it is fixed.

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
db/migrations/003-image-paths.sql
db/migrations/004-credit-sales.sql
db/migrations/005-customer-profile.sql
db/migrations/006-scope-completion.sql
db/migrations/007-persistent-cart.sql
db/migrations/008-customer-archive-restore.sql
db/migrations/009-backfill-product-lots.sql
db/migrations/010-notification-priority.sql
db/migrations/011-product-reviews.sql
db/migrations/012-lockout-context.sql
db/migrations/013-credit-payments.sql
db/migrations/014-vat.sql
db/migrations/015-ph-locations.sql
```

Run them in that order — numeric order is the required order — and **name the
database on every command**:

```bash
mysql -u root elisha_bay_db < db/migrations/001-unify-batch-codes.sql
```

`002` adds foreign keys on the batch-code columns and cannot until `001` has
repaired the data. Run in the wrong order it now refuses before changing anything,
and says why:

```
ERROR 1644 (45000): 42 batch code(s) resolve to no lot in this database.
Run 001-unify-batch-codes.sql against THIS database first, then this migration.
```

The rest are independent but assume everything before them has run.

**Every migration is re-runnable.** `001` and `009` are guarded data fixes (each
statement skips rows already handled); `002` onwards wrap their schema changes in
a stored procedure guarded by `information_schema`, so running one twice does
nothing the second time. `002` used to be the exception — three bare
`ALTER TABLE`s that failed with "Duplicate key on write or update" on a second
run — and is guarded like the rest now. Run them all after any `schema.sql`
reload — `schema.sql` builds the ORIGINAL tables, not the current ones.

A complete install through this order gives **37 foreign keys**. Checked by
building a scratch copy this way and comparing
`information_schema.REFERENTIAL_CONSTRAINTS` against a live install: the same 37
names with the same rules, and `001` translating the same rows the same way.

### The trap: the three setup files hardcode `USE elisha_bay_db;`

`schema.sql`, `schema-additions.sql` and `seed.sql` begin with
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

**To install into a differently-named database**, strip the header from those
three first:

```bash
sed -E '/^\s*(CREATE DATABASE|USE )/Id' db/schema.sql | mysql -u root your_db
```

Then confirm nothing can still reach the live database before running anything:

```bash
grep -nE "^\s*USE\s+elisha_bay_db|elisha_bay_db\." the-copy.sql   # must print nothing
```

**The migrations no longer carry the line.** `001` and `009` used to, and it
caused the most misleading failure this project has had. Rehearsing a clean
install in a scratch database, `001` quietly ran against the live one — so the
scratch copy kept its old `BT-…` batch codes, and `002` then failed there with

```
ERROR 1452 (23000): Cannot add or update a child row: a foreign key constraint fails
```

That reads exactly like a bug in `001`'s translation logic, and it was diagnosed
as one: "a fresh install ends up with 34 foreign keys instead of 37". It was not.
`001` ran correctly, in the wrong place, and a real install into `elisha_bay_db`
was never affected. `009` was worse in principle: it is the one migration that
**inserts rows**, and a rehearsal sent its inserts to the live database (a no-op
there only because its guard found the lots already present). Both now write to
the database named on the command line, like every migration from `003` on.

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
