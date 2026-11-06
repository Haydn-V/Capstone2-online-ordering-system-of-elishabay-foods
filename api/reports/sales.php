<?php
declare(strict_types=1);

/** GET /api/reports/sales.php (needs sales.report) aggregates every figure in SQL and excludes cancelled orders from revenue. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('sales.report');

$q = $_GET;

/* Ranges are based on CURDATE() so "this week" is the real week. */
$range = (string) ($q['range'] ?? 'month');
$from = $to = null;

/* Named ranges come from Dates::ranges(), shared with the client. */
$named = Dates::range($range);
if ($named !== null) {
    $from = $named['from'];
    $to   = $named['to'];
}

switch ($range) {
    case 'today': case 'week': case 'month': case 'year': case 'all':
    case 'yesterday': case 'lastweek': case 'lastmonth': case 'lastyear':
        break;
    case 'custom':
        foreach (['from', 'to'] as $k) {
            $d = DateTime::createFromFormat('Y-m-d', (string) ($q[$k] ?? ''));
            if (!$d || $d->format('Y-m-d') !== $q[$k]) {
                Response::validation('Check the date range.', [$k => 'Use YYYY-MM-DD.']);
            }
        }
        $from = $q['from']; $to = $q['to'];
        if ($from > $to) {
            Response::validation('Check the date range.', ['from' => 'Start date is after the end date.']);
        }
        break;
    default:
        Response::validation('Unknown range.', ['range' => 'Use today, week, month, year, all or custom.']);
}

/* Use the one revenue definition from Revenue::STATUSES. */
/* Revenue has two parts (see api/core/Revenue.php): completed non-credit orders on the order date, plus verified Net payments on the payment date. */
[$revClause, $revParams] = Revenue::clause('o');
$where  = [$revClause];
$params = $revParams;
if ($from !== null) { $where[] = 'o.date >= ?'; $params[] = $from; }
if ($to   !== null) { $where[] = 'o.date <= ?'; $params[] = $to; }
$clause = 'WHERE ' . implode(' AND ', $where);

/* Part 2, dated by the payment. */
[$crClause] = Revenue::creditClause('cp');
$crWhere  = [$crClause];
$crParams = [];
if ($from !== null) { $crWhere[] = 'cp.paid_date >= ?'; $crParams[] = $from; }
if ($to   !== null) { $crWhere[] = 'cp.paid_date <= ?'; $crParams[] = $to; }
$crSql = 'WHERE ' . implode(' AND ', $crWhere);

/* Order-date filter on its own, for the queries about GOODS rather than money. */
$dateWhere  = [];
$dateParams = [];
if ($from !== null) { $dateWhere[] = 'o.date >= ?'; $dateParams[] = $from; }
if ($to   !== null) { $dateWhere[] = 'o.date <= ?'; $dateParams[] = $to; }
$dateSql       = $dateWhere ? ' AND ' . implode(' AND ', $dateWhere) : '';
$statusPh      = implode(',', array_fill(0, count(Revenue::STATUSES), '?'));
$creditMethods = Revenue::creditMethods();
$creditPh      = implode(',', array_fill(0, count($creditMethods), '?'));

/* ---- part 1: orders paid at the time ---- */
$totals = Database::one(
    "SELECT COUNT(*) AS orders,
            COALESCE(SUM(" . Payments::dueSql('o') . "), 0) AS revenue,
            COALESCE(SUM(CASE WHEN o.type = 'walk-in' THEN " . Payments::dueSql('o') . " ELSE 0 END), 0) AS walkin_revenue,
            COALESCE(SUM(CASE WHEN o.type = 'online'  THEN " . Payments::dueSql('o') . " ELSE 0 END), 0) AS online_revenue
       FROM orders o $clause",
    $params
);

/* Part 2, Net payments: walk-in or online follows the order that opened the account (seeded accounts count as walk-in). */
$credit = Database::one(
    "SELECT COUNT(*) AS n,
            COALESCE(SUM(cp.amount), 0) AS amount,
            COALESCE(SUM(CASE WHEN o.type = 'online' THEN cp.amount ELSE 0 END), 0) AS online_amt
       FROM credit_payments cp
       JOIN payment_accounts pa ON pa.id = cp.account_id
       LEFT JOIN orders o ON o.id = pa.order_id
       $crSql",
    $crParams
);

/* Credit sales in the range (orders that committed stock) and what is still owed on them, shown as their own line. */
$bookedWhere  = "o.method IN ($creditPh) AND o.status IN ('accepted','shipping','delivered','completed')" . $dateSql;
$bookedParams = array_merge($creditMethods, $dateParams);
$booked = Database::one(
    "SELECT COUNT(*) AS n, COALESCE(SUM(" . Payments::dueSql('o') . "), 0) AS total FROM orders o WHERE $bookedWhere",
    $bookedParams
);
$rate = Payments::penaltyRate();
$notYetReceived = 0.0;
foreach (Database::all(
    Payments::accountSelect() . " WHERE pa.order_id IN (SELECT o.id FROM orders o WHERE $bookedWhere)",
    $bookedParams
) as $r) {
    $notYetReceived += Payments::describeAccount($r, $rate)['remaining'];
}

