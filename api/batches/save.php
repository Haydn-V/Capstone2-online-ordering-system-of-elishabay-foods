<?php
declare(strict_types=1);

/** POST /api/batches/save.php (needs batches.manage) creates or edits a batch record but never adds stock, because stock only moves through inventory/adjust.php. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('batches.manage');

$in = Response::input();
$isUpdate = !empty($in['id']);

$data = Validate::check($in)
    ->required('lot_code', 'Lot code')
    ->maxLen('lot_code', 50, 'Lot code')
    ->required('product_id', 'Product')
    ->date('production_date', 'Production date')
    ->in('lab_status', ['passed', 'pending', 'failed'], 'Lab status')
    ->values();

/* The expiry is never typed in: it is the production date plus the product's shelf life (bottled 1 year, deboned
   6 months), and a production date may be at most a month back. Editing a batch without changing its product or
   production date keeps the dates it already has. */
$before = $isUpdate
    ? Database::one('SELECT product_id, production_date, expiry_date FROM batches WHERE id = ?', [$in['id']])
    : null;
if ($before !== null && $before['product_id'] === $data['product_id'] && $before['production_date'] === $data['production_date']) {
    $data['expiry_date'] = $before['expiry_date'];
} else {
    $prodErr = Inventory::productionDateError($data['production_date']);
    if ($prodErr !== null) {
        Response::validation('Check the dates.', ['production_date' => $prodErr]);
    }
    $data['expiry_date'] = Inventory::autoExpiry($data['product_id'], $data['production_date']);
}

$harvest = trim((string) ($in['harvest_date'] ?? '')) ?: $data['production_date'];
$d = DateTime::createFromFormat('Y-m-d', $harvest);
if (!$d || $d->format('Y-m-d') !== $harvest) {
    Response::validation('Check the dates.', ['harvest_date' => 'Use YYYY-MM-DD.']);
}
if ($harvest > $data['production_date']) {
    Response::validation('Check the dates.', [
        'harvest_date' => 'Fish cannot be harvested after the batch was produced.',
    ]);
}

$product = Database::one('SELECT id, name FROM products WHERE id = ?', [$data['product_id']]);
if ($product === null) {
    Response::validation('Check the highlighted fields.', ['product_id' => 'That product does not exist.']);
}

/* Lot codes must be unique because customers look them up on the public traceability page. */
$clash = Database::scalar(
    'SELECT COUNT(*) FROM batches WHERE lot_code = ? AND id <> ?',
    [$data['lot_code'], $in['id'] ?? '']
);
if ($clash) {
    Response::conflict("Lot code {$data['lot_code']} is already in use.");
}

$grade     = trim((string) ($in['quality_grade'] ?? '')) ?: null;
$inspector = trim((string) ($in['qa_inspector'] ?? '')) ?: null;
$notes     = trim((string) ($in['notes'] ?? '')) ?: null;

if ($isUpdate) {
    $existing = Database::one('SELECT id, lot_code, lab_status, remaining_qty FROM batches WHERE id = ?', [$in['id']]);
    if ($existing === null) {
        Response::notFound('That batch does not exist.');
    }

    /* total_qty cannot be edited after creation, because remaining_qty and every recorded movement depend on it. */
    Database::run(
        'UPDATE batches
            SET lot_code = ?, product_id = ?, harvest_date = ?, production_date = ?,
                expiry_date = ?, quality_grade = ?, lab_status = ?, qa_inspector = ?, notes = ?
          WHERE id = ?',
        [$data['lot_code'], $data['product_id'], $harvest, $data['production_date'],
         $data['expiry_date'], $grade, $data['lab_status'], $inspector, $notes, $existing['id']]
    );

    $note = $existing['lab_status'] !== $data['lab_status']
        ? sprintf(' QA %s → %s.', $existing['lab_status'], $data['lab_status'])
        : '';
    /* Warn when a failed batch still has units on the shelf. */
    if ($data['lab_status'] === 'failed' && (int) $existing['remaining_qty'] > 0) {
        $note .= sprintf(' NOTE: %d units remain in stock and should be disposed.', $existing['remaining_qty']);
    }

    audit_batch($user, sprintf('Updated batch %s (%s).%s', $data['lot_code'], $product['name'], $note));
    $id = $existing['id'];
} else {
    $qty = Validate::check($in)->int('total_qty', 'Quantity', 1, 1000000)->values()['total_qty'];

    $id = 'bat-' . bin2hex(random_bytes(5));
    Database::run(
        'INSERT INTO batches (id, lot_code, product_id, harvest_date, production_date,
                              expiry_date, total_qty, remaining_qty, quality_grade,
                              lab_status, qa_inspector, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$id, $data['lot_code'], $data['product_id'], $harvest, $data['production_date'],
         $data['expiry_date'], $qty, $qty, $grade, $data['lab_status'], $inspector, $notes]
    );

    audit_batch($user, sprintf(
        'Registered batch %s for %s — %d units, expires %s. Stock unchanged; use Inventory Management to receive them.',
        $data['lot_code'], $product['name'], $qty, $data['expiry_date']
    ));
}

$row = Database::one(
    'SELECT b.*, p.name AS product_name, DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry
       FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?',
    [$id]
);

Response::ok([
    'id'           => $row['id'],
    'lotCode'      => $row['lot_code'],
    'productId'    => $row['product_id'],
    'productName'  => $row['product_name'],
    'harvestDate'  => $row['harvest_date'],
    'prodDate'     => $row['production_date'],
    'expiryDate'   => $row['expiry_date'],
    'totalQty'     => (int) $row['total_qty'],
    'remainingQty' => (int) $row['remaining_qty'],
    'qualityGrade' => $row['quality_grade'],
    'labStatus'    => $row['lab_status'],
    'qaInspector'  => $row['qa_inspector'],
    'notes'        => $row['notes'],
    'daysToExpiry' => (int) $row['days_to_expiry'],
], null, $isUpdate ? 200 : 201);


function audit_batch(array $user, string $description): void
{
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [$user['name'], $user['id'], 'product', $description]
    );
}
