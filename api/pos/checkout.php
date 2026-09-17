<?php
declare(strict_types=1);

/**
 * POST /api/pos/checkout.php
 *
 * Body: {
 *   "items": [ { "id": "db-pesto", "qty": 2 }, … ],
 *   "order_type": "pickup" | "delivery",
 *   "customer_type": "regular" | "retailer",
 *   "pay_method": "cash" | "gcash" | "bank",
 *   "customer_name": "...", "contact": "...", "address": "...",
 *   "ref_num": "...",        // gcash / bank
 *   "tendered": 500          // cash
 * }
 *
 * Requires pos.use.
 *
 * THE MONEY RULE
 * --------------
 * The client sends product ids and quantities. It does NOT send prices, line
 * totals or a grand total — and if it does, they are ignored. Every peso is
 * computed here from products.price. The old placeOrder() calculated the total
 * in the browser and stored whatever it arrived at, which means the amount
 * charged was decided by code the customer's own machine was running.
 *
 * STOCK AND THE ORDER MOVE TOGETHER
 * ---------------------------------
 * Order row, line items, stock decrements and the audit entry are one
 * transaction. A sale that records the order but not the stock movement (or the
 * reverse) leaves inventory permanently wrong, and nothing downstream can tell
 * which half is missing.
 */

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

/* Merge duplicate lines before pricing. Two lines of the same product would
   otherwise each be checked against full stock and could jointly oversell. */
$wanted = [];
foreach ($cart as $line) {
    $id  = trim((string) ($line['id'] ?? ''));
    $qty = (int) ($line['qty'] ?? 0);
    if ($id === '' || $qty < 1) {
        Response::validation('A cart line is invalid.', ['items' => 'Every line needs a product and a quantity of at least 1.']);
    }
    $wanted[$id] = ($wanted[$id] ?? 0) + $qty;
}

/* ---- options ----
   The accepted payment methods come from Payments::methods(), not from a list
   written out here. This endpoint used to hardcode ['cash','gcash','bank']
   while the POS offered Net 30/60/90 the instant a cashier picked "Retailer" —
   so a credit sale returned 422 and, because placeOrder() had no branch for a
   `pay_method` field error, showed the cashier nothing at all. The button
   appeared dead, no order was written, and the payment never reached Payment
   History. That is the reported defect.

   Credit terms are offered only when the customer type is retailer, and the
   check runs against the customer type the request actually carries — not
   against what the button grid happened to render. */
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
}

/* A credit sale has to name WHICH retailer. Selling on terms to a free-text
   name would create a debt owed by nobody — the receivable needs a customer row
   to hang off, and `Walk-In Customer` is not one.

   This is the reason the POS grew a retailer picker rather than the endpoint
   simply accepting net30: accepting the method without an account to bill would
   have turned a loud failure into a silent one. */
/* SENIOR CITIZEN / PWD. Validated here, applied in Tax::compute() once the
   lines are priced. A discount without the ID number and name is refused: the
   BIR requires both on the invoice. */
$scPwd = Tax::scPwdFrom($in, $fieldErrors);
if ($scPwd !== null && ($customerType === 'retailer' || $isCredit)) {
    /* The discount is for the senior's or PWD's own purchase. A retailer
       buying stock to resell is not that, whoever is standing at the counter. */
    $fieldErrors['sc_pwd'] = 'A senior citizen or PWD discount is for a personal purchase, not a retailer sale.';
    $scPwd = null;
}

$retailer = null;
/* The retailer account is REQUIRED for a credit sale and OPTIONAL for any
   other retailer sale. Optional, because naming it is what lets a withholding
   agent's tax be deducted on a cash, GCash or bank sale too — and what files
   the sale under their account instead of "Walk-In Customer". */
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
            /* Checked against the database, not against what the dropdown was
               populated with. The dropdown is not what sends the request. */
            $fieldErrors['retailer_id'] = 'That customer is not a retailer, so they cannot buy on terms.';
        }
    }
}

if ($fieldErrors !== []) {
    Response::validation('Check the highlighted fields.', $fieldErrors);
}

$pdo = Database::pdo();

