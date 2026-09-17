<?php
declare(strict_types=1);

/**
 * GET /api/payments/received.php — money received on Net accounts, by date.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD   (both optional)
 *
 * Requires sales.report or payments.manage.
 *
 * Every VERIFIED, non-legacy payment toward a Net account: the part of revenue
 * that is not an order (api/core/Revenue.php). The portal adds these to the
 * revenue it computes in the browser — the dashboard, the Sales Report's
 * first-paint estimate and its chart — through receivedBetween(), so a figure
 * worked out on screen and one from reports/sales.php follow the same rule.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireAny('sales.report', 'payments.manage');

[$crClause] = Revenue::creditClause('cp');
$where  = [$crClause];
$params = [];
foreach (['from' => '>=', 'to' => '<='] as $key => $op) {
    $value = trim((string) ($_GET[$key] ?? ''));
    if ($value === '') {
        continue;
    }
    $d = DateTime::createFromFormat('Y-m-d', $value);
    if (!$d || $d->format('Y-m-d') !== $value) {
        Response::validation('Check the date range.', [$key => 'Use YYYY-MM-DD.']);
    }
    $where[]  = "cp.paid_date $op ?";
    $params[] = $value;
}

$rows = Database::all(
    'SELECT cp.id, cp.account_id, cp.amount, cp.method, cp.paid_date,
            pa.scheme, pa.order_id, pa.name
       FROM credit_payments cp
       JOIN payment_accounts pa ON pa.id = cp.account_id
      WHERE ' . implode(' AND ', $where) . '
      ORDER BY cp.paid_date ASC, cp.id ASC',
    $params
);

Response::ok(array_map(static fn(array $r): array => [
    'id'        => (int) $r['id'],
    'accountId' => $r['account_id'],
    'orderId'   => $r['order_id'],
    'name'      => $r['name'],
    'scheme'    => $r['scheme'],
    'method'    => $r['method'],
    'amount'    => (float) $r['amount'],
    'paidDate'  => $r['paid_date'],
], $rows));
