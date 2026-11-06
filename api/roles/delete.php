<?php
declare(strict_types=1);

/** POST /api/roles/delete.php (needs rbac.manage) deletes a custom role, refusing the built-in roles and any role still assigned to staff; its permissions are removed by cascade. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('rbac.manage');

const BUILT_IN_ROLE_SLUGS = ['super-admin', 'admin', 'cashier', 'inventory-staff', 'online-orders-staff'];

$in = Response::input();
$id = (int) ($in['id'] ?? 0);
if ($id <= 0) {
    Response::badRequest('Role id is required.');
}

$role = Database::one('SELECT id, name, slug, is_system FROM roles WHERE id = ?', [$id]);
if (!$role) {
    Response::notFound('That role no longer exists.');
}
if ((int) $role['is_system'] === 1 || in_array($role['slug'], BUILT_IN_ROLE_SLUGS, true)) {
    Response::conflict("{$role['name']} is a built-in staff role and cannot be deleted.");
}

$users = (int) Database::scalar('SELECT COUNT(*) FROM users WHERE role_id = ?', [$id]);
if ($users > 0) {
    Response::conflict("{$role['name']} is still assigned to {$users} staff account"
        . ($users === 1 ? '' : 's') . '. Move them to another role in Employee Accounts first.');
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();
    Database::run('DELETE FROM roles WHERE id = ?', [$id]);
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$actor['name'], $actor['id'], 'system', sprintf('Deleted role %s.', $role['name'])]
    );
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::ok(['id' => $id, 'name' => $role['name']]);
