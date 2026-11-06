<?php
declare(strict_types=1);

/** POST /api/pos/checkout.php (needs pos.use) prices every item from the database (ignoring any client prices) and saves the order, line items, stock movement and audit row in one transaction. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('pos.use');

$in = Response::input();

/* ---- cart ---- */
$cart = $in['items'] ?? [];
if (!is_array($cart) || $cart === []) {
    Response::validation('The cart is empty.', ['items' => 'Add at least one product.']);
}
if (count($cart) > 100) {
    Response::validation('Too many line items.', ['items' => 'A single sale is limited to 100 lines.']);
}

/* Merge duplicate product lines before pricing so they cannot oversell together. */
$wanted = [];
foreach ($cart as $line) {
    $id  = trim((string) ($line['id'] ?? ''));
    $qty = (int) ($line['qty'] ?? 0);
    if ($id === '' || $qty < 1) {
        Response::validation('A cart line is invalid.', ['items' => 'Every line needs a product and a quantity of at least 1.']);
    }
    $wanted[$id] = ($wanted[$id] ?? 0) + $qty;
}

/* Accepted payment methods come from Payments::methods(), with credit terms only for a retailer customer type. */
$customerType = (string) ($in['customer_type'] ?? '');
$allowCredit  = $customerType === 'retailer';

$data = Validate::check($in)
    ->in('order_type', ['pickup', 'delivery'], 'Order type')
    ->in('customer_type', ['regular', 'retailer'], 'Customer type')
    ->in('pay_method', Payments::methods($allowCredit), 'Payment method')
    ->values();

$name    = trim((string) ($in['customer_name'] ?? '')) ?: 'Walk-In Customer';
$contact = trim((string) ($in['contact'] ?? '')) ?: null;
$address = trim((string) ($in['address'] ?? '')) ?: null;
$refNum  = trim((string) ($in['ref_num'] ?? '')) ?: null;
$tendered = (float) ($in['tendered'] ?? 0);
$isCredit = Payments::isCredit($data['pay_method']);

$fieldErrors = [];
if ($data['order_type'] === 'delivery' && $address === null) {
    $fieldErrors['address'] = 'A delivery address is required.';
}
if (in_array($data['pay_method'], ['gcash', 'bank'], true) && $refNum === null) {
    $fieldErrors['ref_num'] = 'A reference number is required for this payment method.';
} else {
    [$refNum, $refErr] = Payments::checkRef($data['pay_method'], $refNum);
    if ($refErr !== null) { $fieldErrors['ref_num'] = $refErr; }
}

/* A credit sale must name an existing retailer account, so the debt belongs to someone. */
/* Senior/PWD details are validated here and applied in Tax::compute(); ID number and name are required by BIR. */
$scPwd = Tax::scPwdFrom($in, $fieldErrors);
if ($scPwd !== null && ($customerType === 'retailer' || $isCredit)) {
    /* The Senior/PWD discount does not apply to a retailer buying for resale. */
    $fieldErrors['sc_pwd'] = 'A senior citizen or PWD discount is for a personal purchase, not a retailer sale.';
    $scPwd = null;
}

$retailer = null;
/* A retailer account is required for credit sales and optional otherwise (it enables withholding and files the sale under the retailer). */
$retailerId = trim((string) ($in['retailer_id'] ?? ''));
if ($isCredit || ($customerType === 'retailer' && $retailerId !== '')) {
    if ($retailerId === '') {
        $fieldErrors['retailer_id'] = 'Choose which retailer this credit sale is for.';
    } else {
        $retailer = Database::one(
            "SELECT id, name, email, status FROM customers WHERE id = ?",
            [$retailerId]
        );
        if ($retailer === null) {
            $fieldErrors['retailer_id'] = 'That customer does not exist.';
        } elseif ($retailer['status'] !== 'retailer') {
            /* Check the retailer against the database, not the dropdown. */
            $fieldErrors['retailer_id'] = 'That customer is not a retailer, so they cannot buy on terms.';
        }
    }
}

/* A regular sale may be filed under a customer on record (pos/customers.php), so it shows in their order history
   and lifetime spend. No credit and no retailer discount come with it — those stay with retailer accounts. */
$regular   = null;
$regularId = trim((string) ($in['customer_id'] ?? ''));
if ($retailer === null && $regularId !== '') {
    $regular = Database::one('SELECT id, name, email, contact, status FROM customers WHERE id = ?', [$regularId]);
    if ($regular === null || $regular['status'] !== 'active') {
        $fieldErrors['customer_id'] = 'That customer is not on record as an active customer. Search again or clear it.';
        $regular = null;
    } elseif (!isset($in['customer_name']) || trim((string) $in['customer_name']) === '' || $name === 'Walk-In Customer') {
        $name = $regular['name'];
    }
    if ($regular !== null && $contact === null) {
        $contact = $regular['contact'];
    }
}

