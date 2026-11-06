<?php
declare(strict_types=1);

/** GET /api/batches/list.php (needs batches.manage or inventory.report) lists lots, with days_to_expiry computed by MySQL so every screen uses the server's real date. */

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

/* "Expiring within N days" also includes already-expired lots, since those are the most urgent. */
if (isset($q['expiring_within']) && $q['expiring_within'] !== '') {
    $where[] = 'DATEDIFF(b.expiry_date, CURDATE()) < ?';
    $params[] = (int) $q['expiring_within'];
}

/* Expiry bands must match expiryInfo() in assets/js/portal/inventory.js exactly, and are applied here so filters and counts cover all rows, not just one page. */
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
        /* Band the figure here so every screen uses the same "critical" thresholds. */
        'expiryLevel'  => $days < 0 ? 'gone' : ($days < 30 ? 'crit' : ($days < 90 ? 'warn' : 'ok')),
    ];
}, $rows);

Response::ok($batches, [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
    'today' => date('Y-m-d'),
    /* Suggest the next lot code so restock forms can prefill it, while inventory/adjust.php still decides the real code at save time and rejects duplicates. */
    'nextLotCode' => Inventory::nextLotCode(),
]);
