<?php
declare(strict_types=1);

/**
 * GET /api/content/get.php
 *
 * PUBLIC — the storefront's About/Vision/Mission text, contact details, FAQs
 * and hero slides.
 *
 * This replaces the localStorage bridge: the admin's Landing Page module wrote
 * localStorage["eb-landing-content"] and the public page read it back, which
 * only ever worked inside one browser. An edit made by an administrator was
 * invisible to every actual visitor — the one audience it was for.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$content = [];
foreach (Database::all('SELECT key_name, value_text FROM site_content') as $row) {
    $content[$row['key_name']] = $row['value_text'];
}

$faqs = Database::all('SELECT question, answer FROM faqs ORDER BY display_order, id');
/* image_path, not image_data — renamed by migration 003. The column holds an
   application-root-relative path now; it held base64 before, and nothing ever
   wrote it, which is why the landing hero images never survived a logout. */
$hero = Database::all('SELECT title, image_path FROM hero_slides ORDER BY display_order, id');

/* Empty means "fall back to each product's own is_best flag", which is what the
   carousel already does. */
$featured = array_column(
    Database::all('SELECT product_id FROM featured_products ORDER BY display_order'),
    'product_id'
);

Response::ok([
    'about'   => $content['about']   ?? '',
    'vision'  => $content['vision']  ?? '',
    'mission' => $content['mission'] ?? '',
    'contact' => [
        'address'  => $content['contact_address']  ?? '',
        'phone'    => $content['contact_phone']    ?? '',
        'email'    => $content['contact_email']    ?? '',
        'facebook' => $content['contact_facebook'] ?? '',
    ],
    'faqs'     => array_map(static fn(array $f): array => ['q' => $f['question'], 'a' => $f['answer']], $faqs),
    /* Sent as `image`, matching every other endpoint that returns a picture.
       `img` is kept alongside it for one release because the storefront's hero
       accordion and the landing editor both read `img` today; imageUrl()
       accepts either, so the two can be retired independently rather than in
       one flag-day rename across three files. */
    'hero'     => array_map(static function (array $h): array {
        $path = $h['image_path'] ?? '';
        return ['title' => $h['title'], 'image' => $path, 'img' => $path];
    }, $hero),
    'featured' => $featured,
]);
