<?php
declare(strict_types=1);

/**
 * Mailer — outbound email.
 *
 * WHY THIS IS HAND-WRITTEN
 * ------------------------
 * This project has no Composer and no vendor/ directory; it is plain PHP by
 * design. Pulling in a dependency manager to send one kind of email would be a
 * larger change to the project than the feature itself, so this is a small SMTP
 * client — enough of RFC 5321 to authenticate and deliver, and nothing more.
 *
 * PHP's own mail() is deliberately not used. It shells out to sendmail, which
 * XAMPP ships unconfigured, and its failure mode is to return true having
 * delivered nothing.
 *
 * TWO TRANSPORTS, AND WHY THE SECOND EXISTS
 * -----------------------------------------
 *   'smtp' — real delivery.
 *   'log'  — writes the complete message to storage/mail/ and reports success.
 *
 * The log transport is not a stub for unfinished work. A B2B approval must not
 * fail because nobody has entered SMTP credentials yet, and an installation
 * without them should still be able to demonstrate and test the whole flow.
 * What it must never do is *pretend*: every log-transport send is recorded, the
 * response says which transport ran, and the staff screen shows it.
 *
 * MAIL IS NEVER PART OF A TRANSACTION
 * -----------------------------------
 * send() does not throw. A decision on a partner application is a database fact;
 * whether the notification email reached them is a separate, best-effort thing.
 * Rolling back an approval because a mail server timed out would be the wrong
 * trade every time. Callers commit first, then send, and report the outcome.
 */

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

    /** Whether real delivery is configured. The UI says so rather than guessing. */
    public static function isLive(): bool
    {
        $c = self::config();
        return $c['transport'] === 'smtp' && $c['host'] !== '';
    }

    /**
     * Send one message. Returns true on success.
     *
     * `$html` is the body. A plain-text alternative is generated from it rather
     * than asked for, because two hand-maintained copies of the same message
     * drift and the text one is the copy nobody looks at.
     */
    public static function send(string $toEmail, string $toName, string $subject, string $html): bool
    {
        self::$lastError = '';
        $c = self::config();

        if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
            self::$lastError = 'Not a valid email address.';
            return false;
        }

        /* Header injection: a newline in a name or subject would let the caller
           add its own headers — a Bcc, a different From. Stripped, not escaped,
           because a line break has no legitimate place in either. */
        $toName  = self::oneLine($toName);
        $subject = self::oneLine($subject);

        $message = self::build($c, $toEmail, $toName, $subject, $html);

        try {
            if ($c['transport'] === 'smtp' && $c['host'] !== '') {
                return self::sendSmtp($c, $toEmail, $message);
            }
            return self::sendLog($toEmail, $subject, $message);
        } catch (Throwable $e) {
            /* Never propagates. The caller has already committed. */
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
            /* Non-ASCII in a subject must be encoded or it arrives as mojibake —
               business names here contain ñ and é. */
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

    /* ------------------------------------------------------------------
       Log transport
       ------------------------------------------------------------------ */
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

    /* ------------------------------------------------------------------
       SMTP transport
       ------------------------------------------------------------------ */
    private static function sendSmtp(array $c, string $toEmail, string $message): bool
    {
        $host    = (string) $c['host'];
        $port    = (int) $c['port'];
        $timeout = (int) $c['timeout'];
        $enc     = strtolower((string) $c['encryption']);

        /* Implicit TLS (port 465) wraps the socket from the first byte;
           STARTTLS (587) upgrades a plain connection mid-session. */
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
                /* EHLO again: the server's capability list after the upgrade is
                   the one that counts, and some refuse AUTH before it. */
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

            /* Dot-stuffing: a line consisting of a single "." ends DATA, so any
               body line starting with one is doubled. */
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
