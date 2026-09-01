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

/* ---------------------------------------------------------------
   The lot, for a disposal or a return
   ---------------------------------------------------------------
   REQUIRED, not optional. This field used to be a free-text box the form
   labelled "(optional)", which defeated the module it belongs to: Batch
   Tracking exists so a unit can be traced to the lot it came from and so a
   recall can name the affected lots, and a disposal with no lot is
   untraceable. It was also free text meeting a foreign key —
   inventory_adjustments.batch_code references batches.lot_code (migration
   002), so a typo produced a database error rather than a field message.

   `restock` is excluded on purpose. There the field names a NEW lot being
   opened, validated further down against a different set of rules. */
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

    /* A lot that exists but belongs to a different product satisfies the
       foreign key and means nothing — it would file a disposal of one product
       against another product's production run. The FK cannot catch this
       because it only checks that the code exists somewhere. */
    if ($batch['product_id'] !== $product['id']) {
        Response::validation('That lot belongs to a different product.', [
            'batch_code' => sprintf('Lot %s is not a lot of %s.', $batch['lot_code'], $product['name']),
        ]);
    }
}

/* Disposal and customer returns move stock in opposite directions. Signed
   here, once, so the sign cannot be dictated by the client. */
$delta = $data['type'] === 'disposal' ? -$data['qty'] : $data['qty'];

/* Nothing can be discarded from a lot that does not hold it. Checked before
   the transaction for the message; the UPDATE below is still written so it
   cannot drive the column negative if this row moves underneath us. */
if ($data['type'] === 'disposal' && (int) $batch['remaining_qty'] < $data['qty']) {
    Response::conflict(sprintf(
        'Lot %s holds only %d unit(s) — cannot discard %d.',
        $batch['lot_code'], (int) $batch['remaining_qty'], $data['qty']
    ));
}

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

    /* The lot moves with the stock.
       ---------------------------
       Nothing in this system decremented batches.remaining_qty before this. A
       disposal reduced products.stock and left the lot at its full quantity, so
       a discarded lot kept claiming stock that was in a bin: it stayed in the
       Expiry Monitor asking to be disposed, and disposing it again drew the
       product's stock down a second time. Requiring a lot without this would
       have made choosing one purely decorative.

       GREATEST(...,0) for the same reason Stock.php guards `sold`: the check
       above reads the row before the transaction, and the floor means a
       concurrent adjustment can at worst make this a no-op rather than write a
       negative quantity.

       Restock is not handled here — it opens a NEW lot below, whose
       remaining_qty is set at creation. */
    if ($batch !== null) {
        Database::run(
            $data['type'] === 'disposal'
                ? 'UPDATE batches SET remaining_qty = GREATEST(remaining_qty - ?, 0) WHERE id = ?'
                : 'UPDATE batches SET remaining_qty = remaining_qty + ? WHERE id = ?',
            [$data['qty'], $batch['id']]
        );
    }

    /* ORDER MATTERS: the new lot is created BEFORE the adjustment row.
       inventory_adjustments.batch_code is a foreign key onto batches.lot_code
       (migration 002), so writing the adjustment first meant a restock opening
       a new lot referenced a row that did not exist yet. InnoDB checks foreign
       keys per statement rather than at commit, so this did not fail at the end
       of the transaction — it failed on the spot, and a restock with a new lot
       code returned a 500 with a raw SQLSTATE in it rather than working. */
    /* A restock may also open a new batch. Only when a lot code was supplied —
       topping up an existing batch is a legitimate restock too.

       $newLot, not $batch: $batch above holds the EXISTING lot a disposal or
       return draws from, and reusing the name here put two different meanings
       on one variable in one function. */
    /* WHAT OPENS A LOT IS NOW THE EXPIRY DATE, NOT THE CODE.
       ------------------------------------------------------
       It used to be `!empty($in['batch_code'])`, which made the operator's
       typing the thing that decided whether a production run was recorded. The
       code is the system's to assign (Inventory::nextLotCode), so it can no
       longer be the signal. The expiry date is: a lot without one is not a lot
       this business can trace, and a restock without one is a top-up of stock
       already on the shelf — which stays legitimate and still writes no batch
       row.

       A caller may still supply its own code; it is validated and used as
       before. Nothing that worked stops working. */
    $opensLot = $data['type'] === 'restock' && !empty($in['expiry_date']);

    if ($opensLot) {
        $newLot = Validate::check($in)
            ->date('production_date', 'Production date')
            ->date('expiry_date', 'Expiry date')
            ->values();

        if ($newLot['expiry_date'] <= $newLot['production_date']) {
            Response::validation('Check the dates.', [
                'expiry_date' => 'Expiry must be after the production date.',
            ]);
        }

        /* Supplied or assigned. The exists-check stays for the supplied case —
           nextLotCode() has already stepped past anything taken. */
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

        /* So the adjustment row below references the lot this restock actually
           opened. Without this an assigned code left inventory_adjustments.
           batch_code null, and the movement that CREATED a lot would be the one
           movement in the table not traceable to one. */
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
            /* The adjustments table only models disposal and return; a restock
               is recorded as a positive return-to-stock movement, matching how
               the existing seed rows use it. */
            $data['type'] === 'disposal' ? 'disposal' : 'return',
            $data['reason'],
            /* The validated, trimmed code — not the raw input. For a
               restock with no lot this is null, which the column allows. */
            $batchCode !== '' ? $batchCode : null,
        ]
    );

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
    /* Returned so the form can TELL the operator which lot was opened. The
       code is assigned here now, so without this the one person who needs to
       write it on the carton would have to go and look it up. Null when the
       movement opened no lot. */
    'lotCode'  => $opensLot ? $batchCode : null,
]);
