<?php
declare(strict_types=1);

/**
 * POST /api/b2b/apply.php
 *
 * PUBLIC — no session required. A business owner applying to become a wholesale
 * partner has no account yet; requiring one would be a chicken-and-egg.
 *
 * WHAT WAS MISSING
 * ----------------
 * public/become-partner.html has had a complete twelve-field form since the
 * beginning, and b2b_applications has a column for every one of them. The staff
 * side works: b2b/list.php reads applications and b2b/decide.php approves or
 * rejects them, promoting the customer to `retailer`.
 *
 * The customer side sent nothing. The submit handler validated the fields,
 * advanced a stepper, and swapped in "Application Submitted! … we'll reach out
 * within 2 business days". No fetch, no endpoint, and no INSERT INTO
 * b2b_applications anywhere in the codebase — so the only applications that
 * could exist were the eight seeded rows.
 *
 * A real business owner filled that in, was told it succeeded, and no member of
 * staff ever saw it. This endpoint is the missing half.
 *
 * THE PASSWORD
 * ------------
 * The form collects a username and password, and the table has columns for
 * them, because applying IS the signup for a wholesale account. They are held
 * on the application and only become a customer login when staff approve —
 * an applicant who is rejected never gets an account. Hashed here, on arrival,
 * so a pending application never holds a readable password.
 *
 * A SIGNED-IN CUSTOMER APPLYING IS DIFFERENT, AND IT IS A SECURITY BOUNDARY.
 * -------------------------------------------------------------------------
 * An existing customer upgrading to a partner account already has credentials,
 * so none are asked for and none are required — b2b/decide.php promotes with
 * `COALESCE(username, ?)`, so an existing login survives approval untouched.
 *
 * The important half is the email. This endpoint used to take `email` from the
 * request body and resolve `customer_id` by looking that address up in
 * `customers`. That was safe while every applicant was a stranger with nothing
 * to gain. It stops being safe the moment an authenticated customer can apply:
 * they could file an application naming somebody else's address, and on
 * approval decide.php would promote THAT person's account to retailer — a
 * trade credit line opened against an account the applicant does not own.
 *
 * So when a customer session exists, the email and the customer id come from
 * the session and the body is not consulted, the same rule shop/checkout.php
 * states outright: "Always the session's address. Never read from the request."
 * With no session the old behaviour stands, because a stranger applying is
 * still the normal case and there is nothing to bind to.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* No Csrf token: the caller has no session, so there is none to ride. That is
   the same reasoning that exempts auth/login.php, and it is why the rate limit
   below matters more here than it does on an authenticated endpoint. */

$in = Response::input();

/* ---------------------------------------------------------------
   Who is applying
   ---------------------------------------------------------------
   Auth::customer(), not Auth::requireCustomer(): a session is optional here
   and always will be. A business owner applying for the first time has no
   account, and requiring one would be a chicken-and-egg.

   When there IS one, it decides the identity and the body does not get a vote.
   The override happens BEFORE validation so that every check below — the
   duplicate-application lookup, the already-a-retailer refusal, the customer
   link — runs against the session's address rather than a supplied one. Doing
   it afterwards would leave those three checks answering questions about
   somebody else's account. */
$sessionCustomer = Auth::customer();
if ($sessionCustomer !== null) {
    $in['email'] = $sessionCustomer['email'];
}

/* ---------------------------------------------------------------
   Rate limit
   ---------------------------------------------------------------
   A public endpoint that writes a row is a spam target. Applications are a
   considered act — nobody legitimately submits four in an hour from one
   address — and the table feeds a staff review queue that is useless when
   flooded.

   Counted per IP over the hour. Deliberately not per email: the email is
   supplied by the sender and changing it is free. */
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
$recent = (int) Database::scalar(
    "SELECT COUNT(*) FROM b2b_applications
      WHERE created_at > (NOW() - INTERVAL 1 HOUR)
        AND notes LIKE ?",
    ['%[ip:' . $ip . ']%']
);
if ($recent >= 3) {
    Response::rateLimited('Too many applications from this connection. Try again later, or call us.');
}

/* ---------------------------------------------------------------
   Validation — every field, server-side
   ---------------------------------------------------------------
   The page validates too. That is for the applicant's benefit; this is the
   check that counts, because the page is not what sends the request. */
$data = Validate::check($in)
    ->required('business_name', 'Business name')
    ->maxLen('business_name', 150, 'Business name')
    ->required('applicant_name', 'Contact name')
    ->maxLen('applicant_name', 100, 'Contact name')
    ->email('email', 'Email')
    ->required('phone', 'Phone')
    ->maxLen('phone', 30, 'Phone')
    ->required('business_type', 'Business type')
    ->maxLen('business_type', 50, 'Business type')
    ->required('business_address', 'Business address')
    ->values();

