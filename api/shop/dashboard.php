<?php
declare(strict_types=1);

/** GET /api/shop/dashboard.php returns everything the customer dashboard shows in one session-scoped request (counts, tracking, five recent orders, payment history), using Payments::describeAccount() so figures match the other screens. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$customer   = Auth::requireCustomer('Sign in to view your dashboard.');
$customerId = (string) $customer['id'];

/* Retailer status from Auth::customer(), which re-reads the row every request. */
$isRetailer = ($customer['status'] ?? null) === 'retailer';

/* Order counts: pending (incl. on-hold) and active (accepted to delivered) never overlap, and total includes every order ever placed. */
const PENDING_STATUSES = ['pending', 'on-hold'];
const ACTIVE_STATUSES  = ['accepted', 'shipping', 'delivered'];

$countIn = static function (array $statuses) use ($customerId): int {
    $ph = implode(',', array_fill(0, count($statuses), '?'));
    return (int) Database::scalar(
        "SELECT COUNT(*) FROM orders WHERE customer_id = ? AND status IN ($ph)",
        array_merge([$customerId], $statuses)
    );
};

$counts = [
    'pending' => $countIn(PENDING_STATUSES),
    'active'  => $countIn(ACTIVE_STATUSES),
    'total'   => (int) Database::scalar(
        'SELECT COUNT(*) FROM orders WHERE customer_id = ?',
        [$customerId]
    ),
];

/* Lifetime spend uses the one revenue definition from Revenue::clause(). */
[$spendSql, $spendParams] = Revenue::spendSql('?');
$counts['lifetimeSpend'] = (float) Database::scalar(
    "SELECT $spendSql",
    /* The id is bound twice: once for orders, once for Net payments. */
    array_merge([$customerId], $spendParams, [$customerId])
);

/* Tracking shows only the most recent unfinished order. */
$trackPh = implode(',', array_fill(0, count(PENDING_STATUSES) + count(ACTIVE_STATUSES), '?'));
$track = Database::one(
    "SELECT id, status, order_type, total, date, datetime, tracking_number, delivered_at
       FROM orders
      WHERE customer_id = ? AND status IN ($trackPh)
      ORDER BY datetime DESC
      LIMIT 1",
    array_merge([$customerId], PENDING_STATUSES, ACTIVE_STATUSES)
);

$tracking = null;
if ($track !== null) {
    /* The tracking steps are sent from here (with on-hold reported as held, not a step) so the page never hard-codes them. */
    $tracking = [
        'id'             => $track['id'],
        'status'         => $track['status'],
        'held'           => $track['status'] === 'on-hold',
        'orderType'      => $track['order_type'],
        'total'          => (float) $track['total'],
        'placedAt'       => $track['datetime'],
        'trackingNumber' => $track['tracking_number'],
        'deliveredAt'    => $track['delivered_at'],
        'steps'          => Orders::trackingSteps($track['status']),
    ];
}

/* Recent orders: five, with enough detail to recognise them. */
$recent = Database::all(
    'SELECT id, status, order_type, method, total, ' . Payments::dueSql('orders') . ' AS amount_due, date, datetime, tracking_number
       FROM orders WHERE customer_id = ?
      ORDER BY datetime DESC LIMIT 5',
    [$customerId]
);

$recentIds = array_column($recent, 'id');
$itemCount = [];
$firstItem = [];
if ($recentIds !== []) {
    $ph = implode(',', array_fill(0, count($recentIds), '?'));
    /* One query for all five, including a product name so a card reads "Bangus in Pesto + 2 more". */
    foreach (Database::all(
        "SELECT oi.order_id, oi.qty, p.name
           FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN ($ph)
          ORDER BY oi.id ASC",
        $recentIds
    ) as $it) {
        $itemCount[$it['order_id']] = ($itemCount[$it['order_id']] ?? 0) + 1;
        $firstItem[$it['order_id']] ??= $it['name'];
    }
}

$recentOrders = array_map(static fn(array $o): array => [
    'id'         => $o['id'],
    'status'     => $o['status'],
    'orderType'  => $o['order_type'],
    'payMethod'  => $o['method'],
    /* What the customer pays: a retailer's discount already taken off (matches the invoice's Total Amount Due). */
    /* What they pay: less the retailer discount, plus any Net term interest (Payments::dueSql). */
    'total'      => round((float) $o['amount_due'], 2),
    'placedAt'   => $o['datetime'],
    'itemCount'  => $itemCount[$o['id']] ?? 0,
    'firstItem'  => $firstItem[$o['id']] ?? null,
    /* Everything the tracking popup needs, so it opens without a request. */
    'held'           => $o['status'] === 'on-hold',
    'trackingNumber' => $o['tracking_number'],
    'steps'          => Orders::trackingSteps($o['status']),
], $recent);

/* Payment history means credit accounts for a retailer and paid orders with verification status for a regular customer, told apart by paymentsKind. */
$credit   = null;
$payments = [];

if ($isRetailer) {
    $rate = Payments::penaltyRate();
    $rows = Database::all(
        Payments::accountSelect() . ' WHERE pa.customer_id = ? ORDER BY pa.paid ASC, pa.due_date ASC',
        [$customerId]
    );

    $outstanding = 0.0;
    $overdue = 0;
    $nextDue = null;

    foreach ($rows as $r) {
        /* Part payments and penalties come from Payments::describeAccount(). */
        $standing = Payments::describeAccount($r, $rate);
        $paid     = $standing['settled'];

        if (!$paid) {
            $outstanding += $standing['totalDue'];
            if ($standing['overdue']) { $overdue++; }
            if ($nextDue === null || $r['due_date'] < $nextDue) { $nextDue = $r['due_date']; }
        }

        /* Show five accounts but total over all of them. */
        if (count($payments) < 5) {
            $payments[] = [
                'id'       => $r['id'],
                'orderId'  => $r['order_id'],
                'scheme'   => $r['scheme'],
                'balance'  => (float) $r['balance'],
                'dueDate'  => $r['due_date'],
                'paid'     => $paid,
                'overdue'  => $standing['overdue'],
                'penalty'  => $standing['penalty'],
                'totalDue' => $standing['totalDue'],
            ];
        }
    }

    $credit = [
        'totalOutstanding' => round($outstanding, 2),
        'overdueCount'     => $overdue,
        'accountCount'     => count($rows),
        'nextDueDate'      => $nextDue,
        'penaltyRate'      => $rate,
    ];
} else {
    $payments = array_map(static fn(array $o): array => [
        'orderId'   => $o['id'],
        'placedAt'  => $o['datetime'],
        'method'    => $o['method'],
        'amount'    => (float) $o['total'],
        'refNum'    => $o['proof_ref_num'],
        /* Regular customers see whether staff have verified each payment yet. */
        'verified'  => (bool) $o['pay_verified'],
        'status'    => $o['status'],
    ], Database::all(
        "SELECT id, datetime, method, total, proof_ref_num, pay_verified, status
           FROM orders
          WHERE customer_id = ? AND status <> 'cancelled'
          ORDER BY datetime DESC LIMIT 5",
        [$customerId]
    ));
}

Response::ok([
    'customer' => [
        'name'       => $customer['name'],
        'email'      => $customer['email'],
        'status'     => $customer['status'] ?? null,
        'isRetailer' => $isRetailer,
    ],
    'counts'       => $counts,
    'tracking'     => $tracking,
    'recentOrders' => $recentOrders,
    /* Null for a regular customer, rather than zeroes that imply credit terms. */
    'credit'       => $credit,
    'paymentsKind' => $isRetailer ? 'credit' : 'orders',
    'payments'     => $payments,
]);
