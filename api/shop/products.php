<?php
declare(strict_types=1);

/** GET /api/shop/products.php (public) returns only what shoppers need, never archived products or sales velocity; the exact stock count is shown at the adviser's request. */

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

/* Unprefixed because ORDER BY applies to the derived table. */
$sortMap = [
    /* featured puts starred products first (ties by units sold), while best-selling ranks purely by units sold. */
    'featured' => 'is_best DESC, sold DESC',
    'best-selling' => 'sold DESC, rating DESC',
    'price-asc'=> 'price ASC',
    'price-desc'=> 'price DESC',
    'rating'   => 'rating DESC',
    'name'     => 'name ASC',
    /* Accept name-asc, which is what the storefront sends. */
    'name-asc' => 'name ASC',
];
$order = $sortMap[$q['sort'] ?? 'featured'] ?? $sortMap['featured'];

/* Uses the same derived bands as the staff catalogue so shoppers and staff see the same stock band. */
$base = 'SELECT p.id, p.name, p.description, p.price, ' . Stock::availableSql('p') . ' AS stock, p.rating, p.review_count, p.sold,
                ' . (Database::hasTable('featured_products')
                    /* A product in the landing page's Best Sellers is a best seller everywhere, including the shop ribbon. */
                    ? '(p.is_best = 1 OR p.id IN (SELECT product_id FROM featured_products)) AS is_best,'
                    : 'p.is_best,') . ' p.tint, p.image_url, c.name AS category,'
                . (Database::hasColumn('products', 'nutrition') ? ' p.net_weight_g, p.nutrition,' : '') . '
                ' . Inventory::velocityColumns() . ',
                ' . Inventory::expirySelect() . '
           FROM products p
           JOIN categories c ON c.id = p.category_id
           ' . Inventory::velocityJoin() . '
          WHERE ' . implode(' AND ', $where);

$derived = 'SELECT b.*, ' . Inventory::derivedSelect() . ' FROM (' . $base . ') b';
$ranked  = 'SELECT d.*, ' . Inventory::rankSelect()    . ' FROM (' . $derived . ') d';

$rows = Database::all("SELECT * FROM ($ranked) r ORDER BY $order", $params);

/* Shopper wording comes from Inventory::shopLabel(), shared with the cart. */

Response::ok(array_map(static function (array $r): array {
    $inv   = Inventory::describe($r);
    $stock = (int) $r['stock'];
    return [
        'id'          => $r['id'],
        'name'        => $r['name'],
        'desc'        => $r['description'],
        'price'       => (float) $r['price'],
        'rating'      => (float) $r['rating'],
        /* Always send review_count with the rating so unrated products show "No ratings yet". */
        'reviewCount' => (int) $r['review_count'],
        'sold'        => (int) $r['sold'],
        'best'        => (bool) $r['is_best'],
        'tint'        => $r['tint'],
        'image'       => $r['image_url'],
        'cat'         => $r['category'],
        'weightG'     => isset($r['net_weight_g']) ? (int) $r['net_weight_g'] : null,
        'nutrition'   => !empty($r['nutrition']) ? json_decode($r['nutrition'], true) : null,
        'inStock'     => $stock > 0,
        /* Stock count used for the quantity stepper; checkout still re-checks it. */
        'stock'       => $stock,
        'stockLevel'  => $inv['level'],
        'stockLabel'  => Inventory::shopLabel($inv['level'], $stock),
    ];
}, $rows));
