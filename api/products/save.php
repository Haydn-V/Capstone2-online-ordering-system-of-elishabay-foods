<?php
declare(strict_types=1);

/** POST /api/products/save.php (needs products.manage) creates or updates a product, where image is an uploaded path (omit = keep, path = set, null/"" = remove) and stock, sold and rating are never accepted here. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('products.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('name', 'Product name')
    ->maxLen('name', 150, 'Product name')
    ->required('category_id', 'Category')
    ->decimal('price', 'Price', 0)
    ->values();

/* Check the category exists, since the dropdown is not what sends the request. */
$category = Database::one('SELECT id, name FROM categories WHERE id = ?', [$data['category_id']]);
if ($category === null) {
    Response::validation('Check the highlighted fields.', ['category_id' => 'That category does not exist.']);
}

$description = trim((string) ($in['description'] ?? '')) ?: null;
$tint        = trim((string) ($in['tint'] ?? '')) ?: null;
$isBest      = !empty($in['is_best']) ? 1 : 0;

/* A hex colour or nothing, since it ends up in a style attribute. */
if ($tint !== null && !preg_match('/^#[0-9a-fA-F]{3,8}$/', $tint)) {
    Response::validation('Check the highlighted fields.', ['tint' => 'Use a hex colour such as #3f8f4f.']);
}

/* Net weight (grams) and nutrition facts per serving are optional (NULL if blank), with nutrition limited to a fixed list of keys. */
$weightRaw = trim((string) ($in['net_weight_g'] ?? ''));
$netWeight = null;
if ($weightRaw !== '') {
    if (!ctype_digit($weightRaw) || (int) $weightRaw < 1 || (int) $weightRaw > 100000) {
        Response::validation('Check the highlighted fields.', ['net_weight_g' => 'Enter the weight in whole grams (1–100000).']);
    }
    $netWeight = (int) $weightRaw;
}

$nutrition = null;
if (is_array($in['nutrition'] ?? null)) {
    $clean = [];
    foreach (['serving_size', 'servings', 'calories', 'fat', 'sat_fat', 'cholesterol',
              'sodium', 'carbs', 'sugar', 'protein'] as $k) {
        $v = trim((string) ($in['nutrition'][$k] ?? ''));
        if ($v === '') continue;
        if ($k === 'serving_size') { $clean[$k] = mb_substr($v, 0, 40); continue; }
        if (!is_numeric($v) || (float) $v < 0) {
            Response::validation('Check the highlighted fields.', ['nutrition' => 'Nutrition values must be numbers of 0 or more.']);
        }
        $clean[$k] = (float) $v;
    }
    $nutrition = $clean ? json_encode($clean, JSON_UNESCAPED_UNICODE) : null;
}

/* image must be a path produced by api/uploads/image.php; data URLs and any other value are refused to block path tricks and XSS. */
/* Use array_key_exists so a missing image key (keep) is different from null (remove). */
$imageProvided = array_key_exists('image', $in);
$image = $imageProvided ? $in['image'] : null;
if ($image !== null && $image !== '') {
    $image = trim((string) $image);

    if (str_starts_with($image, 'data:')) {
        Response::validation('Check the highlighted fields.', [
            'image' => 'Upload the image first — this field now takes a path from api/uploads/image.php, not the file itself.',
        ]);
    }

    /* Only /uploads/products/<32 hex>.webp is accepted, anchored so no path traversal is possible. */
    if (!preg_match('#^/uploads/products/[a-f0-9]{32}\.webp$#', $image)) {
        Response::validation('Check the highlighted fields.', [
            'image' => 'That is not a valid uploaded image path.',
        ]);
    }

    /* The image file must exist on disk. */
    if (!is_file(dirname(__DIR__, 2) . $image)) {
        Response::validation('Check the highlighted fields.', [
            'image' => 'That upload is no longer on the server. Upload the image again.',
        ]);
    }
} else {
    $image = null;
}

