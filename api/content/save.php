<?php
declare(strict_types=1);

/**
 * POST /api/content/save.php
 * Body: { "about"?, "vision"?, "mission"?, "contact"?: {...}, "faqs"?: [{q,a}],
 *         "hero"?: [{title, image}], "featured"?: ["prod-id", …] }
 *
 * Requires landing.manage.
 *
 * Only the keys present in the request are written, so saving one panel cannot
 * blank the others. FAQs, hero images and the featured list are the exceptions
 * — they are ordered collections, so each is replaced wholesale when supplied,
 * inside one transaction.
 *
 * `hero` and `featured` were added closing defect 3.3. Before that this
 * endpoint accepted five keys and content/get.php returned seven: the reader
 * could hand back a hero image and a featured list that no writer anywhere in
 * the system could produce. hero_slides was NULL in all five rows and
 * featured_products had none at all.
 *
 * `hero[].image` is a PATH from api/uploads/image.php, never an image.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('landing.manage');

$in = Response::input();

$textKeys    = ['about', 'vision', 'mission'];
$contactKeys = ['address', 'phone', 'email', 'facebook'];

$pdo = Database::pdo();
$changed = [];

try {
    $pdo->beginTransaction();

    foreach ($textKeys as $k) {
        if (!array_key_exists($k, $in)) {
            continue;
        }
        $val = trim((string) $in[$k]);
        if (mb_strlen($val) > 5000) {
            $pdo->rollBack();
            Response::validation('That text is too long.', [$k => 'Keep it under 5000 characters.']);
        }
        Database::run(
            'INSERT INTO site_content (key_name, value_text) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
            [$k, $val]
        );
        $changed[] = $k;
    }

    if (isset($in['contact']) && is_array($in['contact'])) {
        foreach ($contactKeys as $k) {
            if (!array_key_exists($k, $in['contact'])) {
                continue;
            }
            $val = trim((string) $in['contact'][$k]);
            if ($k === 'email' && $val !== '' && !filter_var($val, FILTER_VALIDATE_EMAIL)) {
                $pdo->rollBack();
                Response::validation('Check the contact details.', ['email' => 'Enter a valid email address.']);
            }
            Database::run(
                'INSERT INTO site_content (key_name, value_text) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
                ['contact_' . $k, $val]
            );
            $changed[] = 'contact.' . $k;
        }
    }

    if (isset($in['faqs']) && is_array($in['faqs'])) {
        if (count($in['faqs']) > 50) {
            $pdo->rollBack();
            Response::validation('Too many FAQs.', ['faqs' => 'Keep it under 50 entries.']);
        }
        Database::run('DELETE FROM faqs');
        $order = 1;
        foreach ($in['faqs'] as $f) {
            $q = trim((string) ($f['q'] ?? ''));
            $a = trim((string) ($f['a'] ?? ''));
            /* Skip blank rows the editor leaves behind rather than storing
               empty questions that render as gaps on the public page. */
            if ($q === '' || $a === '') {
                continue;
            }
            Database::run(
                'INSERT INTO faqs (question, answer, display_order) VALUES (?, ?, ?)',
                [$q, $a, $order++]
            );
        }
        $changed[] = 'faqs (' . ($order - 1) . ')';
    }

    /* ---- hero slide images -------------------------------------------------

       THIS IS DEFECT 3.3.

       This endpoint accepted about, vision, mission, contact and faqs — and
       nothing else. content/get.php read and returned hero_slides.image_data,
       so the READER could return a hero image and NOTHING IN THE SYSTEM COULD
       EVER PUT ONE THERE. All five rows were NULL and structurally unfillable.

       The administrator saw the image anyway, because saveLanding() mirrored
       the whole SITE_CONTENT object into localStorage and the in-portal preview
       iframe read it back from the same browser. Log out, or open the site
       anywhere else, and it was gone — which is the defect exactly as reported.

       Matched by title rather than by row id: the editor renders the slides it
       was given by content/get.php, so the titles are the ones already in this
       table. An unknown title is ignored rather than inserted — the carousel is
       a fixed set of panels on the public page, and silently growing it from a
       request body would put a slide on the landing page that nobody designed
       a place for. */
    if (isset($in['hero']) && is_array($in['hero'])) {
        $slides = Database::all('SELECT id, title FROM hero_slides');
        $byTitle = [];
        foreach ($slides as $s) {
            $byTitle[$s['title']] = $s['id'];
        }

        $updated = 0;
        foreach ($in['hero'] as $h) {
            if (!is_array($h)) {
                continue;
            }
            $title = trim((string) ($h['title'] ?? ''));
            if ($title === '' || !isset($byTitle[$title])) {
                continue;
            }

            /* Accepts the path api/uploads/image.php returned, or an empty
               string meaning "remove this slide's photo". Validated to the
               exact shape that endpoint produces — a landing.manage holder is
               trusted staff, but a stored path ends up in an <img src> on the
               public storefront, so it is checked rather than assumed. */
            $path = trim((string) ($h['image'] ?? $h['img'] ?? ''));

            if ($path !== '') {
                if (str_starts_with($path, 'data:')) {
                    $pdo->rollBack();
                    Response::validation('Check the hero images.', [
                        'hero' => 'Upload the image first — this field takes a path from api/uploads/image.php, not the file itself.',
                    ]);
                }
                if (!preg_match('#^/uploads/content/[a-f0-9]{32}\.webp$#', $path)) {
                    $pdo->rollBack();
                    Response::validation('Check the hero images.', [
                        'hero' => 'That is not a valid uploaded image path.',
                    ]);
                }
                if (!is_file(dirname(__DIR__, 2) . $path)) {
                    $pdo->rollBack();
                    Response::validation('Check the hero images.', [
                        'hero' => 'That upload is no longer on the server. Upload the image again.',
                    ]);
                }
            }

            Database::run(
                'UPDATE hero_slides SET image_path = ? WHERE id = ?',
                [$path !== '' ? $path : null, $byTitle[$title]]
            );
            $updated++;
        }
        if ($updated > 0) {
            $changed[] = 'hero images (' . $updated . ')';
        }
    }

    /* ---- featured products -------------------------------------------------

       The same shape of gap as the hero images, one table over. saveLanding()
       has always computed the ticked list (`SITE_CONTENT.featured`) and never
       sent it; this endpoint never accepted it; featured_products has 0 rows
       and content/get.php reads it on every storefront load.

       Replaced wholesale, so unticking a product actually unfeatures it. An
       empty list is a real answer and means "fall back to each product's own
       is_best flag", which is what the carousel already does. */
    if (isset($in['featured']) && is_array($in['featured'])) {
        if (count($in['featured']) > 24) {
            $pdo->rollBack();
            Response::validation('Too many featured products.', [
                'featured' => 'Choose 24 or fewer.',
            ]);
        }

        Database::run('DELETE FROM featured_products');
        $order = 1;
        foreach ($in['featured'] as $pid) {
            $pid = trim((string) $pid);
            if ($pid === '') {
                continue;
            }
            /* The product must exist. The FK would refuse anyway, but a 500 out
               of a foreign-key violation tells the administrator nothing about
               which product went missing. */
            if (!Database::scalar('SELECT COUNT(*) FROM products WHERE id = ?', [$pid])) {
                $pdo->rollBack();
                Response::validation('Check the featured products.', [
                    'featured' => "Product '{$pid}' does not exist.",
                ]);
            }
            Database::run(
                'INSERT INTO featured_products (product_id, display_order) VALUES (?, ?)',
                [$pid, $order++]
            );
        }
        $changed[] = 'featured (' . ($order - 1) . ')';
    }

    if ($changed === []) {
        $pdo->rollBack();
        Response::badRequest('Nothing to save.');
    }

    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'system',
         'Updated landing page content: ' . implode(', ', $changed) . '.']
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

Response::ok(['updated' => $changed]);
