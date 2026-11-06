<?php
declare(strict_types=1);

/** The single shared PDO connection; all database access in the API goes through Database::pdo(). */
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
                /* Throw exceptions so a failed query is never mistaken for an empty result. */
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,

                /* Use real prepared statements instead of PDO's emulation, for safer parameter handling. */
                PDO::ATTR_EMULATE_PREPARES   => false,

                /* Force strict SQL mode per connection so constraint violations raise errors instead of warnings. */
                /* Set the MySQL clock to Manila time (+08:00) so CURDATE()/NOW() match PHP's dates. */
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET SESSION sql_mode='{$db['sql_mode']}', time_zone='+08:00'",
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

    /** Check whether a table exists, for features that depend on optional tables. */
    public static function hasTable(string $table): bool
    {
        return (bool) self::scalar(
            'SELECT COUNT(*) FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            [self::config()['db']['name'], $table]
        );
    }

    /** Check whether a column exists, so code can ship before its migration runs. */
    public static function hasColumn(string $table, string $column): bool
    {
        static $seen = [];
        return $seen["$table.$column"] ??= (bool) self::scalar(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [self::config()['db']['name'], $table, $column]
        );
    }
}