if ($isUpdate) {
    $existing = Database::one('SELECT id, name, price, image_url FROM products WHERE id = ?', [$in['id']]);
    if ($existing === null) {
        Response::notFound('That product does not exist.');
    }

    /* Image rule: key absent keeps the stored photo, a valid path stores it, null or "" removes it (the old file is cleaned up by tools/prune-uploads.php). */
    $newImage = $imageProvided ? $image : $existing['image_url'];

    Database::run(
        'UPDATE products
            SET name = ?, category_id = ?, price = ?, description = ?,
                tint = ?, is_best = ?, image_url = ?
          WHERE id = ?',
        [$data['name'], $data['category_id'], $data['price'], $description,
         $tint, $isBest, $newImage, $existing['id']]
    );

    /* Audit line says exactly what changed (e.g. the price). */
    $changes = [];
    if ($existing['name'] !== $data['name']) {
        $changes[] = "name '{$existing['name']}' → '{$data['name']}'";
    }
    if ((float) $existing['price'] !== (float) $data['price']) {
        $changes[] = 'price ₱' . number_format((float) $existing['price'], 2) .
                     ' → ₱' . number_format((float) $data['price'], 2);
    }
    /* Log photo removal separately from replacement. */
    if (($existing['image_url'] ?? null) !== $newImage) {
        $changes[] = $newImage === null
            ? 'image removed'
            : (($existing['image_url'] ?? null) === null ? 'image set' : 'image replaced');
    }

    audit($user, 'product', sprintf(
        'Updated product %s (%s). %s',
        $data['name'], $existing['id'],
        $changes ? implode('; ', $changes) : 'No field values changed.'
    ));

    $id = $existing['id'];
} else {
    /* Create a readable id from the name, like the seed data (db-pesto). */
    $id = makeProductId($data['name'], $category['id']);

    Database::run(
        'INSERT INTO products (id, category_id, name, description, price, stock,
                               rating, sold, is_best, tint, image_url, archived)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0)',
        [$id, $data['category_id'], $data['name'], $description, $data['price'],
         $isBest, $tint, $image]
    );

    audit($user, 'product', sprintf(
        'Added product: %s (%s) at ₱%s in %s. Opening stock 0 — use Inventory Management to stock it.',
        $data['name'], $id, number_format($data['price'], 2), $category['name']
    ));
}

/* Saved separately so the endpoint still works before migration 020. */
$hasLabel = Database::hasColumn('products', 'nutrition');
if (!$hasLabel && ($netWeight !== null || $nutrition !== null)) {
    /* Say so rather than save the rest and drop these without a word. */
    Response::error('MIGRATION_NEEDED',
        'Product saved, but net weight and nutrition could not be stored: the database is missing '
        . 'migration 020 (db/migrations/020-product-weight-nutrition.sql). Run it in phpMyAdmin, then save again.', 409);
}
if ($hasLabel) {
    Database::run('UPDATE products SET net_weight_g = ?, nutrition = ? WHERE id = ?',
                  [$netWeight, $nutrition, $id]);
}

$row = Database::one(
    'SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.sold,
            p.is_best, p.tint, p.image_url, p.archived, c.id AS category_id, c.name AS category'
          . ($hasLabel ? ', p.net_weight_g, p.nutrition' : '') . '
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = ?',
    [$id]
);

Response::ok([
    'id'         => $row['id'],
    'name'       => $row['name'],
    'desc'       => $row['description'],
    'price'      => (float) $row['price'],
    'stock'      => (int) $row['stock'],
    'rating'     => (float) $row['rating'],
    'sold'       => (int) $row['sold'],
    'best'       => (bool) $row['is_best'],
    'tint'       => $row['tint'],
    'image'      => $row['image_url'],
    'archived'   => (bool) $row['archived'],
    'weightG'    => isset($row['net_weight_g']) ? (int) $row['net_weight_g'] : null,
    'nutrition'  => !empty($row['nutrition']) ? json_decode($row['nutrition'], true) : null,
    'categoryId' => $row['category_id'],
    'cat'        => $row['category'],
], null, $isUpdate ? 200 : 201);


/** Slug from the category prefix and product name, uniquified on collision. */
function makeProductId(string $name, string $categoryId): string
{
    $prefix = str_replace('cat-', '', $categoryId);
    $slug = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', $name), '-'));
    $slug = substr($slug, 0, 30) ?: 'item';
    $base = $prefix . '-' . $slug;

    $id = $base;
    $n  = 2;
    while (Database::scalar('SELECT COUNT(*) FROM products WHERE id = ?', [$id])) {
        $id = $base . '-' . $n++;
    }
    return $id;
}

/** Audit rows are written by the server, on every write, without exception. */
function audit(array $user, string $type, string $description): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], $type, $description]
    );
}
