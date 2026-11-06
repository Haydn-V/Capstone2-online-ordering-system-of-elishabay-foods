<?php
declare(strict_types=1);

/** POST /api/inventory/adjust.php (needs inventory.manage) restocks, disposes or returns stock in one transaction with validated input and a server-written audit row. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('inventory.manage');

$in = Response::input();

$data = Validate::check($in)
    ->required('product_id', 'Product')
    ->int('qty', 'Quantity', 1, 1000000)
    ->in('type', ['restock', 'disposal', 'return'], 'Adjustment type')
    ->required('reason', 'Reason')
    ->maxLen('reason', 500, 'Reason')
    ->values();

$pdo = Database::pdo();

/* Row-level check, not a trust of whatever id arrived. */
$product = Database::one(
    'SELECT id, name, stock, archived FROM products WHERE id = ?',
    [$data['product_id']]
);
if ($product === null) {
    Response::notFound('That product does not exist.');
}
if ((int) $product['archived'] === 1 && $data['type'] === 'restock') {
    Response::conflict('This product is archived. Restore it before restocking.');
}

/* A disposal or return must name an existing lot, so every unit removed stays traceable (restock opens a new lot instead). */
$batchCode = trim((string) ($in['batch_code'] ?? ''));
$batch     = null;

if ($data['type'] !== 'restock') {
    if ($batchCode === '') {
        Response::validation('Choose the lot this adjustment applies to.', [
            'batch_code' => 'Select a lot. If none is listed, register one in Batch Tracking first.',
        ]);
    }

    $batch = Database::one(
        'SELECT id, lot_code, product_id, remaining_qty, expiry_date
           FROM batches WHERE lot_code = ?',
        [$batchCode]
    );
    if ($batch === null) {
        Response::validation('That lot does not exist.', [
            'batch_code' => 'No lot with that code is on record.',
        ]);
    }

    /* The lot must belong to this product. */
    if ($batch['product_id'] !== $product['id']) {
        Response::validation('That lot belongs to a different product.', [
            'batch_code' => sprintf('Lot %s is not a lot of %s.', $batch['lot_code'], $product['name']),
        ]);
    }
}

/* Disposal subtracts and return adds; the sign is set here, not by the client. */
$delta = $data['type'] === 'disposal' ? -$data['qty'] : $data['qty'];

/* Cannot dispose more than the lot holds. */
if ($data['type'] === 'disposal' && (int) $batch['remaining_qty'] < $data['qty']) {
    Response::conflict(sprintf(
        'Lot %s holds only %d unit(s) — cannot discard %d.',
        $batch['lot_code'], (int) $batch['remaining_qty'], $data['qty']
    ));
}

/* Cannot return more into a lot than it was made with (remaining never above total). */
if ($data['type'] === 'return') {
    $lotTotal = (int) Database::scalar('SELECT total_qty FROM batches WHERE id = ?', [$batch['id']]);
    $room     = max(0, $lotTotal - (int) $batch['remaining_qty']);
    if ($data['qty'] > $room) {
        Response::conflict($room > 0
            ? sprintf('Lot %s started with %d unit(s) and holds %d — only %d more can be returned to it.',
                $batch['lot_code'], $lotTotal, (int) $batch['remaining_qty'], $room)
            : sprintf('Lot %s is already full (%d of %d) — nothing more can be returned to it.',
                $batch['lot_code'], (int) $batch['remaining_qty'], $lotTotal));
    }
}

/* Stock must not go negative, checked inside the transaction. */
if ((int) $product['stock'] + $delta < 0) {
    Response::conflict(
        "Cannot remove {$data['qty']} units — only {$product['stock']} in stock."
    );
}

