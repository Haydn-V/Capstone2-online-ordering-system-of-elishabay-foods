<?php
declare(strict_types=1);

/**
 * GET /api/payments/list.php
 *
 * Requires payments.manage. Retailer credit accounts (Net 30/60/90).
 *
 * Overdue status and the penalty are COMPUTED, never stored: days overdue is
 * measured against CURDATE() at read time, so an account does not sit at
 * "3 days late" forever because nobody reopened the screen. The penalty rate
 * comes from the settings table rather than a number typed into the UI.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('payments.manage');

/* One implementation, shared with api/shop/my-payments.php — see the note on
   Payments::accountStanding(). The customer's figure and the cashier's must be
   the same number, not two calculations that happen to agree today. */
$rate = Payments::penaltyRate();

$paging = Validate::paging($_GET, 10, 200);
$total  = (int) Database::scalar('SELECT COUNT(*) FROM payment_accounts');

$rows = Database::all(
    "SELECT pa.id, pa.customer_id, pa.name, pa.email, pa.scheme,
            pa.balance, pa.due_date, pa.paid,
            DATEDIFF(CURDATE(), pa.due_date) AS days_past_due
       FROM payment_accounts pa
      ORDER BY pa.paid ASC, pa.due_date ASC
      LIMIT {$paging['limit']} OFFSET {$paging['offset']}"
);

/* Outstanding and overdue totals are for ALL accounts, not the page. They are
   summary figures above the table; computing them from the page would quietly
   under-report what the business is owed. Overdue days and penalty are derived
   against CURDATE() in SQL for the same reason they are in the row mapping. */
$summary = Database::one(
    "SELECT
        COALESCE(SUM(CASE WHEN paid = 0 THEN balance ELSE 0 END), 0) AS outstanding_balance,
        COALESCE(SUM(CASE WHEN paid = 0 AND DATEDIFF(CURDATE(), due_date) > 0 THEN balance ELSE 0 END), 0) AS overdue_balance,
        SUM(CASE WHEN paid = 0 AND DATEDIFF(CURDATE(), due_date) > 0 THEN 1 ELSE 0 END) AS overdue_count
     FROM payment_accounts"
);

$accounts = array_map(static function (array $r) use ($rate): array {
    $paid    = (bool) $r['paid'];
    $days    = (int) $r['days_past_due'];
    $balance = (float) $r['balance'];
    $standing = Payments::accountStanding($balance, $days, $paid, $rate);
    $overdue = $standing['overdue'];
    $penalty = $standing['penalty'];

    return [
        'id'          => $r['id'],
        'customerId'  => $r['customer_id'],
        'name'        => $r['name'],
        'email'       => $r['email'],
        'scheme'      => $r['scheme'],
        'balance'     => $balance,
        'dueDate'     => $r['due_date'],
        'paid'        => $paid,
        'daysPastDue' => $overdue ? $days : 0,
        'overdue'     => $overdue,
        'penalty'     => $penalty,
        'totalDue'    => round($balance + $penalty, 2),
    ];
}, $rows);

$outstanding = (float) $summary['outstanding_balance']
             + round((float) $summary['overdue_balance'] * ($rate / 100), 2);

Response::ok($accounts, [
    'page'         => $paging['page'],
    'limit'        => $paging['limit'],
    'total'        => $total,
    'pages'        => (int) ceil($total / $paging['limit']),
    'penaltyRate'  => $rate,
    'outstanding'  => round($outstanding, 2),
    'overdueCount' => (int) $summary['overdue_count'],
]);
