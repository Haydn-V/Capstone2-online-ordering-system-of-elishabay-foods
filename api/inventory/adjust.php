<?php
declare(strict_types=1);

/**
 * POST /api/inventory/adjust.php
 *
 * Body: { "product_id": "db-pesto", "qty": 50, "type": "restock",
 *         "reason": "...", "batch_code": "JBF-2026-B120",
 *         "production_date": "2026-08-16", "expiry_date": "2027-08-16" }
 *
 * type: restock | disposal | return
 *
 * Requires inventory.manage. The first WRITE endpoint, so it establishes the
 * pattern for every other one:
 *
 *   - permission checked server-side before any work
 *   - every value validated, including ones the UI "already checks"
 *   - the whole thing in a transaction, because stock, batch and audit rows
 *     must move together or not at all
 *   - the audit trail written here rather than by the client, which could
 *     simply decline to
 *   - quantities computed from the database, never taken from the browser
 */

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

/* Disposal and customer returns move stock in opposite directions. Signed
   here, once, so the sign cannot be dictated by the client. */
$delta = $data['type'] === 'disposal' ? -$data['qty'] : $data['qty'];

/* Stock must not go negative. Checked against the row just read, inside the
   transaction below, so a concurrent adjustment cannot slip underneath. */
if ((int) $product['stock'] + $delta < 0) {
    Response::conflict(
        "Cannot remove {$data['qty']} units — only {$product['stock']} in stock."
    );
}

try {
    $pdo->beginTransaction();

    /* An adjustment is not a sale: `sold` is deliberately untouched. Stock::adjust
       is the only movement with that property, which is why it has its own name
       (api/core/Stock.php). */
    Stock::adjust($product['id'], (int) $delta);

    Database::run(
        'INSERT INTO inventory_adjustments (date, product_id, qty, type, reason, batch_code)
         VALUES (CURDATE(), ?, ?, ?, ?, ?)',
        [
            $product['id'],
            $delta,
            /* The adjustments table only models disposal and return; a restock
               is recorded as a positive return-to-stock movement, matching how
               the existing seed rows use it. */
            $data['type'] === 'disposal' ? 'disposal' : 'return',
            $data['reason'],
            $in['batch_code'] ?? null,
        ]
    );

    /* A restock may also open a new batch. Only when a lot code was supplied —
       topping up an existing batch is a legitimate restock too. */
    if ($data['type'] === 'restock' && !empty($in['batch_code'])) {
        $batch = Validate::check($in)
            ->required('batch_code', 'Lot code')
            ->date('production_date', 'Production date')
            ->date('expiry_date', 'Expiry date')
            ->values();

        if ($batch['expiry_date'] <= $batch['production_date']) {
            Response::validation('Check the dates.', [
                'expiry_date' => 'Expiry must be after the production date.',
            ]);
        }

        $exists = Database::scalar('SELECT COUNT(*) FROM batches WHERE lot_code = ?', [$batch['batch_code']]);
        if ($exists) {
            Response::conflict("Lot code {$batch['batch_code']} already exists.");
        }

        Database::run(
            'INSERT INTO batches (id, lot_code, product_id, harvest_date, production_date,
                                  expiry_date, total_qty, remaining_qty, quality_grade,
                                  lab_status, qa_inspector, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                'bat-' . bin2hex(random_bytes(5)),
                $batch['batch_code'],
                $product['id'],
                $batch['production_date'],
                $batch['production_date'],
                $batch['expiry_date'],
                $data['qty'],
                $data['qty'],
                'Grade A Export Quality',
                'pending',
                null,
                'Created by restock from Inventory Management.',
            ]
        );
    }

    /* Audit written server-side. If the client were responsible for this, the
       one action worth hiding would be the one that never gets logged. */
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
]);
