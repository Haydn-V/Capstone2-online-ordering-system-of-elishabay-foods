<?php
declare(strict_types=1);

/**
 * POST /api/shop/cart-save.php
 *
 * Upsert ONE line of the signed-in customer's cart.
 *
 * Body: { "product_id": "bg-pesto", "qty": 3 }
 *
 * qty 0 deletes the row. That is the whole delete API — a separate
 * cart-remove.php would be a second endpoint with the same auth, the same
 * scoping and the same validation, differing only in which SQL verb it
 * reaches for, and the storefront already treats "none of this" as a quantity
 * (see the minus-at-one handler in assets/js/public/site.js).
 *
 * ONE LINE, NOT THE WHOLE CART. A "replace my cart with this array" endpoint
 * is the obvious alternative and is worse here: every add, every stepper
 * click and every removal would post the entire cart, so two tabs open on the
 * same account would each overwrite the other's work with whatever they last
 * saw. A per-line upsert means two tabs editing different products both land.
 *
 * INSERT … ON DUPLICATE KEY UPDATE rather than SELECT-then-branch. The primary
 * key is (customer_id, product_id), so the database decides whether this is an
 * insert or an update, atomically, and two requests racing on the same line
 * cannot both decide "insert".
 *
 * Scoped to the session customer. There is no customer_id in the body and one
 * sent anyway is refused rather than ignored — the same rule
 * api/shop/checkout.php applies, for the same reason: a caller that believes
 * it can name the account must be told it cannot.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');

$customer   = Auth::requireCustomer('Sign in to save your cart.');
$customerId = (string) $customer['id'];

$in = Response::input();

foreach (['customer_id', 'customerId'] as $forbidden) {
    if (array_key_exists($forbidden, $in)) {
        Response::validation('The signed-in account owns the cart.', [
            $forbidden => 'Remove this field — the cart belongs to the signed-in customer.',
        ]);
    }
}

/* CART_MAX_QTY in site.js is 99 and the CHECK constraint on cart_items is the
   same number. Three copies of one bound, which is two too many to leave
   undocumented: this is the one a request meets, the CHECK is the one a
   hand-written INSERT meets, and the client's is a courtesy that stops the
   request being made at all. */
const CART_MAX_QTY = 99;

$data = Validate::check($in)
    ->required('product_id', 'Product')
    ->maxLen('product_id', 50, 'Product')
    ->int('qty', 'Quantity', 0, CART_MAX_QTY)
    ->values();

$productId = (string) $data['product_id'];
$qty       = (int) $data['qty'];

if ($qty === 0) {
    Database::run(
        'DELETE FROM cart_items WHERE customer_id = ? AND product_id = ?',
        [$customerId, $productId]
    );
    Response::ok(['productId' => $productId, 'qty' => 0, 'removed' => true]);
}

/* The product has to exist, be sellable and have the stock. Checked here and
   not only at checkout: saving a line the shopper can never buy just moves the
   disappointment later, and api/shop/cart.php would strip it on the next load
   anyway — which would look like the cart losing things by itself. */
$p = Database::one(
    'SELECT id, name, stock, archived FROM products WHERE id = ?',
    [$productId]
);

if ($p === null || (int) $p['archived'] === 1) {
    Response::validation('That product is not available.', [
        'product_id' => 'This product is no longer sold.',
    ]);
}

$stock = (int) $p['stock'];
if ($stock <= 0) {
    Response::conflict(sprintf('%s is out of stock.', $p['name']));
}
if ($qty > $stock) {
    Response::conflict(sprintf('We only have %d of %s left.', $stock, $p['name']));
}

Database::run(
    'INSERT INTO cart_items (customer_id, product_id, qty)
          VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE qty = VALUES(qty), updated_at = CURRENT_TIMESTAMP',
    [$customerId, $productId, $qty]
);

Response::ok([
    'productId' => $productId,
    'qty'       => $qty,
    'removed'   => false,
    /* The running count, so the badge can be corrected from the server rather
       than recomputed from a client array that may have drifted. COUNT(*), not
       SUM(qty): the badge and the drawer label both count PRODUCTS, matching
       cartLineCount() in site.js and `count` in cart.php. */
    'count'     => (int) Database::scalar(
        'SELECT COUNT(*) FROM cart_items WHERE customer_id = ?',
        [$customerId]
    ),
]);
