<?php
declare(strict_types=1);

/** GET /api/inventory/daily-sales.php?days=14 (needs inventory.manage or inventory.report) returns units sold per
    product per day from completed orders, for the Restock tab's "Recent sales" chart and suggested quantity. Read
    here rather than from the order list, which Inventory Staff cannot open (and which held only the newest orders). */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireAny('inventory.manage', 'inventory.report');

$days = max(1, min(60, (int) ($_GET['days'] ?? 14)));
$back = $days - 1;
$today = Dates::today();

$out = [];
foreach (Database::all(
    "SELECT oi.product_id, o.date, SUM(oi.qty) AS units
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'completed'
        AND o.date BETWEEN (? - INTERVAL {$back} DAY) AND ?
      GROUP BY oi.product_id, o.date",
    [$today, $today]
) as $r) {
    $out[$r['product_id']][$r['date']] = (int) $r['units'];
}

Response::ok($out, ['days' => $days, 'today' => $today]);
