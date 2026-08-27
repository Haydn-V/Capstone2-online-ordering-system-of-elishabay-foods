<?php
declare(strict_types=1);

/**
 * GET  /api/shop/profile.php   — the signed-in customer's saved details
 * POST /api/shop/profile.php   — update them
 *
 * Requires a CUSTOMER session. Identity comes from the session and only from
 * the session (D6, D7). There is no `customer_id` parameter and no `email`
 * parameter; supplying one changes nothing, because nothing reads them. That is
 * the same rule shop/checkout.php enforces, and for the same reason: an
 * endpoint that lets the client name the account is an endpoint that lets any
 * client edit any account.
 *
 * WHAT THIS REPLACES
 * ------------------
 * public/profile/profile.html has had a Delivery Address form, a Personal Info
 * form and a password form since the beginning. All three were mocks: the
 * submit handler validated a field was non-empty, called
 * showToast("Address saved!") and wrote nothing. No endpoint existed. A
 * customer could "save" their address every day for a year and the database
 * would never hear about it.
 *
 * ONE address (see db/migrations/005). Not an address book — that is a feature
 * with unasked questions attached, and the request was "prefill the customer's
 * saved address".
 *
 * Password changes are NOT handled here. That needs the current password
 * re-verified and belongs in its own endpoint with its own rate limiting; a
 * profile save that could also change credentials is a different security
 * problem wearing a form's clothes.
 *
 * SENSITIVE FIELDS NEED AN EMAILED CODE
 * ------------------------------------
 * The Scope says "the system sends a verification code to the registered email
 * whenever the user attempts to change important account details", and
 * profile.html has always carried the hint "A verification code will be sent to
 * confirm email changes" under the email input. The mechanism did not exist.
 *
 * Important here means EMAIL and CONTACT NUMBER — the two ways an account is
 * reached and recovered. Name and address save immediately, as they always
 * have: getting those wrong is an inconvenience, not a route to taking the
 * account over.
 *
 * THIS REVERSES A DECISION RECORDED IN THIS FILE.
 * The note on the name field used to read "but never the email, which is the
 * login identifier and the key other records join on. Changing it is an
 * account-recovery operation, not a profile edit." That was correct while there
 * was no way to prove the request came from the account holder rather than from
 * somebody holding a stolen session — an endpoint that lets a session move the
 * account to a new address is an account takeover with extra steps.
 *
 * The code closes exactly that gap, and it is sent to the address ALREADY ON
 * FILE, never to the proposed one. Somebody who has taken a session cannot
 * receive it; the real owner does, and finds out an attempt was made.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod(['GET', 'POST']);

$customer = Auth::requireCustomer('Sign in to view your profile.');

$row = Database::one(
    'SELECT id, name, email, contact,
            addr_street, addr_city, addr_province, addr_zip, addr_region
       FROM customers WHERE id = ?',
    [$customer['id']]
);
if ($row === null) {
    /* The session names a customer that no longer exists — archived or deleted
       mid-session. Treated as signed out rather than as a 404, because that is
       what it is. */
    Response::unauthenticated('Your account is no longer available. Sign in again.');
}

/* ------------------------------------------------------------------ */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    Response::ok(profilePayload($row));
}

/* ---- POST -------------------------------------------------------- */
$in = Response::input();

$fields = [];
$errors = [];

/* Contact number. Same pattern shop/checkout.php validates against, so a number
   accepted at checkout is accepted here and vice versa — two different rules
   for one field is how a customer ends up unable to save what they just
   successfully ordered with. */
/* `$pending` is what needs a code; `$fields` is what saves now. */
$pending = [];

if (array_key_exists('contact', $in)) {
    $contact = trim((string) $in['contact']);
    if ($contact !== '' && !preg_match('/^[0-9 +\-()]{7,20}$/', $contact)) {
        $errors['contact'] = 'Enter a valid contact number.';
    } else {
        $contact = $contact !== '' ? $contact : null;
        /* Only a real change is held back. Re-saving the address panel posts
           the contact number unchanged, and demanding a code for that would
           make the page unusable. */
        if ($contact !== $row['contact']) {
            $pending['contact'] = $contact;
        }
    }
}

/* Email. Refused outright before this — see the header note. */
if (array_key_exists('email', $in)) {
    $email = trim((string) $in['email']);
    if ($email === '') {
        $errors['email'] = 'Your email address is required.';
    } elseif (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 100) {
        $errors['email'] = 'Enter a valid email address.';
    } elseif (strcasecmp($email, (string) $row['email']) !== 0) {
        /* Checked now so the customer is not made to wait for a code before
           being told the address is taken. Checked AGAIN when the code is
           accepted — somebody else can register it in the ten minutes between,
           and customers.email is UNIQUE. */
        $taken = Database::scalar(
            'SELECT id FROM customers WHERE email = ? AND id <> ?',
            [$email, $customer['id']]
        );
        if ($taken) {
            $errors['email'] = 'That email address is already registered.';
        } else {
            $pending['email'] = $email;
        }
    }
}