$fieldErrors = [];

if (!preg_match('/^[0-9 +\-()]{7,30}$/', $data['phone'])) {
    $fieldErrors['phone'] = 'Enter a valid contact number.';
}

/* BIR TIN: 9 or 12 digits, however the applicant chooses to punctuate it.
   Optional — a new business may not have one yet, and refusing the whole
   application over it would lose a real customer. */
$tin = trim((string) ($in['bir_tin'] ?? '')) ?: null;
if ($tin !== null) {
    $digits = preg_replace('/\D/', '', $tin);
    if (!in_array(strlen((string) $digits), [9, 12], true)) {
        $fieldErrors['bir_tin'] = 'A BIR TIN is 9 or 12 digits.';
    }
}

/* Normalised to the canonical scheme name the rest of the system uses.
   ---------------------------------------------------------------------
   The form offers friendly labels — "Net 30 Days Credit Terms" — while
   b2b_applications.requested_terms is seeded with "Net 30", payment_accounts
   .scheme stores "Net 30", and Payments::schemeLabel() produces "Net 30". Storing
   the form's label verbatim would put a value in the column that no screen and
   no lookup downstream matches.

   Both spellings are accepted so the endpoint is not brittle to a wording
   change on the page, and "Cash on Delivery" is a real answer meaning no credit
   line is being asked for — stored as NULL rather than refused. */
$TERMS = [
    'Cash on Delivery (COD)'     => null,
    'Cash on Delivery'           => null,
    'COD'                        => null,
    'Net 30 Days Credit Terms'   => 'Net 30',
    'Net 60 Days Credit Terms'   => 'Net 60',
    'Net 90 Days Credit Terms'   => 'Net 90',
    'Net 30'                     => 'Net 30',
    'Net 60'                     => 'Net 60',
    'Net 90'                     => 'Net 90',
];
$termsRaw = trim((string) ($in['requested_terms'] ?? ''));
$terms = null;
if ($termsRaw !== '') {
    if (!array_key_exists($termsRaw, $TERMS)) {
        $fieldErrors['requested_terms'] = 'Choose one of the listed payment terms.';
    } else {
        $terms = $TERMS[$termsRaw];
    }
}

$username = trim((string) ($in['username'] ?? '')) ?: null;
if ($username !== null && !preg_match('/^[A-Za-z0-9._-]{3,50}$/', $username)) {
    $fieldErrors['username'] = 'Use 3–50 letters, numbers, dot, dash or underscore.';
}

$password = (string) ($in['password'] ?? '');
if ($username !== null && $password === '') {
    $fieldErrors['password'] = 'Choose a password for your partner account.';
}

/* Credentials are required from a STRANGER and refused as unnecessary from a
   customer who already has them.

   Server-side this was previously optional for everybody — only the form's
   `required` attributes asked, and an attribute is not a check. An approved
   application with no username left decide.php inserting a customer row with
   NULL credentials: an account nobody can ever sign in to, created silently.

   For a signed-in applicant the opposite holds. They have a username and a
   password; asking for a second set invites a collision on the UNIQUE username
   column and gives them two ways into one account. The client hides the block
   entirely; this is what makes that hiding true. */
if ($sessionCustomer === null) {
    if ($username === null) {
        $fieldErrors['username'] = 'Choose a username for your partner account.';
    }
} elseif ($username !== null || $password !== '') {
    $fieldErrors['username'] = 'You are signed in — your existing account credentials are used.';
}

if ($fieldErrors !== []) {
    Response::validation('Please check the highlighted fields.', $fieldErrors);
}

/* A second pending application from the same business is almost always an
   impatient resubmit, not a new request. Refused with an explanation rather
   than silently creating a duplicate for staff to reconcile. */
$existing = Database::one(
    "SELECT app_id_code, status FROM b2b_applications
      WHERE email = ? AND status = 'pending' LIMIT 1",
    [$data['email']]
);
if ($existing !== null) {
    Response::conflict(sprintf(
        'You already have an application under review (%s). We will be in touch — no need to apply again.',
        $existing['app_id_code']
    ));
}

/* Someone already trading as a retailer does not need to apply. */
$alreadyRetailer = Database::scalar(
    "SELECT id FROM customers WHERE email = ? AND status = 'retailer'",
    [$data['email']]
);
if ($alreadyRetailer) {
    Response::conflict('That email already has an active wholesale account. Sign in instead.');
}

