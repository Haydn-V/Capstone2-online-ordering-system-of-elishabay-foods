<?php
declare(strict_types=1);

/** GET /api/shop/cart.php returns the signed-in customer's saved cart, removing archived products and lowering quantities above stock, saving those fixes and reporting them in changes. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$customer = Auth::requireCustomer('Sign in to see your cart.');
$customerId = (string) $customer['id'];

/* Return all product fields with each line so the drawer does not depend on the storefront's product list. */
$rows = Database::all(
    "SELECT ci.product_id, ci.qty, ci.updated_at,
            p.name, p.price, p.image_url, p.tint, " . Stock::availableSql('p') . " AS stock, p.archived,
            c.name AS category
       FROM cart_items ci
       JOIN products p   ON p.id = ci.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE ci.customer_id = ?
      ORDER BY ci.updated_at ASC, p.name ASC",
    [$customerId]
);

/* Stock band only (wording from Inventory::shopLabel()); these simple thresholds differ from Inventory's full rule but only affect the pill colour. */
$band = static function (int $stock): array {
    if ($stock <= 0)  return ['level' => 'out'];
    if ($stock <= 10) return ['level' => 'crit'];
    if ($stock <= 100)return ['level' => 'warn'];
    return                   ['level' => 'ok'];
};

$items   = [];
$changes = [];
$drop    = [];
$clamp   = [];

foreach ($rows as $r) {
    $stock = (int) $r['stock'];

    if ((int) $r['archived'] === 1 || $stock <= 0) {
        $drop[] = $r['product_id'];
        $changes[] = [
            'productId' => $r['product_id'],
            'name'      => $r['name'],
            'action'    => 'removed',
            'reason'    => (int) $r['archived'] === 1
                ? 'is no longer available'
                : 'is out of stock',
        ];
        continue;
    }

    $qty = (int) $r['qty'];
    if ($qty > $stock) {
        $clamp[$r['product_id']] = $stock;
        $changes[] = [
            'productId' => $r['product_id'],
            'name'      => $r['name'],
            'action'    => 'clamped',
            'qty'       => $stock,
            'reason'    => 'stock has fallen since you added it',
        ];
        $qty = $stock;
    }

    $b = $band($stock);
    $items[] = [
        'id'         => $r['product_id'],
        'qty'        => $qty,
        'name'       => $r['name'],
        'price'      => (float) $r['price'],
        'image'      => $r['image_url'],
        'tint'       => $r['tint'],
        'cat'        => $r['category'],
        'inStock'    => true,
        /* Include stock so the drawer's stepper can cap at what is available. */
        'stock'      => $stock,
        'stockLevel' => $b['level'],
        'stockLabel' => Inventory::shopLabel($b['level'], $stock),
    ];
}

/* Save the fixes in one transaction so the next load matches. */
if ($drop !== [] || $clamp !== []) {
    $pdo = Database::pdo();
    try {
        $pdo->beginTransaction();

        if ($drop !== []) {
            $ph = implode(',', array_fill(0, count($drop), '?'));
            Database::run(
                "DELETE FROM cart_items WHERE customer_id = ? AND product_id IN ($ph)",
                array_merge([$customerId], $drop)
            );
        }
        foreach ($clamp as $pid => $qty) {
            Database::run(
                'UPDATE cart_items SET qty = ? WHERE customer_id = ? AND product_id = ?',
                [$qty, $customerId, $pid]
            );
        }

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        throw $e;
    }
}

Response::ok([
    'items'   => $items,
    /* Count products, not units, matching cartLineCount() in site.js. */
    'count'   => count($items),
    'changes' => $changes,
]);
