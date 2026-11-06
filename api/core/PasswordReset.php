<?php
declare(strict_types=1);

/** Customer password reset by a 6-digit emailed code (hashed, 10 minutes, 5 attempts, one resend per minute), held in the session and answering the same way whether or not the email exists. */
final class PasswordReset
{
    private const KEY      = 'eb_pwreset';
    public  const TTL      = 600;
    public  const RESEND   = 60;
    public  const ATTEMPTS = 5;

    /** Start a reset for an email and send its first code. */
    public static function start(string $email): array
    {
        $c = Database::one(
            "SELECT id, name, email FROM customers
              WHERE email = ? AND password IS NOT NULL AND status <> 'archived'",
            [$email]
        );
        $prev = $_SESSION[self::KEY] ?? null;
        if (is_array($prev) && ($prev['email'] ?? '') === $email && isset($prev['sent'])
            && time() - $prev['sent'] < self::RESEND) {
            return self::out($prev, null);
        }
        $_SESSION[self::KEY] = ['email' => $email, 'id' => $c['id'] ?? null, 'name' => $c['name'] ?? ''];
        return self::issue(false);
    }

    /** New code for the reset in progress (resend). */
    public static function issue(bool $isResend = true): array
    {
        $s = $_SESSION[self::KEY] ?? null;
        if (!is_array($s)) {
            Response::error('EXPIRED', 'Your reset request has expired. Please start again.', 410);
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

        /* Only a real account is emailed; the answer is the same either way. */
        if ($s['id'] !== null) {
            Mailer::send($s['email'], $s['name'], 'Your Elisha Bay password reset code', self::email($s['name'], $code));
        }
        return self::out($s, $s['id'] !== null ? $code : null);
    }

    /** Check the code and return the customer id, or respond with an error and exit. */
    public static function verify(string $code): string
    {
        $s = $_SESSION[self::KEY] ?? null;
        if (!is_array($s) || !isset($s['hash'])) {
            Response::error('EXPIRED', 'Your reset request has expired. Please start again.', 410);
        }
        if (time() > $s['expires']) {
            Response::validation('That code has expired. Tap "Resend code" for a new one.', ['code' => 'Code expired.']);
        }
        if ($s['attempts'] >= self::ATTEMPTS) {
            Response::validation('Too many wrong codes. Tap "Resend code" for a new one.', ['code' => 'Too many attempts.']);
        }
        if ($s['id'] === null || !preg_match('/^\d{6}$/', $code) || !password_verify($code, $s['hash'])) {
            $s['attempts']++;
            $_SESSION[self::KEY] = $s;
            $left = self::ATTEMPTS - $s['attempts'];
            Response::validation(
                $left > 0 ? "Incorrect code. $left attempt" . ($left === 1 ? '' : 's') . ' left.' : 'Too many wrong codes. Tap "Resend code" for a new one.',
                ['code' => 'Incorrect code.']
            );
        }
        return (string) $s['id'];
    }

    public static function clear(): void
    {
        unset($_SESSION[self::KEY]);
    }

    private static function out(array $s, ?string $code): array
    {
        $out = [
            'email'     => self::mask($s['email']),
            'expiresIn' => self::TTL,
            'resendIn'  => max(1, self::RESEND - (time() - ($s['sent'] ?? time()))),
            'mailLive'  => Mailer::isLive(),
        ];
        /* Dev install with no real mail: hand the code back (same rule as Signup). */
        if ($code !== null && !Mailer::isLive() && (Database::config()['app']['debug'] ?? false)) {
            $out['devCode'] = $code;
        }
        return $out;
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
            . '<p>Use this code to reset your Elisha Bay password:</p>'
            . '<p style="font-size:30px;font-weight:bold;letter-spacing:8px;margin:18px 0">' . $e($code) . '</p>'
            . '<p>It expires in 10 minutes. If you did not ask to reset your password, ignore this email — your password has not changed.</p>'
            . '</div>';
    }
}
