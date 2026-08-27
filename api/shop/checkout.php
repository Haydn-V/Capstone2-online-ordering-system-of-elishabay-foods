<?php
declare(strict_types=1);

/**
 * POST /api/shop/checkout.php
 *
 * PUBLIC — a shopper places an order without an account.
 *
 * THIS IS THE FLOW THAT DID NOT EXIST.
 *
 * The storefront's checkout validated the form, rendered a receipt and threw
 * the order away. A customer saw "Order Placed!", and nothing ever reached the
 * staff portal — no queue entry, no payment to verify, no record at all. This
 * endpoint is the missing half.
 *
 * Body: {
 *   "items": [ { "id": "bg-pesto", "qty": 2 }, … ],
 *   "name", "contact", "email?", "address?", "notes?",
 *   "order_type": "pickup" | "delivery",
 *   "pay_method": "cash" | "gcash" | "bank",
 *   "ref_num": "..."   // gcash / bank
 * }
 *
 * DIFFERENCES FROM pos/checkout.php, all deliberate:
 *
 *   - The order lands as `pending` with pay_verified = 0. A walk-in sale is
 *     money in the drawer; an online order is a claim that has to be checked
 *     by a human before anything ships.
 *   - Stock is NOT decremented here. It moves when staff accept the order (see
 *     orders/status.php). An unverified stranger must not be able to zero the
 *     inventory by placing orders nobody accepts.
 *   - Availability IS checked, so a shopper is told immediately rather than
 *     after a staff member has to chase them.
 */

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

/* ---- who is buying ----------------------------------------------------
   D6: checkout requires a signed-in customer. There is no guest checkout.

   This used to accept anyone and file the order against whichever customer row
   matched the posted email, which meant a stranger could write an order into
   someone else's history — inflating their spend and appearing in their My
   Orders list. Scoping attribution to the session closed the write; requiring
   the session closes the hole, rather than guarding it.

   The rest of the system already assumes accounts: My Orders, lifetime spend,
   retailer tiers and B2B applications are all keyed to a customer row. A guest
   order was a row those features could never see.

   Checked before validation so an unauthenticated caller learns nothing about
   which fields exist. */
$buyer = Auth::requireCustomer('Sign in to place your order.');

/* Auth::customer() SELECTs the customers row on every request — it is not a
   cached copy of what the session said at sign-in — so this is a live read of
   the account's current standing, which is exactly what a credit decision
   needs. Named here because it is used three times below. */
$isRetailer = ($buyer['status'] ?? null) === 'retailer';

/* An identity in the body is refused, not ignored. Silently overriding it
   would leave a caller believing they had set the buyer. */
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
    /* Credit terms are offered to a retailer and to nobody else.
       ------------------------------------------------------------------
       This passed `false` unconditionally, with a comment saying "the
       storefront has no retailer selection and no cashier to authorise terms".
       The first half of that stopped being true: D6 made checkout require a
       customer session, so the storefront now knows exactly who is buying and
       whether their account is a retail partnership.

       The second half was never the point. A Net-30 order is not authorised by
       a cashier at the POS either — it is authorised by the partnership, which
       staff granted through b2b/decide.php after reviewing the business. The
       cashier only types it in.

       $isRetailer is re-derived from the DATABASE, inside this request.
       Auth::customer() re-reads the customers row every request rather than
       trusting anything cached, so a partnership ended five minutes ago is not
       a partnership here. Nothing about the client's opinion is consulted: the
       storefront renders the Net tiles from state.auth.status, which is
       presentation, and this line is the enforcement. A regular customer who
       hand-crafts `pay_method: "net30"` gets a validation failure naming the
       methods they may actually use.

       Taken from Payments::methods() rather than written out here, which is how
       the POS list and the storefront list came to disagree in the first
       place. */
    ->in('pay_method', Payments::methods($isRetailer), 'Payment method')
    ->values();

/* Always the session's address. Never read from the request. */
$email   = (string) $buyer['email'];
$address = trim((string) ($in['address'] ?? '')) ?: null;
$refNum  = trim((string) ($in['ref_num'] ?? '')) ?: null;
$notes   = trim((string) ($in['notes'] ?? '')) ?: null;

