<?php
declare(strict_types=1);

/**
 * GET /api/shop/dashboard.php
 *
 * Everything the customer's account dashboard draws, in ONE request.
 *
 * WHY ONE ENDPOINT AND NOT FOUR
 * -----------------------------
 * The dashboard shows order counts, a tracking timeline, recent orders and a
 * payment history. Assembled from the existing endpoints that would be four
 * round trips (my-orders twice over, my-payments, profile), four loading
 * states to choreograph, and four ways for the page to be half-drawn. It would
 * also be four different answers to "how many orders do I have", because
 * my-orders.php pages its results and a count taken from a page is a count of
 * that page.
 *
 * A dashboard is one view of one account at one moment. It gets one query set
 * and one response.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not replace my-orders.php or my-payments.php. Those two are the full,
 * paged, filterable lists; this returns the five most recent of each and the
 * totals. A caller wanting the sixth order goes to My Orders.
 *
 * THE NUMBERS COME FROM THE SAME PLACE THE OTHER SCREENS' DO
 * ----------------------------------------------------------
 * Credit standing is Payments::accountStanding(), the same call
 * shop/my-payments.php and portal payments/list.php make. A retailer shown a
 * total outstanding here that differs by a peso from their Payment Schemes page
 * will not assume a rounding rule; they will assume one of the two is lying.
 *
 * SCOPED BY SESSION
 * -----------------
 * Every query is bound to the session's customer id. There is no parameter
 * that could carry one — the same rule as my-orders.php and my-payments.php,
 * and for the same reason: a `?customer_id=` here would be a dashboard of
 * somebody else's life.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$customer   = Auth::requireCustomer('Sign in to view your dashboard.');
$customerId = (string) $customer['id'];

/* Re-read rather than trusting the session copy for the retailer decision.
   Auth::customer() already SELECTs the row every request, so this is that same
   fresh value — named here because three separate branches below turn on it. */
$isRetailer = ($customer['status'] ?? null) === 'retailer';

/* ------------------------------------------------------------------
   Order counts
   ------------------------------------------------------------------
   PENDING and ACTIVE are deliberately disjoint, so the two tiles never count
   the same order twice — a dashboard whose numbers overlap is a dashboard
   nobody trusts the third time they read it.

     pending — placed, waiting for staff to accept it. The customer can still
               cancel. 'on-hold' belongs here: from the customer's side it is
               the same state, "not moving yet".
     active  — accepted and on its way. 'delivered' stays active because the
               order is not finished until it completes an hour later
               (Orders::autoCompleteDelivered), and telling someone their
               delivered order is "done" before the system agrees invites the
               question of why it is still listed.
     total   — every order ever placed, cancelled ones included. It is a
               lifetime count, not a count of successes.
   ------------------------------------------------------------------ */
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

/* Lifetime spend, on the one revenue definition (D2) — completed orders only,
   taken from Revenue::clause() rather than written out here, because a second
   opinion about what counts as revenue is how the customer's total and the
   portal's report come to disagree. */
[$spendClause, $spendParams] = Revenue::clause('o');
$counts['lifetimeSpend'] = (float) Database::scalar(
    "SELECT COALESCE(SUM(o.total), 0) FROM orders o
      WHERE o.customer_id = ? AND $spendClause",
    array_merge([$customerId], $spendParams)
);

