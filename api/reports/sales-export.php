<?php
declare(strict_types=1);

/** GET /api/reports/sales-export.php?from=Y-m-d&to=Y-m-d (needs sales.report) returns everything the Sales Report PDF/CSV export prints: summary, money received by source and method, sales by day, top products, and the walk-in and online order lists. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
$user = Rbac::require('sales.report');

foreach (['from', 'to'] as $k) {
    $d = DateTime::createFromFormat('Y-m-d', (string) ($_GET[$k] ?? ''));
    if (!$d || $d->format('Y-m-d') !== $_GET[$k]) {
        Response::validation('Check the date range.', [$k => 'Use YYYY-MM-DD.']);
    }
}
$from = (string) $_GET['from'];
$to   = (string) $_GET['to'];
if ($from > $to) {
    Response::validation('Check the date range.', ['from' => 'Start date is after the end date.']);
}

/* A sale: a completed order paid at the time, or a Net order once accepted (it committed stock); see Revenue::saleClause(). */
[$saleSql, $saleParams] = Revenue::saleClause('o');
$inRange    = 'o.date BETWEEN ? AND ?';

$orders = Database::all(
    "SELECT o.id, o.customer_name, o.date, o.datetime, o.type, o.status, o.method, " . Payments::dueSql('o') . " AS total
       FROM orders o
      WHERE $saleSql AND $inRange
      ORDER BY o.datetime DESC",
    array_merge($saleParams, [$from, $to])
);

/* What has been paid on each Net order (its account), so the online list shows Paid and Balance. */
$rate = Payments::penaltyRate();
$acct = [];
if ($orders !== []) {
    $ids = array_column($orders, 'id');
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    foreach (Database::all(Payments::accountSelect() . " WHERE pa.order_id IN ($ph)", $ids) as $r) {
        $acct[$r['order_id']] = Payments::describeAccount($r, $rate);
    }
}

$units = [];
foreach (Database::all(
    "SELECT oi.order_id, SUM(oi.qty) AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE $saleSql AND $inRange GROUP BY oi.order_id",
    array_merge($saleParams, [$from, $to])
) as $r) {
    $units[$r['order_id']] = (int) $r['units'];
}

$summary = ['sales' => 0.0, 'walkinCount' => 0, 'onlineCount' => 0, 'units' => 0, 'walkinUnits' => 0, 'onlineUnits' => 0];
$byDay = [];
$walkin = [];
$online = [];
foreach ($orders as $o) {
    $isCredit = Payments::isCredit((string) $o['method']);
    $total    = (float) $o['total'];
    $a        = $acct[$o['id']] ?? null;
    $paid     = $isCredit ? ($a['paidAmount'] ?? 0.0) : $total;
    $balance  = $isCredit ? ($a['remaining'] ?? $total) : 0.0;
    $u        = $units[$o['id']] ?? 0;
    $isWalkin = $o['type'] === 'walk-in';

    $summary['sales'] += $total;
    $summary['units'] += $u;
    $summary[$isWalkin ? 'walkinCount' : 'onlineCount']++;
    $summary[$isWalkin ? 'walkinUnits' : 'onlineUnits'] += $u;

    $d = (string) $o['date'];
    $byDay[$d] ??= ['date' => $d, 'walkin' => 0.0, 'online' => 0.0];
    $byDay[$d][$isWalkin ? 'walkin' : 'online'] += $total;

    $row = [
        'ref'      => $o['id'],
        'customer' => $o['customer_name'] ?: 'Walk-in customer',
        'date'     => $o['datetime'],
        'method'   => Payments::schemeLabel((string) $o['method']),
        'status'   => $o['status'],
        'total'    => round($total, 2),
        'paid'     => round((float) $paid, 2),
        'balance'  => round((float) $balance, 2),
    ];
    if ($isWalkin) { $walkin[] = $row; } else { $online[] = $row; }
}
ksort($byDay);

