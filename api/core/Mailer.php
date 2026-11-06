<?php
declare(strict_types=1);

/** Mailer: a small hand-written SMTP client (no Composer, and mail() is unreliable on XAMPP) with an 'smtp' transport that really sends and a 'log' transport that saves to storage/mail/; send() never throws, so callers commit first and email after. */

final class Mailer
{
    /** Last error, for the caller to surface. */
    private static string $lastError = '';

    public static function lastError(): string
    {
        return self::$lastError;
    }

    private static function config(): array
    {
        $cfg = Database::config()['mail'] ?? [];
        return $cfg + [
            'transport'  => 'log',
            'host'       => '',
            'port'       => 587,
            'encryption' => 'tls',
            'username'   => '',
            'password'   => '',
            'from_email' => 'no-reply@elishabay.ph',
            'from_name'  => 'Elisha Bay',
            'timeout'    => 15,
        ];
    }

    /** Whether real email delivery is configured, so the UI can say so. */
    public static function isLive(): bool
    {
        $c = self::config();
        return $c['transport'] === 'smtp' && $c['host'] !== '';
    }

    /** Send one message (true on success), generating the plain-text version from the HTML body. */
    public static function send(string $toEmail, string $toName, string $subject, string $html): bool
    {
        self::$lastError = '';
        $c = self::config();

        if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
            self::$lastError = 'Not a valid email address.';
            return false;
        }

        /* Strip newlines from names and the subject to prevent email header injection. */
        $toName  = self::oneLine($toName);
        $subject = self::oneLine($subject);

        $message = self::build($c, $toEmail, $toName, $subject, $html);

