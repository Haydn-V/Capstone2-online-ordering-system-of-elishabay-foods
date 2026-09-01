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

/* Unprefixed: the ORDER BY now applies to the derived table these columns are
   selected into, where there is no `p` to qualify them with. */
$sortMap = [
    'featured' => 'is_best DESC, sold DESC',
    'price-asc'=> 'price ASC',
    'price-desc'=> 'price DESC',
    'rating'   => 'rating DESC',
    'name'     => 'name ASC',
];
$order = $sortMap[$q['sort'] ?? 'featured'] ?? $sortMap['featured'];

/* The same derived-column stack the staff catalogue uses, so the band a
   shopper sees and the band the inventory screen shows are one decision made
   once. This file used to carry its own copy of the thresholds; the comment
   below it claimed they were "the same thresholds the staff side uses", and
   keeping that true depended on nobody editing one without the other. They are
   now literally the same code. */
$base = 'SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.sold,
                p.is_best, p.tint, p.image_url, c.name AS category,
                COALESCE(vel.units, 0) AS window_units,
                ' . Inventory::expirySelect() . '
           FROM products p
           JOIN categories c ON c.id = p.category_id
           ' . Inventory::velocityJoin() . '
          WHERE ' . implode(' AND ', $where);

$derived = 'SELECT b.*, ' . Inventory::derivedSelect() . ' FROM (' . $base . ') b';
$ranked  = 'SELECT d.*, ' . Inventory::rankSelect()    . ' FROM (' . $derived . ') d';

$rows = Database::all("SELECT * FROM ($ranked) r ORDER BY $order", $params);

/* Staff wording is an instruction to act; shopper wording is scarcity. Same
   four bands underneath, relabelled here and nowhere else. The exact count is
   still deliberately not sent, and neither is the velocity — how fast a
   product sells is commercial information, not shopfront copy. */
$SHOP_LABEL = [
    'out'  => 'Out of Stock',
    'crit' => 'Only a few left',
    'warn' => 'Low stock',
    'ok'   => 'In Stock',
];

Response::ok(array_map(static function (array $r) use ($SHOP_LABEL): array {
    $inv = Inventory::describe($r);
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
        'stockLevel'  => $inv['level'],
        'stockLabel'  => $SHOP_LABEL[$inv['level']] ?? $SHOP_LABEL['ok'],
    ];
}, $rows));
