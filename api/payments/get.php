<?php
declare(strict_types=1);

/** GET /api/payments/get.php (needs payments.manage) returns one Net account with its figures, originating order and every payment toward it. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('payments.manage');

$id = trim((string) ($_GET['id'] ?? ''));
if ($id === '') {
    Response::validation('Which account?', ['id' => 'Account is required.']);
}

$row = Database::one(Payments::accountSelect() . ' WHERE pa.id = ?', [$id]);
if ($row === null) {
    Response::notFound('That payment account does not exist.');
}
$account = Payments::describeAccount($row);

/* The order behind the account; seeded accounts may have none. */
$order = null;
if ($account['orderId']) {
    $o = Database::one(
        'SELECT o.id, o.date, o.datetime, o.total, o.status, o.type, o.order_type, o.method,
                (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS units
           FROM orders o WHERE o.id = ?',
        [$account['orderId']]
    );
    if ($o !== null) {
        $order = [
            'id'        => $o['id'],
            'date'      => $o['date'],
            'datetime'  => $o['datetime'],
            'total'     => (float) $o['total'],
            'status'    => $o['status'],
            'type'      => $o['type'],
            'orderType' => $o['order_type'],
            'payMethod' => $o['method'],
            'units'     => (int) $o['units'],
        ];
    }
}

Response::ok([
    'account'  => $account,
    'order'    => $order,
    'payments' => Payments::paymentsFor($id),
]);
