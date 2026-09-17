<?php
declare(strict_types=1);

/**
 * GET /api/payments/list.php — Payment Scheme Monitoring.
 *
 * Query: ?page=1&limit=10&filter=all|open|review|overdue|paid
 *
 * Requires payments.manage.
 *
 * Every figure comes from Payments::describeAccount(): billed, paid so far
 * (VERIFIED payments in credit_payments), waiting for review, penalty and what
 * is left. The retailer's own Payment Schemes page reads the same function, so
 * the two cannot show different numbers.
 *
 * `balance` used to be the whole story — the amount billed, shown as
 * outstanding until someone pressed Mark Paid. A retailer who had paid ₱9,000
 * of ₱13,330 was shown owing ₱13,330. `remaining` is the number to act on.
 *
 * WHY EVERY ACCOUNT IS READ, NOT ONLY ONE PAGE
 * --------------------------------------------
 * The summary above the table — total outstanding, overdue, waiting for review —
 * must cover every account, and the penalty rule (charged on what was still
 * unpaid on the due date) is computed in PHP. There are a few dozen accounts;
 * reading them all is cheaper than a second copy of the rule in SQL, and a
 * second copy is how the customer's number and the cashier's drift apart.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('payments.manage');

$rate   = Payments::penaltyRate();
$paging = Validate::paging($_GET, 10, 200);

$FILTERS = ['all', 'open', 'review', 'overdue', 'paid'];
$filter  = (string) ($_GET['filter'] ?? 'all');
if (!in_array($filter, $FILTERS, true)) {
    Response::validation('Unknown filter.', ['filter' => 'Use ' . implode(', ', $FILTERS) . '.']);
}

$all = array_map(
    static fn(array $r): array => Payments::describeAccount($r, $rate),
    Database::all(Payments::accountSelect() . ' ORDER BY pa.due_date ASC, pa.id ASC')
);

/* Worst first: payments waiting for a person to check them, then overdue, then
   open by due date, settled last. */
$rank = static fn(array $a): int =>
    $a['pendingCount'] > 0 ? 0 : ($a['overdue'] ? 1 : ($a['settled'] ? 3 : 2));
usort($all, static fn(array $x, array $y): int =>
    [$rank($x), $x['dueDate'], $x['id']] <=> [$rank($y), $y['dueDate'], $y['id']]);

$summary = ['outstanding' => 0.0, 'overdueCount' => 0, 'reviewCount' => 0, 'reviewAmount' => 0.0];
foreach ($all as $a) {
    if (!$a['settled']) { $summary['outstanding'] += $a['remaining']; }
    if ($a['overdue'])  { $summary['overdueCount']++; }
    $summary['reviewCount']  += $a['pendingCount'];
    $summary['reviewAmount'] += $a['pendingAmount'];
}

$filtered = array_values(array_filter($all, static fn(array $a): bool => match ($filter) {
    'open'    => !$a['settled'],
    'review'  => $a['pendingCount'] > 0,
    'overdue' => $a['overdue'],
    'paid'    => $a['settled'],
    default   => true,
}));

$total = count($filtered);

Response::ok(array_slice($filtered, $paging['offset'], $paging['limit']), [
    'page'         => $paging['page'],
    'limit'        => $paging['limit'],
    'total'        => $total,
    'pages'        => (int) ceil($total / max(1, $paging['limit'])),
    'penaltyRate'  => $rate,
    'outstanding'  => round($summary['outstanding'], 2),
    'overdueCount' => $summary['overdueCount'],
    'reviewCount'  => $summary['reviewCount'],
    'reviewAmount' => round($summary['reviewAmount'], 2),
]);
