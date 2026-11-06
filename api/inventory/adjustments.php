<?php
declare(strict_types=1);

/** GET /api/inventory/adjustments.php (needs inventory.report) lists the stock adjustment log, joining product names so renames stay current. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireAny('inventory.report', 'inventory.manage');

$q      = $_GET;
$paging = Validate::paging($q, 10, 200);

$where  = [];
$params = [];

if (!empty($q['product_id'])) {
    $where[] = 'a.product_id = ?';
    $params[] = $q['product_id'];
}

if (!empty($q['type']) && in_array($q['type'], ['disposal', 'return'], true)) {
    $where[] = 'a.type = ?';
    $params[] = $q['type'];
}

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(p.name LIKE ? OR a.reason LIKE ? OR a.batch_code LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like);
}

$sql = 'FROM inventory_adjustments a JOIN products p ON p.id = a.product_id';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

$rows = Database::all(
    "SELECT a.id, a.date, a.product_id, p.name AS product_name,
            a.qty, a.type, a.reason, a.batch_code, a.created_at
     $sql
     ORDER BY a.date DESC, a.id DESC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

Response::ok(array_map(static fn(array $r): array => [
    'id'          => (int) $r['id'],
    'date'        => $r['date'],
    'productId'   => $r['product_id'],
    'productName' => $r['product_name'],
    'qty'         => (int) $r['qty'],
    'type'        => $r['type'],
    'reason'      => $r['reason'],
    'batch'       => $r['batch_code'],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
]);