/* Money received in the period: orders paid at the time (on their date) plus verified Net payments (on their paid date). */
[$revClause, $revParams] = Revenue::clause('o');
$paidNow = Database::all(
    "SELECT o.type, o.method, COALESCE(SUM(" . Payments::dueSql('o') . "), 0) AS amount
       FROM orders o WHERE $revClause AND $inRange GROUP BY o.type, o.method",
    array_merge($revParams, [$from, $to])
);
[$crClause] = Revenue::creditClause('cp');
$netPaid = Database::all(
    "SELECT COALESCE(cp.method, 'cash') AS method, COALESCE(SUM(cp.amount), 0) AS amount
       FROM credit_payments cp WHERE $crClause AND cp.paid_date BETWEEN ? AND ? GROUP BY cp.method",
    [$from, $to]
);
$received = ['walkin' => 0.0, 'online' => 0.0, 'net' => 0.0, 'byMethod' => []];
foreach ($paidNow as $r) {
    $received[$r['type'] === 'walk-in' ? 'walkin' : 'online'] += (float) $r['amount'];
    $m = Payments::schemeLabel((string) $r['method']);
    $received['byMethod'][$m] = ($received['byMethod'][$m] ?? 0.0) + (float) $r['amount'];
}
foreach ($netPaid as $r) {
    $received['net'] += (float) $r['amount'];
    $m = Payments::schemeLabel((string) $r['method']);
    $received['byMethod'][$m] = ($received['byMethod'][$m] ?? 0.0) + (float) $r['amount'];
}
$received['total'] = round($received['walkin'] + $received['online'] + $received['net'], 2);
$methods = [];
foreach ($received['byMethod'] as $m => $amt) { $methods[] = ['method' => $m === 'Bank' ? 'Bank Transfer' : ($m === 'Gcash' ? 'GCash' : $m), 'amount' => round($amt, 2)]; }
usort($methods, static fn($a, $b) => $b['amount'] <=> $a['amount']);

/* Refunds paid out in the period, subtracted from money received on the day they were paid. */
[$refClause, $refParams] = Revenue::refundClause('r');
$refDate = Revenue::refundDateSql('r');
$refunds = (float) Database::scalar(
    "SELECT COALESCE(SUM(r.refund_amount), 0) FROM product_returns r WHERE $refClause AND $refDate BETWEEN ? AND ?",
    array_merge($refParams, [$from, $to])
);
$received['gross'] = $received['total'];
$received['total'] = round($received['total'] - $refunds, 2);

/* Still to collect: every open Net balance as of today, whatever its order date. */
$toCollect = 0.0;
$toCollectCount = 0;
foreach (Database::all(Payments::accountSelect() . ' WHERE pa.paid = 0') as $r) {
    $a = Payments::describeAccount($r, $rate);
    if (!$a['settled'] && $a['remaining'] > 0) { $toCollect += $a['remaining']; $toCollectCount++; }
}

/* Top selling products by units in the period's sales. */
$top = Database::all(
    "SELECT p.name, SUM(oi.qty) AS units, SUM(oi.qty * oi.price_at_purchase) AS sales
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE $saleSql AND $inRange
      GROUP BY p.id, p.name ORDER BY units DESC, sales DESC LIMIT 10",
    array_merge($saleParams, [$from, $to])
);

Response::ok([
    'range'      => ['from' => $from, 'to' => $to],
    'preparedBy' => $user['name'] ?? '',
    'summary'    => [
        'sales'          => round($summary['sales'], 2),
        'walkinCount'    => $summary['walkinCount'],
        'onlineCount'    => $summary['onlineCount'],
        'received'       => $received['total'],
        'toCollect'      => round($toCollect, 2),
        'toCollectCount' => $toCollectCount,
        'units'          => $summary['units'],
        'walkinUnits'    => $summary['walkinUnits'],
        'onlineUnits'    => $summary['onlineUnits'],
    ],
    'received'   => [
        'walkin'   => round($received['walkin'], 2),
        'online'   => round($received['online'], 2),
        'net'      => round($received['net'], 2),
        'gross'    => $received['gross'],
        'total'    => $received['total'],
        'byMethod' => $methods,
        'refunds'  => round($refunds, 2),
    ],
    'byDay'      => array_map(static fn($d) => $d + ['total' => round($d['walkin'] + $d['online'], 2)], array_values($byDay)),
    'top'        => array_map(static fn($r) => ['name' => $r['name'], 'units' => (int) $r['units'], 'sales' => round((float) $r['sales'], 2)], $top),
    'walkin'     => $walkin,
    'online'     => $online,
]);