if ($fieldErrors !== []) {
    Response::validation('Check the highlighted fields.', $fieldErrors);
}

$pdo = Database::pdo();

try {
    $pdo->beginTransaction();

    /* Lock the product rows for the transaction so two cashiers cannot sell the last unit twice. */
    $ids = array_keys($wanted);
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    $products = Database::all(
        "SELECT id, name, price, tax_type, stock, archived FROM products WHERE id IN ($ph) FOR UPDATE",
        $ids
    );
    $byId = [];
    foreach ($products as $p) { $byId[$p['id']] = $p; }

    $lines = [];
    $total = 0.0;
    foreach ($wanted as $id => $qty) {
        if (!isset($byId[$id])) {
            $pdo->rollBack();
            Response::validation('A product in the cart no longer exists.', ['items' => "Unknown product: {$id}."]);
        }
        $p = $byId[$id];
        if ((int) $p['archived'] === 1) {
            $pdo->rollBack();
            Response::conflict("{$p['name']} has been archived and cannot be sold.");
        }
        if ((int) $p['stock'] < $qty) {
            $pdo->rollBack();
            Response::conflict("Not enough stock for {$p['name']} — {$p['stock']} left, {$qty} requested.");
        }

        /* Price read from the database, not from the request. */
        $unit = (float) $p['price'];
        $lineTotal = round($unit * $qty, 2);
        $total += $lineTotal;

        /* Copy the product's current tax type onto the line so later changes never alter this invoice. */
        $lines[] = ['id' => $id, 'name' => $p['name'], 'qty' => $qty, 'price' => $unit,
                    'lineTotal' => $lineTotal, 'taxType' => $p['tax_type']];
    }

    /* Compute and store the VAT breakdown here: total is after any Senior/PWD discount, amountDue is after any withholding. */
    $tax = Tax::compute(
        array_map(static fn(array $l): array => ['gross' => $l['lineTotal'], 'tax_type' => $l['taxType']], $lines),
        $scPwd,
        Tax::withholdingRateFor($retailer['id'] ?? null, (int) array_sum(array_column($lines, 'qty')))
    );
    /* Add the estimated delivery fee for deliveries (api/core/Shipping.php); pickup has none. */
    $shipQuote = null;
    if ($data['order_type'] === 'delivery' && Shipping::ready()) {
        $shipQuote = Shipping::quote($wanted, Shipping::destinationFromPos($in['destination'] ?? '', $address));
        /* Deliveries to an island/remote area that is paused (e.g. a typhoon) are refused before anything is saved. */
        if (!empty($shipQuote['paused'])) {
            $pdo->rollBack();
            Shipping::refuseIfPaused($shipQuote);
        }
        $tax = Shipping::applyTo($tax, $shipQuote);
    }
    $total = $tax['total'];
    /* Buying on Net terms adds the term's interest to what is owed (Payments::applyInterest). */
    $tax   = Payments::applyInterest($tax, $data['pay_method']);
    $due   = $tax['amountDue'];

    /* Tier credit budget: a Net sale may not take the retailer past it (row lock stops two sales slipping under together). */
    if ($isCredit) {
        Database::scalar('SELECT id FROM customers WHERE id = ? FOR UPDATE', [$retailer['id']]);
        $overBudget = Payments::creditProblem($retailer['id'], (float) $due, true);
        if ($overBudget !== null) {
            $pdo->rollBack();
            Response::conflict($overBudget);
        }
    }

    /* Check the cash tendered against the real amount due. */
    if ($data['pay_method'] === 'cash' && $tendered > 0 && $tendered < $due) {
        $pdo->rollBack();
        Response::validation('Not enough cash tendered.', [
            'tendered' => 'Tendered ₱' . number_format($tendered, 2) . ' but the amount due is ₱' . number_format($due, 2) . '.',
        ]);
    }
    $change = ($data['pay_method'] === 'cash' && $tendered >= $due) ? round($tendered - $due, 2) : 0.0;

    /* A pickup is completed on the spot; a delivery goes into the fulfilment flow. */
    $status = $data['order_type'] === 'pickup' ? 'completed' : 'accepted';

    $orderId = 'EB-' . strtoupper(bin2hex(random_bytes(3))) . '-' . random_int(100, 999);

    /* Payment columns come from Payments::orderFields() (atTill: true verifies immediate methods, never credit). */
    $pay = Payments::orderFields($data['pay_method'], $refNum, null, $due, true);

    /* Linked to the retailer's customer row, or to the regular customer it was filed under; else no customer_id. */
    $customerId = $retailer['id'] ?? $regular['id'] ?? null;
    $email      = $retailer['email'] ?? $regular['email'] ?? null;

    Database::run(
        'INSERT INTO orders (id, customer_id, customer_name, email, contact, address,
                             type, order_type, customer_type, method, total, date, datetime,
                             status, notes, pay_verified, proof_uploaded, proof_ref_num,
                             proof_image_path, proof_amount, cashier, batch_code_hint,
                             gross_total, vat_rate, less_vat, net_of_vat, sc_pwd_discount, vatable_sales,
                             vat_amount, vat_exempt_sales, sc_pwd_type, sc_pwd_id, sc_pwd_name,
                             withholding_rate, withholding_tax)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), NOW(), ?, NULL, ?, ?, ?, ?, ?, ?, NULL,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        array_merge([
            $orderId, $customerId, $name, $email, $contact, $address,
            'walk-in', $data['order_type'], $data['customer_type'],
            $data['pay_method'], $total, $status,
            $pay['pay_verified'], $pay['proof_uploaded'], $pay['proof_ref_num'],
            $pay['proof_image_path'], $pay['proof_amount'],
            $user['id'],
        ], array_values(Tax::orderColumns($tax)))
    );

    foreach ($lines as $l) {
        Database::run(
            'INSERT INTO order_items (order_id, product_id, qty, price_at_purchase, tax_type) VALUES (?, ?, ?, ?, ?)',
            [$orderId, $l['id'], $l['qty'], $l['price'], $l['taxType']]
        );
        /* Shared stock movement (api/core/Stock.php), safe thanks to the row lock and sell()'s guard. */
        Stock::sell($l['id'], $l['qty']);
        /* Record which lots the units came from (earliest expiry first). */
        Stock::allocateLots($orderId, $l['id'], (int) $l['qty']);
    }
    Shipping::saveOnOrder($orderId, $shipQuote);
    Payments::saveInterestOnOrder($orderId, $tax);

    /* A credit sale opens its receivable in this same transaction, so the sale and the debt are saved together or not at all. */
    $creditAccount = null;
    if ($isCredit) {
        /* The account bills what the retailer owes: the total less their discount (never a "payment" of the discount). */
        $creditAccount = Payments::openCreditAccount($orderId, $retailer, $data['pay_method'], $due);
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('POS sale %s — ₱%s (%s, %s). %d line(s), %d unit(s).%s',
             $orderId, number_format((float) $due, 2), $data['pay_method'], $data['order_type'],
             count($lines), array_sum(array_column($lines, 'qty')),
             /* Describe the credit sale clearly in the audit line (who owes how much, and when). */
             ($creditAccount !== null
                ? sprintf(' On terms: %s opened for %s — ₱%s due %s (%s).',
                    $creditAccount['id'], $retailer['name'],
                    number_format($creditAccount['balance'], 2),
                    $creditAccount['dueDate'], $creditAccount['scheme'])
                : '')
             /* The two tax events an auditor would otherwise have to rebuild. */
             . ($scPwd !== null
                ? sprintf(' %s discount ₱%s for ID %s (%s).',
                    $scPwd['type'] === 'pwd' ? 'PWD' : 'Senior citizen',
                    number_format($tax['scPwdDiscount'], 2), $scPwd['id'], $scPwd['name'])
                : '')
             . ($tax['withholdingTax'] > 0
                ? sprintf(' Withholding tax ₱%s (%s%%) kept by %s.',
                    number_format($tax['withholdingTax'], 2), $tax['withholdingRate'], $retailer['name'])
                : ''))]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

/* Return everything the receipt needs, computed here so printed and stored figures match. */
Response::created([
    'id'          => $orderId,
    /* Tell the invoice the order type, since a walk-in's business address only prints for deliveries. */
    'type'        => 'walk-in',
    'tin'         => Orders::buyerTin($customerId),
    'status'      => $status,
    'customer'    => $name,
    'contact'     => $contact,
    'address'     => $address,
    'orderType'   => $data['order_type'],
    'customerType'=> $data['customer_type'],
    'payMethod'   => $data['pay_method'],
    'refNum'      => $refNum,
    'items'       => $lines,
    'total'       => $total,
    /* The stored breakdown — the invoice prints these figures as they are. */
    'tax'         => $tax,
    'amountDue'   => $due,
    'tendered'    => $tendered ?: null,
    'change'      => $change,
    'cashier'     => $user['name'],
    'datetime'    => date('Y-m-d H:i'),
    /* The receipt prints the due date computed by the database, not by the browser. */
    'creditAccount' => $creditAccount,
    'retailer'      => $retailer !== null ? ['id' => $retailer['id'], 'name' => $retailer['name']] : null,
]);
