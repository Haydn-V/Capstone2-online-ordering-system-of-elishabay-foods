<?php
declare(strict_types=1);

/** POST /api/shop/checkout.php places a signed-in customer's online order as pending and unverified, reserving its items (Stock::reservedSql) so shoppers see them as taken; stock itself moves when staff accept it. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$in = Response::input();

/* ---- cart ---- */
$cart = $in['items'] ?? [];
if (!is_array($cart) || $cart === []) {
    Response::validation('Your cart is empty.', ['items' => 'Add at least one product.']);
}
if (count($cart) > 50) {
    Response::validation('That is a very large order.', ['items' => 'Please contact us directly for orders above 50 lines.']);
}

$wanted = [];
foreach ($cart as $line) {
    $id  = trim((string) ($line['id'] ?? ''));
    $qty = (int) ($line['qty'] ?? 0);
    if ($id === '' || $qty < 1) {
        Response::validation('A cart line is invalid.', ['items' => 'Every line needs a product and a quantity.']);
    }
    if ($qty > 500) {
        Response::validation('That quantity is too large.', ['items' => 'Please contact us directly for bulk orders.']);
    }
    $wanted[$id] = ($wanted[$id] ?? 0) + $qty;
}

/* Checkout requires a signed-in customer (no guest checkout), checked before validation. */
$buyer = Auth::requireCustomer('Sign in to place your order.');

/* Auth::customer() re-reads the account every request, so retailer status here is current. */
$isRetailer = ($buyer['status'] ?? null) === 'retailer';

/* Refuse (not ignore) any buyer identity in the body. */
foreach (['customer_id', 'customerId', 'email'] as $forbidden) {
    if (array_key_exists($forbidden, $in) && trim((string) $in[$forbidden]) !== ''
        && strcasecmp(trim((string) $in[$forbidden]), (string) $buyer['email']) !== 0) {
        Response::validation('The signed-in account is used for checkout.', [
            $forbidden => 'Remove this field — the order is placed for the signed-in customer.',
        ]);
    }
}

/* ---- customer details ---- */
$data = Validate::check($in)
    ->required('name', 'Your name')
    ->maxLen('name', 100, 'Your name')
    ->required('contact', 'Contact number')
    ->in('order_type', ['pickup', 'delivery'], 'Order type')
    /* Credit terms are offered only to a current retailer, checked from the database each request, using the list from Payments::methods(). */
    ->in('pay_method', Payments::methods($isRetailer), 'Payment method')
    ->values();

/* The account email always comes from the session; only the delivery address comes from the request. */
$email   = (string) $buyer['email'];

/* Delivery address is resolved from picker codes (see api/core/Address.php); pickup orders store no address. */
[$ship, $addressErrors] = $data['order_type'] === 'delivery'
    ? Address::check(is_array($in['address'] ?? null) ? $in['address'] : null, true)
    : [null, []];
$address = $ship['line'] ?? null;
$refNum  = trim((string) ($in['ref_num'] ?? '')) ?: null;
$notes   = trim((string) ($in['notes'] ?? '')) ?: null;

/* The payment screenshot path must match the upload format and exist on disk. */
$proofPath = trim((string) ($in['proof_image'] ?? '')) ?: null;
if ($proofPath !== null && !preg_match('#^/uploads/references/[a-f0-9]{32}\.webp$#', $proofPath)) {
    Response::validation('Please check the highlighted fields.', [
        'proof_image' => 'That is not a valid uploaded image path. Attach the screenshot again.',
    ]);
}
if ($proofPath !== null && !is_file(dirname(__DIR__, 2) . $proofPath)) {
    Response::validation('Please check the highlighted fields.', [
        'proof_image' => 'That upload is no longer on the server. Attach the screenshot again.',
    ]);
}

$fieldErrors = [];
if (!preg_match('/^[0-9 +\-()]{7,20}$/', $data['contact'])) {
    $fieldErrors['contact'] = 'Enter a valid contact number.';
}
/* Keyed addr_region, addr_barangay, … — the picker lays them on its own fields. */
$fieldErrors += $addressErrors;
/* Cash is pickup-only, since there is no one to collect it on delivery. */
if ($data['pay_method'] === 'cash' && $data['order_type'] === 'delivery') {
    $fieldErrors['pay_method'] = 'Cash is available on pickup only. Choose GCash or bank transfer for a delivery.';
}
/* Only GCash and bank carry a reference; credit orders have nothing to reference yet. */
if (in_array($data['pay_method'], ['gcash', 'bank'], true) && $refNum === null) {
    $fieldErrors['ref_num'] = 'Enter the reference number of your payment.';
} else {
    [$refNum, $refErr] = Payments::checkRef($data['pay_method'], $refNum);
    if ($refErr !== null) { $fieldErrors['ref_num'] = $refErr; }
}
/* No Senior/PWD discount online, since the ID must be seen at the counter. */
if (!empty($in['sc_pwd'])) {
    $fieldErrors['sc_pwd'] = 'Senior citizen and PWD discounts are applied at the counter, where your ID can be checked.';
}
if ($fieldErrors !== []) {
    Response::validation('Please check the highlighted fields.', $fieldErrors);
}

