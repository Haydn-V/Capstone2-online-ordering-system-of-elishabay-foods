<?php
declare(strict_types=1);

/** GET /api/customers/list.php (needs users.manage) with order counts and lifetime spend computed in SQL. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('users.manage');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(c.name LIKE ? OR c.email LIKE ? OR c.contact LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like);
}

/* Sort options (whitelisted): name A to Z (default), fifo (oldest first), newest. */
$orderBy = [
    'fifo'   => 'c.joined ASC, c.created_at ASC, c.id ASC',
    'newest' => 'c.joined DESC, c.created_at DESC, c.id DESC',
][(string) ($q['sort'] ?? '')] ?? 'c.name ASC';

$status = (string) ($q['status'] ?? 'all');
if (in_array($status, ['active', 'retailer', 'archived'], true)) {
    $where[] = 'c.status = ?';
    $params[] = $status;
}

$sql = 'FROM customers c';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

/* Lifetime spend uses the one revenue definition; its params come first because the sub-select appears before $sql. */
[$spendSql, $spendParams] = Revenue::spendSql('c.id');
$rows = Database::all(
    /* Send only canSignIn (yes/no), never the password hash. */
    "SELECT c.id, c.name, c.email, c.contact, c.status, c.joined,
            (c.password IS NOT NULL) AS can_sign_in,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count,
            $spendSql AS lifetime_spend
     $sql
     ORDER BY " . $orderBy . "
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    array_merge($spendParams, $params)
);

Response::ok(array_map(static fn(array $r): array => [
    'id'       => $r['id'],
    'name'     => $r['name'],
    'email'    => $r['email'],
    'contact'  => $r['contact'],
    'status'   => $r['status'],
    /* canSignIn false means the customer has no password (e.g. created by staff), shown only inside the portal so staff can tell them to register with that email. */
    'canSignIn' => (bool) $r['can_sign_in'],
    'joined'   => $r['joined'],
    'orders'   => (int) $r['order_count'],
    'spend'    => (float) $r['lifetime_spend'],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
]);
