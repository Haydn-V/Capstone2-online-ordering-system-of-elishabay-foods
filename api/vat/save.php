<?php
declare(strict_types=1);

/** POST /api/vat/save.php (Super Admin only) saves one change per request (rules, a product's tax type, or a retailer's withholding rate), audited with before and after values; past invoices never change. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::requireSystemRole('vat.manage');

$in      = Response::input();
$section = (string) ($in['section'] ?? '');

function vat_audit(array $actor, string $text): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$actor['name'], $actor['id'], 'system', $text]
    );
}

/* ------------------------------------------------------------------ rules */
if ($section === 'rules') {
    $posted = $in['rules'] ?? null;
    if (!is_array($posted) || $posted === []) {
        Response::validation('Nothing to save.', ['rules' => 'Send at least one rule.']);
    }

    /* API name => [settings key, label, boolean?] */
    $map = [
        'vatRate'                => ['vat_rate',                 'VAT rate (%)',                    false],
        'withholdingDefaultRate' => ['withholding_default_rate', 'Default retailer discount (%)',   false],
        'withholdingMinQty'      => ['withholding_min_qty',      'Retailer discount minimum items', false],
    ];

    $errors = [];
    $writes = [];
    foreach ($posted as $name => $value) {
        if (!isset($map[$name])) {
            $errors[$name] = 'Not a VAT setting.';
            continue;
        }
        [$key, $label, $isBool] = $map[$name];
        if ($isBool) {
            $writes[$key] = [$label, $value ? '1' : '0'];
            continue;
        }
        if (!is_numeric($value)) {
            $errors[$name] = 'Enter a number.';
            continue;
        }
        if ($key === 'withholding_min_qty' && floor((float) $value) != (float) $value) {
            $errors[$name] = 'Enter a whole number of items.';
            continue;
        }
        [$lo, $hi] = Tax::LIMITS[$key];
        $num = round((float) $value, 2);
        if ($num < $lo || $num > $hi) {
            $errors[$name] = sprintf('Use a value from %s to %s.', rtrim(rtrim(number_format($lo, 2), '0'), '.'),
                rtrim(rtrim(number_format($hi, 2), '0'), '.'));
            continue;
        }
        $writes[$key] = [$label, rtrim(rtrim(number_format($num, 2, '.', ''), '0'), '.')];
    }
    if ($errors !== []) {
        Response::validation('Check the highlighted rules.', $errors);
    }

    $before = Tax::rules();
    $changes = [];
    $pdo = Database::pdo();
    $pdo->beginTransaction();
    try {
        foreach ($writes as $key => [$label, $stored]) {
            $old = rtrim(rtrim(number_format((float) $before[$key], 2, '.', ''), '0'), '.');
            if ($old === $stored) {
                continue;
            }
            Database::run(
                'INSERT INTO settings (key_name, value_text) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)',
                [$key, $stored]
            );
            $changes[] = "{$label}: {$old} → {$stored}";
        }
        if ($changes !== []) {
            vat_audit($actor, 'VAT rules changed. ' . implode('; ', $changes) . '.');
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        throw $e;
    }
    Tax::forget();
    Response::ok(['changed' => $changes]);
}

/* ---------------------------------------------------------------- product */
if ($section === 'product') {
    $productId = trim((string) ($in['product_id'] ?? ''));
    $taxType   = (string) ($in['tax_type'] ?? '');
    if (!in_array($taxType, Tax::TAX_TYPES, true)) {
        Response::validation('Choose a tax type.', ['tax_type' => 'Use vatable or exempt.']);
    }
    $p = Database::one('SELECT id, name, tax_type FROM products WHERE id = ?', [$productId]);
    if ($p === null) {
        Response::notFound('That product does not exist.');
    }
    if ($p['tax_type'] !== $taxType) {
        Database::run('UPDATE products SET tax_type = ? WHERE id = ?', [$taxType, $productId]);
        vat_audit($actor, sprintf('Product %s (%s) tax type: %s → %s. Applies to sales from now on.',
            $p['name'], $p['id'], $p['tax_type'], $taxType));
    }
    Response::ok(['productId' => $productId, 'taxType' => $taxType]);
}

/* ------------------------------------------------------------ withholding */
if ($section === 'withholding') {
    $customerId = trim((string) ($in['customer_id'] ?? ''));
    $c = Database::one('SELECT id, name, status FROM customers WHERE id = ?', [$customerId]);
    if ($c === null) {
        Response::notFound('That customer does not exist.');
    }
    $current = Database::scalar('SELECT rate FROM withholding_agents WHERE customer_id = ?', [$customerId]);
    $current = ($current === false || $current === null) ? null : (float) $current;

    $rate = $in['rate'] ?? null;
    if ($rate === null || $rate === '') {
        if ($current !== null) {
            Database::run('DELETE FROM withholding_agents WHERE customer_id = ?', [$customerId]);
            vat_audit($actor, sprintf('%s (%s) retailer discount turned off (was %s%%).',
                $c['name'], $c['id'], $current));
        }
        Response::ok(['customerId' => $customerId, 'withholdingRate' => null]);
    }

    if ($c['status'] !== 'retailer') {
        Response::conflict("{$c['name']} is not a retailer. Only a retailer can get the retailer discount.");
    }
    if (!is_numeric($rate) || (float) $rate <= 0 || (float) $rate > 50) {
        Response::validation('Check the rate.', ['rate' => 'Use a rate above 0 and at most 50%.']);
    }
    $rate = round((float) $rate, 2);

    if ($current !== $rate) {
        Database::run(
            'INSERT INTO withholding_agents (customer_id, rate, updated_by) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_by = VALUES(updated_by)',
            [$customerId, $rate, $actor['id']]
        );
        vat_audit($actor, sprintf('%s (%s) retailer discount: %s → %s%%. Applies to sales from now on.',
            $c['name'], $c['id'], $current === null ? 'none' : $current . '%', $rate));
    }
    Response::ok(['customerId' => $customerId, 'withholdingRate' => $rate]);
}

Response::validation('Unknown section.', ['section' => 'Use rules, product or withholding.']);
