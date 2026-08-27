<?php
declare(strict_types=1);

/**
 * GET /api/products/list.php
 *
 * Query: ?page=1&limit=25&search=&category=&status=active|archived|all&sort=name|price|stock|sold
 *
 * Readable by any signed-in staff member — the catalogue appears in POS,
 * inventory and reports, so gating it behind products.manage would break
 * screens that only display it. Writing is a different matter and lives
 * behind products.manage in create/update/delete.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

/* Bound parameters throughout — never string concatenation. The sort column
   cannot be bound (it is an identifier, not a value), so it is resolved
   through a whitelist instead. */
$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(p.name LIKE ? OR p.id LIKE ? OR p.description LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like);
}

$category = trim((string) ($q['category'] ?? ''));
if ($category !== '' && $category !== 'All') {
    $where[] = 'c.name = ?';
    $params[] = $category;
}

$status = (string) ($q['status'] ?? 'active');
if ($status === 'active') {
    $where[] = 'p.archived = 0';
} elseif ($status === 'archived') {
    $where[] = 'p.archived = 1';
}   /* 'all' adds no clause */

/* Stock-level and movement bands, expressed in SQL rather than applied to a
   page after the fact. The Inventory Report filters on both; doing it client-
   side meant "show me everything critical" returned only the critical items
   that happened to be on the current page. Thresholds match stockInfo() and
   movementType() in the client exactly — if one moves, move the other. */
$level = (string) ($q['level'] ?? '');
if ($level !== '' && $level !== 'all') {
    $bands = [
        'out'  => 'p.stock <= 0',
        'crit' => 'p.stock > 0 AND p.stock <= 10',
        'warn' => 'p.stock > 10 AND p.stock <= 100',
        'ok'   => 'p.stock > 100',
    ];
    if (!isset($bands[$level])) {
        Response::validation('Unknown stock level.', ['level' => 'Use out, crit, warn or ok.']);
    }
    $where[] = $bands[$level];
}

$movement = (string) ($q['movement'] ?? '');
if ($movement !== '' && $movement !== 'all') {
    $bands = [
        'fast' => 'p.sold > 1000',
        'slow' => 'p.sold >= 200 AND p.sold <= 1000',
        'non'  => 'p.sold < 200',
    ];
    if (!isset($bands[$movement])) {
        Response::validation('Unknown movement band.', ['movement' => 'Use fast, slow or non.']);
    }
    $where[] = $bands[$movement];
}

$sortMap = [
    'name'  => 'p.name ASC',
    'price' => 'p.price ASC',
    'stock' => 'p.stock ASC',
    'sold'  => 'p.sold DESC',
    'newest'=> 'p.created_at DESC',
];
$order = $sortMap[$q['sort'] ?? 'name'] ?? $sortMap['name'];

$sql = 'FROM products p JOIN categories c ON c.id = p.category_id';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

$rows = Database::all(
    "SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.sold,
            p.is_best, p.tint, p.image_url, p.archived,
            c.id AS category_id, c.name AS category
     $sql
     ORDER BY $order
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

/* Cast at the edge so the client gets numbers and booleans rather than the
   strings MySQL hands back for DECIMAL and TINYINT. */
$products = array_map(static fn(array $r): array => [
    'id'          => $r['id'],
    'name'        => $r['name'],
    'desc'        => $r['description'],
    'price'       => (float) $r['price'],
    'stock'       => (int) $r['stock'],
    'rating'      => (float) $r['rating'],
    'sold'        => (int) $r['sold'],
    'best'        => (bool) $r['is_best'],
    'tint'        => $r['tint'],
    'image'       => $r['image_url'],
    'archived'    => (bool) $r['archived'],
    'categoryId'  => $r['category_id'],
    'cat'         => $r['category'],
], $rows);

Response::ok($products, [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
]);