try {
    $pdo->beginTransaction();

    /* Lock the product rows for the life of the transaction. Without this, two
       cashiers selling the last unit at the same moment both read stock = 1,
       both pass the check, and stock lands at -1. */
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

        /* The tax type AS IT IS NOW, copied onto the line — a product made
           exempt next month must not change this sale's invoice. */
        $lines[] = ['id' => $id, 'name' => $p['name'], 'qty' => $qty, 'price' => $unit,
                    'lineTotal' => $lineTotal, 'taxType' => $p['tax_type']];
    }

    /* The VAT breakdown, decided here and stored with the order (api/core/Tax.php).
       `total` is what the sale CHARGES — after any senior/PWD discount — and
       `amountDue` is what changes hands, after any tax a withholding retailer
       keeps. */
    $tax = Tax::compute(
        array_map(static fn(array $l): array => ['gross' => $l['lineTotal'], 'tax_type' => $l['taxType']], $lines),
        $scPwd,
        Tax::withholdingRateFor($retailer['id'] ?? null)
    );
    $total = $tax['total'];
    $due   = $tax['amountDue'];

    /* Now that the real amount due is known, the cash check can be made against
       it rather than against whatever the browser believed. */
    if ($data['pay_method'] === 'cash' && $tendered > 0 && $tendered < $due) {
        $pdo->rollBack();
        Response::validation('Not enough cash tendered.', [
            'tendered' => 'Tendered ₱' . number_format($tendered, 2) . ' but the amount due is ₱' . number_format($due, 2) . '.',
        ]);
    }
    $change = ($data['pay_method'] === 'cash' && $tendered >= $due) ? round($tendered - $due, 2) : 0.0;

    /* A pickup is handed over and paid on the spot; a delivery still has to go
       out, so it enters the fulfilment flow instead of being closed. */
    $status = $data['order_type'] === 'pickup' ? 'completed' : 'accepted';

    $orderId = 'EB-' . strtoupper(bin2hex(random_bytes(3))) . '-' . random_int(100, 999);

    /* One place decides what the payment columns mean (I8). This used to be
       `1` hardcoded for pay_verified and `$refNum !== null ? 1 : 0` written out
       here and again in shop/checkout.php.

       `atTill: true` — a cashier is present and has either taken the money or
       watched the transfer land, so an immediate method is verified on the
       spot. A credit method is not: Payments::orderFields returns
       pay_verified = 0 for it, because nothing has been paid. */
    $pay = Payments::orderFields($data['pay_method'], $refNum, null, $due, true);

    /* A credit sale is attributed to the retailer's customer row. Every other
       walk-in keeps customer_id NULL, which is correct — a walk-in has no
       account. Here there has to be one, or the receivable belongs to nobody. */
    $customerId = $retailer !== null ? $retailer['id'] : null;

    Database::run(
        'INSERT INTO orders (id, customer_id, customer_name, email, contact, address,
                             type, order_type, customer_type, method, total, date, datetime,
                             status, notes, pay_verified, proof_uploaded, proof_ref_num,
                             proof_image_path, proof_amount, cashier, batch_code_hint,
                             gross_total, vat_rate, less_vat, net_of_vat, sc_pwd_discount, vatable_sales,
                             vat_amount, vat_exempt_sales, sc_pwd_type, sc_pwd_id, sc_pwd_name,
                             withholding_rate, withholding_tax)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, CURDATE(), NOW(), ?, NULL, ?, ?, ?, ?, ?, ?, NULL,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        array_merge([
            $orderId, $customerId, $name, $contact, $address,
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
        /* One shared movement (see api/core/Stock.php). The FOR UPDATE above
           already makes this safe; the guard inside sell() means a bug here can
           never drive stock negative either way. */
        Stock::sell($l['id'], $l['qty']);
    }

    /* A credit sale opens a receivable, in THIS transaction alongside the order
       and the stock movement (I8). If either write fails, both roll back — a
       sale without its debt is money the business cannot see it is owed, and a
       debt without its sale is one nobody can explain.

       This is the write that did not exist. Every row in payment_accounts was
       seeded, and the only statement in the codebase that touched the table was
       `UPDATE ... SET paid = ?` — a balance could be settled and could never be
       raised. */
    $creditAccount = null;
    if ($isCredit) {
        $creditAccount = Payments::openCreditAccount($orderId, $retailer, $data['pay_method'], $total);
        Payments::recordWithholding($creditAccount['id'], $retailer['id'], $tax['withholdingTax'],
            (float) $tax['withholdingRate'], $user);
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'order',
         sprintf('POS sale %s — ₱%s (%s, %s). %d line(s), %d unit(s).%s',
             $orderId, number_format($total, 2), $data['pay_method'], $data['order_type'],
             count($lines), array_sum(array_column($lines, 'qty')),
             /* Say what the credit sale actually created. "POS sale, net30" does
                not tell a later reader that the business is now owed ₱570 by a
                named retailer, or when. */
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

/* Everything the receipt needs, computed here so the printed figures and the
   stored figures cannot disagree. */
Response::created([
    'id'          => $orderId,
    /* Stated rather than implied: the Sales Invoice leaves a walk-in's
       Business Address blank unless the sale is a delivery, and it needs to
       know which kind of order it is looking at. */
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
    /* The receipt prints the due date the DATABASE computed, not one the
       browser worked out from its own clock. buildReceipt() used to derive it
       with addDays(dAgo(0), 30) — which was correct only after dAgo() stopped
       being a frozen constant, and is still a second opinion about a date the
       server has already decided. */
    'creditAccount' => $creditAccount,
    'retailer'      => $retailer !== null ? ['id' => $retailer['id'], 'name' => $retailer['name']] : null,
]);
