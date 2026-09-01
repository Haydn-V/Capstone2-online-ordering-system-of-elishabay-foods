<?php
declare(strict_types=1);

/**
 * GET /api/batches/list.php
 *
 * Query: ?page=1&limit=50&product_id=&lab_status=&expiring_within=90&level=gone|crit|warn|ok
 *        &sort=expiry|latest|lot|product|remaining&search=
 *
 * Requires batches.manage or inventory.report — the batch list feeds both the
 * QA Traceability screen and Expiration Monitoring, which different roles hold.
 *
 * days_to_expiry is computed by MySQL against CURDATE(), not by the browser
 * against a hardcoded date. The client used to calculate it from
 * INV_TODAY = "2026-06-17", frozen in inventory.js, so every "days left" figure
 * in the UI was measured from a date that stopped moving. One clock, on the
 * server, is the fix.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireAny('batches.manage', 'inventory.report');

$q      = $_GET;
$paging = Validate::paging($q, 50, 200);

$where  = [];
$params = [];

if (!empty($q['product_id'])) {
    $where[] = 'b.product_id = ?';
    $params[] = $q['product_id'];
}

if (!empty($q['lab_status']) && in_array($q['lab_status'], ['passed', 'pending', 'failed'], true)) {
    $where[] = 'b.lab_status = ?';
    $params[] = $q['lab_status'];
}

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(b.lot_code LIKE ? OR p.name LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like);
}

/* "Expiring within N days" includes anything already expired — a lot that went
   out of date last week is more urgent than one going out next week, and
   dropping it from the view is how expired stock stays on a shelf. */
if (isset($q['expiring_within']) && $q['expiring_within'] !== '') {
    $where[] = 'DATEDIFF(b.expiry_date, CURDATE()) < ?';
    $params[] = (int) $q['expiring_within'];
}

/* Named expiry bands, matching expiryInfo() in assets/js/portal/inventory.js
   exactly. The Expiration Monitoring screen filters on these; applying them to
   a page after it arrived meant "show me everything expired" returned only the
   expired lots that happened to land on the current page, and the row count
   above the table disagreed with the rows in it. If a threshold moves here,
   move it there too. */
$level = (string) ($q['level'] ?? '');
if ($level !== '' && $level !== 'all') {
    $bands = [
        'gone' => 'DATEDIFF(b.expiry_date, CURDATE()) < 0',
        'crit' => 'DATEDIFF(b.expiry_date, CURDATE()) BETWEEN 0 AND 29',
        'warn' => 'DATEDIFF(b.expiry_date, CURDATE()) BETWEEN 30 AND 89',
        'ok'   => 'DATEDIFF(b.expiry_date, CURDATE()) >= 90',
    ];
    if (!isset($bands[$level])) {
        Response::validation('Unknown expiry band.', ['level' => 'Use gone, crit, warn or ok.']);
    }
    $where[] = $bands[$level];
}

$sortMap = [
    'expiry'    => 'b.expiry_date ASC',
    'latest'    => 'b.expiry_date DESC',
    'lot'       => 'b.lot_code DESC',
    'product'   => 'p.name ASC, b.expiry_date ASC',
    'remaining' => 'b.remaining_qty ASC',
];
$order = $sortMap[$q['sort'] ?? 'expiry'] ?? $sortMap['expiry'];

$sql = 'FROM batches b JOIN products p ON p.id = b.product_id';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

$rows = Database::all(
    "SELECT b.id, b.lot_code, b.product_id, p.name AS product_name,
            b.harvest_date, b.production_date, b.expiry_date,
            b.total_qty, b.remaining_qty, b.quality_grade, b.lab_status,
            b.qa_inspector, b.notes,
            DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry
     $sql
     ORDER BY $order
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

$batches = array_map(static function (array $r): array {
    $days = (int) $r['days_to_expiry'];
    return [
        'id'           => $r['id'],
        'lotCode'      => $r['lot_code'],
        'productId'    => $r['product_id'],
        'productName'  => $r['product_name'],
        'harvestDate'  => $r['harvest_date'],
        'prodDate'     => $r['production_date'],
        'expiryDate'   => $r['expiry_date'],
        'totalQty'     => (int) $r['total_qty'],
        'remainingQty' => (int) $r['remaining_qty'],
        'qualityGrade' => $r['quality_grade'],
        'labStatus'    => $r['lab_status'],
        'qaInspector'  => $r['qa_inspector'],
        'notes'        => $r['notes'],
        'daysToExpiry' => $days,
        /* Banded here so the same thresholds apply everywhere the figure is
           shown, instead of each screen re-deciding what "critical" means. */
        'expiryLevel'  => $days < 0 ? 'gone' : ($days < 30 ? 'crit' : ($days < 90 ? 'warn' : 'ok')),
    ];
}, $rows);

Response::ok($batches, [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
    'today' => date('Y-m-d'),
    /* The code the next lot WOULD be assigned, so the restock and replenish
       forms can prefill it and let the operator see — and override — what they
       are about to create.

       Carried on this response rather than given an endpoint of its own: the
       inventory screens already load this list on entry and reload it after
       every stock movement, so the suggestion refreshes exactly when it goes
       stale, at no extra request. It is a SUGGESTION and nothing more; the
       code that actually lands is decided by inventory/adjust.php at save
       time, which re-derives it and rejects a duplicate. Two operators reading
       the same suggestion cannot both write it. */
    'nextLotCode' => Inventory::nextLotCode(),
]);