/* Refunds paid out come off revenue on the day they were paid (Revenue::refundDateSql). */
[$refClause, $refParams] = Revenue::refundClause('r');
$refDate = Revenue::refundDateSql('r');
$refundWhere = [$refClause];
$refundParams = $refParams;
if ($from !== null) { $refundWhere[] = "$refDate >= ?"; $refundParams[] = $from; }
if ($to   !== null) { $refundWhere[] = "$refDate <= ?"; $refundParams[] = $to; }
$refundSql = implode(' AND ', $refundWhere);
$refunds = Database::one(
    "SELECT COUNT(*) AS n, COALESCE(SUM(r.refund_amount), 0) AS amount,
            COALESCE(SUM(CASE WHEN o.type = 'walk-in' THEN r.refund_amount ELSE 0 END), 0) AS walkin_amt
       FROM product_returns r LEFT JOIN orders o ON o.id = r.order_id WHERE $refundSql",
    $refundParams
);

/* Units sold: every completed order including credit, on the order date. */
$units = (int) Database::scalar(
    "SELECT COALESCE(SUM(oi.qty), 0)
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ($statusPh)$dateSql",
    array_merge(Revenue::STATUSES, $dateParams)
);

/* ---- daily series, for the chart: both parts, each on its own date ---- */
$seriesMap = [];
foreach (Database::all(
    "SELECT o.date AS d, COUNT(*) AS n, COALESCE(SUM(" . Payments::dueSql('o') . "), 0) AS amount
       FROM orders o $clause GROUP BY o.date",
    $params
) as $r) {
    $seriesMap[$r['d']] = ['orders' => (int) $r['n'], 'revenue' => (float) $r['amount']];
}
foreach (Database::all(
    "SELECT cp.paid_date AS d, COALESCE(SUM(cp.amount), 0) AS amount
       FROM credit_payments cp $crSql GROUP BY cp.paid_date",
    $crParams
) as $r) {
    $seriesMap[$r['d']]['orders']  = $seriesMap[$r['d']]['orders'] ?? 0;
    $seriesMap[$r['d']]['revenue'] = ($seriesMap[$r['d']]['revenue'] ?? 0.0) + (float) $r['amount'];
}
foreach (Database::all(
    "SELECT $refDate AS d, COALESCE(SUM(r.refund_amount), 0) AS amount
       FROM product_returns r WHERE $refundSql GROUP BY d",
    $refundParams
) as $r) {
    $seriesMap[$r['d']]['orders']  = $seriesMap[$r['d']]['orders'] ?? 0;
    $seriesMap[$r['d']]['revenue'] = ($seriesMap[$r['d']]['revenue'] ?? 0.0) - (float) $r['amount'];
}
ksort($seriesMap);

/* Best sellers ranked by revenue using Revenue::productTotals() (shared with the inventory dashboard), dated by when the money arrived. */
$topProducts = Revenue::productTotals($from, $to, 'revenue', 10);

/* The payment-method split was removed because nothing reads it anymore. */

$gross   = (float) $totals['revenue'] + (float) $credit['amount'];
$revenue = $gross - (float) $refunds['amount'];   /* net of refunds paid out in the range */
$orders  = (int) $totals['orders'] + (int) $booked['n'];
$sold    = (float) $totals['revenue'] + (float) $booked['total'];

Response::ok([
    'range'   => ['name' => $range, 'from' => $from, 'to' => $to],
    'totals'  => [
        /* Sales made: orders paid at the time, plus Net orders that committed stock. */
        'orders'        => $orders,
        'revenue'       => round($revenue, 2),
        /* Average order size uses what was sold (credit included), not what was received. */
        'average'       => $orders ? round($sold / $orders, 2) : 0.0,
        'units'         => $units,
        'grossRevenue'  => round($gross, 2),
        'walkinRevenue' => round((float) $totals['walkin_revenue'] + (float) $credit['amount'] - (float) $credit['online_amt'] - (float) $refunds['walkin_amt'], 2),
        'onlineRevenue' => round((float) $totals['online_revenue'] + (float) $credit['online_amt'] - ((float) $refunds['amount'] - (float) $refunds['walkin_amt']), 2),
    ],
    /* Show how much came from Net payments and what is still owed. */
    'credit' => [
        'received'       => round((float) $credit['amount'], 2),
        'receivedCount'  => (int) $credit['n'],
        'bookedCount'    => (int) $booked['n'],
        'bookedTotal'    => round((float) $booked['total'], 2),
        'notYetReceived' => round($notYetReceived, 2),
    ],
    /* Already subtracted from `revenue` above; `gross` is before refunds. */
    'refunds' => [
        'count'  => (int) $refunds['n'],
        'amount' => round((float) $refunds['amount'], 2),
        'gross'  => round($gross, 2),
        'net'    => round($revenue, 2),
    ],
    /* Stated in the payload so a consumer never has to guess what was counted. */
    'revenueStatuses' => Revenue::STATUSES,
    'creditMethods'   => $creditMethods,
    'series' => array_map(static fn(string $d, array $v): array => [
        'date'    => $d,
        'orders'  => (int) $v['orders'],
        'revenue' => round((float) $v['revenue'], 2),
    ], array_keys($seriesMap), array_values($seriesMap)),
    'topProducts' => array_map(static fn(array $r): array => [
        'id'      => $r['id'],
        'name'    => $r['name'],
        /* Round units once at the end, since part-paid Net orders contribute fractions. */
        'units'   => (int) round((float) $r['units']),
        'revenue' => round((float) $r['revenue'], 2),
    ], $topProducts),
]);
