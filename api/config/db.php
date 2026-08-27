<?php
declare(strict_types=1);

/**
 * The single PDO connection for the whole API.
 *
 * Nothing outside api/ ever talks to MySQL, and nothing inside api/ builds its
 * own connection — everything goes through Database::pdo().
 */
final class Database
{
    private static ?PDO $pdo = null;
    private static ?array $config = null;

    /** Load api/config/config.php once. */
    public static function config(): array
    {
        if (self::$config === null) {
            $path = __DIR__ . '/config.php';
            if (!is_file($path)) {
                Response::serverError(
                    'api/config/config.php is missing. Copy config.example.php to config.php — see docs/SETUP.md.'
                );
            }
            self::$config = require $path;
        }
        return self::$config;
    }

    public static function pdo(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $db = self::config()['db'];

        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $db['host'],
            $db['port'],
            $db['name'],
            $db['charset']
        );

        try {
            self::$pdo = new PDO($dsn, $db['user'], $db['pass'], [
                /* Exceptions, not silent false returns. A query that fails
                   must not be mistaken for a query that found nothing. */
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,

                /* Real prepared statements, not client-side interpolation.
                   With emulation on, PDO builds the SQL string itself and the
                   protection depends on the charset being handled correctly. */
                PDO::ATTR_EMULATE_PREPARES   => false,

                /* XAMPP ships MySQL without STRICT_TRANS_TABLES, which turns
                   constraint violations into warnings — that is how the first
                   seed import silently wrote '' into a NOT NULL column. Pin it
                   per connection so the app never inherits a loose server. */
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET SESSION sql_mode='{$db['sql_mode']}'",
            ]);
        } catch (PDOException $e) {
            /* The DSN and credentials must never reach the client. */
            error_log('[elishabay] DB connection failed: ' . $e->getMessage());
            Response::serverError('Cannot reach the database. Is MySQL running? See docs/SETUP.md.');
        }

        return self::$pdo;
    }

    /** Run a prepared statement and return every row. */
    public static function all(string $sql, array $params = []): array
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    /** Run a prepared statement and return the first row, or null. */
    public static function one(string $sql, array $params = []): ?array
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    /** Run a prepared statement and return a single scalar. */
    public static function scalar(string $sql, array $params = [])
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st->fetchColumn();
    }

    /** Run a write and return the number of affected rows. */
    public static function run(string $sql, array $params = []): int
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    /** Does a table exist? Used for features that depend on optional tables. */
    public static function hasTable(string $table): bool
    {
        return (bool) self::scalar(
            'SELECT COUNT(*) FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            [self::config()['db']['name'], $table]
        );
    }
}
