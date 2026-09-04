# Build prompt — customers cannot sign in, and the lockout policy

> Paste everything below the horizontal rule into Claude Code with the `elishabay` repo open.

---

You are working in `C:\xampp\htdocs\elishabay`, a PHP + vanilla-JS system on XAMPP
(schema `elisha_bay_db`). No framework, no Composer, no npm build step — do not add any.

**Task 1 is a live blocker: customer accounts that are known to be correct cannot sign in.**
Diagnose it before doing anything else. Do not start Task 2 or 3 until sign-in works.

## Conventions

- Non-GET calls go through `EbApi`, which attaches the CSRF token.
- Customer endpoints call `Auth::requireCustomer()` and scope by the session's customer id.
- Match the house comment style: explain **why** a change exists.
- Update `docs/API.md` for any endpoint change.

## How to write files in this repo — read this first

The last session tried to create `api/shop/review-save.php` with a shell heredoc:

```
cat > api/shop/review-save.php <<'PHPEOF'
…
PHPEOF
```

and it failed with ``unexpected EOF while looking for matching `'``. **Do not write PHP with
`cat`, heredocs, or `echo` on this machine.** This is Git Bash on Windows, and the files in
this repo are full of apostrophes, `$` variables and long comment blocks — exactly what breaks
shell quoting. Use the editor/Write tool for every file you create or change.

**Before anything else, find out what that failed command left behind.** A half-written PHP
file is a parse error, and if it sits anywhere `api/core/bootstrap.php` pulls in, then *every*
endpoint 500s — including sign-in. Run:

```
/c/xampp/php/php.exe -l api/shop/review-save.php
for f in api/core/*.php api/shop/*.php; do /c/xampp/php/php.exe -l "$f"; done
```

Also confirm whether `Reviews` and `Notify` — referenced by that endpoint as
`Reviews::classify()`, `Reviews::recompute()` and `Notify::create()` — actually exist. If the
file was written but its dependencies were not, it fatals when called. Delete or complete any
truncated file before moving on.

---

# Task 1 — Customers cannot sign in with correct credentials

Both a normal customer and a retailer were created deliberately and now fail with
**"Email or password is incorrect."** Work through these in order — do not guess and patch.

## Step 0 — Is the endpoint even succeeding?

Open the browser Network tab and sign in. Look at `api/shop/login.php`:

- **500** → a PHP fatal. Read Apache's `error.log`. Almost certainly the truncated file above.
- **200 with a JSON error** → the endpoint ran and rejected the credentials. Continue below.
- **429** → this is a lockout being displayed as "incorrect". Go straight to Step 3.

The login modal shows one generic message for several different failures, which is itself part
of the problem — see the end of this task.

## Step 1 — Does the account actually have a password?

`customers.password` is `VARCHAR(255) NULL`, and the schema comment says the seed rows leave
it NULL because "signup/login must fill these (hashed)". Check the real rows:

```sql
SELECT id, name, email, username, status,
       (password IS NULL) AS no_password, LENGTH(password) AS hash_len
  FROM customers
 WHERE email IN ('juan@gmail.com', 'Jedskie@gmail.com');
```

**Two known ways an account ends up with no password — both are real code paths:**

- **`api/customers/save.php`** — the portal's *Add Customer* — inserts
  `(id, name, email, contact, status, joined)`. **There is no password column in that INSERT.**
  Any customer an administrator creates through User Management therefore cannot ever sign in,
  and nothing on that screen says so.
- **`api/b2b/decide.php`** — approval does
  `UPDATE customers SET username = COALESCE(username, ?), password = COALESCE(password, ?)`.
  `COALESCE` keeps the existing value, so if the customer had no password *and* the application
  carried no credentials, the approved retailer is left with `password = NULL`. This became
  reachable when applications from signed-in customers were allowed to omit username and
  password.

If `no_password` is 1 for either account, that is your bug and it is a data path problem, not
a login problem.

**Fix it properly, not by hand-patching the two rows:**

- *Add Customer* must either collect a password and hash it with `Auth::hashPassword()`, or
  stop presenting itself as creating a usable account. Decide which and say why. If an
  administrator can create a passwordless record deliberately, the Customer Accounts table
  must show that state plainly — a "no sign-in" marker — so nobody is left debugging it again.
- *B2B approval* must guarantee the resulting retailer has a usable credential. If the linked
  customer already has one, keep it. If neither the customer nor the application has one,
  approval must not silently produce an account nobody can enter — refuse with a clear message,
  or issue a set-password path. Say which you chose.

## Step 2 — Is the hash being written and read the same way?

Recent work added a staff profile with its own password change and a new staff
re-authentication path in `Auth`. Confirm nothing there changed how customer passwords are
written or verified:

- Every write goes through `Auth::hashPassword()`; nothing hashes twice (a rehash of a hash
  verifies against nothing).
- Verification uses `password_verify()` against the stored column.
- `customers.password` is wide enough for the algorithm's output — a truncated hash fails
  silently and forever.
- Registration (`api/shop/register.php`) and the customer password change
  (`api/shop/password.php`) both still produce a hash the login path accepts. Test the full
  loop: register a throwaway account, sign out, sign in.

## Step 3 — Is a lockout being reported as "incorrect"?

`db/schema-additions.sql` defines `login_attempts (email, ip_address, attempted_at)`. Check it:

```sql
SELECT email, ip_address, COUNT(*) AS fails, MAX(attempted_at) AS last_try
  FROM login_attempts
 WHERE attempted_at > NOW() - INTERVAL 30 MINUTE
 GROUP BY email, ip_address;
```

While testing this you will have generated failures, so a lockout may now be the *current*
reason sign-in fails even if it was not the original one. Confirm whether successful sign-in
clears the counter — if failures accumulate forever and are never cleared, an account can
reach a state it never recovers from.

## Whatever the cause — fix the message

"Email or password is incorrect" is currently shown for at least three different situations:
wrong credentials, a locked-out account, and an account with no password set. That is why this
took so long to find.

Keep the wrong-credentials message deliberately vague — it must not reveal whether an email is
registered — but **a lockout must say so and say for how long**, and an account that cannot
sign in because it has no password must produce something a person can act on rather than a
message that sends them to retype a correct password.

*Done when:* both accounts sign in, a fresh registration can sign out and back in, and each
distinct failure produces its own message.

---

# Task 2 — Escalating lockout instead of a flat 15 minutes

The current lockout is 15 minutes from the first trigger. Replace it with a progressive one.

**The policy:**

- Three consecutive failures for the same identity are free — typos happen.
- The fourth consecutive failure locks for **2 minutes**. Each further consecutive failure adds
  two minutes: **2, 4, 6, 8, 10**, and **capped at 10**.
- A successful sign-in clears the streak completely.
- The streak decays on its own: after a quiet period with no attempts (use 30 minutes unless
  you have a better argument), it resets. Someone who fails twice this morning must not start
  this evening one failure from a lockout.

**Apply it everywhere the same counter is used** — customer sign-in, staff portal sign-in, and
the password-change re-authentication in `api/shop/password.php`, whose header comment says it
deliberately shares sign-in's counter. All three must use one implementation, not three.

**Two things I want you to weigh and report on:**

1. **This is a weakening of a security control.** Ten minutes is less than fifteen, and the
   first four attempts now cost nothing. That is a reasonable trade for a storefront where real
   customers get locked out of their own accounts. It is a worse trade for the **staff portal**,
   where the accounts have real privileges. Consider keeping a higher cap for staff sign-in and
   say what you did.
2. **Lock on identity plus source, not on the email alone.** If the streak is keyed only to an
   email address, anyone who knows a customer's email can lock them out of their own account by
   failing on purpose — a denial-of-service you would have built deliberately. Key it on email
   *and* IP, and consider a separate, looser per-IP limit to catch someone spraying many
   accounts from one machine.

**The message must be usable:** name the remaining time, and let it count down in the modal
rather than making the customer guess. It must be clearly different from the
wrong-credentials message — see the end of Task 1.

*Done when:* four wrong passwords produce a 2-minute lock naming the wait, a fifth produces 4
minutes, the escalation caps at 10, a correct password clears it, and the streak decays after a
quiet period.

---

# Task 3 — Finish or remove the half-written review endpoint

Depending on what Step 0 found:

- If `api/shop/review-save.php` is truncated or its dependencies are missing, **complete it
  properly with the editor** — the logic in the attempted version is sound and worth keeping.
  It needs `Reviews::classify()`, `Reviews::recompute()` and the constants it references, plus
  `Notify::create()`. Build whichever of those do not yet exist.
- If it cannot be completed in this pass, **delete the file** rather than leaving a broken
  endpoint on disk, and say so.

Either way, run `php -l` over `api/core/` and `api/shop/` again before you finish, and paste
the result.

---

# Order of work

1. Step 0 — find and clear anything the failed write left behind. Nothing else matters until
   the endpoints parse.
2. Task 1, steps 1 to 3, in order. Report which one it actually was.
3. Task 1's error messages.
4. Task 2.
5. Task 3.

Three things I want stated back in your summary: which of the three causes actually broke
sign-in, whether *Add Customer* can still create an account nobody can sign in to, and how you
keyed the lockout streak.

If any diagnosis above conflicts with what you find in the code, follow the code and tell me
where I was wrong.
