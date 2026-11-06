<?php
declare(strict_types=1);

/** GET /api/payments/list.php (needs payments.manage) lists Net accounts using Payments::describeAccount() for every figure, reading all accounts so the summary covers everything. */

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

/* Each account carries its retailer's current tier (for the badge in Payment Schemes). */
$tiers = [];
foreach (Database::all("SELECT id, retailer_tier FROM customers WHERE status = 'retailer'") as $c) {
    $tiers[$c['id']] = $c['retailer_tier'] ?: 'Bronze';
}
foreach ($all as &$a) { $a['tier'] = $tiers[$a['customerId']] ?? null; }
unset($a);

/* Worst first: awaiting review, then overdue, then open by due date, settled last. */
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
    'interestRates' => Payments::interestRates(),
    'creditLimits' => Payments::creditLimits(),
    'outstanding'  => round($summary['outstanding'], 2),
    'overdueCount' => $summary['overdueCount'],
    'reviewCount'  => $summary['reviewCount'],
    'reviewAmount' => round($summary['reviewAmount'], 2),
]);
