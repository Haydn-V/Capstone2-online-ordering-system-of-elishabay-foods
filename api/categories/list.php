<?php
declare(strict_types=1);

/** GET /api/categories/list.php returns product varieties to any signed-in staff member for filter dropdowns. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$status = (string) ($_GET['status'] ?? 'active');

$where = '';
if ($status === 'active') {
    $where = 'WHERE c.archived = 0';
} elseif ($status === 'archived') {
    $where = 'WHERE c.archived = 1';
}

/* Include each category's product count to save the Varieties screen extra requests. */
$rows = Database::all(
    "SELECT c.id, c.name, c.description, c.archived,
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.archived = 0) AS product_count
       FROM categories c
       $where
       ORDER BY c.name ASC"
);

Response::ok(array_map(static fn(array $r): array => [
    'id'       => $r['id'],
    'name'     => $r['name'],
    'desc'     => $r['description'],
    'archived' => (bool) $r['archived'],
    'products' => (int) $r['product_count'],
], $rows));