try {
    $pdo->beginTransaction();

    /* An adjustment is not a sale, so sold is untouched (Stock::adjust). */
    Stock::adjust($product['id'], (int) $delta);

    /* Reduce the lot's remaining_qty along with product stock (never below 0) so disposed lots stop claiming stock. */
    if ($batch !== null) {
        Database::run(
            $data['type'] === 'disposal'
                ? 'UPDATE batches SET remaining_qty = GREATEST(remaining_qty - ?, 0) WHERE id = ?'
                : 'UPDATE batches SET remaining_qty = remaining_qty + ? WHERE id = ?',
            [$data['qty'], $batch['id']]
        );
    }

    /* Create the new lot before the adjustment row, because the adjustment's batch_code foreign key must already exist. */
    /* A restock may also open a new batch ($newLot, separate from the existing $batch used by disposals). */
    /* A restock opens a new lot when a production date is given (the code is assigned by the system unless supplied);
       without one it just tops up stock. The expiry is never taken from the form: it is the production date plus the
       category's shelf life (Inventory::autoExpiry), and the production date may be at most a month back. */
    $opensLot = $data['type'] === 'restock' && (!empty($in['production_date']) || !empty($in['expiry_date']));

    if ($opensLot) {
        $newLot = Validate::check($in)
            ->date('production_date', 'Production date')
            ->values();

        $prodErr = Inventory::productionDateError($newLot['production_date']);
        if ($prodErr !== null) {
            Response::validation('Check the dates.', ['production_date' => $prodErr]);
        }
        $newLot['expiry_date'] = Inventory::autoExpiry($data['product_id'], $newLot['production_date']);

        /* Use the supplied code (checked for duplicates) or an assigned one. */
        $lotCode = trim((string) ($in['batch_code'] ?? ''));
        if ($lotCode === '') {
            $lotCode = Inventory::nextLotCode();
        } else {
            $exists = Database::scalar('SELECT COUNT(*) FROM batches WHERE lot_code = ?', [$lotCode]);
            if ($exists) {
                Response::conflict("Lot code {$lotCode} already exists.");
            }
        }
        $newLot['batch_code'] = $lotCode;

        /* Point the adjustment row at the lot this restock opened. */
        $batchCode = $lotCode;

        Database::run(
            'INSERT INTO batches (id, lot_code, product_id, harvest_date, production_date,
                                  expiry_date, total_qty, remaining_qty, quality_grade,
                                  lab_status, qa_inspector, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                'bat-' . bin2hex(random_bytes(5)),
                $newLot['batch_code'],
                $product['id'],
                $newLot['production_date'],
                $newLot['production_date'],
                $newLot['expiry_date'],
                $data['qty'],
                $data['qty'],
                'Grade A Export Quality',
                'pending',
                null,
                'Created by restock from Inventory Management.',
            ]
        );
    }

    Database::run(
        'INSERT INTO inventory_adjustments (date, product_id, qty, type, reason, batch_code)
         VALUES (CURDATE(), ?, ?, ?, ?, ?)',
        [
            $product['id'],
            $delta,
            /* A restock is stored as a positive return movement, matching the existing rows. */
            $data['type'] === 'disposal' ? 'disposal' : 'return',
            $data['reason'],
            /* The validated code, or null for a restock with no lot. */
            $batchCode !== '' ? $batchCode : null,
        ]
    );

    /* The audit row is written on the server so it cannot be skipped. */
    $verb = ['restock' => 'Restocked', 'disposal' => 'Disposed', 'return' => 'Returned'][$data['type']];
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description)
         VALUES (NOW(), ?, ?, ?, ?)',
        [
            $user['name'],
            $user['id'],
            $data['type'] === 'restock' ? 'restock' : 'product',
            sprintf(
                '%s %s %d units of %s. Reason: %s',
                $verb,
                $delta >= 0 ? '+' : '-',
                abs($delta),
                $product['name'],
                $data['reason']
            ),
        ]
    );

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

$fresh = Database::one('SELECT id, name, stock FROM products WHERE id = ?', [$product['id']]);

Response::ok([
    'product'  => ['id' => $fresh['id'], 'name' => $fresh['name'], 'stock' => (int) $fresh['stock']],
    'movement' => $delta,
    /* Return the opened lot code so the form can show it (null when no lot was opened). */
    'lotCode'  => $opensLot ? $batchCode : null,
]);
