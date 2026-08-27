<?php
declare(strict_types=1);

/**
 * GET /api/shop/cart.php
 *
 * The signed-in customer's saved cart.
 *
 * WHY THIS EXISTS
 * ---------------
 * The storefront's cart was `cart: []` on a JavaScript object and nothing
 * else. It did not survive a reload, a sign-out, or opening the shop on a
 * different device — and #cart-badge rendering 0 was the honest answer, not a
 * display bug. The manuscript describes the cart as part of the customer's
 * account; db/migrations/007-persistent-cart.sql is the storage and this is
 * the read side.
 *
 * WHAT IT RETURNS, AND WHY IT IS NOT JUST THE ROWS
 * -----------------------------------------------
 * A cart can sit untouched for a week, and the catalogue does not sit still
 * for a week. Two things can have happened to a saved line by the time
 * somebody comes back for it:
 *
 *   - the product was archived, so it cannot be bought at all; or
 *   - stock fell below the saved quantity.
 *
 * Neither is a reason to hand the shopper a cart that will be refused at
 * checkout. api/shop/checkout.php already re-checks both and rejects the whole
 * order with "We only have N of X left" — correct, but the shopper meets it at
 * the last step, after filling in an address. Reconciling here means the
 * drawer they open is a cart that can actually be bought.
 *
 * The reconciliation is WRITTEN BACK, not merely applied to the response. A
 * response that quietly differs from the stored row would put it back on the
 * next load, and the shopper would fix the same line twice.
 *
 * `changes` reports what was done so the page can say so. Silently deleting
 * somebody's cart line is worse than the stale line was.
 *
 * Scoped to the session customer throughout. No id is read from the request —
 * there is no parameter that could carry one.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$customer = Auth::requireCustomer('Sign in to see your cart.');
$customerId = (string) $customer['id'];

/* Everything the drawer draws, in one query. The storefront's renderCart()
   looks each line up in its own PRODUCTS array, which is loaded from
   shop/products.php and therefore holds only unarchived rows — so a cart line
   whose product has since been archived would have found nothing there and
   thrown on `p.name`. Sending the product fields with the line removes that
   dependency entirely. */
$rows = Database::all(
    "SELECT ci.product_id, ci.qty, ci.updated_at,
            p.name, p.price, p.image_url, p.tint, p.stock, p.archived,
            c.name AS category
       FROM cart_items ci
       JOIN products p   ON p.id = ci.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE ci.customer_id = ?
      ORDER BY ci.updated_at ASC, p.name ASC",
    [$customerId]
);

/* Same coarse band shop/products.php sends. The exact stock count is
   deliberately not returned to a storefront caller — see that file's header —
   and it is not needed here either: a clamped line reports its new quantity,
   which is the only number the shopper has to know. */
$band = static function (int $stock): array {
    if ($stock <= 0)  return ['level' => 'out',  'label' => 'Out of Stock'];
    if ($stock <= 10) return ['level' => 'crit', 'label' => 'Only a few left'];
    if ($stock <= 100)return ['level' => 'warn', 'label' => 'Low stock'];
    return                   ['level' => 'ok',   'label' => 'In Stock'];
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
        'stockLevel' => $b['level'],
        'stockLabel' => $b['label'],
    ];
}

/* Written back so the next load agrees with this one. One transaction: a
   half-applied reconciliation is a cart nobody has seen a correct version of. */
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
    /* PRODUCTS, not units — the same definition cartLineCount() uses in
       assets/js/public/site.js. Two products at quantity 2 is 2, not 4. One
       definition on both sides, so the badge cannot show a different number
       depending on whether the cart came from here or from local state. */
    'count'   => count($items),
    'changes' => $changes,
]);
