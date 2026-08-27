<?php
declare(strict_types=1);

/**
 * GET /api/shop/products.php?category=&search=&sort=
 *
 * PUBLIC — no session required. This is the storefront catalogue.
 *
 * Being public changes what may be returned. products/list.php is a staff
 * endpoint and includes stock counts, cost-adjacent fields and archived rows;
 * none of that belongs on a page anyone can open. This returns only what a
 * shopper needs, plus a coarse availability band instead of an exact stock
 * number — "Low stock" is useful to a customer, "7 units left in Dagupan" is
 * operational detail a competitor can poll.
 *
 * Archived products are never returned.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$q = $_GET;

$where  = ['p.archived = 0'];
$params = [];

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(p.name LIKE ? OR p.description LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like);
}

$category = trim((string) ($q['category'] ?? ''));
if ($category !== '' && $category !== 'All') {
    $where[] = 'c.name = ?';
    $params[] = $category;
}

$sortMap = [
    'featured' => 'p.is_best DESC, p.sold DESC',
    'price-asc'=> 'p.price ASC',
    'price-desc'=> 'p.price DESC',
    'rating'   => 'p.rating DESC',
    'name'     => 'p.name ASC',
];
$order = $sortMap[$q['sort'] ?? 'featured'] ?? $sortMap['featured'];

$rows = Database::all(
    "SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.sold,
            p.is_best, p.tint, p.image_url, c.name AS category
       FROM products p
       JOIN categories c ON c.id = p.category_id
      WHERE " . implode(' AND ', $where) . "
      ORDER BY $order",
    $params
);

/* Same thresholds the staff side uses, reduced to a label. The exact count is
   deliberately not sent. */
$band = static function (int $stock): array {
    if ($stock <= 0)  return ['level' => 'out',  'label' => 'Out of Stock'];
    if ($stock <= 10) return ['level' => 'crit', 'label' => 'Only a few left'];
    if ($stock <= 100)return ['level' => 'warn', 'label' => 'Low stock'];
    return                   ['level' => 'ok',   'label' => 'In Stock'];
};

Response::ok(array_map(static function (array $r) use ($band): array {
    $b = $band((int) $r['stock']);
    return [
        'id'          => $r['id'],
        'name'        => $r['name'],
        'desc'        => $r['description'],
        'price'       => (float) $r['price'],
        'rating'      => (float) $r['rating'],
        'sold'        => (int) $r['sold'],
        'best'        => (bool) $r['is_best'],
        'tint'        => $r['tint'],
        'image'       => $r['image_url'],
        'cat'         => $r['category'],
        'inStock'     => (int) $r['stock'] > 0,
        'stockLevel'  => $b['level'],
        'stockLabel'  => $b['label'],
    ];
}, $rows));
