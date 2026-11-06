<?php
declare(strict_types=1);

/** GET /api/users/list.php (needs employees.manage) lists staff accounts, checked on the server, and never selects password hashes. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('employees.manage');

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
            r.id AS role_id, r.name AS role, COALESCE(r.is_system, 0) AS is_system
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
