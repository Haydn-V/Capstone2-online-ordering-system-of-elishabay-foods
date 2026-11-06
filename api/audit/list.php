<?php
declare(strict_types=1);

/** GET /api/audit/list.php (needs audit.view) is read-only on purpose: an audit log the system could edit would not be evidence. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('audit.view');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

if (!empty($q['type'])) {
    $where[] = 'a.type = ?';
    $params[] = $q['type'];
}
if (!empty($q['actor'])) {
    $where[] = '(a.actor_user_id = ? OR a.actor = ?)';
    array_push($params, $q['actor'], $q['actor']);
}
$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(a.description LIKE ? OR a.actor LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like);
}
foreach (['from' => '>=', 'to' => '<='] as $key => $op) {
    if (!empty($q[$key])) {
        $d = DateTime::createFromFormat('Y-m-d', $q[$key]);
        if (!$d || $d->format('Y-m-d') !== $q[$key]) {
            Response::validation('Check the date range.', [$key => 'Use YYYY-MM-DD.']);
        }
        /* Compare against the end of the day, or a "to today" filter would skip everything logged today. */
        $where[] = "a.ts $op ?";
        $params[] = $q[$key] . ($op === '<=' ? ' 23:59:59' : ' 00:00:00');
    }
}

$sql = 'FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

$rows = Database::all(
    "SELECT a.id, a.ts, a.actor, a.actor_user_id, u.status AS actor_status,
            a.type, a.description
     $sql
     ORDER BY a.ts DESC, a.id DESC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

/* Distinct types from the data, so the filter dropdown only offers types that actually exist. */
$types = array_column(Database::all('SELECT DISTINCT type FROM audit_logs ORDER BY type'), 'type');

Response::ok(array_map(static fn(array $r): array => [
    'id'          => (int) $r['id'],
    'ts'          => $r['ts'],
    'actor'       => $r['actor'],
    'actorUserId' => $r['actor_user_id'],
    /* Keep the actor name as written and only flag that the account is no longer active, so history is never rewritten. */
    'actorArchived' => $r['actor_status'] === 'archived',
    'type'        => $r['type'],
    'desc'        => $r['description'],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
    'types' => $types,
]);
