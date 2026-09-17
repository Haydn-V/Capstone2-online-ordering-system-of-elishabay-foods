<?php
declare(strict_types=1);

/**
 * GET /api/products/list.php
 *
 * Query: ?page=1&limit=25&search=&category=&status=active|archived|all&sort=name|price|stock|sold
 *        &window=default|yesterday|week|month
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

/* The window every band on this page is measured over. Chosen by the reader
   (Inventory Report and Stock Overview both offer it) and falling back to the
   stored setting, which is what every other caller of this endpoint gets.

   BEFORE THE FILTERS, because `level` and `movement` are predicates over
   columns the window defines: asking for everything Critical as measured
   yesterday has to measure yesterday first. */
Inventory::useWindow(isset($q['window']) ? (string) $q['window'] : null);

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

/* Stock-level and movement bands.
 *
 * These are no longer predicates on p.stock and p.sold. Both are now derived
 * from measured sales velocity — see api/core/Inventory.php for why fixed piece
 * counts and a lifetime `sold` counter were the wrong instruments. The filter
 * still runs in SQL, and still for the original reason: applied to a page of
 * results, "show me everything critical" returned only the critical items that
 * happened to be on the current page.
 *
 * The predicates read `level_rank` / `movement_rank`, which are computed by the
 * derived-table stack assembled below rather than available on `p` directly. */
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

/* Products whose earliest-dated lot will not sell before it expires. Its own
   filter rather than a fifth stock level, because it is the opposite failure:
   a product can be comfortably stocked, correctly labelled Safe, and still be
   about to be thrown away. Evaluated in describe() rather than SQL — it needs
   the per-lot arithmetic — so this one filters after the fact and the count is
   adjusted to match. */
$expiringOnly = in_array((string) ($q['expiring'] ?? ''), ['1', 'true', 'yes'], true);

/* Sort keys. `urgency` and `cover` are the two the Inventory Report actually
   wants — "what needs attention first" is not answerable by name or price.
   level_rank ascends from 0 = out of stock, so worst-first needs no DESC.
   A NULL cover means nothing has sold, which is not urgency; it sorts last. */
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

/* Three layers, because SQL cannot reference a column alias from the same
   SELECT. Each one adds what the next needs:
     base    products, category, window units, earliest-dated lot
     derived per_day / per_month / days_cover from those units
     ranked  the bands, which are CASEs over days_cover and per_month
   Written out rather than folded together so that a threshold change lands in
   Inventory.php alone and this file never has to restate one. */
$baseWhere = $where ? ' WHERE ' . implode(' AND ', $where) : '';

$base = 'SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.review_count, p.sold,
                p.is_best, p.tint, p.image_url, p.archived, p.created_at,
                c.id AS category_id, c.name AS category,
                COALESCE(vel.units, 0) AS window_units,
                ' . Inventory::expirySelect() . '
           FROM products p
           JOIN categories c ON c.id = p.category_id
           ' . Inventory::velocityJoin() . $baseWhere;

$derived = 'SELECT b.*, ' . Inventory::derivedSelect() . ' FROM (' . $base . ') b';
$ranked  = 'SELECT d.*, ' . Inventory::rankSelect()    . ' FROM (' . $derived . ') d';

$outerWhere = $outer ? ' WHERE ' . implode(' AND ', $outer) : '';
$stack      = "FROM ($ranked) r$outerWhere";

/* The same params feed the count and the page — the placeholders all live in
   the base layer, which both wrap. */
$total = (int) Database::scalar("SELECT COUNT(*) $stack", $params);

/* Expiry filtering happens in PHP, so the page cannot be trimmed in SQL
   without losing rows the filter would have kept. Fetch the matching set whole
   in that case; the catalogue is small and this screen is not paged when a
   risk filter is on. */
$rows = $expiringOnly
    ? Database::all("SELECT * $stack ORDER BY $order", $params)
    : Database::all(
        "SELECT * $stack ORDER BY $order LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
        $params
      );

/* Cast at the edge so the client gets numbers and booleans rather than the
   strings MySQL hands back for DECIMAL and TINYINT. */
$products = array_map(static function (array $r): array {
    /* `sold` is still returned. It remains the honest lifetime total and the
       storefront prints it as "N sold" — it is only its use as a MOVEMENT
       CLASSIFIER that was wrong. `stockLevel` and `movement` below are the
       measured replacements and are what every band on screen now reads. */
    return [
        'id'          => $r['id'],
        'name'        => $r['name'],
        'desc'        => $r['description'],
        'price'       => (float) $r['price'],
        'stock'       => (int) $r['stock'],
        'rating'      => (float) $r['rating'],
        /* Always beside the average. `rating` is 0.00 for a product nobody has
           reviewed, and a screen that prints it without checking this shows
           "0.0 stars" — which reads as a bad product rather than an unrated
           one. Every renderer of `rating` in the portal checks this first. */
        'reviewCount' => (int) $r['review_count'],
        'sold'        => (int) $r['sold'],
        'best'        => (bool) $r['is_best'],
        'tint'        => $r['tint'],
        'image'       => $r['image_url'],
        'archived'    => (bool) $r['archived'],
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
    /* The count must describe what was returned, not what the SQL matched
       before the risk filter ran — a total the page cannot reach produces
       pager buttons that lead nowhere. */
    $total = count($products);
}

Response::ok($products, [
    'page'   => $paging['page'],
    'limit'  => $paging['limit'],
    'total'  => $total,
    'pages'  => (int) ceil($total / max(1, $paging['limit'])),
    /* Echoed so a screen can label its own thresholds without a second
       request, and so a reader can see what the bands were measured against. */
    'inventoryModel' => Inventory::tunables(),
    /* Which window answered THIS request. The screen labels itself from the
       response rather than from what it asked for, so a request that fell
       back to the stored default cannot be captioned "Yesterday". */
    'window'         => Inventory::windowKey() ?? 'default',
    'windowDays'     => Inventory::windowDays(),
    'windowLabel'    => Inventory::windowLabel(),
]);
