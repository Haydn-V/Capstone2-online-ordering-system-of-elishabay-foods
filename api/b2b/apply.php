<?php
declare(strict_types=1);

/** POST /api/b2b/apply.php records a retail-partner application, and when a customer is signed in the email and customer id come only from the session so nobody can apply on someone else's account. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

/* No CSRF token here because the caller may have no session, which is why the rate limit below matters. */

$in = Response::input();

/* Who is applying: a signed-in session always overrides the request body, and this happens before validation so every check runs against the session's own account. */
/* Applicants must now sign in or create an account first, so every application is tied to an existing customer login. */
$sessionCustomer = Auth::requireCustomer('Sign in or create an account before applying.');
$in['email'] = $sessionCustomer['email'];

/* Rate limit: at most a few applications per IP per hour, counted by IP because the email is free to change. */
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

/* Validate every field on the server too, since the page's own checks can be skipped. */
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
    ->values();

$fieldErrors = [];

/* The business address is built from the address picker's codes (see api/core/Address.php) and is required in full, because credit deliveries go there. */
[$biz, $addrErrors] = Address::check(is_array($in['address'] ?? null) ? $in['address'] : null, true);
$fieldErrors += $addrErrors;

if (!preg_match('/^[0-9 +\-()]{7,30}$/', $data['phone'])) {
    $fieldErrors['phone'] = 'Enter a valid contact number.';
}

/* BIR TIN is optional and accepts 9 or 12 digits with any punctuation. */
$tin = trim((string) ($in['bir_tin'] ?? '')) ?: null;
if ($tin !== null) {
    $digits = preg_replace('/\D/', '', $tin);
    if (!in_array(strlen((string) $digits), [9, 12], true)) {
        $fieldErrors['bir_tin'] = 'A BIR TIN is 9 or 12 digits.';
    }
}

/* Payment terms are no longer collected (retailers pick Net 30/60/90 per order), so any requested_terms sent by an old form is ignored and stored as NULL. */

$username = trim((string) ($in['username'] ?? '')) ?: null;
if ($username !== null && !preg_match('/^[A-Za-z0-9._-]{3,50}$/', $username)) {
    $fieldErrors['username'] = 'Use 3–50 letters, numbers, dot, dash or underscore.';
}

$password = (string) ($in['password'] ?? '');
if ($username !== null && $password === '') {
    $fieldErrors['password'] = 'Choose a password for your partner account.';
}

/* New applicants must supply a username and password, while signed-in customers must not, because they already have a login. */
if ($sessionCustomer === null) {
    if ($username === null) {
        $fieldErrors['username'] = 'Choose a username for your partner account.';
    }
} elseif ($username !== null || $password !== '') {
    $fieldErrors['username'] = 'You are signed in — your existing account credentials are used.';
}

/* Retail Partner Terms consent from the application checkbox. */
if (($in['agree_partner_terms'] ?? false) !== true) {
    $fieldErrors['agree_partner_terms'] = 'Please agree to the Retail Partner Terms to submit your application.';
}

if ($fieldErrors !== []) {
    Response::validation('Please check the highlighted fields.', $fieldErrors);
}

/* Refuse a second pending application from the same business instead of creating a duplicate for staff to sort out. */
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

/* Link the application to the session's customer when signed in (never by email lookup, which an attacker could aim at someone else's account). */
$customerId = $sessionCustomer !== null
    ? $sessionCustomer['id']
    : (Database::scalar('SELECT id FROM customers WHERE email = ?', [$data['email']]) ?: null);

$hash = $username !== null ? Auth::hashPassword($password) : null;

$notes = trim((string) ($in['notes'] ?? ''));
if (mb_strlen($notes) > 1000) {
    $notes = mb_substr($notes, 0, 1000);
}
/* The applicant's IP goes into notes (clearly marked as machine-written) for the rate limit, instead of adding a column. */
$notesStored = trim($notes . "\n\n[ip:" . $ip . ']');

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* Next code like APP-2026-009 uses MAX, not COUNT, inside the transaction so deleted rows or simultaneous applicants never cause a duplicate. */
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
             business_type, bir_tin, business_address,
             biz_street, biz_barangay, biz_city, biz_province, biz_region, biz_zip,
             biz_region_code, biz_province_code, biz_city_code, biz_barangay_code,
             username, password,
             requested_terms, notes, submitted_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?)',
        [
            $appCode, $customerId, $data['business_name'], $data['applicant_name'],
            $data['email'], $data['phone'], $data['business_type'], $tin,
            /* business_address keeps the one printable line staff and emails already use, with the structured parts stored beside it. */
            $biz['line'],
            $biz['street'], $biz['barangay'], $biz['city'], $biz['province'], $biz['region'], $biz['zip'],
            $biz['region_code'], $biz['province_code'], $biz['city_code'], $biz['barangay_code'],
            $username, $hash,
            /* requested_terms and monthly_volume are no longer written, but the columns stay so older applications keep their history. */
            null,
            $notesStored, 'pending',
        ]
    );

    /* Notify staff with an info-level alert, the same way a new online order does. */
    Notify::create(
        'audit',
        sprintf('New B2B partner application %s — %s (%s)',
            $appCode, $data['business_name'], $data['business_type'])
    );

    /* The actor is the applicant, not staff, so actor_user_id stays NULL like other customer-initiated writes. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$data['applicant_name'], 'user',
         sprintf('B2B application %s submitted — %s, %s.',
             $appCode, $data['business_name'], $data['business_type'])]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Email the applicant only after the commit, and never let a mail failure fail the request, since the application is already saved. */
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
    /* The client only says "check your inbox" when an email was actually sent. */
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
