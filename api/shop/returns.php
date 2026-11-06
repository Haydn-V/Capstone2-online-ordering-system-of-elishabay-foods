<?php
declare(strict_types=1);

/** GET /api/shop/returns.php returns the signed-in customer's return requests and the orders still eligible within the 24-hour window, without internal staff notes. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
$customer = Auth::requireCustomer('Sign in to see your returns.');

if (!Returns::ready()) {
    Response::ok(['requests' => [], 'eligible' => [], 'windowHours' => Returns::WINDOW_HOURS]);
}

$rows = Database::all(
    'SELECT r.id, r.order_id, r.scope, r.reason, r.proof_image, r.status, r.received_date,
            r.refund_amount, r.refund_method, r.rejected_reason' . (Returns::refundReady() ? ',
            r.refund_pref, r.refund_account_name, r.refund_account_number, r.refund_bank_name,
            r.refund_qr, r.refund_receipt' : '') . '
       FROM product_returns r
      WHERE r.customer_id = ?
      ORDER BY r.received_date DESC, r.id DESC',
    [$customer['id']]
);
$items = Returns::itemsFor(array_column($rows, 'id'));

$requests = array_map(static function (array $r) use ($items): array {
    $lines = $items[$r['id']] ?? [];
    [$key, $label] = Returns::customerStatus($r['status']);
    return [
        'id'             => $r['id'],
        'orderId'        => $r['order_id'],
        'scope'          => $r['scope'],
        'reason'         => $r['reason'],
        'proofImage'     => $r['proof_image'],
        'status'         => $key,
        'statusLabel'    => $label,
        'submittedAt'    => $r['received_date'],
        'items'          => $lines,
        'itemCount'      => array_sum(array_column($lines, 'qty')),
        /* What the customer asked for (their lines at the price they paid). */
        'total'          => round(array_sum(array_column($lines, 'subtotal')), 2),
        /* What was actually paid back — only once it has been. */
        'refundAmount'   => $r['status'] === 'processed' ? (float) $r['refund_amount'] : null,
        'refundMethod'   => $r['status'] === 'processed' ? $r['refund_method'] : null,
        'rejectedReason' => $r['rejected_reason'],
        /* Where they asked for the money to go (017). */
        'refundTo'       => empty($r['refund_pref']) ? null : [
            'method'        => $r['refund_pref'],
            'accountName'   => $r['refund_account_name'],
            'accountNumber' => $r['refund_account_number'],
            'bankName'      => $r['refund_bank_name'],
            'qr'            => $r['refund_qr'],
        ],
        /* Staff's transfer screenshot — the customer's proof it was sent. */
        'refundReceipt'  => $r['status'] === 'processed' ? ($r['refund_receipt'] ?? null) : null,
    ];
}, $rows);

/* The window uses the database clock, same as completed_at. */
$eligible = [];
foreach (Database::all(
    'SELECT id, date, total, completed_at,
            TIMESTAMPDIFF(MINUTE, NOW(), completed_at + INTERVAL ' . Returns::WINDOW_HOURS . ' HOUR) AS mins_left
       FROM orders
      WHERE customer_id = ? AND status = \'completed\'
        AND completed_at IS NOT NULL
        AND completed_at >= NOW() - INTERVAL ' . Returns::WINDOW_HOURS . ' HOUR
      ORDER BY completed_at DESC',
    [$customer['id']]
) as $o) {
    $lines = array_values(array_filter(Returns::orderLines($o['id']), static fn($l) => $l['remaining'] > 0));
    if (!$lines) continue;
    $eligible[] = [
        'id'          => $o['id'],
        'date'        => $o['date'],
        'total'       => (float) $o['total'],
        'completedAt' => $o['completed_at'],
        'minutesLeft' => max(0, (int) $o['mins_left']),
        'lines'       => $lines,
    ];
}

Response::ok([
    'requests'    => $requests,
    'eligible'    => $eligible,
    'windowHours' => Returns::WINDOW_HOURS,
]);
