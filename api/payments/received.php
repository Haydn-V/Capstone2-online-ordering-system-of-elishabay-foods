<?php
declare(strict_types=1);

/** GET /api/payments/received.php (needs sales.report or payments.manage) lists verified non-legacy Net payments by date, which the portal adds to revenue via receivedBetween(). */

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

/* Refunds paid out, by the day they come off revenue (see refundedBetween() in engine.js). */
[$refClause, $refParams] = Revenue::refundClause('r');
$refDate = Revenue::refundDateSql('r');
$refunds = array_map(static fn(array $r): array => [
    'id' => $r['id'], 'orderId' => $r['order_id'], 'amount' => (float) $r['refund_amount'], 'date' => $r['d'],
], Database::all("SELECT r.id, r.order_id, r.refund_amount, $refDate AS d FROM product_returns r WHERE $refClause ORDER BY d", $refParams));

Response::ok(array_map(static fn(array $r): array => [
    'id'        => (int) $r['id'],
    'accountId' => $r['account_id'],
    'orderId'   => $r['order_id'],
    'name'      => $r['name'],
    'scheme'    => $r['scheme'],
    'method'    => $r['method'],
    'amount'    => (float) $r['amount'],
    'paidDate'  => $r['paid_date'],
], $rows), ['refunds' => $refunds]);