/* The payment reference image, as a path from api/uploads/image.php. The
   checkout "upload" used to be a div that set a boolean and printed
   "✓ payment-proof.jpg attached (mock)" — no file input existed anywhere on the
   storefront, and there was no column to put one in.

   Validated the same way products/save.php validates its path: exact shape,
   and the file must exist. A shopper-supplied string reaches this, so it is
   never trusted to be what it claims. */
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
if ($data['order_type'] === 'delivery' && $address === null) {
    $fieldErrors['address'] = 'A delivery address is required.';
}
/* Only the transfer methods carry a reference. A credit order has nothing to
   reference yet — nothing has been paid — and Payments::orderFields() already
   returns null for both proof columns and 0 for proof_amount when the method is
   credit, so a reference number sent anyway is dropped rather than stored
   against a debt that has not been settled. The list is spelled out rather than
   written as `!== 'cash'` precisely so that adding net30 to the offered methods
   could not silently start demanding a screenshot for it. */
if (in_array($data['pay_method'], ['gcash', 'bank'], true) && $refNum === null) {
    $fieldErrors['ref_num'] = 'Enter the reference number of your payment.';
}
if ($fieldErrors !== []) {
    Response::validation('Please check the highlighted fields.', $fieldErrors);
}

$pdo = Database::pdo();

