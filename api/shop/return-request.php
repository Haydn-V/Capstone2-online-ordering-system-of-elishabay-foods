<?php
declare(strict_types=1);

/** POST /api/shop/return-request.php files a return for the signed-in customer's own completed order within Returns::WINDOW_HOURS, re-checking units and computing the amount on the server; nothing changes until staff process it. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$customer = Auth::requireCustomer('Sign in to request a return.');

if (!Returns::ready()) {
    Response::conflict('Return requests are not available yet. Please contact us instead.');
}

$in      = Response::input();
$orderId = trim((string) ($in['order_id'] ?? ''));
$scope   = ($in['scope'] ?? 'items') === 'whole' ? 'whole' : 'items';
$reason  = trim((string) ($in['reason'] ?? ''));
$proof   = trim((string) ($in['proof'] ?? ''));

$errors = [];
if ($orderId === '')                 $errors['order_id'] = 'Choose the order to return.';
if (mb_strlen($reason) < 10)         $errors['reason']   = 'Tell us what went wrong (at least 10 characters).';
if (mb_strlen($reason) > 1000)       $errors['reason']   = 'Keep the reason under 1000 characters.';
/* Only a path our own upload endpoint hands a customer — never a URL. */
if (!preg_match('#^/uploads/references/[a-f0-9]{32}\.webp$#', $proof)) {
    $errors['proof'] = 'Attach a photo of the product.';
} elseif (!in_array($proof, $_SESSION['eb_issued_uploads'] ?? [], true)) {
    /* The proof photo must have been uploaded by this session. */
    $errors['proof'] = 'Please attach the photo again.';
}
/* Refund destination (migration 017): GCash or bank only, with a name plus a number or QR code. */
$refund = null;
if (Returns::refundReady()) {
    $pref   = (string) ($in['refund_pref'] ?? '');
    $accNm  = trim((string) ($in['refund_account_name'] ?? ''));
    $accNo  = preg_replace('/[\s-]+/', '', (string) ($in['refund_account_number'] ?? ''));
    $bank   = trim((string) ($in['refund_bank_name'] ?? ''));
    $qr     = trim((string) ($in['refund_qr'] ?? ''));
    if (!in_array($pref, ['gcash', 'bank'], true)) {
        $errors['refund_pref'] = 'Choose GCash or bank transfer for your refund.';
    }
    if (mb_strlen($accNm) < 2 || mb_strlen($accNm) > 100) {
        $errors['refund_account_name'] = 'Enter the account name.';
    }
    if ($pref === 'bank' && ($bank === '' || mb_strlen($bank) > 100)) {
        $errors['refund_bank_name'] = 'Enter the bank name.';
    }
    if ($qr !== '' && (!Returns::isUploadPath($qr, 'references')
            || !in_array($qr, $_SESSION['eb_issued_uploads'] ?? [], true))) {
        $errors['refund_qr'] = 'Please attach the QR code again.';
    }
    if ($accNo === '' && $qr === '') {
        $errors['refund_account_number'] = $pref === 'bank'
            ? 'Enter the account number or attach a QR code.'
            : 'Enter the GCash number or attach a QR code.';
    } elseif ($accNo !== '') {
        $ok = $pref === 'gcash'
            ? preg_match('/^(09\d{9}|\+639\d{9})$/', $accNo)
            : preg_match('/^\d{6,20}$/', $accNo);
        if (!$ok) {
            $errors['refund_account_number'] = $pref === 'gcash'
                ? 'GCash number should look like 09XXXXXXXXX.'
                : 'Account number should be 6 to 20 digits.';
        }
    }
    $refund = [$pref, $accNm, $accNo ?: null, $pref === 'bank' ? $bank : null, $qr ?: null];
}

