<?php
declare(strict_types=1);

/** Invitation for a customer that staff put on record (customers/save.php): an email with a link that opens the
    website's sign-up with their name and email filled in. Signing up still verifies the email with a code
    (Signup.php) and then attaches the password to this same record (register.php), so the link carries no secret
    and only the owner of the inbox can claim the account. Send after the insert is committed; Mailer never throws. */
final class CustomerInvite
{
    /** Email the invitation; false when the customer already has a password, is archived, or mail failed. */
    public static function send(string $customerId): bool
    {
        $c = Database::one('SELECT id, name, email, password, status FROM customers WHERE id = ?', [$customerId]);
        if ($c === null || $c['password'] !== null || $c['status'] === 'archived' || !$c['email']) {
            return false;
        }
        return Mailer::send($c['email'], $c['name'], 'You are invited to shop at Elisha Bay', self::email($c['name'], self::link($c)));
    }

    /** The sign-up link on this site: public/index.html?invite=1&email=…&name=… */
    public static function link(array $c): string
    {
        $https  = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
               || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
        $host   = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
        $base   = '/' . trim((string) (Database::config()['app']['base_path'] ?? '/'), '/') . '/';
        $base   = $base === '//' ? '/' : $base;
        return ($https ? 'https' : 'http') . '://' . $host . $base . 'public/index.html?'
            . http_build_query(['invite' => 1, 'email' => $c['email'], 'name' => $c['name']]);
    }

    private static function email(string $name, string $link): string
    {
        $e = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
        return '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#2a2418">'
            . '<h2 style="color:#b8860b;margin:0 0 12px">Elisha Bay</h2>'
            . '<p>Hello ' . $e($name) . ',</p>'
            . '<p>Our team has added you as a customer of Elisha Bay. Create your password to order online, '
            . 'track your deliveries and see every purchase you have made with us, in store or online.</p>'
            . '<p style="margin:22px 0"><a href="' . $e($link) . '" style="background:#e8a317;color:#1e1a0e;'
            . 'padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Create my account</a></p>'
            . '<p style="font-size:12px;color:#6b6250;word-break:break-all">Or open this link: ' . $e($link) . '</p>'
            . '<p style="font-size:13px;color:#6b6250">We will email you a short code to confirm this address while you sign up. '
            . 'If you were not expecting this, you can ignore this email.</p>'
            . '</div>';
    }
}
