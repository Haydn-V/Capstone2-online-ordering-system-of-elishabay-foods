<?php
declare(strict_types=1);

/** POST /api/products/archive.php (needs products.manage or inventory.manage) hides a product from the shop and POS without deleting it, keeping all past orders intact. */

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

/* Warn that archiving does not remove the product's remaining stock. */
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
