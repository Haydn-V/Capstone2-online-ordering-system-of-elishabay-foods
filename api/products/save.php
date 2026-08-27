<?php
declare(strict_types=1);

/**
 * POST /api/products/save.php
 *
 * Creates when `id` is absent, updates when present. One endpoint because the
 * validation, permission and audit rules are identical — two files would be
 * two places to forget a rule.
 *
 * Body: { "id": "db-pesto" (omit to create), "name": "...", "category_id": "cat-db",
 *         "price": 285, "description": "...", "tint": "#3f8f4f",
 *         "is_best": false, "image": "/uploads/products/<32 hex>.webp" | null }
 *
 * `image` is a path returned by api/uploads/image.php, not an image. Posting a
 * data URL here is refused with a message saying so — see the note by the
 * validation below.
 *
 * On update, `image` is read three ways: omit the key to keep the stored photo,
 * send a path to store it, send null or "" to REMOVE it. The removed file stays
 * on disk — tools/prune-uploads.php collects it.
 *
 * Requires products.manage.
 *
 * Note what is NOT accepted here: `stock`, `sold` and `rating`. Stock moves
 * only through inventory/adjust.php, which records why and writes an audit
 * row; letting the product form set it directly would be a way to change stock
 * with no trace. `sold` and `rating` are derived from orders and reviews.
 */

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

/* The category must exist. A form dropdown "guarantees" this, which is exactly
   why it has to be checked — the dropdown is not what sends the request. */
$category = Database::one('SELECT id, name FROM categories WHERE id = ?', [$data['category_id']]);
if ($category === null) {
    Response::validation('Check the highlighted fields.', ['category_id' => 'That category does not exist.']);
}

$description = trim((string) ($in['description'] ?? '')) ?: null;
$tint        = trim((string) ($in['tint'] ?? '')) ?: null;
$isBest      = !empty($in['is_best']) ? 1 : 0;

/* A hex colour or nothing. Anything else lands in a style attribute later. */
if ($tint !== null && !preg_match('/^#[0-9a-fA-F]{3,8}$/', $tint)) {
    Response::validation('Check the highlighted fields.', ['tint' => 'Use a hex colour such as #3f8f4f.']);
}

/* `image` is now a PATH, not the image.
   ---------------------------------------------------------------------------
   It used to be a base64 data URL: the client posted the whole file inside this
   JSON body and it went into image_url as LONGTEXT. Three rows held 1.81MB
   between them and every public storefront request carried all of it.

   The file is uploaded first, to api/uploads/image.php, which validates the
   real MIME, re-encodes through GD and returns a path. This endpoint stores
   that path and never sees image bytes at all — which is why the validation
   here is a shape check rather than an image check. The endpoint that has the
   bytes is the endpoint that judges them.

   Only a path this server produced is accepted. Without that constraint the
   column would take `/../../api/config/config.php` or an off-site URL and hand
   it to every page that renders a product image, and a stored `javascript:`
   or `data:text/html` value would be an XSS delivered by the catalogue.

   A data URL is now REFUSED rather than quietly stored, with a message that
   says what to do. Silently accepting the old shape into a VARCHAR(255) would
   truncate it to 255 characters of base64 — a corrupt value that looks like
   data and renders as nothing. */
/* ABSENT and NULL are different requests, and `?? null` could not tell them
   apart — which is why there was no request an administrator could make that
   cleared a photo. array_key_exists() draws the line the three-way rule below
   needs. */
$imageProvided = array_key_exists('image', $in);
$image = $imageProvided ? $in['image'] : null;
if ($image !== null && $image !== '') {
    $image = trim((string) $image);

    if (str_starts_with($image, 'data:')) {
        Response::validation('Check the highlighted fields.', [
            'image' => 'Upload the image first — this field now takes a path from api/uploads/image.php, not the file itself.',
        ]);
    }

    /* /uploads/products/<32 hex>.webp is the only shape this server writes.
       Anchored at both ends, with no path separators inside the name, so
       traversal has nowhere to live. */
    if (!preg_match('#^/uploads/products/[a-f0-9]{32}\.webp$#', $image)) {
        Response::validation('Check the highlighted fields.', [
            'image' => 'That is not a valid uploaded image path.',
        ]);
    }

    /* The path must name a file that exists. A row pointing at nothing renders
       as the placeholder and looks to an administrator exactly like the bug
       this whole exercise is about. */
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

    /* THREE-WAY RULE on `image`, not two.
       -----------------------------------------------------------------------
       This used to read `$image ?? $existing['image_url']` under a comment
       saying the edit form only sends an image when a new one was chosen. That
       client no longer exists — engine.js sends the field on every save, and
       re-sends the product's existing path when nothing was touched. The effect
       was that "keep the current one" was the ONLY reachable outcome: no
       request could clear image_url, so a wrong photo could be replaced but
       never removed.

           field absent          → keep whatever is stored (any other caller,
                                   and anything that posts a partial body)
           field = a valid path  → store it (validated above)
           field = null or ""    → store NULL, i.e. remove the photo

       The file the cleared path named is NOT unlinked here — see the orphaned
       uploads note in docs/API.md and tools/prune-uploads.php. */
    $newImage = $imageProvided ? $image : $existing['image_url'];

    Database::run(
        'UPDATE products
            SET name = ?, category_id = ?, price = ?, description = ?,
                tint = ?, is_best = ?, image_url = ?
          WHERE id = ?',
        [$data['name'], $data['category_id'], $data['price'], $description,
         $tint, $isBest, $newImage, $existing['id']]
    );

    /* Say what actually changed. "Updated product X" tells a later reader
       nothing about whether the price moved. */
    $changes = [];
    if ($existing['name'] !== $data['name']) {
        $changes[] = "name '{$existing['name']}' → '{$data['name']}'";
    }
    if ((float) $existing['price'] !== (float) $data['price']) {
        $changes[] = 'price ₱' . number_format((float) $existing['price'], 2) .
                     ' → ₱' . number_format((float) $data['price'], 2);
    }
    /* Removal is a distinct act from replacement and reads as one in the log —
       "image replaced" on a row that now has no photo would send a later reader
       looking for a file that was never stored. */
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
    /* Readable, stable id derived from the name, in the style the seed data
       uses (db-pesto, bg-adobo) rather than an opaque timestamp. */
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

$row = Database::one(
    'SELECT p.id, p.name, p.description, p.price, p.stock, p.rating, p.sold,
            p.is_best, p.tint, p.image_url, p.archived, c.id AS category_id, c.name AS category
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
