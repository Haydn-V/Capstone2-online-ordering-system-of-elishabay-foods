<?php
declare(strict_types=1);

/**
 * GET /api/reports/sales.php?range=today|week|month|year|all&from=&to=
 *
 * Requires sales.report.
 *
 * Every figure is aggregated in SQL. The Sales Report previously summed the
 * ORDERS array in the browser, which was accurate only while the browser held
 * every order — true at 42 rows and quietly wrong the moment paging or a date
 * filter meant it did not.
 *
 * Cancelled orders are excluded from revenue everywhere. A cancelled sale is
 * not income, and including it is how a report overstates a good month.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('sales.report');

$q = $_GET;

/* Ranges are resolved against CURDATE() so "this week" means this week, not a
   week frozen when the seed data was written. */
$range = (string) ($q['range'] ?? 'month');
$from = $to = null;

/* D1: named ranges come from Dates::ranges(), the one resolver both ends
   share. They used to be spelled out here AND recomputed in JavaScript, and the
   two disagreed about which day a week starts on. */
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

/* D2: one definition of revenue, from Revenue::STATUSES. This used to be a
   hand-written "o.status <> 'cancelled'", which counted pending and on-hold
   orders — money nobody had received — as earnings. */
[$revClause, $revParams] = Revenue::clause('o');
$where  = [$revClause];
$params = $revParams;
if ($from !== null) { $where[] = 'o.date >= ?'; $params[] = $from; }
if ($to   !== null) { $where[] = 'o.date <= ?'; $params[] = $to; }
$clause = 'WHERE ' . implode(' AND ', $where);

/* ---- headline figures ---- */
$totals = Database::one(
    "SELECT COUNT(*) AS orders,
            COALESCE(SUM(o.total), 0) AS revenue,
            COALESCE(AVG(o.total), 0) AS average,
            COALESCE(SUM(CASE WHEN o.type = 'walk-in' THEN o.total ELSE 0 END), 0) AS walkin_revenue,
            COALESCE(SUM(CASE WHEN o.type = 'online'  THEN o.total ELSE 0 END), 0) AS online_revenue
       FROM orders o $clause",
    $params
);

/* Refunds as their OWN line, never netted into revenue (D2). "We sold
   60,000 and refunded 4,000" and "we made 56,000" describe different
   businesses, and only the first tells anyone what to do about it. Only
   refunds actually paid out count — a return sitting at `received` has cost
   nothing yet. */
[$refClause, $refParams] = Revenue::refundClause('r');
$refundWhere = [$refClause];
$refundParams = $refParams;
if ($from !== null) { $refundWhere[] = 'DATE(r.received_date) >= ?'; $refundParams[] = $from; }
if ($to   !== null) { $refundWhere[] = 'DATE(r.received_date) <= ?'; $refundParams[] = $to; }
$refunds = Database::one(
    'SELECT COUNT(*) AS n, COALESCE(SUM(r.refund_amount), 0) AS amount
       FROM product_returns r WHERE ' . implode(' AND ', $refundWhere),
    $refundParams
);

$units = (int) Database::scalar(
    "SELECT COALESCE(SUM(oi.qty), 0)
       FROM order_items oi JOIN orders o ON o.id = oi.order_id $clause",
    $params
);

/* ---- daily series, for the chart ---- */
$series = Database::all(
    "SELECT o.date, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue
       FROM orders o $clause
      GROUP BY o.date ORDER BY o.date ASC",
    $params
);

/* ---- best sellers, by revenue rather than units ----
   Ranking by units flatters cheap products; a report used to decide what to
   make more of should rank by what actually earned. */
$topProducts = Database::all(
    "SELECT p.id, p.name, SUM(oi.qty) AS units,
            SUM(oi.qty * oi.price_at_purchase) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       $clause
      GROUP BY p.id, p.name
      ORDER BY revenue DESC
      LIMIT 10",
    $params
);

/* ---- payment method split ---- */
$byMethod = Database::all(
    "SELECT o.method, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue
       FROM orders o $clause GROUP BY o.method ORDER BY revenue DESC",
    $params
);

Response::ok([
    'range'   => ['name' => $range, 'from' => $from, 'to' => $to],
    'totals'  => [
        'orders'        => (int) $totals['orders'],
        'revenue'       => round((float) $totals['revenue'], 2),
        'average'       => round((float) $totals['average'], 2),
        'units'         => $units,
        'walkinRevenue' => round((float) $totals['walkin_revenue'], 2),
        'onlineRevenue' => round((float) $totals['online_revenue'], 2),
    ],
    /* Its own line, deliberately NOT subtracted from `revenue` above (D2).
       A reader who wants the net figure can do the subtraction; a reader shown
       only the net figure cannot recover how much was refunded, which is the
       number that tells them whether something is wrong. */
    'refunds' => [
        'count'  => (int) $refunds['n'],
        'amount' => round((float) $refunds['amount'], 2),
        'net'    => round((float) $totals['revenue'] - (float) $refunds['amount'], 2),
    ],
    /* Stated in the payload so a consumer never has to guess which statuses
       were counted, and a change here is visible to anyone reading a response. */
    'revenueStatuses' => Revenue::STATUSES,
    'series' => array_map(static fn(array $r): array => [
        'date'    => $r['date'],
        'orders'  => (int) $r['orders'],
        'revenue' => round((float) $r['revenue'], 2),
    ], $series),
    'topProducts' => array_map(static fn(array $r): array => [
        'id'      => $r['id'],
        'name'    => $r['name'],
        'units'   => (int) $r['units'],
        'revenue' => round((float) $r['revenue'], 2),
    ], $topProducts),
    'byMethod' => array_map(static fn(array $r): array => [
        'method'  => $r['method'],
        'orders'  => (int) $r['orders'],
        'revenue' => round((float) $r['revenue'], 2),
    ], $byMethod),
]);
