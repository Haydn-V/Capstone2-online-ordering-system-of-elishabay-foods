<?php
declare(strict_types=1);

/** POST /api/categories/save.php (needs products.manage) creates a variety when id is missing and updates it otherwise. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('products.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('name', 'Variety name')
    ->maxLen('name', 100, 'Variety name')
    ->values();

$description = trim((string) ($in['description'] ?? '')) ?: null;

/* Variety names must be unique (excluding itself on update), since duplicates confuse filters and the storefront. */
$clash = Database::scalar(
    'SELECT COUNT(*) FROM categories WHERE name = ? AND id <> ?',
    [$data['name'], $in['id'] ?? '']
);
if ($clash) {
    Response::conflict('A variety with that name already exists.');
}

if ($isUpdate) {
    $existing = Database::one('SELECT id, name FROM categories WHERE id = ?', [$in['id']]);
    if ($existing === null) {
        Response::notFound('That variety does not exist.');
    }

    Database::run(
        'UPDATE categories SET name = ?, description = ? WHERE id = ?',
        [$data['name'], $description, $existing['id']]
    );

    $what = $existing['name'] !== $data['name']
        ? "renamed '{$existing['name']}' → '{$data['name']}'"
        : 'description updated';
    audit_cat($user, "Updated product variety: {$what} ({$existing['id']}).");
    $id = $existing['id'];
} else {
    /* Matches the seed convention: cat-db, cat-bg. */
    $slug = strtolower(preg_replace('/[^a-z]/i', '', $data['name']));
    $base = 'cat-' . (substr($slug, 0, 2) ?: 'xx');
    $id = $base;
    $n = 2;
    while (Database::scalar('SELECT COUNT(*) FROM categories WHERE id = ?', [$id])) {
        $id = $base . $n++;
    }

    Database::run(
        'INSERT INTO categories (id, name, description, archived) VALUES (?, ?, ?, 0)',
        [$id, $data['name'], $description]
    );
    audit_cat($user, "Added product variety: {$data['name']} ({$id}).");
}

$row = Database::one(
    'SELECT c.id, c.name, c.description, c.archived,
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.archived = 0) AS product_count
       FROM categories c WHERE c.id = ?',
    [$id]
);

Response::ok([
    'id'       => $row['id'],
    'name'     => $row['name'],
    'desc'     => $row['description'],
    'archived' => (bool) $row['archived'],
    'products' => (int) $row['product_count'],
], null, $isUpdate ? 200 : 201);


function audit_cat(array $user, string $description): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'product', $description]
    );
}
