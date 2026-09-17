<?php
declare(strict_types=1);

/**
 * POST /api/b2b/decide.php
 * Body: { "app_id": "APP-2026-008", "decision": "approved"|"rejected",
 *         "tier": "Bronze"|"Silver"|"Gold", "reason": "..." }
 *
 * Requires b2b.review.
 *
 * Approving promotes the applicant's customer record to `retailer`, which is
 * what unlocks wholesale pricing and credit terms elsewhere — so approval is a
 * two-table change and runs in a transaction. A decision is final: re-deciding
 * a settled application would silently change someone's commercial terms with
 * no new record, so it is refused.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('b2b.review');

$in = Response::input();

$data = Validate::check($in)
    ->required('app_id', 'Application')
    ->in('decision', ['approved', 'rejected'], 'Decision')
    ->values();

$app = Database::one(
    'SELECT id, app_id_code, business_name, applicant_name, email, phone,
            customer_id, username, password, requested_terms, status
       FROM b2b_applications WHERE app_id_code = ?',
    [$data['app_id']]
);
if ($app === null) {
    Response::notFound('That application does not exist.');
}
if ($app['status'] !== 'pending') {
    Response::conflict("This application was already {$app['status']}. Decisions are final.");
}

$tier   = null;
$reason = null;

if ($data['decision'] === 'approved') {
    $tier = Validate::check($in)
        ->in('tier', ['Bronze', 'Silver', 'Gold'], 'Partner tier')
        ->values()['tier'];
} else {
    $reason = trim((string) ($in['reason'] ?? '')) ?: null;
    if ($reason === null) {
        Response::validation('A reason is required.', [
            'reason' => 'Say why this application is being rejected — the applicant is told this.',
        ]);
    }
}

/* AN APPROVAL MUST PRODUCE AN ACCOUNT SOMEBODY CAN ENTER.
   -------------------------------------------------------
   Checked BEFORE the transaction, so the application stays pending and staff
   see why rather than finding an approved partner who cannot sign in.

   The hole this closes: the approval below fills the customer's credentials
   from the application with COALESCE, which keeps whatever is already there.
   If the customer row has password NULL *and* the application carries none,
   both branches do nothing and the retailer is promoted with no way in — and
   nothing said so. That became reachable when applications from signed-in
   customers were allowed to omit username and password, because a signed-in
   customer was assumed to already have one. A staff-created customer record
   (api/customers/save.php never sets a password) has not.

   WHY REFUSE RATHER THAN ISSUE A SET-PASSWORD LINK. A reset flow needs a
   token table, an expiry, a public claim page and mail that is allowed to
   fail — none of which exists here, and inventing it inside an approval
   endpoint would be the largest untested surface in this change. The route
   back already exists and is one the applicant controls: registering with
   that email CLAIMS the existing row (see the claim path in
   shop/register.php), after which approval works unchanged. The message says
   exactly that, so the refusal is actionable rather than a dead end. */
if ($data['decision'] === 'approved') {
    $linkedId = $app['customer_id']
        ?: Database::scalar('SELECT id FROM customers WHERE email = ?', [$app['email']]);

    /* Read once. scalar() returns false for "no such row" and null for "the
       column is NULL" — both mean no usable credential, and both must be
       treated the same. */
    $stored = $linkedId
        ? Database::scalar('SELECT password FROM customers WHERE id = ?', [$linkedId])
        : false;
    $customerHasPassword = is_string($stored) && $stored !== '';

    if ($app['password'] === null && !$customerHasPassword) {
        Response::conflict(sprintf(
            'This application carries no password, and %s has no sign-in set up, '
            . 'so approving it would create a wholesale account nobody can enter. '
            . 'Ask the applicant to register at the storefront with %s first — that '
            . 'sets their password and links to this record — then approve.',
            $linkedId ? 'the linked customer record' : 'that email address',
            $app['email']
        ));
    }
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    Database::run(
        'UPDATE b2b_applications SET status = ?, assigned_tier = ?, rejection_reason = ?
          WHERE id = ? AND status = ?',
        [$data['decision'], $tier, $reason, $app['id'], 'pending']
    );
    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just decided this application. Reload and try again.');
    }

    $promoted = false;
    $accountCreated = false;
    if ($data['decision'] === 'approved') {
        /* Match by the linked customer if there is one, otherwise by email. */
        $customerId = $app['customer_id']
            ?: Database::scalar('SELECT id FROM customers WHERE email = ?', [$app['email']]);

        if ($customerId) {
            Database::run("UPDATE customers SET status = 'retailer' WHERE id = ? AND status <> 'archived'",
                [$customerId]);
            $promoted = true;

            /* An applicant who already shopped with us has a customer row but
               may have no password — the seed leaves them NULL. Approval is
               when the credentials they chose on the application become real,
               so fill them in rather than leaving a retailer who cannot sign
               in. An existing password is never overwritten. */
            if ($app['password'] !== null) {
                Database::run(
                    'UPDATE customers SET username = COALESCE(username, ?), password = COALESCE(password, ?)
                      WHERE id = ?',
                    [$app['username'], $app['password'], $customerId]
                );
            }
        } elseif ($app['password'] !== null) {
            /* No customer row at all, and they chose credentials on the form.
               This comment used to say "approval does not invent one — the
               partner account is created at signup", but there IS no separate
               signup: api/b2b/apply.php collects a username and password
               precisely because applying is the signup for a wholesale
               account. Approving without creating it left an approved partner
               with no way to log in.

               Created here, at approval, so a rejected applicant never gets an
               account. */
            $n = (int) Database::scalar(
                "SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0)
                   FROM customers WHERE id REGEXP '^cus-[0-9]+$'"
            );
            $customerId = sprintf('cus-%02d', $n + 1);
            Database::run(
                'INSERT INTO customers (id, name, email, username, password, contact, status, joined)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())',
                [$customerId, $app['applicant_name'], $app['email'], $app['username'],
                 $app['password'], $app['phone'], 'retailer']
            );
            Database::run('UPDATE b2b_applications SET customer_id = ? WHERE id = ?',
                [$customerId, $app['id']]);
            $promoted = true;
            $accountCreated = true;
        }
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'user',
         $data['decision'] === 'approved'
            ? sprintf('Approved B2B application %s — %s as %s tier.%s',
                  $app['app_id_code'], $app['business_name'], $tier,
                  $accountCreated ? ' Partner account created.'
                    : ($promoted ? ' Customer promoted to retailer.' : ' No customer record to promote.'))
            : sprintf('Rejected B2B application %s — %s. Reason: %s',
                  $app['app_id_code'], $app['business_name'], $reason)]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* THE APPLICANT IS TOLD, BY EMAIL.
   ---------------------------------
   Sent AFTER the commit and never allowed to fail the request. A decision is a
   database fact; whether the notification reached them is a separate,
   best-effort thing, and rolling back an approval because a mail server timed
   out would be the wrong trade every time.

   The response reports what actually happened, so the staff screen can say
   "emailed" or "could not email" rather than implying one and doing the other.
   Mailer::isLive() distinguishes real delivery from the log transport — an
   install with no SMTP credentials still completes the flow, and still says so
   rather than pretending. */
