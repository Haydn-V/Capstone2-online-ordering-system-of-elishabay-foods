<?php
declare(strict_types=1);

/**
 * GET /api/shop/my-payments.php
 *
 * The signed-in RETAILER's own credit accounts. Requires a customer session.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The Scope promises retailers a place to "view all outstanding and upcoming
 * payments in one place", with notification when a payment nears its deadline
 * or is overdue, "including any penalties incurred".
 *
 * Everything needed already existed — the payment_accounts table, the due
 * dates, settings.penalty_rate — and staff could see all of it at
 * portal/views/payments.html. There was no customer-facing screen at all. The
 * retailer could see what they owed only by asking the person they owed it to.
 *
 * SCOPED BY SESSION, AND BY STATUS
 * --------------------------------
 * Rows are filtered by the session's customer id, never by a parameter — the
 * same rule as shop/my-orders.php, and for the same reason: a `?customer_id=`
 * here would let anyone read anyone else's debts.
 *
 * A non-retailer is refused rather than shown an empty list. An empty list
 * reads as "you owe nothing", which is true but answers a question a regular
 * customer never asked and implies a facility they do not have.
 *
 * THE NUMBERS COME FROM THE SAME PLACE THE CASHIER'S DO
 * ----------------------------------------------------
 * Payments::accountStanding() — extracted from api/payments/list.php when this
 * endpoint was written, precisely so there is one calculation rather than two.
 * A retailer shown a penalty a peso different from the cashier's screen will
 * not assume a rounding rule; they will assume they are being overcharged.
 *
 * Overdue days come from DATEDIFF(CURDATE(), due_date) in SQL, derived at read
 * time and never stored, so an account does not sit at "3 days late" for ever
 * because nobody reopened the page.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$customer = Auth::requireCustomer('Sign in to view your payment schedule.');

$status = Database::scalar('SELECT status FROM customers WHERE id = ?', [$customer['id']]);
if ($status !== 'retailer') {
    Response::forbidden('Payment schemes are available to approved retail partners.');
}

$rate = Payments::penaltyRate();

$rows = Database::all(
    "SELECT pa.id, pa.order_id, pa.scheme, pa.balance, pa.due_date, pa.paid,
            DATEDIFF(CURDATE(), pa.due_date) AS days_past_due
       FROM payment_accounts pa
      WHERE pa.customer_id = ?
      ORDER BY pa.paid ASC, pa.due_date DESC",
    [$customer['id']]
);

/* "Due soon" is seven days, matching the banner the Scope asks for. Named once
   here rather than repeated in the page, so the endpoint and the screen cannot
   disagree about what "nears its deadline" means. */
const DUE_SOON_DAYS = 7;

$accounts = [];
$outstanding = 0.0;
$overdueCount = 0;
$dueSoonCount = 0;
$nextDue = null;

foreach ($rows as $r) {
    $paid     = (bool) $r['paid'];
    $balance  = (float) $r['balance'];
    $days     = (int) $r['days_past_due'];
    $standing = Payments::accountStanding($balance, $days, $paid, $rate);

    /* Negative when overdue, positive when still ahead — the sign carries the
       meaning, so the page does not need a separate flag to read. */
    $daysUntilDue = -$days;
    $dueSoon = !$paid && !$standing['overdue'] && $daysUntilDue <= DUE_SOON_DAYS;

    if (!$paid) {
        $outstanding += $standing['totalDue'];
        if ($standing['overdue']) {
            $overdueCount++;
        } elseif ($dueSoon) {
            $dueSoonCount++;
        }
        if ($nextDue === null || $r['due_date'] < $nextDue) {
            $nextDue = $r['due_date'];
        }
    }

    $accounts[] = [
        'id'           => $r['id'],
        /* The sale this debt came from, when there is one. Seeded rows predate
           the link (migration 004) and legitimately have none. */
        'orderId'      => $r['order_id'],
        'scheme'       => $r['scheme'],
        'balance'      => $balance,
        'dueDate'      => $r['due_date'],
        'paid'         => $paid,
        'daysUntilDue' => $daysUntilDue,
        'overdue'      => $standing['overdue'],
        'dueSoon'      => $dueSoon,
        'penalty'      => $standing['penalty'],
        'totalDue'     => $standing['totalDue'],
        'state'        => $paid ? 'paid' : ($standing['overdue'] ? 'overdue' : ($dueSoon ? 'due-soon' : 'pending')),
    ];
}

Response::ok([
    'accounts' => $accounts,
    'summary'  => [
        /* Includes accrued penalties: what the retailer would pay to clear
           everything today, not the principal they were originally billed. A
           figure that quietly excludes the penalty is the one that causes the
           argument at the counter. */
        'totalOutstanding' => round($outstanding, 2),
        'overdueCount'     => $overdueCount,
        'dueSoonCount'     => $dueSoonCount,
        'nextDueDate'      => $nextDue,
        'penaltyRate'      => $rate,
        'dueSoonDays'      => DUE_SOON_DAYS,
    ],
]);
