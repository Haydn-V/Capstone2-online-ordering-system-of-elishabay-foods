<?php
declare(strict_types=1);

/**
 * GET /api/shop/products.php?category=&search=&sort=
 *
 * PUBLIC — no session required. This is the storefront catalogue.
 *
 * Being public changes what may be returned. products/list.php is a staff
 * endpoint and includes cost-adjacent fields and archived rows; none of that
 * belongs on a page anyone can open. This returns only what a shopper needs.
 *
 * THE EXACT STOCK COUNT IS NOW PUBLIC. READ THIS BEFORE COPYING THE PATTERN.
 * -------------------------------------------------------------------------
 * This endpoint used to send a coarse band and nothing else, on the reasoning
 * that "Low stock" is useful to a customer while "7 units left in Dagupan" is
 * operational detail a competitor can poll on a timer and read the sales rate
 * off. That reasoning has not stopped being true. It was overruled: the
 * adviser asked for the available quantity to be shown, and a storefront
 * cannot display a number it was never sent.
 *
 * The trade-off is real and the group should make it deliberately. Most shops
 * publish an exact count only when stock is LOW, where scarcity helps the
 * shopper more than the figure helps a competitor. Narrowing to that is one
 * line — return `stock` only when `$inv['level']` is 'crit' or 'out' — and
 * Inventory::shopLabel() already words those bands with the count in them.
 *
 * Velocity is still not sent. How fast a product sells is the thing the count
 * would otherwise have to be sampled repeatedly to infer, and nothing on the
 * storefront needs it.
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
    /* `featured` and `best-selling` are NOT the same ranking and both are
       offered. `featured` puts the manually-flagged products first and only
       breaks ties by units sold, so a slow product an administrator starred
       outranks the actual top seller — which is the point of flagging one.
       `best-selling` is the unedited ranking by units sold, and it is what the
       shop's Best Selling / Top 5 / Top 10 options mean. */
    'featured' => 'is_best DESC, sold DESC',
    'best-selling' => 'sold DESC, rating DESC',
    'price-asc'=> 'price ASC',
    'price-desc'=> 'price DESC',
    'rating'   => 'rating DESC',
    'name'     => 'name ASC',
    /* The storefront's select has always sent `name-asc`; the map only had
       `name`, so choosing "Name (A–Z)" fell through to the `featured` default
       and the order silently did not change. */
    'name-asc' => 'name ASC',
];
$order = $sortMap[$q['sort'] ?? 'featured'] ?? $sortMap['featured'];

/* The same derived-column stack the staff catalogue uses, so the band a
   shopper sees and the band the inventory screen shows are one decision made
   once. This file used to carry its own copy of the thresholds; the comment
   below it claimed they were "the same thresholds the staff side uses", and
   keeping that true depended on nobody editing one without the other. They are
   now literally the same code. */
$base = 'SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.review_count, p.sold,
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

/* The shopper-facing wording lives in Inventory::shopLabel() rather than in a
   table here, because shop/cart.php has to say the same thing about the same
   product and a second copy is how the two start disagreeing. */

Response::ok(array_map(static function (array $r): array {
    $inv   = Inventory::describe($r);
    $stock = (int) $r['stock'];
    return [
        'id'          => $r['id'],
        'name'        => $r['name'],
        'desc'        => $r['description'],
        'price'       => (float) $r['price'],
        'rating'      => (float) $r['rating'],
        /* THE COUNT TRAVELS WITH THE AVERAGE, ALWAYS. Sent unconditionally so
           no caller has to decide whether a rating is real: 0 reviews means
           there is no score to show, and every surface renders "No ratings yet"
           from this field rather than from a 0.00 that looks like a bad score. */
        'reviewCount' => (int) $r['review_count'],
        'sold'        => (int) $r['sold'],
        'best'        => (bool) $r['is_best'],
        'tint'        => $r['tint'],
        'image'       => $r['image_url'],
        'cat'         => $r['category'],
        'inStock'     => $stock > 0,
        /* The number the storefront prints and clamps its quantity stepper to.
           The stepper is a courtesy, not a control: checkout re-reads stock
           inside its transaction and refuses the line by name. */
        'stock'       => $stock,
        'stockLevel'  => $inv['level'],
        'stockLabel'  => Inventory::shopLabel($inv['level'], $stock),
    ];
}, $rows));