/* Address. Each part is optional and independently clearable — partial is a
   real state, and someone who knows their city but not their ZIP should be able
   to save what they know. */
$addressMap = [
    'street'   => ['col' => 'addr_street',   'max' => 160],
    'city'     => ['col' => 'addr_city',     'max' => 80],
    'province' => ['col' => 'addr_province', 'max' => 80],
    'zip'      => ['col' => 'addr_zip',      'max' => 10],
    'region'   => ['col' => 'addr_region',   'max' => 80],
];

if (isset($in['address']) && is_array($in['address'])) {
    foreach ($addressMap as $key => $spec) {
        if (!array_key_exists($key, $in['address'])) {
            continue;
        }
        $val = trim((string) $in['address'][$key]);
        if (mb_strlen($val) > $spec['max']) {
            $errors[$key] = 'Keep this under ' . $spec['max'] . ' characters.';
            continue;
        }
        $fields[$spec['col']] = $val !== '' ? $val : null;
    }
}

/* Name. Saves immediately — getting it wrong is an inconvenience, not a route
   to taking the account over. Email is handled above, behind a code. */
if (array_key_exists('name', $in)) {
    $name = trim((string) $in['name']);
    if ($name === '') {
        $errors['name'] = 'Your name is required.';
    } elseif (mb_strlen($name) > 100) {
        $errors['name'] = 'Keep your name under 100 characters.';
    } else {
        $fields['name'] = $name;
    }
}

if ($errors !== []) {
    Response::validation('Please check the highlighted fields.', $errors);
}
if ($fields === [] && $pending === []) {
    Response::badRequest('Nothing to save.');
}

/* The non-sensitive half saves now, even when a code is also being issued: a
   customer who fixed their street and their email in one submission should not
   lose the street because the email needs confirming. */
if ($fields !== []) {
    $set    = implode(', ', array_map(static fn(string $c): string => "$c = ?", array_keys($fields)));
    $params = array_values($fields);
    $params[] = $customer['id'];

    Database::run("UPDATE customers SET $set WHERE id = ?", $params);
}

/* No audit row.
   audit_logs records STAFF actions against the business's data — its actor
   columns are a staff name and a users.id foreign key, and every existing row
   is an employee doing something. A customer editing their own address is not
   that, and writing it here with a NULL actor_user_id would quietly turn the
   staff audit trail into a general activity log that the Audit screen then
   pages through. Worth its own table if customer activity needs recording;
   not worth corrupting this one. */

$row = Database::one(
    'SELECT id, name, email, contact,
            addr_street, addr_city, addr_province, addr_zip, addr_region
       FROM customers WHERE id = ?',
    [$customer['id']]
);

/* ------------------------------------------------------------------
   Nothing sensitive changed — done.
   ------------------------------------------------------------------ */
if ($pending === []) {
    Response::ok(profilePayload($row) + ['requiresVerification' => false]);
}

/* ------------------------------------------------------------------
   Something sensitive changed. Issue a code; write nothing.
   ------------------------------------------------------------------ */
const VC_PURPOSE = 'profile_change';
const VC_TTL     = 600;   /* seconds a code stays usable */
const VC_RESEND  = 60;    /* seconds before another may be issued */

/* An unconsumed, unexpired code issued moments ago is reused rather than
   replaced. Otherwise the Resend button, or an impatient second submit, mints a
   new code and silently invalidates the one already in the customer's inbox —
   they then type the code they can see and are told it is wrong. */
$live = Database::one(
    "SELECT id, created_at, expires_at FROM verification_codes
      WHERE customer_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1",
    [$customer['id'], VC_PURPOSE]
);

if ($live !== null && (time() - strtotime((string) $live['created_at'])) < VC_RESEND) {
    Response::ok(profilePayload($row) + [
        'requiresVerification' => true,
        'ticket'    => $live['id'],
        'expiresIn' => max(0, strtotime((string) $live['expires_at']) - time()),
        'resent'    => false,
        'mailLive'  => Mailer::isLive(),
    ]);
}

/* Any older code for this purpose is dead the moment a new one is issued — two
   live codes for one change means the earlier one is a second key. */
Database::run(
    "UPDATE verification_codes SET consumed_at = NOW()
      WHERE customer_id = ? AND purpose = ? AND consumed_at IS NULL",
    [$customer['id'], VC_PURPOSE]
);

/* random_int, not rand(): this is a credential, and a predictable one is not a
   check at all. Zero-padded so 004212 is six digits and not four. */
$code   = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
$ticket = 'vc-' . bin2hex(random_bytes(5));