/* ------------------------------------------------------------------
   Order tracking — the one order worth watching right now
   ------------------------------------------------------------------
   The most recent order that has not finished. Not a list: the dashboard's job
   is to answer "where is my order?" at a glance, and a list of five timelines
   answers it worse than one does. Everything else is a click away in My
   Orders.
   ------------------------------------------------------------------ */
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
    /* The steps the page draws, in order, with the reached ones marked. Sent
       from here rather than inferred in the browser so that the sequence lives
       next to the statuses it describes — a step order hardcoded in a template
       is a step order nobody updates when a status is added.

       'on-hold' is not a step. It is a pause on the first one, reported through
       `held` so the page can say so without inventing a stage in the journey
       that the order does not actually pass through. */
    $sequence = ['pending', 'accepted', 'shipping', 'delivered', 'completed'];
    $current  = $track['status'] === 'on-hold' ? 'pending' : $track['status'];
    $reached  = array_search($current, $sequence, true);

    $tracking = [
        'id'             => $track['id'],
        'status'         => $track['status'],
        'held'           => $track['status'] === 'on-hold',
        'orderType'      => $track['order_type'],
        'total'          => (float) $track['total'],
        'placedAt'       => $track['datetime'],
        'trackingNumber' => $track['tracking_number'],
        'deliveredAt'    => $track['delivered_at'],
        'steps'          => array_map(
            static fn(string $st, int $i): array => [
                'key'   => $st,
                'done'  => $reached !== false && $i < $reached,
                'now'   => $reached !== false && $i === $reached,
            ],
            $sequence,
            array_keys($sequence)
        ),
    ];
}

/* ------------------------------------------------------------------
   Recent orders — five, with enough to recognise them by
   ------------------------------------------------------------------ */
$recent = Database::all(
    'SELECT id, status, order_type, method, total, date, datetime
       FROM orders WHERE customer_id = ?
      ORDER BY datetime DESC LIMIT 5',
    [$customerId]
);

$recentIds = array_column($recent, 'id');
$itemCount = [];
$firstItem = [];
if ($recentIds !== []) {
    $ph = implode(',', array_fill(0, count($recentIds), '?'));
    /* One query for all five rather than one per order. The product name is
       carried so a card can say "Bangus in Pesto Sauce + 2 more" instead of
       "3 items", which is not something anyone recognises their own order by. */
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
    'total'      => (float) $o['total'],
    'placedAt'   => $o['datetime'],
    'itemCount'  => $itemCount[$o['id']] ?? 0,
    'firstItem'  => $firstItem[$o['id']] ?? null,
], $recent);

/* ------------------------------------------------------------------
   Payment history — a different thing for each kind of customer
   ------------------------------------------------------------------
   A RETAILER's payment history is their credit accounts: what is owed, on what
   terms, by when. That is what payment_accounts holds and what Payment Schemes
   shows in full.

   A REGULAR CUSTOMER has no credit accounts and never will, so the same query
   would return an empty list for ever. Their payment history is what they
   actually paid and how: the method, the reference number they typed, and —
   the part nothing on this site answered before — whether staff have verified
   it yet. "Did my GCash transfer go through?" was a question a customer could
   only answer by asking someone.

   Two shapes, one field name, distinguished by `paymentsKind` so the page does
   not have to guess from the contents of an array that may be empty.
   ------------------------------------------------------------------ */
$credit   = null;
$payments = [];

if ($isRetailer) {
    $rate = Payments::penaltyRate();
    $rows = Database::all(
        'SELECT id, order_id, scheme, balance, due_date, paid,
                DATEDIFF(CURDATE(), due_date) AS days_past_due
           FROM payment_accounts
          WHERE customer_id = ?
          ORDER BY paid ASC, due_date ASC',
        [$customerId]
    );

    $outstanding = 0.0;
    $overdue = 0;
    $nextDue = null;

    foreach ($rows as $r) {
        $paid     = (bool) $r['paid'];
        $standing = Payments::accountStanding(
            (float) $r['balance'], (int) $r['days_past_due'], $paid, $rate
        );

        if (!$paid) {
            $outstanding += $standing['totalDue'];
            if ($standing['overdue']) { $overdue++; }
            if ($nextDue === null || $r['due_date'] < $nextDue) { $nextDue = $r['due_date']; }
        }

        /* Five on the dashboard; the rest are on Payment Schemes. Counted over
           every row above, though — a summary that only totals what fits on
           screen is worse than no summary. */
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
        /* The whole point of this list for a regular customer. An order can sit
           for a day with the money already sent and nothing telling them it has
           been seen. */
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
    /* Null for a regular customer — there are no credit accounts to summarise,
       and an object of zeroes reads as "you owe nothing on terms you have",
       which is a different and wrong statement. */
    'credit'       => $credit,
    'paymentsKind' => $isRetailer ? 'credit' : 'orders',
    'payments'     => $payments,
]);
