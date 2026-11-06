<?php
declare(strict_types=1);

/** POST /api/returns/advance.php (needs orders.returns) enforces the return pipeline on the server so no step (like approval) can be skipped. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('orders.returns');

$in = Response::input();

$data = Validate::check($in)
    ->required('id', 'Return')
    ->in('status', ['received','validated','eligible','ineligible','approved','rejected','processed'], 'Status')
    ->values();

$note = trim((string) ($in['note'] ?? '')) ?: null;

/* received → validated → eligible/ineligible → approved/rejected → processed; ineligible and rejected are final. */
const RETURN_FLOW = [
    'received'   => ['validated', 'rejected'],
    'validated'  => ['eligible', 'ineligible'],
    'eligible'   => ['approved', 'rejected'],
    'ineligible' => [],
    'approved'   => ['processed'],
    'rejected'   => [],
    'processed'  => [],
];

$ret = Database::one(
    'SELECT r.id, r.status, r.qty, r.product_id, r.refund_amount, r.order_id, r.customer_name
       FROM product_returns r WHERE r.id = ?',
    [$data['id']]
);
if ($ret === null) {
    Response::notFound('That return does not exist.');
}

$from = $ret['status'];
$to   = $data['status'];

if ($from === $to) {
    Response::conflict("That return is already {$to}.");
}

$allowed = RETURN_FLOW[$from] ?? [];
if (!in_array($to, $allowed, true)) {
    Response::conflict($allowed === []
        ? "This return is {$from} and cannot be advanced further."
        : sprintf('Cannot move a return from %s to %s. Allowed from %s: %s.',
                  $from, $to, $from, implode(', ', $allowed)));
}

/* Refusing a claim requires a reason. */
if (in_array($to, ['rejected', 'ineligible'], true)) {
    $reason = trim((string) ($in['rejected_reason'] ?? '')) ?: $note;
    if ($reason === null) {
        Response::validation('A reason is required.', [
            'rejected_reason' => 'Say why this return is being refused.',
        ]);
    }
} else {
    $reason = null;
}

/* The returned lines come from the request (migration 016) or from the single product of an older return. */
$lines = Returns::itemsFor([$ret['id']])[$ret['id']] ?? [[
    'productId' => $ret['product_id'], 'qty' => (int) $ret['qty'], 'subtotal' => null,
]];

$refundAmount = $ret['refund_amount'];
$refundMethod = null;
$refundReceipt = null;

if ($to === 'processed') {
    /* Processing a refund requires a validated amount and method. */
    $paid = Validate::check($in)
        ->decimal('refund_amount', 'Refund amount', 0)
        /* No cash refunds; the money goes to the customer's account, and the receipt is their proof. */
        ->in('refund_method', ['gcash', 'bank'], 'Refund method')
        ->values();
    $refundAmount = $paid['refund_amount'];
    $refundMethod = $paid['refund_method'];

    if (Returns::refundReady()) {
        $refundReceipt = trim((string) ($in['refund_receipt'] ?? ''));
        if (!Returns::isUploadPath($refundReceipt, 'refunds')) {
            Response::validation('Attach the transfer receipt.', [
                'refund_receipt' => 'Upload a screenshot of the GCash or bank transfer.',
            ]);
        }
    }

    /* The refund cannot exceed what the customer actually paid for the line. */
    $linePaid = $lines[0]['subtotal'] !== null
        ? array_sum(array_column($lines, 'subtotal'))
        : Database::scalar(
            'SELECT oi.price_at_purchase * ? FROM order_items oi
              WHERE oi.order_id = ? AND oi.product_id = ? LIMIT 1',
            [$ret['qty'], $ret['order_id'], $ret['product_id']]
        );
    if ($linePaid !== false && $linePaid !== null && $refundAmount > (float) $linePaid + 0.01) {
        Response::conflict(sprintf(
            'Refund of ₱%s exceeds what was paid for the returned items (₱%s).',
            number_format($refundAmount, 2), number_format((float) $linePaid, 2)
        ));
    }
}

/* Large refunds: at or above the threshold, only an Admin or the Super Admin may approve or process. */
if (in_array($to, ['approved', 'processed'], true)
    && Returns::isLarge((float) $refundAmount)
    && !Returns::canHandleLarge($user)) {
    Response::forbidden(sprintf(
        'Refunds of ₱%s or more must be approved and processed by an Admin or the Super Admin.',
        number_format(Returns::largeThreshold(), 2)
    ));
}

$eligibility = match ($to) {
    'eligible', 'approved', 'processed' => 1,
    'ineligible', 'rejected'            => 0,
    default                             => null,
};

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    Database::run(
        'UPDATE product_returns
            SET status = ?, eligibility = COALESCE(?, eligibility),
                refund_amount = ?, refund_method = COALESCE(?, refund_method),
                notes = COALESCE(?, notes), rejected_reason = COALESCE(?, rejected_reason)
          WHERE id = ? AND status = ?',
        [$to, $eligibility, $refundAmount, $refundMethod, $note, $reason, $ret['id'], $from]
    );

    if (Database::pdo()->query('SELECT ROW_COUNT()')->fetchColumn() < 1) {
        $pdo->rollBack();
        Response::conflict('Somebody else just changed this return. Reload and try again.');
    }
    if ($refundReceipt !== null) {
        Database::run('UPDATE product_returns SET refund_receipt = ? WHERE id = ?', [$refundReceipt, $ret['id']]);
    }
    /* The day the refund comes off revenue (030). */
    if ($to === 'processed' && Database::hasColumn('product_returns', 'processed_at')) {
        Database::run('UPDATE product_returns SET processed_at = NOW() WHERE id = ?', [$ret['id']]);
    }

    /* Returned goods are never put back in stock (they are damaged or unsellable); a refunded unit
       only comes off the sold count. Stock and batch quantities stay as they are. */
    if ($to === 'processed') {
        foreach ($lines as $line) {   /* one per product or batch on the request */
            Database::run('UPDATE products SET sold = GREATEST(sold - ?, 0) WHERE id = ?',
                [(int) $line['qty'], $line['productId']]);
        }
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('Return %s: %s → %s.%s%s', $ret['id'], $from, $to,
             $to === 'processed'
                 ? sprintf(' Refunded ₱%s via %s.', number_format($refundAmount, 2), $refundMethod)
                 : '',
             $reason ? ' Reason: ' . $reason : ($note ? ' Note: ' . $note : ''))]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Notify the customer after the commit, so a failed notification never undoes the change. */
CustomerNotify::returnStatus($ret['id'], $to, $reason ?? null);

Response::ok([
    'id'          => $ret['id'],
    'from'        => $from,
    'status'      => $to,
    'allowedNext' => RETURN_FLOW[$to] ?? [],
    'stockReturned' => 0,   /* returned goods are not restocked */
]);
