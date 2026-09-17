<?php
declare(strict_types=1);

/**
 * GET /api/roles/list.php
 *
 * Requires rbac.manage — this is the screen that decides what everyone else
 * can do, so reading it is already privileged.
 *
 * Returns every role with its granted permission keys and a live account count,
 * plus the full permission catalogue grouped by area, which is everything the
 * Role & Permission Matrix needs to render in one request.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('rbac.manage');

$roles = Database::all(
    "SELECT r.id, r.name, r.slug, r.description, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.status = 'active') AS active_users,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS total_users
       FROM roles r
      ORDER BY r.id"
);

/* One query for every grant, grouped in PHP — not one query per role. */
$grants = [];
foreach (Database::all(
    'SELECT rp.role_id, p.permission_key
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      ORDER BY p.id'
) as $g) {
    $grants[(int) $g['role_id']][] = $g['permission_key'];
}

$permissions = Database::all('SELECT id, permission_key, area, label FROM permissions ORDER BY id');

$allKeys = array_column($permissions, 'permission_key');

Response::ok([
    'roles' => array_map(static function (array $r) use ($grants, $allKeys): array {
        $isSystem = (int) $r['is_system'] === 1;
        return [
            'id'          => (int) $r['id'],
            'name'        => $r['name'],
            'slug'        => $r['slug'],
            'desc'        => $r['description'],
            'isSystem'    => $isSystem,
            /* A system role holds everything unconditionally and owns no
               role_permissions rows. Reporting the full list here keeps the
               matrix honest instead of showing Super Admin with zero ticks. */
            /* A non-system role never reports a SYSTEM_ONLY permission, even if
               a stray row grants it — Rbac::forRole() ignores that row too. */
            'permissions' => $isSystem
                ? $allKeys
                : array_values(array_diff($grants[(int) $r['id']] ?? [], Rbac::SYSTEM_ONLY)),
            'activeUsers' => (int) $r['active_users'],
            'totalUsers'  => (int) $r['total_users'],
        ];
    }, $roles),
    'permissions' => array_map(static fn(array $p): array => [
        'key'   => $p['permission_key'],
        'area'  => $p['area'],
        'label' => $p['label'],
        /* So the matrix can show it locked for every other role. */
        'systemOnly' => Rbac::isSystemOnly($p['permission_key']),
    ], $permissions),
]);