$mailed = Mailer::send(
    $app['email'],
    $app['applicant_name'],
    $data['decision'] === 'approved'
        ? 'Your partner application is approved — ' . $app['app_id_code']
        : 'About your partner application — ' . $app['app_id_code'],
    $data['decision'] === 'approved'
        ? b2bApprovedEmail($app, $tier, $accountCreated)
        : b2bRejectedEmail($app, (string) $reason)
);

Response::ok([
    'appId'          => $app['app_id_code'],
    'status'         => $data['decision'],
    'tier'           => $tier,
    'reason'         => $reason,
    'promoted'       => $promoted ?? false,
    'accountCreated' => $accountCreated ?? false,
    'emailed'        => $mailed,
    /* false here means the message was written to storage/mail/ rather than
       delivered — the staff member needs to know to follow up by hand. */
    'mailLive'       => Mailer::isLive(),
    'mailError'      => $mailed ? null : (Mailer::lastError() ?: null),
]);


function b2bEmailShell(string $body): string
{
    return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px">'
        . $body
        . '<p style="color:#666;font-size:.9em;margin-top:22px">Elisha Bay — Juris Bay Foods, Inc.<br>'
        . '148 Brgy. Mangin, Dagupan City, Pangasinan</p></div>';
}

function b2bApprovedEmail(array $app, ?string $tier, bool $accountCreated): string
{
    $e = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');

    /* Applicants no longer request a term (see b2b/apply.php), so this states
       what approval actually unlocks rather than echoing a stored preference —
       which, for every application from here on, would be empty. */
    $terms = '<p>As a wholesale partner you can choose <strong>Net 30, Net 60 or Net 90</strong> '
           . 'payment terms at checkout on each order, and pay those balances from the '
           . '<strong>Payment Schemes</strong> page in your account.</p>';

    /* Never the password — we only hold a bcrypt hash, and emailing a
       credential would be wrong even if we could. The username is a reminder of
       what they chose, which is the part people forget. */
    $account = $accountCreated
        ? '<p>Your wholesale account is now active. Sign in with the username you '
          . 'chose on the application — <strong>' . $e($app['username']) . '</strong> — '
          . 'and the password you set at that time.</p>'
        : '<p>Your existing customer account has been upgraded to a wholesale partner '
          . 'account. Sign in as usual — wholesale pricing and terms are applied '
          . 'automatically.</p>';

    return b2bEmailShell(
        '<h2 style="color:#1d4e3f">Welcome aboard, ' . $e($app['applicant_name']) . '.</h2>'
        . '<p>Your partner application for <strong>' . $e($app['business_name'])
        . '</strong> (' . $e($app['app_id_code']) . ') has been <strong>approved</strong>'
        . ($tier ? ' at <strong>' . $e($tier) . '</strong> tier' : '') . '.</p>'
        . $account
        . $terms
        . '<p>If anything looks wrong, reply to this message quoting '
        . $e($app['app_id_code']) . '.</p>'
    );
}

function b2bRejectedEmail(array $app, string $reason): string
{
    $e = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');

    /* The reason staff typed is sent verbatim. decide.php already refuses a
       rejection without one, and that requirement exists because this email is
       where it lands — a decision the applicant cannot understand is one they
       cannot act on. */
    return b2bEmailShell(
        '<h2 style="color:#1d4e3f">About your partner application</h2>'
        . '<p>Thank you for your interest in a wholesale partnership for <strong>'
        . $e($app['business_name']) . '</strong> (' . $e($app['app_id_code']) . ').</p>'
        . '<p>We are not able to approve the application at this time.</p>'
        . '<p style="padding:12px 14px;background:#f6f4f0;border-left:3px solid #c9a227">'
        . $e($reason) . '</p>'
        . '<p>If your circumstances change, or you believe this was decided in error, '
        . 'reply to this message and we will take another look. You are very welcome '
        . 'to keep ordering from us as a regular customer in the meantime.</p>'
    );
}