        try {
            if ($c['transport'] === 'smtp' && $c['host'] !== '') {
                return self::sendSmtp($c, $toEmail, $message);
            }
            return self::sendLog($toEmail, $subject, $message);
        } catch (Throwable $e) {
            /* Never throws, because the caller has already committed. */
            self::$lastError = $e->getMessage();
            error_log('[mail] ' . $e->getMessage());
            return false;
        }
    }

    private static function oneLine(string $v): string
    {
        return trim(str_replace(["\r", "\n", "\0"], ' ', $v));
    }

    /** RFC 5322 message with a text and an HTML part. */
    private static function build(array $c, string $toEmail, string $toName, string $subject, string $html): string
    {
        $boundary = 'eb' . bin2hex(random_bytes(12));
        $text     = self::htmlToText($html);
        $from     = sprintf('%s <%s>', self::oneLine((string) $c['from_name']), $c['from_email']);
        $to       = $toName !== '' ? sprintf('%s <%s>', $toName, $toEmail) : $toEmail;

        $headers = [
            'Date: ' . date('r'),
            'From: ' . $from,
            'To: ' . $to,
            /* Encode non-ASCII subjects (names with ñ, é) so they do not arrive garbled. */
            'Subject: ' . self::encodeHeader($subject),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@elishabay.ph>',
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        ];

        $body = "--{$boundary}\r\n"
              . "Content-Type: text/plain; charset=UTF-8\r\n"
              . "Content-Transfer-Encoding: base64\r\n\r\n"
              . chunk_split(base64_encode($text)) . "\r\n"
              . "--{$boundary}\r\n"
              . "Content-Type: text/html; charset=UTF-8\r\n"
              . "Content-Transfer-Encoding: base64\r\n\r\n"
              . chunk_split(base64_encode($html)) . "\r\n"
              . "--{$boundary}--\r\n";

        return implode("\r\n", $headers) . "\r\n\r\n" . $body;
    }

    private static function encodeHeader(string $v): string
    {
        return preg_match('/[\x80-\xFF]/', $v)
            ? '=?UTF-8?B?' . base64_encode($v) . '?='
            : $v;
    }

    private static function htmlToText(string $html): string
    {
        $t = preg_replace('#<br\s*/?>#i', "\n", $html);
        $t = preg_replace('#</(p|div|h[1-6]|tr|li)>#i', "\n", (string) $t);
        $t = strip_tags((string) $t);
        $t = html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $t = preg_replace("/[ \t]+/", ' ', $t);
        $t = preg_replace("/\n{3,}/", "\n\n", (string) $t);
        return trim((string) $t);
    }

    /* Log transport */
    private static function sendLog(string $toEmail, string $subject, string $message): bool
    {
        $dir = dirname(__DIR__, 2) . '/storage/mail';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            self::$lastError = 'Cannot create the mail log directory.';
            return false;
        }
        $name = date('Ymd-His') . '-' . bin2hex(random_bytes(4)) . '.eml';
        $ok = @file_put_contents($dir . '/' . $name, $message) !== false;
        if (!$ok) {
            self::$lastError = 'Cannot write to the mail log directory.';
        }
        return $ok;
    }

    /* SMTP transport */
    private static function sendSmtp(array $c, string $toEmail, string $message): bool
    {
        $host    = (string) $c['host'];
        $port    = (int) $c['port'];
        $timeout = (int) $c['timeout'];
        $enc     = strtolower((string) $c['encryption']);

        /* Port 465 uses TLS from the start; port 587 upgrades with STARTTLS. */
        $dsn = ($enc === 'ssl' ? 'ssl://' : '') . $host;

        $sock = @stream_socket_client("$dsn:$port", $errno, $errstr, $timeout);
        if (!$sock) {
            self::$lastError = "Cannot reach the mail server ($errstr)";
            return false;
        }
        stream_set_timeout($sock, $timeout);

        try {
            self::expect($sock, 220);
            self::cmd($sock, 'EHLO ' . self::heloName(), 250);

            if ($enc === 'tls') {
                self::cmd($sock, 'STARTTLS', 220);
                if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                    throw new RuntimeException('STARTTLS negotiation failed.');
                }
                /* Send EHLO again after the TLS upgrade, because some servers only allow AUTH after it. */
                self::cmd($sock, 'EHLO ' . self::heloName(), 250);
            }

            if ($c['username'] !== '') {
                self::cmd($sock, 'AUTH LOGIN', 334);
                self::cmd($sock, base64_encode((string) $c['username']), 334);
                self::cmd($sock, base64_encode((string) $c['password']), 235);
            }

            self::cmd($sock, 'MAIL FROM:<' . $c['from_email'] . '>', 250);
            self::cmd($sock, 'RCPT TO:<' . $toEmail . '>', 250);
            self::cmd($sock, 'DATA', 354);

            /* Dot-stuffing: double any leading "." so it does not end the message early. */
            $payload = preg_replace('/^\./m', '..', $message);
            fwrite($sock, $payload . "\r\n.\r\n");
            self::expect($sock, 250);

            self::cmd($sock, 'QUIT', 221, true);
            fclose($sock);
            return true;
        } catch (Throwable $e) {
            self::$lastError = $e->getMessage();
            @fclose($sock);
            error_log('[mail] SMTP: ' . $e->getMessage());
            return false;
        }
    }

    private static function heloName(): string
    {
        $h = (string) ($_SERVER['SERVER_NAME'] ?? 'localhost');
        return preg_match('/^[A-Za-z0-9.\-]+$/', $h) ? $h : 'localhost';
    }

    private static function cmd($sock, string $line, int $expect, bool $lenient = false): string
    {
        fwrite($sock, $line . "\r\n");
        return self::expect($sock, $expect, $lenient);
    }

    /** Reads a full multi-line reply and checks its code. */
    private static function expect($sock, int $code, bool $lenient = false): string
    {
        $reply = '';
        while (($line = fgets($sock, 8192)) !== false) {
            $reply .= $line;
            /* "250-" continues, "250 " is the last line. */
            if (strlen($line) >= 4 && $line[3] === ' ') {
                break;
            }
            $meta = stream_get_meta_data($sock);
            if (!empty($meta['timed_out'])) {
                throw new RuntimeException('The mail server stopped responding.');
            }
        }
        $got = (int) substr(trim($reply), 0, 3);
        if ($got !== $code && !$lenient) {
            throw new RuntimeException("SMTP expected {$code}, got: " . trim($reply));
        }
        return $reply;
    }
}
