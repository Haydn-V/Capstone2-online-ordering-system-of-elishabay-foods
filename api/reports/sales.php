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
/* REVENUE IS TWO THINGS — see api/core/Revenue.php.

     1. orders paid at the time: completed, not on credit terms, on the ORDER's date
     2. payments toward Net accounts: verified, not legacy, on the PAYMENT's date

   A Net order adds nothing on the day it is placed. It used to add its whole
   total, whether or not a peso had come in, which is why the report could not be
   matched against a retailer's receipts. */
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
            COALESCE(SUM(o.total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN o.type = 'walk-in' THEN o.total ELSE 0 END), 0) AS walkin_revenue,
            COALESCE(SUM(CASE WHEN o.type = 'online'  THEN o.total ELSE 0 END), 0) AS online_revenue
       FROM orders o $clause",
    $params
);

/* ---- part 2: received on Net accounts ----
   Walk-in or online follows the order that opened the account. The seeded
   accounts that predate that link were counter credit, so walk-in. */
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

/* ---- sold on credit in the range, and what is still to come in on it ----
   Its own line, so a sale made on terms stays visible instead of vanishing from
   the report until it is paid. Only orders that committed stock count as sold:
   a Net order still waiting to be accepted is not a sale yet. */
$bookedWhere  = "o.method IN ($creditPh) AND o.status IN ('accepted','shipping','delivered','completed')" . $dateSql;
$bookedParams = array_merge($creditMethods, $dateParams);
$booked = Database::one(
    "SELECT COUNT(*) AS n, COALESCE(SUM(o.total), 0) AS total FROM orders o WHERE $bookedWhere",
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

/* Goods, not money: every completed order's units, credit ones included, on the
   order's date. A Net order's jars left the shelf when it was fulfilled,
   whenever it is paid for. */
$units = (int) Database::scalar(
    "SELECT COALESCE(SUM(oi.qty), 0)
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ($statusPh)$dateSql",
    array_merge(Revenue::STATUSES, $dateParams)
);

/* ---- daily series, for the chart: both parts, each on its own date ---- */
$seriesMap = [];
foreach (Database::all(
    "SELECT o.date AS d, COUNT(*) AS n, COALESCE(SUM(o.total), 0) AS amount
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
ksort($seriesMap);

/* ---- best sellers, by revenue rather than units ----
   Ranking by units flatters cheap products; a report used to decide what to
   make more of should rank by what actually earned.

   The query itself is Revenue::productTotals() — shared with the inventory
   dashboard's Product Rankings, which asks the same question of the same rows
   and only orders it by units instead. Read that method for why a Net payment
   buys a fractional share of its order's units, and why both columns are dated
   by the money rather than by the order.

   The goods-out view is not lost — `credit.bookedCount` / `bookedTotal` below
   report what was sold on terms in this period, paid or not, which is the
   question this column would otherwise have to answer at the same time. */
$topProducts = Revenue::productTotals($from, $to, 'revenue', 10);

/* The payment-method split — two GROUP BY queries and a `byMethod` key —
   used to be computed here. Its panel has been removed from the Sales Report,
   and nothing else ever read the key, so the queries went with it rather than
   being run on every report load for a field no caller looks at. The same
   question is answered by the Method column of the Transactions table on that
   screen and, for Net accounts, by Payment Schemes. */

$revenue = (float) $totals['revenue'] + (float) $credit['amount'];
$orders  = (int) $totals['orders'] + (int) $booked['n'];
$sold    = (float) $totals['revenue'] + (float) $booked['total'];

Response::ok([
    'range'   => ['name' => $range, 'from' => $from, 'to' => $to],
    'totals'  => [
        /* Sales made: orders paid at the time, plus Net orders that committed stock. */
        'orders'        => $orders,
        'revenue'       => round($revenue, 2),
        /* Order SIZE — so it averages what was sold, credit included, not what
           happened to be received in the period. */
        'average'       => $orders ? round($sold / $orders, 2) : 0.0,
        'units'         => $units,
        'walkinRevenue' => round((float) $totals['walkin_revenue'] + (float) $credit['amount'] - (float) $credit['online_amt'], 2),
        'onlineRevenue' => round((float) $totals['online_revenue'] + (float) $credit['online_amt'], 2),
    ],
    /* What part 2 contributed, and what is still to come — so the report can
       say where its Net figures came from instead of asking to be trusted. */
    'credit' => [
        'received'       => round((float) $credit['amount'], 2),
        'receivedCount'  => (int) $credit['n'],
        'bookedCount'    => (int) $booked['n'],
        'bookedTotal'    => round((float) $booked['total'], 2),
        'notYetReceived' => round($notYetReceived, 2),
    ],
    /* Its own line, deliberately NOT subtracted from `revenue` above (D2). */
    'refunds' => [
        'count'  => (int) $refunds['n'],
        'amount' => round((float) $refunds['amount'], 2),
        'net'    => round($revenue - (float) $refunds['amount'], 2),
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
        /* Rounded once, at the end. A part-paid Net order contributes a
           fraction of a jar per line, and rounding each line first would drift
           the total away from the units the order actually holds. */
        'units'   => (int) round((float) $r['units']),
        'revenue' => round((float) $r['revenue'], 2),
    ], $topProducts),
]);
