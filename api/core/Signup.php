<?php
declare(strict_types=1);

/**
 * Email-verified sign-up.
 *
 * shop/register.php validates the form and HOLDS it here, in the PHP session —
 * nothing is written to customers until the emailed code is confirmed by
 * shop/register-verify.php. The password is kept only as its hash.
 *
 * The code: 6 random digits, stored hashed, 10 minutes, 5 attempts, one resend
 * a minute. A new code replaces the old one.
 */
final class Signup
{
    private const KEY      = 'eb_signup';
    public  const TTL      = 600;
    public  const RESEND   = 60;
    public  const ATTEMPTS = 5;

    /** Hold a validated sign-up and email its first code. */
    public static function hold(array $pending): array
    {
        $_SESSION[self::KEY] = ['p' => $pending];
        return self::issue();
    }

    public static function pending(): ?array
    {
        $s = $_SESSION[self::KEY] ?? null;
        return is_array($s) && isset($s['p']) ? $s : null;
    }

    public static function clear(): void
    {
        unset($_SESSION[self::KEY]);
    }

    /** New code (resend). Throttled; returns what the page needs to show. */
    public static function issue(bool $isResend = false): array
    {
        $s = self::pending();
        if ($s === null) {
            Response::error('EXPIRED', 'Your sign-up has expired. Please fill in the form again.', 410);
        }
        if ($isResend && isset($s['sent']) && time() - $s['sent'] < self::RESEND) {
            Response::error('TOO_SOON', 'Please wait ' . (self::RESEND - (time() - $s['sent'])) . ' seconds before asking for a new code.', 429);
        }

        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $s['hash']     = password_hash($code, PASSWORD_BCRYPT);
        $s['expires']  = time() + self::TTL;
        $s['sent']     = time();
        $s['attempts'] = 0;
        $_SESSION[self::KEY] = $s;

        $p = $s['p'];
        $mailed = Mailer::send($p['email'], $p['name'], 'Your Elisha Bay verification code', self::email($p['name'], $code));

        $out = [
            'requiresVerification' => true,
            'email'     => self::mask($p['email']),
            'expiresIn' => self::TTL,
            'resendIn'  => self::RESEND,
            'emailed'   => $mailed,
            'mailLive'  => Mailer::isLive(),
        ];
        /* Dev install with no real mail: hand the code back so the flow can be
           tested. Never when mail is live (same rule as shop/profile.php). */
        if (!Mailer::isLive() && (Database::config()['app']['debug'] ?? false)) {
            $out['devCode'] = $code;
        }
        return $out;
    }

    /** Check a code. Returns the held sign-up on success; responds and exits otherwise. */
    public static function verify(string $code): array
    {
        $s = self::pending();
        if ($s === null || !isset($s['hash'])) {
            Response::error('EXPIRED', 'Your sign-up has expired. Please fill in the form again.', 410);
        }
        if (time() > $s['expires']) {
            Response::validation('That code has expired. Tap "Resend code" for a new one.', ['code' => 'Code expired.']);
        }
        if ($s['attempts'] >= self::ATTEMPTS) {
            Response::validation('Too many wrong codes. Tap "Resend code" for a new one.', ['code' => 'Too many attempts.']);
        }
        if (!preg_match('/^\d{6}$/', $code) || !password_verify($code, $s['hash'])) {
            $s['attempts']++;
            $_SESSION[self::KEY] = $s;
            $left = self::ATTEMPTS - $s['attempts'];
            Response::validation(
                $left > 0 ? "Incorrect code. $left attempt" . ($left === 1 ? '' : 's') . ' left.' : 'Too many wrong codes. Tap "Resend code" for a new one.',
                ['code' => 'Incorrect code.']
            );
        }
        return $s['p'];
    }

    private static function mask(string $email): string
    {
        [$u, $d] = array_pad(explode('@', $email, 2), 2, '');
        $keep = mb_substr($u, 0, min(2, mb_strlen($u)));
        return $keep . str_repeat('•', max(1, mb_strlen($u) - mb_strlen($keep))) . '@' . $d;
    }

    private static function email(string $name, string $code): string
    {
        $e = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
        return '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#2a2418">'
            . '<h2 style="color:#b8860b;margin:0 0 12px">Elisha Bay</h2>'
            . '<p>Hello ' . $e($name) . ',</p>'
            . '<p>Use this code to finish creating your Elisha Bay account:</p>'
            . '<p style="font-size:30px;font-weight:bold;letter-spacing:8px;margin:18px 0">' . $e($code) . '</p>'
            . '<p>It expires in 10 minutes. If you did not sign up, you can ignore this email — no account has been created.</p>'
            . '</div>';
    }
}
