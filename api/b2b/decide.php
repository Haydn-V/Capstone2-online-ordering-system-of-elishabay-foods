<?php
declare(strict_types=1);

/** POST /api/b2b/decide.php (needs b2b.review) approves or rejects an application in one transaction, promoting the customer to retailer on approval, and a decided application cannot be decided again. */

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
    /* The tier sets the retailer's Net credit budget (Payments::creditLimits()); Bronze when none is sent. */
    $tier = 'Bronze';
    if (($in['tier'] ?? '') !== '') {
        $tier = Validate::check($in)
            ->in('tier', Payments::TIERS, 'Partner tier')
            ->values()['tier'];
    }
} else {
    $reason = trim((string) ($in['reason'] ?? '')) ?: null;
    if ($reason === null) {
        Response::validation('A reason is required.', [
            'reason' => 'Say why this application is being rejected — the applicant is told this.',
        ]);
    }
}

/* Refuse approval before the transaction if it would create a retailer with no password, telling staff the applicant should register with that email first to claim the account. */
if ($data['decision'] === 'approved') {
    $linkedId = $app['customer_id']
        ?: Database::scalar('SELECT id FROM customers WHERE email = ?', [$app['email']]);

    /* scalar() returns false for no row and null for a NULL column, and both mean no usable password. */
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
            Database::run("UPDATE customers SET status = 'retailer', retailer_tier = ? WHERE id = ? AND status <> 'archived'",
                [$tier, $customerId]);
            /* Link the application to the account it promoted, so its tier can be changed later. */
            Database::run('UPDATE b2b_applications SET customer_id = ? WHERE id = ? AND customer_id IS NULL',
                [$customerId, $app['id']]);
            $promoted = true;

            /* If the existing customer has no password yet, fill in the credentials from the application, but never overwrite an existing password. */
            if ($app['password'] !== null) {
                Database::run(
                    'UPDATE customers SET username = COALESCE(username, ?), password = COALESCE(password, ?)
                      WHERE id = ?',
                    [$app['username'], $app['password'], $customerId]
                );
            }
        } elseif ($app['password'] !== null) {
            /* No customer row exists, so create the account here at approval (applying is the signup), and a rejected applicant never gets one. */
            $n = (int) Database::scalar(
                "SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0)
                   FROM customers WHERE id REGEXP '^cus-[0-9]+$'"
            );
            $customerId = sprintf('cus-%02d', $n + 1);
            Database::run(
                'INSERT INTO customers (id, name, email, username, password, contact, status, retailer_tier, joined)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())',
                [$customerId, $app['applicant_name'], $app['email'], $app['username'],
                 $app['password'], $app['phone'], 'retailer', $tier]
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
            ? sprintf('Approved B2B application %s — %s%s.%s',
                  $app['app_id_code'], $app['business_name'], $tier ? " as {$tier} tier" : '',
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

/* Email the decision only after the commit and never let it fail the request, reporting whether the email really went out so staff can follow up. */
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
    /* false means the message was only written to storage/mail/ instead of delivered, so staff should follow up by hand. */
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

    /* Applicants no longer request a term, so the email describes what approval unlocks instead of a stored preference. */
    $limit = $tier ? (Payments::creditLimits()[$tier] ?? null) : null;
    $terms = '<p>As a wholesale partner you can choose <strong>Net 30, Net 60 or Net 90</strong> '
           . 'payment terms at checkout on each order, and pay those balances from the '
           . '<strong>Payment Schemes</strong> page in your account.'
           . ($limit !== null ? ' Your Net credit budget is <strong>₱' . number_format($limit, 2)
               . '</strong>: unpaid Net balances plus a new Net order cannot go above it.' : '')
           . '</p>';

    /* Never send the password (only its hash is stored), just remind them of their username. */
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

    /* Send the staff member's rejection reason as typed, because the applicant needs it to know what to fix. */
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
