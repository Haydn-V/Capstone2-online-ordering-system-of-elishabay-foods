<?php
declare(strict_types=1);

/** GET /api/shop/trace.php (public) looks up a batch code for the traceability page, returning provenance and QA status only. */

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
    /* An unknown code returns 200 with found:false, not 404. */
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
