<?php
declare(strict_types=1);

/**
 * Server-side permission checks.
 *
 * The browser's applyRBAC() hides nav items and buttons the current role lacks.
 * That is presentation, not security — anyone can call an endpoint directly
 * with curl. Every endpoint that does anything must call Rbac::require() and
 * decide for itself.
 *
 * Permissions come from the role_permissions table, which is what the Roles &
 * Permissions screen edits, so a change made there takes effect immediately and
 * everywhere rather than needing a code deploy.
 */
final class Rbac
{
    /** @var array<int, string[]> role_id => permission keys */
    private static array $cache = [];

    /**
     * Permission keys granted to a role.
     *
     * A role flagged is_system (Super Admin) holds every permission
     * unconditionally and owns no role_permissions rows — the same rule
     * hasPerm() applies in the browser.
     */
    public static function forRole(int $roleId, bool $isSystem = false): array
    {
        if ($isSystem) {
            return self::allPermissionKeys();
        }
        /* SYSTEM_ONLY keys are filtered out here, not only refused at save time.
           A row inserted straight into role_permissions — by hand, by an old
           backup, by a bug — must still grant nothing. */
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
            self::SYSTEM_ONLY
        ));
    }

    /**
     * Permissions that belong to the system role (Super Admin) and cannot be
     * given to any other role — not by the Roles & Permissions screen, not by
     * a row in role_permissions.
     *
     * vat.manage is here because VAT Maintenance decides what goes on every
     * Sales Invoice: the VAT rate, which products are exempt, the senior/PWD
     * discount and who withholds tax. A wrong value there is a tax filing
     * problem for the business, so exactly one role may change it.
     */
    public const SYSTEM_ONLY = ['vat.manage'];

    public static function isSystemOnly(string $permission): bool
    {
        return in_array($permission, self::SYSTEM_ONLY, true);
    }

    /**
     * Require a SYSTEM_ONLY permission: the permission AND the system role.
     * Two checks where one would do today, so that neither alone — a grant
     * slipping through, or a role flag set wrongly — opens VAT Maintenance.
     */
    public static function requireSystemRole(string $permission): array
    {
        $user = self::require($permission);
        if ((int) ($user['is_system'] ?? 0) !== 1) {
            Response::forbidden('Only the Super Admin can do this.');
        }
        return $user;
    }

    public static function allPermissionKeys(): array
    {
        return array_column(
            Database::all('SELECT permission_key FROM permissions ORDER BY id'),
            'permission_key'
        );
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

    /**
     * Require a permission, or stop with 401/403.
     *
     * 401 when nobody is signed in and 403 when they are but lack the right —
     * the distinction matters to the client, which redirects to login on 401
     * and shows a message on 403.
     */
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
