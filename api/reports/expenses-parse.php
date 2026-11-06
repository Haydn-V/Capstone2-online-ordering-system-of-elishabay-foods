<?php
declare(strict_types=1);

/** POST /api/reports/expenses-parse.php (needs reports.financial), multipart field "file" (.xlsx, .xls, .csv, .ods,
    at most 2 MB) and optional "sheet": reads the expenses straight from PHP's temp file (never stored) and returns the
    detected columns, rows, skipped rows and category totals, plus the chosen sheet's raw grid so the browser can
    re-apply a different column mapping without uploading again. Nothing is saved. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
Rbac::require('reports.financial');

$autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
if (!is_file($autoload)) {
    Response::serverError('The spreadsheet reader is not installed on this server (vendor/ is missing). See docs/SETUP.md.');
}
require $autoload;
require_once __DIR__ . '/../core/ExpenseImport.php';

$file = $_FILES['file'] ?? null;
if (!is_array($file)) {
    Response::validation('Choose a file.', ['file' => 'Choose an expenses file (.xlsx, .xls, .csv or .ods).']);
}
$err = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
    Response::validation('The file is too large.', ['file' => 'The file is larger than 2 MB.']);
}
if ($err !== UPLOAD_ERR_OK || !is_uploaded_file((string) $file['tmp_name'])) {
    Response::validation('The upload did not finish.', ['file' => 'The upload was interrupted. Try again.']);
}
if ((int) $file['size'] > ExpenseImport::MAX_BYTES) {
    Response::validation('The file is too large.', ['file' => 'The file is larger than 2 MB.']);
}

$name  = basename((string) $file['name']);
$sheet = isset($_POST['sheet']) && $_POST['sheet'] !== '' ? (int) $_POST['sheet'] : null;

try {
    $sheets = ExpenseImport::read((string) $file['tmp_name'], $name);
    $result = ExpenseImport::detect($sheets, $sheet);
} catch (ExpenseImportException $e) {
    Response::validation($e->getMessage(), ['file' => $e->getMessage()]);
}

Response::ok($result + [
    'fileName' => $name,
    'grid'     => $sheets[$result['sheet']]['grid'],
    /* So the preview can say what to do when no amount column was found. */
    'message'  => $result['confidence'] === 'none'
        ? "We couldn't find any amounts in this file. Pick the amount column below."
        : null,
]);