if ($errors) {
    Response::validation('Please check the form.', $errors);
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();

    /* Locked so two quick submits cannot both claim the same units. */
    $order = Database::one(
        "SELECT id, date, status, completed_at,
                completed_at >= NOW() - INTERVAL " . Returns::WINDOW_HOURS . " HOUR AS in_window
           FROM orders WHERE id = ? AND customer_id = ? FOR UPDATE",
        [$orderId, $customer['id']]
    );
    if ($order === null) {
        $pdo->rollBack();
        Response::notFound('That order is not on your account.');
    }
    if ($order['status'] !== 'completed' || $order['completed_at'] === null) {
        $pdo->rollBack();
        Response::conflict('Only completed orders can be returned.');
    }
    if (!(int) $order['in_window']) {
        $pdo->rollBack();
        Response::conflict(sprintf('The return window for this order has closed — requests are accepted up to %d hours after the order is completed.', Returns::WINDOW_HOURS));
    }

    $lines = Returns::orderLines($order['id']);
    $picked = [];      // productId => qty
    $pickedLots = [];  // productId => [lot code ('' = no batch) => qty], when the customer chose the batch
    if ($scope === 'whole') {
        foreach ($lines as $pid => $l) {
            if ($l['remaining'] > 0) $picked[$pid] = $l['remaining'];
        }
    } else {
        foreach ((array) ($in['items'] ?? []) as $it) {
            $pid = (string) ($it['product_id'] ?? '');
            $qty = (int) ($it['qty'] ?? 0);
            if ($qty <= 0) continue;
            if (!isset($lines[$pid])) {
                $pdo->rollBack();
                Response::validation('Please check the items.', ['items' => 'One of those products is not on this order.']);
            }
            /* A chosen batch must be one this order's units came from, with that many still returnable. */
            if (array_key_exists('batch_code', $it) && $lines[$pid]['lots']) {
                $lot = (string) ($it['batch_code'] ?? '');
                $match = null;
                foreach ($lines[$pid]['lots'] as $l) { if ((string) $l['lot'] === $lot) { $match = $l; break; } }
                $already = $pickedLots[$pid][$lot] ?? 0;
                if ($match === null || $qty + $already > $match['remaining']) {
                    $pdo->rollBack();
                    Response::validation('Please check the items.', ['items' => sprintf(
                        'Only %d of %s from batch %s can still be returned.',
                        $match['remaining'] ?? 0, $lines[$pid]['name'], $lot !== '' ? $lot : '(no batch)')]);
                }
                $pickedLots[$pid][$lot] = $already + $qty;
            }
            if ($qty + ($picked[$pid] ?? 0) > $lines[$pid]['remaining']) {
                $pdo->rollBack();
                Response::validation('Please check the items.', ['items' => sprintf(
                    'Only %d of %s can still be returned.', $lines[$pid]['remaining'], $lines[$pid]['name'])]);
            }
            $picked[$pid] = ($picked[$pid] ?? 0) + $qty;
        }
    }
    if (!$picked) {
        $pdo->rollBack();
        Response::validation('Please check the items.', ['items' => $scope === 'whole'
            ? 'Everything on this order is already in a return request.'
            : 'Choose at least one product to return.']);
    }

    $total = 0.0;
    foreach ($picked as $pid => $qty) $total += $qty * $lines[$pid]['unitPrice'];
    $total = round($total, 2);

    $id = 'RET-' . date('Ymd') . '-' . strtoupper(bin2hex(random_bytes(3)));
    $first = array_key_first($picked);

    Database::run(
        'INSERT INTO product_returns
             (id, order_id, customer_id, customer_name, email, phone, product_id, qty, batch_code,
              purchase_date, reason, proof_image, scope, status, received_date, refund_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, \'received\', NOW(), ?)',
        [$id, $order['id'], $customer['id'], $customer['name'], $customer['email'] ?? null,
         $customer['contact'] ?? null, $first, array_sum($picked), $order['date'],
         $reason, $proof, $scope, $total]
    );
    if ($refund !== null) {
        Database::run(
            'UPDATE product_returns
                SET refund_pref = ?, refund_account_name = ?, refund_account_number = ?,
                    refund_bank_name = ?, refund_qr = ?, refund_method = ?
              WHERE id = ?',
            [...$refund, $refund[0], $id]
        );
    }
    /* One line per batch: the returned units are matched to the lots this order's units were taken from, skipping
       units already claimed by earlier requests on this order. Orders from before lot tracking get one line, no batch. */
    foreach ($picked as $pid => $qty) {
        /* The customer chose the batches: one line per chosen batch. */
        if (isset($pickedLots[$pid])) {
            foreach ($pickedLots[$pid] as $lot => $q) {
                Database::run(
                    'INSERT INTO product_return_items (return_id, product_id, qty, unit_price, batch_code) VALUES (?, ?, ?, ?, ?)',
                    [$id, $pid, $q, $lines[$pid]['unitPrice'], $lot !== '' ? $lot : null]
                );
            }
            continue;
        }
        $claimed = [];
        foreach (Database::all(
            "SELECT i.batch_code, SUM(i.qty) AS q FROM product_return_items i JOIN product_returns r ON r.id = i.return_id
              WHERE r.order_id = ? AND i.product_id = ? AND r.id <> ? AND r.status <> 'rejected' GROUP BY i.batch_code",
            [$order['id'], $pid, $id]
        ) as $c) {
            $claimed[(string) $c['batch_code']] = (int) $c['q'];
        }
        $left = $qty;
        foreach (Stock::lotsFor($order['id'], $pid) as $lot) {
            if ($left <= 0) { break; }
            $key  = (string) $lot['lot'];
            $free = $lot['qty'] - ($claimed[$key] ?? 0);
            if ($free <= 0) { $claimed[$key] = ($claimed[$key] ?? 0) - $lot['qty']; continue; }
            $claimed[$key] = 0;
            $take = min($left, $free);
            Database::run(
                'INSERT INTO product_return_items (return_id, product_id, qty, unit_price, batch_code) VALUES (?, ?, ?, ?, ?)',
                [$id, $pid, $take, $lines[$pid]['unitPrice'], $lot['lot']]
            );
            $left -= $take;
        }
        if ($left > 0) {
            Database::run(
                'INSERT INTO product_return_items (return_id, product_id, qty, unit_price) VALUES (?, ?, ?, ?)',
                [$id, $pid, $left, $lines[$pid]['unitPrice']]
            );
        }
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$customer['name'], 'order', sprintf('Return %s requested for order %s (%d item(s), ₱%s).',
            $id, $order['id'], array_sum($picked), number_format($total, 2))]
    );
    Notify::create('return', sprintf('New return request %s from %s — order %s, ₱%s.',
        $id, $customer['name'], $order['id'], number_format($total, 2)),
        ['return' => $id, 'order' => $order['id']]);

    $pdo->commit();

    /* Remove the photo from the discard list so the evidence cannot be deleted later. */
    $_SESSION['eb_issued_uploads'] = array_values(array_filter(
        $_SESSION['eb_issued_uploads'] ?? [],
        static fn($p) => $p !== $proof && $p !== ($refund[4] ?? null)));
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::created(['id' => $id, 'total' => $total, 'itemCount' => array_sum($picked)]);
