<?php
declare(strict_types=1);

/**
 * GET /api/audit/list.php?page=&limit=&type=&actor=&search=&from=&to=
 *
 * Requires audit.view.
 *
 * Read-only, deliberately and permanently. There is no create, update or delete
 * endpoint for audit rows: a log that can be edited by the same system it
 * records is not evidence of anything. Entries are written by the endpoints
 * that perform the actions, inside their transactions.
 */

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
        /* <= on a DATETIME column needs the end of that day, or "to today"
           silently excludes everything logged today. */
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

/* Distinct types, so the filter dropdown offers what actually exists rather
   than a hardcoded list that drifts. */
$types = array_column(Database::all('SELECT DISTINCT type FROM audit_logs ORDER BY type'), 'type');

Response::ok(array_map(static fn(array $r): array => [
    'id'          => (int) $r['id'],
    'ts'          => $r['ts'],
    'actor'       => $r['actor'],
    'actorUserId' => $r['actor_user_id'],
    /* The name is preserved as written; this flags that the account behind it
       is no longer active, without rewriting history. */
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
