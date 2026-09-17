<?php
declare(strict_types=1);

/**
 * POST /api/roles/save.php
 * Body: { "id": 3 (omit to create), "name": "...", "description": "...",
 *         "permissions": ["pos.use", "sales.report", …] }
 *
 * Requires rbac.manage.
 *
 * This endpoint edits the permission system itself, so its own guards matter
 * more than most:
 *
 *   - a system role (Super Admin) cannot be edited or have its grants changed;
 *     it holds everything by definition and is the account of last resort
 *   - you cannot remove rbac.manage from your own role, which is the one edit
 *     that cannot be undone from inside the application
 *   - unknown permission keys are rejected rather than silently dropped, so a
 *     typo does not quietly grant nothing
 *
 * Grants are replaced wholesale inside a transaction: the matrix screen sends
 * the full intended set, and a partial apply would leave a role with a mixture
 * of old and new rights.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('rbac.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('name', 'Role name')
    ->maxLen('name', 50, 'Role name')
    ->values();

$description = trim((string) ($in['description'] ?? '')) ?: null;

$wanted = $in['permissions'] ?? [];
if (!is_array($wanted)) {
    Response::badRequest('permissions must be an array of permission keys.');
}
$wanted = array_values(array_unique(array_map('strval', $wanted)));

/* Reject unknown keys loudly. Silently dropping them would mean the screen
   shows a permission as granted that was never stored. */
$known = array_column(Database::all('SELECT id, permission_key FROM permissions'), 'id', 'permission_key');
$unknown = array_diff($wanted, array_keys($known));
if ($unknown) {
    Response::validation('Unknown permission.', [
        'permissions' => 'Not real permissions: ' . implode(', ', $unknown),
    ]);
}

/* Super Admin's own permissions cannot be handed out. Refused by name, so the
   person trying learns why rather than seeing the switch silently reset. */
$reserved = array_values(array_filter($wanted, [Rbac::class, 'isSystemOnly']));
if ($reserved) {
    Response::validation('That permission belongs to Super Admin only.', [
        'permissions' => 'Only the Super Admin can hold: ' . implode(', ', $reserved)
            . '. It cannot be granted to another role.',
    ]);
}

$clash = Database::scalar('SELECT COUNT(*) FROM roles WHERE name = ? AND id <> ?',
    [$data['name'], $in['id'] ?? 0]);
if ($clash) {
    Response::conflict('A role with that name already exists.');
}

$pdo = Database::pdo();

if ($isUpdate) {
    $role = Database::one('SELECT id, name, is_system FROM roles WHERE id = ?', [$in['id']]);
    if ($role === null) {
        Response::notFound('That role does not exist.');
    }
    if ((int) $role['is_system'] === 1) {
        Response::forbidden(
            "{$role['name']} is a system role — it holds every permission by definition and cannot be edited. " .
            'It is the account of last resort if permissions are misconfigured.'
        );
    }

    /* Removing rbac.manage from your own role locks permission management away
       from the person doing it, and there is no way back from inside the app. */
    if ((int) $role['id'] === (int) $actor['role_id'] && !in_array('rbac.manage', $wanted, true)) {
        Response::conflict(
            'You cannot remove permission management from your own role — you would not be able to undo it.'
        );
    }

    try {
        $pdo->beginTransaction();

        Database::run('UPDATE roles SET name = ?, description = ? WHERE id = ?',
            [$data['name'], $description, $role['id']]);

        $before = array_column(Database::all(
            'SELECT p.permission_key FROM role_permissions rp
               JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?',
            [$role['id']]
        ), 'permission_key');

        Database::run('DELETE FROM role_permissions WHERE role_id = ?', [$role['id']]);
        foreach ($wanted as $key) {
            Database::run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                [$role['id'], $known[$key]]);
        }

        $added   = array_diff($wanted, $before);
        $removed = array_diff($before, $wanted);
        $detail  = [];
        if ($added)   { $detail[] = 'granted ' . implode(', ', $added); }
        if ($removed) { $detail[] = 'revoked ' . implode(', ', $removed); }

        Database::run(
            'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
             VALUES (NOW(), ?, ?, ?, ?)',
            [$actor['name'], $actor['id'], 'system',
             sprintf('Role %s updated. %s', $data['name'],
                 $detail ? implode('; ', $detail) : 'No permission changes.')]
        );

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        throw $e;
    }

    $id = (int) $role['id'];
} else {
    $slug = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', $data['name']), '-'));

    try {
        $pdo->beginTransaction();

        Database::run('INSERT INTO roles (name, slug, description, is_system) VALUES (?, ?, ?, 0)',
            [$data['name'], $slug, $description]);
        $id = (int) $pdo->lastInsertId();

        foreach ($wanted as $key) {
            Database::run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                [$id, $known[$key]]);
        }

        Database::run(
            'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
             VALUES (NOW(), ?, ?, ?, ?)',
            [$actor['name'], $actor['id'], 'system',
             sprintf('Created role %s with %d permission(s): %s.',
                 $data['name'], count($wanted), $wanted ? implode(', ', $wanted) : 'none')]
        );

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        throw $e;
    }
}

Response::ok([
    'id'          => $id,
    'name'        => $data['name'],
    'desc'        => $description,
    'permissions' => $wanted,
], null, $isUpdate ? 200 : 201);