$pdo = Database::pdo();

try {
    $pdo->beginTransaction();

    $ids = array_keys($wanted);
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    /* Lock the rows first so two checkouts cannot both claim the last units, then read what is left after other customers' reservations. */
    Database::all("SELECT id FROM products WHERE id IN ($ph) FOR UPDATE", $ids);
    $products = Database::all(
        "SELECT p.id, p.name, p.price, p.tax_type, " . Stock::availableSql('p') . " AS stock, p.archived
           FROM products p WHERE p.id IN ($ph)",
        $ids
    );
    $byId = [];
    foreach ($products as $p) { $byId[$p['id']] = $p; }

    $lines = [];
    $total = 0.0;
    foreach ($wanted as $id => $qty) {
        if (!isset($byId[$id]) || (int) $byId[$id]['archived'] === 1) {
            $pdo->rollBack();
            Response::conflict('One of the products in your cart is no longer available. Please review your cart.');
        }
        $p = $byId[$id];
        if ((int) $p['stock'] < $qty) {
            $pdo->rollBack();
            Response::conflict("We only have {$p['stock']} of {$p['name']} left. Please adjust your order.");
        }

        /* Prices come from the database, never from the browser. */
        $unit = (float) $p['price'];
        $lineTotal = round($unit * $qty, 2);
        $total += $lineTotal;
        $lines[] = ['id' => $id, 'name' => $p['name'], 'qty' => $qty, 'price' => $unit,
                    'lineTotal' => $lineTotal, 'taxType' => $p['tax_type']];
    }

    /* Store the VAT breakdown; a withholding retailer pays a lower amountDue, but the sale total is unchanged. */
    $tax = Tax::compute(
        array_map(static fn(array $l): array => ['gross' => $l['lineTotal'], 'tax_type' => $l['taxType']], $lines),
        null,
        Tax::withholdingRateFor((string) $buyer['id'], (int) array_sum(array_column($lines, 'qty')))
    );
    /* Add the estimated delivery fee for deliveries (api/core/Shipping.php). */
    $shipQuote = null;
    if ($data['order_type'] === 'delivery' && Shipping::ready()) {
        $shipQuote = Shipping::quote($wanted, Shipping::destinationFromAddress($ship));
        /* Deliveries to an island/remote area that is paused (e.g. a typhoon) are refused before anything is saved. */
        if (!empty($shipQuote['paused'])) {
            $pdo->rollBack();
            Shipping::refuseIfPaused($shipQuote);
        }
        $tax = Shipping::applyTo($tax, $shipQuote);
    }
    /* Buying on Net terms adds the term's interest to what is owed (Payments::applyInterest). */
    $tax   = Payments::applyInterest($tax, $data['pay_method']);
    $total = $tax['total'];
    $due   = $tax['amountDue'];

    /* The order always belongs to the signed-in customer, never to an email in the request. */
    /* Always set: the endpoint refused the request otherwise. */
    $customerId = $buyer['id'];

    /* A retailer with an overdue Net balance cannot open new credit (they can still pay by cash/GCash/bank), and the message names the amount and date. */
    if (Payments::isCredit($data['pay_method'])) {
        /* Use Payments::describeAccount() so part-paid late balances count only what is left. */
        $rate    = Payments::penaltyRate();
        $overdue = array_values(array_filter(
            array_map(
                static fn(array $r): array => Payments::describeAccount($r, $rate),
                Database::all(
                    Payments::accountSelect()
                    . ' WHERE pa.customer_id = ? AND pa.paid = 0 AND pa.due_date < CURDATE()
                        ORDER BY pa.due_date ASC',
                    [$customerId]
                )
            ),
            static fn(array $a): bool => $a['overdue']
        ));
        if ($overdue !== []) {
            $owed   = array_sum(array_column($overdue, 'remaining'));
            $oldest = $overdue[0]['dueDate'];
            $pdo->rollBack();
            Response::conflict(sprintf(
                'You have %s overdue on your account (due %s). Settle it to use credit terms again — '
                . 'you can still place this order on cash, GCash or bank transfer.',
                '₱' . number_format($owed, 2),
                date('j M Y', strtotime((string) $oldest))
            ));
        }

        /* Tier credit budget: lock the customer row so two Net orders at once cannot both slip under the budget. */
        Database::scalar('SELECT id FROM customers WHERE id = ? FOR UPDATE', [$customerId]);
        $overBudget = Payments::creditProblem($customerId, (float) $tax['amountDue']);
        if ($overBudget !== null) {
            $pdo->rollBack();
            Response::conflict($overBudget);
        }
    }

    $orderId = 'ORD-' . date('Ymd') . '-' . strtoupper(bin2hex(random_bytes(3)));

    /* Payment columns via Payments::orderFields() with atTill: false, so online GCash/bank orders always start unverified. */
    /* The amount due (what a withholding retailer actually transfers), for Payment Verification. */
    $pay = Payments::orderFields($data['pay_method'], $refNum, $proofPath, $due, false);

    Database::run(
        'INSERT INTO orders (id, customer_id, customer_name, email, contact, address,
                             ship_street, ship_barangay, ship_city, ship_province, ship_region, ship_zip,
                             ship_region_code, ship_province_code, ship_city_code, ship_barangay_code,
                             type, order_type, customer_type, method, total, date, datetime,
                             status, notes, pay_verified, proof_uploaded, proof_ref_num,
                             proof_image_path, proof_amount, cashier, batch_code_hint,
                             gross_total, vat_rate, less_vat, net_of_vat, sc_pwd_discount, vatable_sales,
                             vat_amount, vat_exempt_sales, sc_pwd_type, sc_pwd_id, sc_pwd_name,
                             withholding_rate, withholding_tax)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, CURDATE(), NOW(), ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        array_merge([
            $orderId, $customerId, $data['name'], $email ?: null, $data['contact'], $address,
            /* Store the address names as they were at the sale, so later PSGC changes never alter the invoice. */
            $ship['street'] ?? null, $ship['barangay'] ?? null, $ship['city'] ?? null,
            $ship['province'] ?? null, $ship['region'] ?? null, $ship['zip'] ?? null,
            $ship['region_code'] ?? null, $ship['province_code'] ?? null,
            $ship['city_code'] ?? null, $ship['barangay_code'] ?? null,
            'online', $data['order_type'], 'regular', $data['pay_method'], $total,
            'pending', $notes,
            $pay['pay_verified'], $pay['proof_uploaded'], $pay['proof_ref_num'],
            $pay['proof_image_path'], $pay['proof_amount'],
        ], array_values(Tax::orderColumns($tax)))
    );

    foreach ($lines as $l) {
        Database::run(
            'INSERT INTO order_items (order_id, product_id, qty, price_at_purchase, tax_type) VALUES (?, ?, ?, ?, ?)',
            [$orderId, $l['id'], $l['qty'], $l['price'], $l['taxType']]
        );
    }
    Shipping::saveOnOrder($orderId, $shipQuote);
    Payments::saveInterestOnOrder($orderId, $tax);

    /* Open the receivable in the same transaction as the order, with the due date computed by the database. */
    $credit = null;
    if (Payments::isCredit($data['pay_method'])) {
        /* The account bills what the retailer owes: the total less their discount (never a "payment" of the discount). */
        $credit = Payments::openCreditAccount($orderId, $buyer, $data['pay_method'], $due);
    }

    /* Notify staff of the new order (Warning level from Notify's table). */
    Notify::create(
        'new-order',
        sprintf('New online order from %s — ₱%s', $data['name'], number_format((float) $due, 2)),
        ['order' => $orderId]
    );

    /* Actor is the customer, not a staff member, so actor_user_id stays NULL. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$data['name'], 'order',
         sprintf('Online order %s placed via storefront — ₱%s (%s, %s), %d line(s).%s',
             $orderId, number_format((float) $due, 2), $data['pay_method'], $data['order_type'], count($lines),
             /* Name the opened receivable in the credit sale's audit line. */
             $credit !== null
                 ? sprintf(' Credit account %s opened on %s terms, due %s.',
                     $credit['id'], $credit['scheme'], $credit['dueDate'])
                 : '')]
    );

    /* Empty the saved cart inside the same transaction, so a failed order never clears it. */
    Database::run('DELETE FROM cart_items WHERE customer_id = ?', [$customerId]);

    $pdo->commit();

    /* Remove the proof path from the discardable list so the customer cannot delete it after ordering. */
    if ($proofPath !== null && !empty($_SESSION['eb_issued_uploads'])) {
        $_SESSION['eb_issued_uploads'] = array_values(array_filter(
            $_SESSION['eb_issued_uploads'],
            static fn($p) => $p !== $proofPath
        ));
    }
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::created([
    'id'        => $orderId,
    'type'      => 'online',
    /* A retailer's own TIN for the Sales Invoice; null for a regular shopper. */
    'tin'       => Orders::buyerTin((string) $buyer['id']),
    'status'    => 'pending',
    'name'      => $data['name'],
    'contact'   => $data['contact'],
    'email'     => $email ?: null,
    'address'   => $address,
    'orderType' => $data['order_type'],
    'payMethod' => $data['pay_method'],
    'refNum'    => $refNum,
    'items'     => $lines,
    'total'     => $total,
    'tax'       => $tax,
    'amountDue' => $due,
    'shipping'  => $shipQuote,
    'placedAt'  => date('Y-m-d H:i'),
    /* Null for an immediate sale; for a credit sale, the account details and database-computed due date for the receipt. */
    'credit'    => $credit,
    'message'   => $credit !== null
        ? sprintf('Your order has been received on %s terms. The balance is due %s.',
            $credit['scheme'], date('j M Y', strtotime((string) $credit['dueDate'])))
        : 'Your order has been received. Our team will verify your payment and contact you shortly.',
]);
