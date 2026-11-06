<?php
declare(strict_types=1);

/** GET /api/vat/summary.php (Super Admin only) totals VAT-return figures for a period from what each non-cancelled order stored, dated by invoice date (unlike revenue, which waits for payment). */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::requireSystemRole('vat.manage');

$where  = ["o.status <> 'cancelled'"];
$params = [];
foreach (['from' => '>=', 'to' => '<='] as $key => $op) {
    $value = trim((string) ($_GET[$key] ?? ''));
    if ($value === '') {
        continue;
    }
    $d = DateTime::createFromFormat('Y-m-d', $value);
    if (!$d || $d->format('Y-m-d') !== $value) {
        Response::validation('Check the date range.', [$key => 'Use YYYY-MM-DD.']);
    }
    $where[]  = "o.date $op ?";
    $params[] = $value;
}
$sql = 'WHERE ' . implode(' AND ', $where);

$sums = "COUNT(*)                                        AS invoices,
         COALESCE(SUM(o.gross_total), 0)                 AS gross_sales,
         COALESCE(SUM(o.vatable_sales), 0)               AS vatable_sales,
         COALESCE(SUM(o.vat_amount), 0)                  AS output_vat,
         COALESCE(SUM(o.vat_exempt_sales), 0)            AS vat_exempt_sales,
         COALESCE(SUM(o.total), 0)                       AS total_sales,
         SUM(o.sc_pwd_type IS NOT NULL)                  AS sc_pwd_count,
         COALESCE(SUM(o.sc_pwd_discount), 0)             AS sc_pwd_discount,
         SUM(o.withholding_tax > 0)                      AS withholding_count,
         COALESCE(SUM(o.withholding_tax), 0)             AS withholding_tax";

$shape = static fn(array $r): array => [
    'invoices'         => (int) $r['invoices'],
    'grossSales'       => round((float) $r['gross_sales'], 2),
    'vatableSales'     => round((float) $r['vatable_sales'], 2),
    'outputVat'        => round((float) $r['output_vat'], 2),
    'zeroRatedSales'   => 0.0,
    'vatExemptSales'   => round((float) $r['vat_exempt_sales'], 2),
    'totalSales'       => round((float) $r['total_sales'], 2),
    'scPwdCount'       => (int) $r['sc_pwd_count'],
    'scPwdDiscount'    => round((float) $r['sc_pwd_discount'], 2),
    'withholdingCount' => (int) $r['withholding_count'],
    'withholdingTax'   => round((float) $r['withholding_tax'], 2),
];

$total = Database::one("SELECT $sums FROM orders o $sql", $params);

$months = Database::all(
    "SELECT DATE_FORMAT(o.date, '%Y-%m') AS month, $sums
       FROM orders o $sql
      GROUP BY DATE_FORMAT(o.date, '%Y-%m')
      ORDER BY month DESC",
    $params
);

/* Split by senior citizen and PWD: the BIR schedules them separately. */
$byType = [];
foreach (Database::all(
    "SELECT o.sc_pwd_type AS type, COUNT(*) AS n, COALESCE(SUM(o.sc_pwd_discount), 0) AS discount
       FROM orders o $sql AND o.sc_pwd_type IS NOT NULL
      GROUP BY o.sc_pwd_type",
    $params
) as $r) {
    $byType[$r['type']] = ['count' => (int) $r['n'], 'discount' => round((float) $r['discount'], 2)];
}

Response::ok([
    'totals' => $shape($total),
    'months' => array_map(static fn(array $r): array => ['month' => $r['month']] + $shape($r), $months),
    'scPwd'  => [
        'senior' => $byType['senior'] ?? ['count' => 0, 'discount' => 0.0],
        'pwd'    => $byType['pwd']    ?? ['count' => 0, 'discount' => 0.0],
    ],
]);
