<?php
declare(strict_types=1);

/** GET /api/reports/top-products.php ranks products by units sold in a period (using the same Revenue::productTotals() and Dates::range() as the Sales Report) with current stock, and returns no money figures so inventory users can see it. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* Allowed for inventory users and anyone with sales.report, since it is still a sales figure. */
Rbac::requireAny('inventory.report', 'inventory.manage', 'sales.report');

$q = $_GET;

$range = (string) ($q['range'] ?? 'week');
$from = $to = null;

if ($range === 'custom') {
    foreach (['from', 'to'] as $k) {
        $v = (string) ($q[$k] ?? '');
        if (!Dates::isValid($v)) {
            Response::validation('Check the date range.', [$k => 'Use YYYY-MM-DD.']);
        }
    }
    $from = (string) $q['from'];
    $to   = (string) $q['to'];
    if ($from > $to) {
        Response::validation('Check the date range.', ['from' => 'Start date is after the end date.']);
    }
} else {
    $named = Dates::range($range);
    if ($named === null) {
        Response::validation('Unknown range.', [
            'range' => 'Use today, yesterday, week, lastweek, month, lastmonth, year, lastyear, all or custom.',
        ]);
    }
    $from = $named['from'];
    $to   = $named['to'];
}

/* Capped so the ranking cannot be used to pull the whole catalogue. */
$limit = (int) ($q['limit'] ?? 5);
$limit = max(1, min(20, $limit));

$rows = Revenue::productTotals($from, $to, 'units', $limit);

/* Current stock and its measured band from Inventory's own layers, so the band matches the Inventory Report. */
$stock = [];
if ($rows) {
    $ids = array_column($rows, 'id');
    $ph  = implode(',', array_fill(0, count($ids), '?'));

    $base = 'SELECT p.id, p.stock,
                    ' . Inventory::velocityColumns() . ',
                    ' . Inventory::expirySelect() . '
               FROM products p
               ' . Inventory::velocityJoin() . "
              WHERE p.id IN ($ph)";
    $derived = 'SELECT b.*, ' . Inventory::derivedSelect() . ' FROM (' . $base . ') b';
    $ranked  = 'SELECT d.*, ' . Inventory::rankSelect()    . ' FROM (' . $derived . ') d';

    foreach (Database::all("SELECT * FROM ($ranked) r", $ids) as $r) {
        $inv = Inventory::describe($r);
        $stock[$r['id']] = [
            'stock'      => (int) $r['stock'],
            'stockLevel' => $inv['level'],
            'stockLabel' => $inv['levelLabel'] ?? null,
            'daysCover'  => $inv['daysCover']  ?? null,
        ];
    }
}

Response::ok(array_map(static function (array $r) use ($stock): array {
    $s = $stock[$r['id']] ?? ['stock' => 0, 'stockLevel' => null, 'stockLabel' => null, 'daysCover' => null];
    return [
        'id'    => $r['id'],
        'name'  => $r['name'],
        /* Rounded once, at the end — see Revenue::productTotals(). */
        'units' => (int) round((float) $r['units']),
    ] + $s;
}, $rows), [
    'range'      => ['name' => $range, 'from' => $from, 'to' => $to],
    'limit'      => $limit,
    /* Echo the thresholds so the panel can label them. */
    'windowLabel' => Inventory::windowLabel(),
]);
