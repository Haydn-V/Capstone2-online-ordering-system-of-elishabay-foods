<?php
declare(strict_types=1);

/** GET /api/products/list.php is readable by any signed-in staff, since the catalogue appears on many screens; writing needs products.manage. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Auth::require();

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

/* Pick the sales window (from the request or the stored setting) before filtering, since level and movement depend on it. */
Inventory::useWindow(isset($q['window']) ? (string) $q['window'] : null);

$where  = [];
$params = [];

/* Always use bound parameters; the sort column comes from a whitelist. */
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

/* Stock level and movement filters use bands computed from measured sales speed (see api/core/Inventory.php), filtered in SQL so they cover every product. */
$outer = [];

$level = (string) ($q['level'] ?? '');
if ($level !== '' && $level !== 'all') {
    $pred = Inventory::levelPredicate($level);
    if ($pred === null) {
        Response::validation('Unknown stock level.', ['level' => 'Use out, crit, warn or ok.']);
    }
    $outer[] = $pred;
}

$movement = (string) ($q['movement'] ?? '');
if ($movement !== '' && $movement !== 'all') {
    $pred = Inventory::movementPredicate($movement);
    if ($pred === null) {
        Response::validation('Unknown movement band.', ['movement' => 'Use fast, slow or non.']);
    }
    $outer[] = $pred;
}

/* Expiry-risk filter (a product can be well stocked yet about to expire), applied in PHP with the count adjusted to match. */
$expiringOnly = in_array((string) ($q['expiring'] ?? ''), ['1', 'true', 'yes'], true);

/* Sort keys: urgency (worst first, from level_rank) and cover (products with no sales last). */
$sortMap = [
    'name'    => 'name ASC',
    'price'   => 'price ASC',
    'stock'   => 'stock ASC',
    'sold'    => 'sold DESC',
    'newest'  => 'created_at DESC',
    'urgency' => 'level_rank ASC, days_cover IS NULL, days_cover ASC',
    'cover'   => 'days_cover IS NULL, days_cover ASC',
    'movement'=> 'movement_rank DESC, per_month DESC',
];
$order = $sortMap[$q['sort'] ?? 'name'] ?? $sortMap['name'];

/* Three query layers (base, derived rates, ranked bands) because SQL cannot reuse an alias in the same SELECT; thresholds stay only in Inventory.php. */
$baseWhere = $where ? ' WHERE ' . implode(' AND ', $where) : '';

$base = 'SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.review_count, p.sold,
                p.is_best, p.tint, p.image_url, p.archived, p.created_at,'
                . (Database::hasColumn('products', 'nutrition') ? ' p.net_weight_g, p.nutrition,' : '') . '
                c.id AS category_id, c.name AS category,
                ' . Inventory::velocityColumns() . ',
                ' . Inventory::expirySelect() . '
           FROM products p
           JOIN categories c ON c.id = p.category_id
           ' . Inventory::velocityJoin() . $baseWhere;

$derived = 'SELECT b.*, ' . Inventory::derivedSelect() . ' FROM (' . $base . ') b';
$ranked  = 'SELECT d.*, ' . Inventory::rankSelect()    . ' FROM (' . $derived . ') d';

$outerWhere = $outer ? ' WHERE ' . implode(' AND ', $outer) : '';
$stack      = "FROM ($ranked) r$outerWhere";

/* The same params feed the count and the page. */
$total = (int) Database::scalar("SELECT COUNT(*) $stack", $params);

/* When an expiry filter is on, fetch the whole matching set, since it is filtered in PHP. */
$rows = $expiringOnly
    ? Database::all("SELECT * $stack ORDER BY $order", $params)
    : Database::all(
        "SELECT * $stack ORDER BY $order LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
        $params
      );

/* Cast values so the client gets numbers and booleans, not strings. */
$products = array_map(static function (array $r): array {
    /* sold is still returned as the lifetime total shown on the storefront; stockLevel and movement are the measured bands. */
    return [
        'id'          => $r['id'],
        'name'        => $r['name'],
        'desc'        => $r['description'],
        'price'       => (float) $r['price'],
        'stock'       => (int) $r['stock'],
        'rating'      => (float) $r['rating'],
        /* Always send review_count with rating, so an unrated product is not shown as 0 stars. */
        'reviewCount' => (int) $r['review_count'],
        'sold'        => (int) $r['sold'],
        'best'        => (bool) $r['is_best'],
        'tint'        => $r['tint'],
        'image'       => $r['image_url'],
        'archived'    => (bool) $r['archived'],
        'weightG'     => isset($r['net_weight_g']) ? (int) $r['net_weight_g'] : null,
        'nutrition'   => !empty($r['nutrition']) ? json_decode($r['nutrition'], true) : null,
        'categoryId'  => $r['category_id'],
        'cat'         => $r['category'],
        'inventory'   => Inventory::describe($r),
    ];
}, $rows);

if ($expiringOnly) {
    $products = array_values(array_filter(
        $products,
        static fn(array $p): bool => $p['inventory']['expiryRisk'] !== null
    ));
    /* The total must match what is returned after the expiry filter, so pagination stays correct. */
    $total = count($products);
}

Response::ok($products, [
    'page'   => $paging['page'],
    'limit'  => $paging['limit'],
    'total'  => $total,
    'pages'  => (int) ceil($total / max(1, $paging['limit'])),
    /* Echo the thresholds used so screens can label them. */
    'inventoryModel' => Inventory::model(),
    /* Echo the window actually used so the screen labels itself correctly. */
    'window'         => Inventory::windowKey() ?? 'default',
    'windowDays'     => Inventory::windowDays(),
    'windowLabel'    => Inventory::windowLabel(),
]);
