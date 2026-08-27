<?php
declare(strict_types=1);

/**
 * POST /api/categories/archive.php
 * Body: { "id": "cat-bg", "archived": true }
 *
 * Requires products.manage.
 *
 * Refuses to archive a variety that still has active products in it. The
 * schema's ON DELETE RESTRICT on products.category_id prevents deletion, but
 * archiving is not deletion and would otherwise leave products filed under a
 * variety that no longer appears in any filter — visible in some screens,
 * missing from others, for no reason the operator can see.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('products.manage');

$in = Response::input();

if (empty($in['id'])) {
    Response::validation('Which variety?', ['id' => 'Variety is required.']);
}
if (!array_key_exists('archived', $in)) {
    Response::badRequest('Specify whether to archive or restore.');
}
$archive = filter_var($in['archived'], FILTER_VALIDATE_BOOLEAN);

$cat = Database::one('SELECT id, name, archived FROM categories WHERE id = ?', [$in['id']]);
if ($cat === null) {
    Response::notFound('That variety does not exist.');
}
if ((bool) $cat['archived'] === $archive) {
    Response::conflict($archive ? 'Already archived.' : 'Not archived.');
}

if ($archive) {
    $active = (int) Database::scalar(
        'SELECT COUNT(*) FROM products WHERE category_id = ? AND archived = 0',
        [$cat['id']]
    );
    if ($active > 0) {
        Response::conflict(sprintf(
            'Cannot archive "%s" — %d active product%s still use%s it. Archive or move them first.',
            $cat['name'], $active, $active === 1 ? '' : 's', $active === 1 ? 's' : ''
        ));
    }
}

Database::run('UPDATE categories SET archived = ? WHERE id = ?', [$archive ? 1 : 0, $cat['id']]);

Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
     VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'product',
     sprintf('%s product variety: %s (%s).', $archive ? 'Archived' : 'Restored', $cat['name'], $cat['id'])]
);

Response::ok(['id' => $cat['id'], 'archived' => $archive]);