Database::run(
    'INSERT INTO verification_codes
        (id, customer_id, purpose, code_hash, payload, attempts, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, NOW() + INTERVAL ? SECOND)',
    [$ticket, $customer['id'], VC_PURPOSE,
     /* Hashed for the same reason a password is — see db/migrations/006.

        password_hash() directly, NOT Auth::hashPassword(). That helper enforces
        the account password policy (Auth::PASSWORD_MIN, currently 8) and a
        six-digit code fails it. Lowering PASSWORD_MIN to accommodate a code
        would weaken every real password in the system to make one unrelated
        thing fit — the length rule and the hashing are separate concerns, and
        only the hashing applies here.

        A code's strength comes from being random, single-use, five-attempt
        capped and ten-minute lived, not from its length. */
     password_hash($code, PASSWORD_BCRYPT),
     json_encode($pending, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
     VC_TTL]
);

/* Sent to the address ON FILE, never to the proposed one. Somebody who has
   taken a session cannot receive it; the real owner does, and learns an attempt
   was made. */
$mailed = Mailer::send(
    (string) $row['email'],
    (string) $row['name'],
    'Your Elisha Bay verification code',
    profileChangeCodeEmail((string) $row['name'], $code, $pending)
);

$out = profilePayload($row) + [
    'requiresVerification' => true,
    'ticket'    => $ticket,
    'expiresIn' => VC_TTL,
    'resent'    => true,
    'emailed'   => $mailed,
    /* Distinguishes real delivery from the log transport, exactly as
       api/b2b/decide.php does. The page says which rather than claiming an
       email was sent when it was written to storage/mail/. */
    'mailLive'  => Mailer::isLive(),
];

/* The code itself, ONLY on a development install with no real mail configured.
   Reuses app.debug — the flag that already decides whether internal detail
   leaves this server — rather than inventing a second switch that could be left
   on independently. Never returned when mail is live, whatever debug says: an
   install that can actually deliver has no excuse to put a live credential in
   an HTTP response. */
if (!Mailer::isLive() && (Database::config()['app']['debug'] ?? false)) {
    $out['devCode'] = $code;
}

Response::ok($out);


/**
 * The code email. Says what is being changed, because "here is a code" with no
 * context is indistinguishable from a phishing attempt — and if the customer did
 * not request it, naming the change is what tells them something is wrong.
 */
function profileChangeCodeEmail(string $name, string $code, array $pending): string
{
    $e = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');

    $what = [];
    if (isset($pending['email'])) {
        $what[] = 'your email address to <strong>' . $e($pending['email']) . '</strong>';
    }
    if (array_key_exists('contact', $pending)) {
        $what[] = 'your contact number to <strong>' . $e($pending['contact'] ?? '(none)') . '</strong>';
    }

    return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px">'
        . '<h2 style="color:#1d4e3f">Confirm your account change</h2>'
        . '<p>Hello ' . $e($name) . ', someone asked to change ' . implode(' and ', $what)
        . ' on your Elisha Bay account.</p>'
        . '<p>Enter this code to confirm:</p>'
        . '<p style="font-size:2rem;font-weight:700;letter-spacing:.32em;margin:18px 0;color:#1d4e3f">'
        . $e($code) . '</p>'
        . '<p>It expires in 10 minutes and can be used once.</p>'
        . '<p><strong>If this was not you, do nothing.</strong> The change will not happen, '
        . 'and your account is unaffected — but please change your password, because '
        . 'somebody was signed in as you.</p>'
        . '<p style="color:#666;font-size:.9em">Elisha Bay — Juris Bay Foods, Inc.<br>'
        . '148 Brgy. Mangin, Dagupan City, Pangasinan</p></div>';
}


/**
 * The response shape, used by both verbs so a save returns exactly what a
 * fresh read would.
 *
 * `address.line` is the joined single-line form the checkout textarea wants.
 * Assembled here rather than in the browser: the checkout and the profile page
 * would otherwise each have their own idea of how to join five fields, and the
 * order would store whichever one happened to run.
 */
function profilePayload(array $row): array
{
    $parts = array_values(array_filter([
        $row['addr_street'],
        $row['addr_city'],
        $row['addr_province'],
        $row['addr_zip'],
        $row['addr_region'],
    ], static fn(?string $v): bool => $v !== null && trim($v) !== ''));

    return [
        'id'      => $row['id'],
        'name'    => $row['name'],
        'email'   => $row['email'],
        'contact' => $row['contact'],
        'address' => [
            'street'   => $row['addr_street'],
            'city'     => $row['addr_city'],
            'province' => $row['addr_province'],
            'zip'      => $row['addr_zip'],
            'region'   => $row['addr_region'],
            'line'     => $parts === [] ? '' : implode(', ', $parts),
            /* So the client never has to infer "is there an address?" from
               whether a joined string is empty. */
            'hasAny'   => $parts !== [],
        ],
    ];
}