try {
    $pdo->beginTransaction();

    $ids = array_keys($wanted);
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    $products = Database::all(
        "SELECT id, name, price, stock, archived FROM products WHERE id IN ($ph)",
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

        /* Priced from the database. The storefront's own JS knows a price, but
           that copy is editable by anyone with a console open. */
        $unit = (float) $p['price'];
        $lineTotal = round($unit * $qty, 2);
        $total += $lineTotal;
        $lines[] = ['id' => $id, 'name' => $p['name'], 'qty' => $qty, 'price' => $unit, 'lineTotal' => $lineTotal];
    }
    $total = round($total, 2);

    /* Who this order belongs to.

       The signed-in customer decides it, and nothing else does. This used to
       read the posted email and file the order under whichever customer row
       matched — which meant anyone could post a checkout carrying somebody
       else's address and write an order into that person's history, inflating
       their spend and appearing in their My Orders list. No password, no
       session, no account of their own required.

       Guest checkout no longer exists (D6), so customer_id is never NULL on a
       storefront order. Registering with an address that already has orders
       still claims that customer row, so history from before this change
       follows the account. */
    /* Always set: the endpoint refused the request otherwise. */
    $customerId = $buyer['id'];

    /* ---- Credit is refused while an earlier one is overdue -------------
       A DECISION, recorded because it is a business rule and not an obvious
       one: a retailer with an unpaid account past its due date cannot open a
       second credit line. They can still buy — on cash, GCash or bank
       transfer — so this refuses the terms, not the order.

       The alternative is an unbounded credit line, which nobody asked for.
       Juris Bay's partnership grants terms; it does not grant a limit, and
       with no limit in the schema the only bound available is "settle the last
       one first". That is a stricter rule than a credit ceiling and a much
       simpler one to explain at the counter, which is where it will be argued
       about.

       The amount and the date are named. "You have an overdue balance" sends
       the retailer to a screen to find out which; naming it lets them act.
       Penalty included via accountStanding(), because the figure that quietly
       excludes it is the one that causes the argument.

       Inside the transaction, so the check and the INSERT that follows read the
       same snapshot. Rolled back explicitly first — Response::conflict() ends
       the request, and an open transaction at that point would be abandoned
       rather than closed. Same shape as the stock conflicts above. */
    if (Payments::isCredit($data['pay_method'])) {
        $overdue = Database::all(
            'SELECT balance, due_date, DATEDIFF(CURDATE(), due_date) AS days_past_due
               FROM payment_accounts
              WHERE customer_id = ? AND paid = 0 AND due_date < CURDATE()
              ORDER BY due_date ASC',
            [$customerId]
        );
        if ($overdue !== []) {
            $rate  = Payments::penaltyRate();
            $owed  = 0.0;
            foreach ($overdue as $o) {
                $standing = Payments::accountStanding(
                    (float) $o['balance'], (int) $o['days_past_due'], false, $rate
                );
                $owed += $standing['totalDue'];
            }
            $oldest = $overdue[0]['due_date'];
            $pdo->rollBack();
            Response::conflict(sprintf(
                'You have %s overdue on your account (due %s). Settle it to use credit terms again — '
                . 'you can still place this order on cash, GCash or bank transfer.',
                '₱' . number_format($owed, 2),
                date('j M Y', strtotime((string) $oldest))
            ));
        }
    }

    $orderId = 'ORD-' . date('Ymd') . '-' . strtoupper(bin2hex(random_bytes(3)));

    /* Same shared decision as the POS (I8). `atTill: false` — nobody watched
       this payment happen, so a GCash or bank order arrives unverified no
       matter what the shopper typed, and staff verify it from the reference
       number and the uploaded image.

       This line and its counterpart in pos/checkout.php were the same
       copy-pasted expression, `$refNum !== null ? 1 : 0`, in two files. */
    $pay = Payments::orderFields($data['pay_method'], $refNum, $proofPath, $total, false);

    Database::run(
        'INSERT INTO orders (id, customer_id, customer_name, email, contact, address,
                             type, order_type, customer_type, method, total, date, datetime,
                             status, notes, pay_verified, proof_uploaded, proof_ref_num,
                             proof_image_path, proof_amount, cashier, batch_code_hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), NOW(), ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
        [
            $orderId, $customerId, $data['name'], $email ?: null, $data['contact'], $address,
            'online', $data['order_type'], 'regular', $data['pay_method'], $total,
            'pending', $notes,
            $pay['pay_verified'], $pay['proof_uploaded'], $pay['proof_ref_num'],
            $pay['proof_image_path'], $pay['proof_amount'],
        ]
    );

    foreach ($lines as $l) {
        Database::run(
            'INSERT INTO order_items (order_id, product_id, qty, price_at_purchase) VALUES (?, ?, ?, ?)',
            [$orderId, $l['id'], $l['qty'], $l['price']]
        );
    }

    /* The receivable, in the SAME transaction as the order (decision I8).

       Payments::openCreditAccount() says it must be, and the reason is worth
       repeating where it is called: a sale recorded without its receivable is
       money the business cannot see it is owed, and a receivable without its
       sale is a debt nobody can explain. Either half alone is worse than
       neither, so they commit together or not at all.

       The due date is computed by the database with DATE_ADD(CURDATE(), …),
       not in PHP and certainly not in the browser (D1). */
    $credit = null;
    if (Payments::isCredit($data['pay_method'])) {
        $credit = Payments::openCreditAccount($orderId, $buyer, $data['pay_method'], $total);
    }

    /* Notify the staff. The Order Queue reads the orders table directly, but a
       notification row is what makes the bell light up without a refresh. */
    Database::run(
        'INSERT INTO notifications (id, type, order_id, message, created_at, is_read)
         VALUES (?, ?, ?, ?, NOW(), 0)',
        ['n-' . strtolower(bin2hex(random_bytes(5))), 'new-order', $orderId,
         sprintf('New online order from %s — ₱%s', $data['name'], number_format($total, 2))]
    );

    /* Actor is the customer, not a staff member, so actor_user_id stays NULL. */
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, NULL, ?, ?)',
        [$data['name'], 'order',
         sprintf('Online order %s placed via storefront — ₱%s (%s, %s), %d line(s).%s',
             $orderId, number_format($total, 2), $data['pay_method'], $data['order_type'], count($lines),
             /* A credit sale is the one an auditor will come looking for, so
                the receivable it opened is named in the same line rather than
                left to be joined up from payment_accounts by timestamp. */
             $credit !== null
                 ? sprintf(' Credit account %s opened on %s terms, due %s.',
                     $credit['id'], $credit['scheme'], $credit['dueDate'])
                 : '')]
    );

    /* The cart is emptied HERE, inside the same transaction that wrote the
       order — not by the browser afterwards.

       site.js used to do `state.cart = []` inline once the response came back,
       which was the only thing emptying anything because the cart lived in
       memory. Now that it lives in cart_items (migration 007), where the
       delete happens decides what a failure costs. Deleting from the client
       means a checkout that fails after the order is written leaves a cart the
       shopper has already paid attention to; deleting in a second request
       after the commit means a dropped connection empties nothing or empties
       everything, at random. Inside the transaction, an order that does not
       commit does not touch the cart at all.

       Scoped to $customerId, which is the session's — never the request's. */
    Database::run('DELETE FROM cart_items WHERE customer_id = ?', [$customerId]);

    $pdo->commit();

    /* The proof is now attached to an order, so it stops being discardable.
       api/uploads/discard.php deletes screenshots the shopper removed before
       checking out, and it authorises on the list of paths this session was
       issued. Leaving a used path on that list would let a customer place an
       order and then delete the payment evidence staff have to verify. */
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
    'placedAt'  => date('Y-m-d H:i'),
    /* Null for an immediate sale. For a credit sale: the account id, the scheme
       as payment_accounts stores it, the balance and the due date the DATABASE
       computed — so the receipt prints the same date the retailer's Payment
       Schemes page and the cashier's screen will show, rather than one the
       browser worked out from its own clock. */
    'credit'    => $credit,
    'message'   => $credit !== null
        ? sprintf('Your order has been received on %s terms. The balance is due %s.',
            $credit['scheme'], date('j M Y', strtotime((string) $credit['dueDate'])))
        : 'Your order has been received. Our team will verify your payment and contact you shortly.',
]);
