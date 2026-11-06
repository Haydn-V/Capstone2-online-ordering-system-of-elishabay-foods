<?php
declare(strict_types=1);

/** Server-side permission checks from role_permissions, because hiding buttons in the browser is not security and every endpoint must check for itself. */
final class Rbac
{
    /** @var array<int, string[]> role_id => permission keys */
    private static array $cache = [];

    /** Permission keys for a role; the system role (Super Admin) holds every permission except the ones it switched off for itself. */
    public static function forRole(int $roleId, bool $isSystem = false): array
    {
        if ($isSystem) {
            return self::$cache[-1] ??= array_values(array_diff(self::allPermissionKeys(), self::superAdminOff()));
        }
        /* Filter out SYSTEM_ONLY keys (and ADMIN_ONLY ones for any role but Admin) so a stray role_permissions row still grants nothing. */
        return self::$cache[$roleId] ??= array_values(array_diff(
            array_column(
                Database::all(
                    'SELECT p.permission_key
                       FROM role_permissions rp
                       JOIN permissions p ON p.id = rp.permission_id
                      WHERE rp.role_id = ?
                      ORDER BY p.id',
                    [$roleId]
                ),
                'permission_key'
            ),
            self::SYSTEM_ONLY,
            self::isAdminRole($roleId) ? [] : self::ADMIN_ONLY
        ));
    }

    /** Permissions only the Super Admin and the Admin role can hold (the Super Admin grants them to Admin on the matrix). */
    public const ADMIN_ONLY = ['refunds.large'];

    /** The built-in Admin role's slug. */
    public const ADMIN_SLUG = 'admin';

    public static function isAdminOnly(string $permission): bool
    {
        return in_array($permission, self::ADMIN_ONLY, true);
    }

    public static function isAdminRole(int $roleId): bool
    {
        return Database::scalar('SELECT slug FROM roles WHERE id = ?', [$roleId]) === self::ADMIN_SLUG;
    }

    /** Permissions only the system role (Super Admin) can hold, such as vat.manage, because VAT settings affect every Sales Invoice. */
    public const SYSTEM_ONLY = ['vat.manage', 'credit.limits', 'shipping.manage'];

    public static function isSystemOnly(string $permission): bool
    {
        return in_array($permission, self::SYSTEM_ONLY, true);
    }

    /** Require a SYSTEM_ONLY permission by checking both the permission and the system role. */
    public static function requireSystemRole(string $permission): array
    {
        $user = self::require($permission);
        if ((int) ($user['is_system'] ?? 0) !== 1) {
            Response::forbidden('Only the Super Admin can do this.');
        }
        return $user;
    }

    /* The Super Admin keeps these no matter what, so it can always manage access, staff and system settings and undo its own changes. */
    public const SUPER_LOCKED = ['rbac.manage', 'employees.manage', 'audit.view', 'vat.manage', 'credit.limits', 'shipping.manage'];

    /* settings row holding the JSON list of permissions the Super Admin switched off (an off-list, so new permissions start on). */
    private const SUPER_OFF_KEY = 'super_admin_off';

    public static function isSuperLocked(string $permission): bool
    {
        return in_array($permission, self::SUPER_LOCKED, true);
    }

    /** Permissions the Super Admin has switched off for itself; locked ones are never returned. */
    public static function superAdminOff(): array
    {
        $raw  = Database::scalar('SELECT value_text FROM settings WHERE key_name = ?', [self::SUPER_OFF_KEY]);
        $list = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($list) ? array_values(array_diff(array_map('strval', $list), self::SUPER_LOCKED)) : [];
    }

    /** Store the Super Admin's permissions as given: everything not wanted (and not locked) is switched off. */
    public static function saveSuperAdmin(array $wanted): array
    {
        $off = array_values(array_diff(self::allPermissionKeys(), $wanted, self::SUPER_LOCKED));
        Database::run(
            'INSERT INTO settings (key_name, value_text) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
            [self::SUPER_OFF_KEY, json_encode($off)]
        );
        unset(self::$cache[-1]);
        return $off;
    }

    /* Keys the code relies on; the Super Admin holds them even before their migration has added the row. */
    private const CODE_KEYS = ['employees.manage', 'reports.financial'];

    public static function allPermissionKeys(): array
    {
        return array_values(array_unique(array_merge(array_column(
            Database::all('SELECT permission_key FROM permissions ORDER BY id'),
            'permission_key'
        ), self::CODE_KEYS)));
    }

    /** Everything the front end needs to rebuild its permission catalogue. */
    public static function catalogue(): array
    {
        return Database::all(
            'SELECT permission_key, area, label FROM permissions ORDER BY id'
        );
    }

    /** Does the signed-in user hold this permission? */
    public static function has(string $permission): bool
    {
        $user = Auth::user();
        if ($user === null) {
            return false;
        }
        return in_array(
            $permission,
            self::forRole((int) $user['role_id'], (bool) $user['is_system']),
            true
        );
    }

    /** Require a permission or stop with 401 (not signed in, client redirects to login) or 403 (signed in but not allowed). */
    public static function require(string $permission): array
    {
        $user = Auth::require();
        if (!self::has($permission)) {
            Response::forbidden('You do not have permission to do this.');
        }
        return $user;
    }

    /** Require any one of several permissions. */
    public static function requireAny(string ...$permissions): array
    {
        $user = Auth::require();
        foreach ($permissions as $p) {
            if (self::has($p)) {
                return $user;
            }
        }
        Response::forbidden('You do not have permission to do this.');
    }
}
