<?php
declare(strict_types=1);

/** POST /api/shop/cart-save.php upserts one line of the signed-in customer's cart (qty 0 deletes it), per line so two tabs do not overwrite each other, and refuses any customer_id in the body. */

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

/* Safety ceiling only (the real limit is available stock, checked below), matching CART_MAX_QTY in site.js and the cart_items CHECK (migration 029). */
const CART_MAX_QTY = 9999;

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

/* The product must exist, be on sale and have enough stock. */
$p = Database::one(
    'SELECT p.id, p.name, ' . Stock::availableSql('p') . ' AS stock, p.archived FROM products p WHERE p.id = ?',
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
    /* Return the number of products in the cart (not units), matching cartLineCount() in site.js. */
    'count'     => (int) Database::scalar(
        'SELECT COUNT(*) FROM cart_items WHERE customer_id = ?',
        [$customerId]
    ),
]);
