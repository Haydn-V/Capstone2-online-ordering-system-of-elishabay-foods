<?php
declare(strict_types=1);

/**
 * GET /api/b2b/list.php?status=&search=&page=&limit=
 *
 * Requires b2b.review. Retail partner applications.
 *
 * The stored username and password hash are never selected — an application
 * carries proposed credentials, and there is no reason for those to travel to
 * a reviewer's browser.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('b2b.review');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

if (!empty($q['status']) && in_array($q['status'], ['pending','approved','rejected'], true)) {
    $where[] = 'b.status = ?';
    $params[] = $q['status'];
}
$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(b.app_id_code LIKE ? OR b.business_name LIKE ? OR b.applicant_name LIKE ? OR b.email LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like, $like);
}

$sql = 'FROM b2b_applications b';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

$rows = Database::all(
    "SELECT b.id, b.app_id_code, b.customer_id, b.business_name, b.applicant_name,
            b.email, b.phone, b.business_type, b.bir_tin, b.business_address,
            b.requested_terms, b.monthly_volume, b.notes, b.submitted_date,
            b.status, b.assigned_tier, b.rejection_reason
     $sql
     ORDER BY b.submitted_date DESC, b.id DESC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    $params
);

$counts = [];
foreach (Database::all('SELECT status, COUNT(*) n FROM b2b_applications GROUP BY status') as $c) {
    $counts[$c['status']] = (int) $c['n'];
}

Response::ok(array_map(static fn(array $r): array => [
    'id'             => (int) $r['id'],
    'appId'          => $r['app_id_code'],
    'customerId'     => $r['customer_id'],
    'businessName'   => $r['business_name'],
    'applicantName'  => $r['applicant_name'],
    'email'          => $r['email'],
    'phone'          => $r['phone'],
    'businessType'   => $r['business_type'],
    'birTin'         => $r['bir_tin'],
    'address'        => $r['business_address'],
    'requestedTerms' => $r['requested_terms'],
    'monthlyVolume'  => $r['monthly_volume'],
    'notes'          => $r['notes'],
    'submittedDate'  => $r['submitted_date'],
    'status'         => $r['status'],
    'tier'           => $r['assigned_tier'],
    'reason'         => $r['rejection_reason'],
], $rows), [
    'page'   => $paging['page'],
    'limit'  => $paging['limit'],
    'total'  => $total,
    'pages'  => (int) ceil($total / $paging['limit']),
    'counts' => $counts,
]);
