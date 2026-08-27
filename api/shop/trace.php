<?php
declare(strict_types=1);

/**
 * GET /api/shop/trace.php?code=JBF-2026-B112
 *
 * PUBLIC — batch traceability lookup for the storefront.
 *
 * batch-traceability.html carried its OWN inline BATCHES object: a third copy
 * of batch data, after engine.js and the database. A customer scanning a jar
 * was shown hardcoded demo values with no connection to the lot in their hand.
 *
 * Returns provenance and QA status only. Quantities, remaining stock and the
 * inspector name are staff information and are not sent.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$code = strtoupper(trim((string) ($_GET['code'] ?? '')));
if ($code === '') {
    Response::validation('Enter a batch code.', ['code' => 'Batch code is required.']);
}

$batch = Database::one(
    'SELECT b.lot_code, b.harvest_date, b.production_date, b.expiry_date,
            b.quality_grade, b.lab_status, p.name AS product_name, c.name AS category
       FROM batches b
       JOIN products p ON p.id = b.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE UPPER(b.lot_code) = ?',
    [$code]
);

if ($batch === null) {
    /* 200 with found:false, not 404. "We have no record of that code" is a
       legitimate answer to a legitimate question, and the page renders it as a
       result rather than as an error. */
    Response::ok([
        'found'   => false,
        'code'    => $code,
        'message' => 'No batch found with that code. Check the code printed on the lid, or contact us.',
    ]);
}

$statusMap = [
    'passed'  => ['label' => 'Passed — Commercial Sterility Certified', 'ok' => true],
    'pending' => ['label' => 'Awaiting laboratory results',             'ok' => null],
    'failed'  => ['label' => 'Failed — batch withdrawn from sale',      'ok' => false],
];
$labStatus = $statusMap[$batch['lab_status']] ?? ['label' => $batch['lab_status'], 'ok' => null];

Response::ok([
    'found'          => true,
    'code'           => $batch['lot_code'],
    'product'        => $batch['product_name'],
    'category'       => $batch['category'],
    'harvestDate'    => $batch['harvest_date'],
    'productionDate' => $batch['production_date'],
    'expiryDate'     => $batch['expiry_date'],
    'qualityGrade'   => $batch['quality_grade'],
    'labStatus'      => $labStatus['label'],
    'labPassed'      => $labStatus['ok'],
    'origin'         => 'Dagupan City, Pangasinan — Juris Bay Foods, Inc.',
]);
