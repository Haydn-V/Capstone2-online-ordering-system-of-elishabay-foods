<?php
declare(strict_types=1);

/**
 * GET /api/users/list.php
 *
 * Query: ?page=1&limit=25&search=&status=active|archived|all
 *
 * Requires users.manage. This is the endpoint that demonstrates the rule the
 * whole API depends on: a Cashier's browser never shows the User Management
 * nav item, but hiding a button is not access control — so the permission is
 * checked here, server-side, and a direct request with a Cashier session gets
 * 403 regardless of what the client did or did not render.
 *
 * Password hashes are never selected. There is no reason for a hash to leave
 * the database, so it does not appear in the query at all rather than being
 * fetched and then unset.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('users.manage');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(u.name LIKE ? OR u.email LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like);
}

$status = (string) ($q['status'] ?? 'all');
if (in_array($status, ['active', 'archived'], true)) {
    $where[] = 'u.status = ?';
    $params[] = $status;
}

$sql = 'FROM users u LEFT JOIN roles r ON r.id = u.role_id';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

$rows = Database::all(
    "SELECT u.id, u.name, u.email, u.avatar, u.status, u.created_at,
            r.id AS role_id, r.name AS role
     $sql
     ORDER BY u.id ASC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

Response::ok($rows, [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
]);