/* The row this application belongs to, so approval promotes the right customer
   rather than creating a second identity.

   From the SESSION when there is one — never from an email lookup. The lookup
   is what an authenticated attacker would have aimed at: supply a victim's
   address, and approval hands them retailer status on the victim's account.
   With no session the lookup is all there is, and it is harmless, because a
   caller with no session has proved nothing either way and the application
   still has to pass a human review before it promotes anything. */
$customerId = $sessionCustomer !== null
    ? $sessionCustomer['id']
    : (Database::scalar('SELECT id FROM customers WHERE email = ?', [$data['email']]) ?: null);

$hash = $username !== null ? Auth::hashPassword($password) : null;

$notes = trim((string) ($in['notes'] ?? ''));
if (mb_strlen($notes) > 1000) {
    $notes = mb_substr($notes, 0, 1000);
}
/* The IP is appended to notes rather than given a column: the rate limit above
   needs it, and adding a column to a table staff read every day for one
   diagnostic value is not worth the migration. Marked so it is obviously
   machine-written and not something the applicant typed. */
$notesStored = trim($notes . "\n\n[ip:" . $ip . ']');

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* APP-2026-009, continuing the seeded sequence. MAX not COUNT — COUNT
       collides the moment a row is deleted, and this column is UNIQUE. Inside
       the transaction so two simultaneous applicants cannot take the same
       code. */
    $year = date('Y');
    $next = (int) Database::scalar(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(app_id_code, 10) AS UNSIGNED)), 0)
           FROM b2b_applications
          WHERE app_id_code LIKE ?",
        ["APP-{$year}-%"]
    );
    $appCode = sprintf('APP-%s-%03d', $year, $next + 1);

    Database::run(
        'INSERT INTO b2b_applications
            (app_id_code, customer_id, business_name, applicant_name, email, phone,
             business_type, bir_tin, business_address, username, password,
             requested_terms, monthly_volume, notes, submitted_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?)',
        [
            $appCode, $customerId, $data['business_name'], $data['applicant_name'],
            $data['email'], $data['phone'], $data['business_type'], $tin,
            $data['business_address'], $username, $hash,
            $terms, trim((string) ($in['monthly_volume'] ?? '')) ?: null,
            $notesStored, 'pending',
        ]
    );

    /* Staff need to know without polling the screen. Same mechanism a new
       online order uses. */
    Database::run(
        'INSERT INTO notifications (id, type, message, created_at, is_read)
         VALUES (?, ?, ?, NOW(), 0)',
        ['n-' . strtolower(bin2hex(random_bytes(5))), 'audit',
         sprintf('New B2B partner application %s — %s (%s)',
             $appCode, $data['business_name'], $data['business_type'])]
    );

    /* Actor is the applicant, not a staff member, so actor_user_id stays NULL —
       the same shape shop/checkout.php uses for a customer-initiated write. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$data['applicant_name'], 'user',
         sprintf('B2B application %s submitted — %s, %s, requested %s.',
             $appCode, $data['business_name'], $data['business_type'],
             $terms ?? 'cash on delivery')]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Acknowledgement to the applicant. Sent AFTER the commit and never allowed to
   fail the request: the application is recorded either way, and telling someone
   their application failed because our mail server is down would be false. */
$mailed = Mailer::send(
    $data['email'],
    $data['applicant_name'],
    'We received your partner application — ' . $appCode,
    b2bAcknowledgementEmail($appCode, $data['business_name'], $data['applicant_name'])
);

Response::created([
    'appId'    => $appCode,
    'status'   => 'pending',
    'business' => $data['business_name'],
    /* The client says "check your inbox" only when there is something to
       check. */
    'emailed'  => $mailed,
]);


function b2bAcknowledgementEmail(string $appCode, string $business, string $applicant): string
{
    $e = static fn(string $v): string => htmlspecialchars($v, ENT_QUOTES, 'UTF-8');
    return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px">'
        . '<h2 style="color:#1d4e3f">Thanks, ' . $e($applicant) . '.</h2>'
        . '<p>We have received the wholesale partner application for <strong>'
        . $e($business) . '</strong>.</p>'
        . '<p>Your reference is <strong>' . $e($appCode) . '</strong>. Please quote it '
        . 'if you contact us about this application.</p>'
        . '<p>Our B2B team will verify your business details and reply to this '
        . 'address with a decision. You do not need to do anything else in the '
        . 'meantime.</p>'
        . '<p style="color:#666;font-size:.9em">Elisha Bay — Juris Bay Foods, Inc.<br>'
        . '148 Brgy. Mangin, Dagupan City, Pangasinan</p></div>';
}
