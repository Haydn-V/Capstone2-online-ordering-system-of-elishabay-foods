<?php
declare(strict_types=1);

/** GET /api/content/get.php (public) returns the storefront's landing content, FAQs, contact details and hero slides from the database. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$content = [];
foreach (Database::all('SELECT key_name, value_text FROM site_content') as $row) {
    $content[$row['key_name']] = $row['value_text'];
}

$faqs = Database::all('SELECT question, answer FROM faqs ORDER BY display_order, id');
/* image_path holds an app-root-relative path (renamed from image_data in migration 003). */
$hero = Database::all('SELECT id, title, image_path FROM hero_slides ORDER BY display_order, id');

/* An empty list means each product's own is_best flag decides. */
$featured = array_column(
    Database::all('SELECT product_id FROM featured_products ORDER BY display_order'),
    'product_id'
);

Response::ok([
    'about'   => $content['about']   ?? '',
    'vision'  => $content['vision']  ?? '',
    'mission' => $content['mission'] ?? '',
    /* Hero text; the defaults are the original wording, used until it is edited in Landing Page. */
    'heroText' => [
        'tagline'     => ($content['hero_tagline'] ?? '') ?: 'Every Mouthful is Delightful.',
        'highlight'   => $content['hero_highlight'] ?? 'Delightful',
        'lead'        => $content['hero_lead'] ?? 'Every product starts with fresh, locally-sourced milkfish — hand-deboned or bottled in small batches.',
        'stat1_value' => $content['hero_stat1_value'] ?? '100%',
        'stat1_label' => $content['hero_stat1_label'] ?? 'Natural',
        'stat2_value' => $content['hero_stat2_value'] ?? '9+',
        'stat2_label' => $content['hero_stat2_label'] ?? 'years of craft',
    ],
    'contact' => [
        'address'  => $content['contact_address']  ?? '',
        'phone'    => $content['contact_phone']    ?? '',
        'email'    => $content['contact_email']    ?? '',
        'facebook' => $content['contact_facebook'] ?? '',
    ],
    'faqs'     => array_map(static fn(array $f): array => ['q' => $f['question'], 'a' => $f['answer']], $faqs),
    /* Send the picture as `image` like every other endpoint, keeping `img` for one release because older screens still read it. */
    'hero'     => array_map(static function (array $h): array {
        $path = $h['image_path'] ?? '';
        return ['id' => (int) $h['id'], 'title' => $h['title'], 'image' => $path, 'img' => $path];
    }, $hero),
    'featured' => $featured,
    /* The payment accounts and QR codes customers pay into are public, like the contact details. */
    'payment'  => [
        'gcash' => [
            'name'   => $content['pay_gcash_name']   ?? '',
            'number' => $content['pay_gcash_number'] ?? '',
            'qr'     => $content['pay_gcash_qr']     ?? '',
        ],
        'bank' => [
            'bank'   => $content['pay_bank_bank']    ?? '',
            'name'   => $content['pay_bank_name']    ?? '',
            'number' => $content['pay_bank_number']  ?? '',
            'qr'     => $content['pay_bank_qr']      ?? '',
        ],
    ],
]);
