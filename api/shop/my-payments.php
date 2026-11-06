<?php
declare(strict_types=1);

/** GET /api/shop/my-payments.php returns a retailer's Net accounts with every payment, using Payments::describeAccount() so it matches staff screens, without revealing which staff member decided. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
$customer = Auth::requireCustomer('Sign in to view your payment schedule.');

$status = Database::scalar('SELECT status FROM customers WHERE id = ?', [$customer['id']]);
if ($status !== 'retailer') {
    Response::forbidden('Payment schemes are available to approved retail partners.');
}

$rate = Payments::penaltyRate();

/* What "nears its deadline" means, stated here so the page does not decide it. */
const DUE_SOON_DAYS = 7;

$rows = Database::all(
    Payments::accountSelect() . ' WHERE pa.customer_id = ? ORDER BY pa.paid ASC, pa.due_date ASC',
    [$customer['id']]
);

$accounts     = [];
$outstanding  = 0.0;
$overdueCount = 0;
$dueSoonCount = 0;
$pendingCount = 0;
$nextDue      = null;

foreach ($rows as $r) {
    $a = Payments::describeAccount($r, $rate);
    $a['dueSoon'] = !$a['settled'] && !$a['overdue'] && $a['daysUntilDue'] <= DUE_SOON_DAYS;
    $a['payments'] = array_map(
        static function (array $p): array {
            unset($p['decidedBy']);
            return $p;
        },
        Payments::paymentsFor($a['id'])
    );

    if (!$a['settled']) {
        $outstanding += $a['remaining'];
        if ($a['overdue']) {
            $overdueCount++;
        } elseif ($a['dueSoon']) {
            $dueSoonCount++;
        }
        if ($nextDue === null || $a['dueDate'] < $nextDue) {
            $nextDue = $a['dueDate'];
        }
    }
    $pendingCount += $a['pendingCount'];
    $accounts[] = $a;
}

Response::ok([
    'accounts' => $accounts,
    'summary'  => [
        /* What they owe today, penalties included. */
        'totalOutstanding' => round($outstanding, 2),
        'overdueCount'     => $overdueCount,
        'dueSoonCount'     => $dueSoonCount,
        'pendingCount'     => $pendingCount,
        'nextDueDate'      => $nextDue,
        'penaltyRate'      => $rate,
        'dueSoonDays'      => DUE_SOON_DAYS,
    ],
    /* Tier credit budget: how much more they can order on Net terms. */
    'credit'   => Payments::creditStanding($customer['id']),
]);
