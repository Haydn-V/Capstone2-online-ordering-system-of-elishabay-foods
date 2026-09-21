<?php
declare(strict_types=1);

/**
 * GET /api/reports/top-products.php?range=week&limit=5
 * GET /api/reports/top-products.php?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * What sold most in a period, BY UNITS, with what is left on the shelf.
 *
 * WHY THIS EXISTS BESIDE reports/sales.php
 * ----------------------------------------
 * The Sales Report already computes best sellers, and it is behind
 * `sales.report` — a permission an inventory user does not hold, and should
 * not: the same response carries revenue, average order value and what is owed
 * on Net accounts. This endpoint answers the one question that is an inventory
 * question — "what is moving, and do we have enough of it" — and returns
 * nothing else. No money appears in the payload.
 *
 * ONE DEFINITION OF WHAT SOLD. The ranking comes from Revenue::productTotals(),
 * the same method the Sales Report's Best Sellers panel uses, over the same
 * rows, dated the same way; only the ORDER BY differs (units here, revenue
 * there). Read that method for why a Net payment contributes a fractional share
 * of its order's units in the period the money arrived.
 *
 * ONE DEFINITION OF A WEEK, TOO — Dates::range(), the resolver the Sales Report
 * uses. `week` there is MONDAY to today; this endpoint does not get to have its
 * own opinion about that, or the two screens disagree about what "this week"
 * covers on six days out of seven.
 *
 * Stock comes from the same three-layer stack as products/list.php, so the band
 * a product carries here is the band the Inventory Report shows for it.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

/* Inventory people, and anyone who can already see this on the Sales Report.
   Not Auth::require() alone: it is still a sales figure, and the catalogue
   being readable by all staff does not make "what is selling" so. */
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

/* Five rows is what the dashboard shows. The cap exists so a caller cannot ask
   for the whole catalogue through a ranking endpoint. */
$limit = (int) ($q['limit'] ?? 5);
$limit = max(1, min(20, $limit));

$rows = Revenue::productTotals($from, $to, 'units', $limit);

/* Current stock and the measured band, for the products that came back.

   Read through Inventory's own layers rather than SELECTing products.stock on
   its own: "do we have enough" is the band's question, and the band is a
   function of sales velocity and lead time, not of the count alone. A product
   with 400 jars and nine days of cover is Critical, and a ranking that showed
   it as simply "400" would be the exact disagreement this file's header is
   about. Nothing is returned for an id with no row — GROUP BY guarantees one,
   but a product archived between the two queries would leave a gap. */
$stock = [];
if ($rows) {
    $ids = array_column($rows, 'id');
    $ph  = implode(',', array_fill(0, count($ids), '?'));

    $base = 'SELECT p.id, p.stock,
                    COALESCE(vel.units, 0) AS window_units,
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
    /* Echoed so the panel can caption its own thresholds without a second
       request, exactly as the Inventory Report does. */
    'windowLabel' => Inventory::windowLabel(),
]);
