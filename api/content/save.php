<?php
declare(strict_types=1);

/** POST /api/content/save.php (needs landing.manage) writes only the keys sent, while FAQs, hero slides and featured products are each replaced as a whole inside one transaction. */

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

    /* Hero text over the landing image: the tagline (with one highlighted word), the line under it, and the two stats. */
    if (isset($in['heroText']) && is_array($in['heroText'])) {
        $ht = $in['heroText'];
        $heroKeys = ['tagline' => 120, 'highlight' => 40, 'lead' => 240,
                     'stat1_value' => 12, 'stat1_label' => 30, 'stat2_value' => 12, 'stat2_label' => 30];
        foreach ($heroKeys as $k => $max) {
            if (!array_key_exists($k, $ht)) { continue; }
            $val = trim((string) $ht[$k]);
            if (mb_strlen($val) > $max) {
                $pdo->rollBack();
                Response::validation('Check the hero text.', ['hero_' . $k => "Keep it under $max characters."]);
            }
            if ($k === 'tagline' && $val === '') {
                $pdo->rollBack();
                Response::validation('Check the hero text.', ['hero_tagline' => 'The tagline cannot be empty.']);
            }
            if ($k === 'highlight' && $val !== '' && mb_stripos(trim((string) ($ht['tagline'] ?? '')), $val) === false) {
                $pdo->rollBack();
                Response::validation('Check the hero text.', ['hero_highlight' => 'The highlighted word must appear in the tagline.']);
            }
            Database::run(
                'INSERT INTO site_content (key_name, value_text) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
                ['hero_' . $k, $val]
            );
        }
        $changed[] = 'hero text';
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
            /* Skip blank FAQ rows so they do not show up as gaps on the public page. */
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

    /* Hero slide images: update existing slides by id (or title), never add new ones, so the landing page keeps its designed set of panels. */
    if (isset($in['hero']) && is_array($in['hero'])) {
        $slides = Database::all('SELECT id, title FROM hero_slides');
        $byTitle = [];
        $byId = [];
        foreach ($slides as $s) {
            $byTitle[$s['title']] = $s['id'];
            $byId[(int) $s['id']] = true;
        }

        $updated = 0;
        foreach ($in['hero'] as $h) {
            if (!is_array($h)) {
                continue;
            }
            $title = trim((string) ($h['title'] ?? ''));
            /* Match by id when sent, because the title is editable now; older clients still match by title. */
            $slideId = (int) ($h['id'] ?? 0);
            if ($slideId > 0) {
                if (!isset($byId[$slideId])) {
                    continue;
                }
                if ($title === '' || mb_strlen($title) > 100) {
                    $pdo->rollBack();
                    Response::validation('Check the hero images.', [
                        'hero' => 'Each hero slide needs a name of 1–100 characters.',
                    ]);
                }
            } elseif ($title === '' || !isset($byTitle[$title])) {
                continue;
            } else {
                $slideId = (int) $byTitle[$title];
            }

            /* Accept only an image path in the exact format api/uploads/image.php produces (or empty to remove), because it ends up in a public <img src>. */
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
                'UPDATE hero_slides SET title = ?, image_path = ? WHERE id = ?',
                [$title, $path !== '' ? $path : null, $slideId]
            );
            $updated++;
        }
        if ($updated > 0) {
            $changed[] = 'hero images (' . $updated . ')';
        }
    }

    /* Featured products are replaced as a whole so unticking one really unfeatures it, and an empty list falls back to each product's is_best flag. */
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
            /* Check the product exists first, so the admin gets a clear message instead of a foreign-key 500. */
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

    /* Payment accounts (GCash, bank) are stored as flat site_content keys, and any QR path must match the upload format and exist on disk because it is shown publicly. */
    if (isset($in['payment']) && is_array($in['payment'])) {
        $PAY_FIELDS = [
            'gcash' => ['name' => 100, 'number' => 40, 'qr' => 0],
            'bank'  => ['bank' => 80, 'name' => 100, 'number' => 40, 'qr' => 0],
        ];
        foreach ($PAY_FIELDS as $acct => $fields) {
            if (!isset($in['payment'][$acct]) || !is_array($in['payment'][$acct])) {
                continue;
            }
            foreach ($fields as $f => $max) {
                if (!array_key_exists($f, $in['payment'][$acct])) {
                    continue;
                }
                $val = trim((string) $in['payment'][$acct][$f]);
                if ($f === 'qr') {
                    if ($val !== '' && (!preg_match('#^/uploads/content/[a-f0-9]{32}\.webp$#', $val)
                                        || !is_file(dirname(__DIR__, 2) . $val))) {
                        $pdo->rollBack();
                        Response::validation('Check the payment QR codes.', [
                            'payment' => 'That QR image is not on the server. Upload it again.',
                        ]);
                    }
                } elseif (mb_strlen($val) > $max) {
                    $pdo->rollBack();
                    Response::validation('Check the payment accounts.', [
                        'payment' => "Keep the {$acct} {$f} under {$max} characters.",
                    ]);
                }
                Database::run(
                    'INSERT INTO site_content (key_name, value_text) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
                    ["pay_{$acct}_{$f}", $val]
                );
                $changed[] = "payment.{$acct}.{$f}";
            }
        }
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
