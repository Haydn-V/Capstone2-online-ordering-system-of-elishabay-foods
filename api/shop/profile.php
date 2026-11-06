<?php
declare(strict_types=1);

/** GET/POST /api/shop/profile.php reads or updates the signed-in customer's own details (no customer id or email parameter): name and address save immediately, while email and contact changes need a code sent to the email already on file. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod(['GET', 'POST']);

$customer = Auth::requireCustomer('Sign in to view your profile.');

$row = Database::one(
    'SELECT id, name, email, contact,
            addr_street, addr_barangay, addr_city, addr_province, addr_zip, addr_region,
            addr_region_code, addr_province_code, addr_city_code, addr_barangay_code
       FROM customers WHERE id = ?',
    [$customer['id']]
);
if ($row === null) {
    /* A session whose customer no longer exists is treated as signed out. */
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

/* Contact number uses the same pattern as checkout. */
/* `$pending` is what needs a code; `$fields` is what saves now. */
$pending = [];

if (array_key_exists('contact', $in)) {
    $contact = trim((string) $in['contact']);
    if ($contact !== '' && !preg_match('/^[0-9 +\-()]{7,20}$/', $contact)) {
        $errors['contact'] = 'Enter a valid contact number.';
    } else {
        $contact = $contact !== '' ? $contact : null;
        /* Only a real change to the contact number needs a code. */
        if ($contact !== $row['contact']) {
            $pending['contact'] = $contact;
        }
    }
}

/* Email change (now allowed behind a code). */
if (array_key_exists('email', $in)) {
    $email = trim((string) $in['email']);
    if ($email === '') {
        $errors['email'] = 'Your email address is required.';
    } elseif (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 100) {
        $errors['email'] = 'Enter a valid email address.';
    } elseif (strcasecmp($email, (string) $row['email']) !== 0) {
        /* Check the new email is free now, and again when the code is accepted. */
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

/* Address via Address::resolve (all or nothing, names from codes); before the location data loads, a free-text line is stored in addr_street. */
if (isset($in['address']) && is_array($in['address'])) {
    $a = Address::resolve($in['address'], false);
    $legacy = $a !== null && $a['barangay_code'] === null;
    $fields += [
        'addr_street'        => $a === null ? null : ($legacy ? $a['line'] : $a['street']),
        'addr_barangay'      => $a['barangay']      ?? null,
        'addr_city'          => $a['city']          ?? null,
        'addr_province'      => $a['province']      ?? null,
        'addr_region'        => $a['region']        ?? null,
        'addr_zip'           => $a['zip']           ?? null,
        'addr_region_code'   => $a['region_code']   ?? null,
        'addr_province_code' => $a['province_code'] ?? null,
        'addr_city_code'     => $a['city_code']     ?? null,
        'addr_barangay_code' => $a['barangay_code'] ?? null,
    ];
}

/* First and last name are joined into name and the halves saved after the update. */
$nm = CustomerName::fromInput($in, $errors);
if ($nm !== null) {
    if (isset($errors['first_name']) || isset($errors['last_name']) || isset($errors['middle_name'])) unset($in['name']);
    else $in['name'] = $nm['full'];
}

/* Name saves immediately; email needs a code (above). */
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

/* Save the non-sensitive fields now even if a code is also being sent. */
if ($fields !== []) {
    $set    = implode(', ', array_map(static fn(string $c): string => "$c = ?", array_keys($fields)));
    $params = array_values($fields);
    $params[] = $customer['id'];

    Database::run("UPDATE customers SET $set WHERE id = ?", $params);
    if ($nm !== null && isset($fields['name'])) {
        CustomerName::write($customer['id'], $nm['first'], $nm['last'], $nm['middle']);
    }
}

/* No audit row, because audit_logs is for staff actions only. */

/* Same column list as the read at the top, for profilePayload(). */
$row = Database::one(
    'SELECT id, name, email, contact,
            addr_street, addr_barangay, addr_city, addr_province, addr_zip, addr_region,
            addr_region_code, addr_province_code, addr_city_code, addr_barangay_code
       FROM customers WHERE id = ?',
    [$customer['id']]
);

/* Nothing sensitive changed, so we are done. */
if ($pending === []) {
    Response::ok(profilePayload($row) + ['requiresVerification' => false]);
}

/* Something sensitive changed: send a code and save nothing yet. */
const VC_PURPOSE = 'profile_change';
const VC_TTL     = 600;   /* seconds a code stays usable */
const VC_RESEND  = 60;    /* seconds before another may be issued */

/* Reuse a still-valid recent code, so a resend does not invalidate the one already in the inbox. */
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

/* Any older code for the same change becomes invalid once a new one is issued. */
Database::run(
    "UPDATE verification_codes SET consumed_at = NOW()
      WHERE customer_id = ? AND purpose = ? AND consumed_at IS NULL",
    [$customer['id'], VC_PURPOSE]
);

/* random_int (not rand) for an unpredictable 6-digit code, zero-padded. */
$code   = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
$ticket = 'vc-' . bin2hex(random_bytes(5));

Database::run(
    'INSERT INTO verification_codes
        (id, customer_id, purpose, code_hash, payload, attempts, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, NOW() + INTERVAL ? SECOND)',
    [$ticket, $customer['id'], VC_PURPOSE,
     /* Hash the code with password_hash() directly (not Auth::hashPassword, whose length rule a 6-digit code would fail); its strength comes from being random, single-use, 5 attempts and 10 minutes. */
     password_hash($code, PASSWORD_BCRYPT),
     json_encode($pending, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
     VC_TTL]
);

/* Send the code to the email on file, never the new one, so a hijacked session cannot receive it. */
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
    /* Report whether the email was really sent or only logged. */
    'mailLive'  => Mailer::isLive(),
];

/* Return the code only on a dev install with app.debug on and no real mail, never when mail is live. */
if (!Mailer::isLive() && (Database::config()['app']['debug'] ?? false)) {
    $out['devCode'] = $code;
}

Response::ok($out);


/** The code email says what change is being made, so an unexpected one is recognisable. */
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


/** The profile response shape, used for both GET and POST, including address.line for checkout. */
function profilePayload(array $row): array
{
    /* Built with Address::compose, the same rule used for order addresses. */
    $a = [
        'street'           => $row['addr_street'],
        'barangay'         => $row['addr_barangay'],
        'sub_municipality' => null,
        'city'             => $row['addr_city'],
        'province'         => $row['addr_province'],
        'region'           => $row['addr_region'],
        'zip'              => $row['addr_zip'],
    ];
    $line  = Address::compose($a);
    $hasAny = $line !== '' || $row['addr_barangay_code'] !== null;

    /* firstName / lastName: stored halves, or a suggested split (019). */
    return CustomerName::parts((string) $row['id'], (string) $row['name']) + [
        'id'      => $row['id'],
        'name'    => $row['name'],
        'email'   => $row['email'],
        'contact' => $row['contact'],
        'address' => [
            'street'   => $row['addr_street'],
            'barangay' => $row['addr_barangay'],
            'city'     => $row['addr_city'],
            'province' => $row['addr_province'],
            'zip'      => $row['addr_zip'],
            'region'   => $row['addr_region'],
            /* The saved PSGC codes the picker prefills from (older addresses only prefill the street). */
            'region_code'   => $row['addr_region_code'],
            'province_code' => $row['addr_province_code'],
            'city_code'     => $row['addr_city_code'],
            'barangay_code' => $row['addr_barangay_code'],
            'line'     => $line,
            /* A flag so the client does not have to guess whether an address exists. */
            'hasAny'   => $hasAny,
        ],
    ];
}
