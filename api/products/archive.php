<?php
declare(strict_types=1);

/**
 * POST /api/products/archive.php
 * Body: { "id": "db-masala", "archived": true }
 *
 * Requires products.manage OR inventory.manage.
 *
 * Two permissions, deliberately. The inventory.manage grant is labelled
 * "Restock, adjust & archive inventory" and Inventory Staff hold it — archiving
 * a line that is out of production is part of running stock, not a catalogue
 * privilege reserved for admins. Requiring products.manage alone meant the
 * Archive tab rendered for Inventory Staff and every button on it returned 403.
 *
 * This widens who may archive, and nothing else. Creating, pricing and editing
 * products still require products.manage in create.php and update.php, so an
 * Inventory Staff member can take a product off the shelf but cannot add one,
 * rename one, or change what it costs.
 *
 * Archive, never delete. Orders and batches reference products, and the schema
 * enforces that with ON DELETE RESTRICT — a deleted product would either break
 * order history or take it with it. Archiving hides the product from the shop
 * and from POS while leaving every past transaction intact and readable.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::requireAny('products.manage', 'inventory.manage');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which product?', ['id' => 'Product is required.']);
}
/* Explicit boolean — an absent flag must not be read as "unarchive". */
if (!array_key_exists('archived', $in)) {
    Response::badRequest('Specify whether to archive or restore.');
}
$archive = filter_var($in['archived'], FILTER_VALIDATE_BOOLEAN);

$product = Database::one('SELECT id, name, stock, archived FROM products WHERE id = ?', [$in['id']]);
if ($product === null) {
    Response::notFound('That product does not exist.');
}

if ((bool) $product['archived'] === $archive) {
    Response::conflict($archive
        ? 'That product is already archived.'
        : 'That product is not archived.');
}

Database::run('UPDATE products SET archived = ? WHERE id = ?', [$archive ? 1 : 0, $product['id']]);

/* Stock does not vanish when a product is archived, and pretending otherwise
   would misreport inventory value. Worth surfacing so it is a decision rather
   than a surprise. */
$note = ($archive && (int) $product['stock'] > 0)
    ? sprintf(' Note: %d units remain in stock and are still counted in inventory.', $product['stock'])
    : '';

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [
        $user['name'], $user['id'], 'product',
        sprintf('%s product: %s (%s).%s',
            $archive ? 'Archived' : 'Restored',
            $product['name'], $product['id'], $note),
    ]
);

Response::ok([
    'id'       => $product['id'],
    'archived' => $archive,
    'stock'    => (int) $product['stock'],
    'notice'   => trim($note) ?: null,
]);
