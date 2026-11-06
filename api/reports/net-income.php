<?php
declare(strict_types=1);

/** POST /api/reports/net-income.php (needs reports.financial) {from, to, expenses: {materials, salaries, utilities,
    delivery, other}, source: {type: "typed"|"file", fileName?, rowCount?}} returns the income statement printed in the
    Sales Report export. Every figure is worked out here from stored order values (the browser's numbers are never
    printed): gross sales = the export's sales for the period, less refunds paid out, less output VAT, less retailer
    discounts, = net sales; less expenses = net income. Writes one audit entry; nothing else is saved. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$user = Rbac::require('reports.financial');
$in   = Response::input();

/* Dates checked exactly like api/reports/sales-export.php. */
foreach (['from', 'to'] as $k) {
    $d = DateTime::createFromFormat('Y-m-d', (string) ($in[$k] ?? ''));
    if (!$d || $d->format('Y-m-d') !== ($in[$k] ?? null)) {
        Response::validation('Check the date range.', [$k => 'Use YYYY-MM-DD.']);
    }
}
$from = (string) $in['from'];
$to   = (string) $in['to'];
if ($from > $to) {
    Response::validation('Check the date range.', ['from' => 'Start date is after the end date.']);
}

/* The five expense categories, in print order. */
const EXPENSE_LABELS = [
    'materials' => 'Raw materials & packaging',
    'salaries'  => 'Salaries & wages',
    'utilities' => 'Utilities & rent',
    'delivery'  => 'Delivery & courier',
    'other'     => 'Other expenses',
];
$expIn    = is_array($in['expenses'] ?? null) ? $in['expenses'] : [];
$expenses = [];
$errors   = [];
foreach (EXPENSE_LABELS as $key => $label) {
    $v = $expIn[$key] ?? '';
    if ($v === '' || $v === null) {
        $expenses[$key] = 0.0;
        continue;
    }
    if (!is_numeric($v) || (float) $v < 0 || (float) $v > 100000000) {
        $errors["expenses.$key"] = "$label must be a number from 0 to 100,000,000.";
        continue;
    }
    $expenses[$key] = round((float) $v, 2);
}
if ($errors) {
    Response::validation('Check the expense amounts.', $errors);
}

$src  = is_array($in['source'] ?? null) ? $in['source'] : [];
$type = ($src['type'] ?? 'typed') === 'file' ? 'file' : 'typed';
$fileName = $type === 'file' ? mb_substr(basename(trim((string) ($src['fileName'] ?? ''))), 0, 120) : '';
$rowCount = $type === 'file' ? max(0, (int) ($src['rowCount'] ?? 0)) : 0;
$sourceText = $type === 'file' && $fileName !== ''
    ? sprintf('%s (%d %s)', $fileName, $rowCount, $rowCount === 1 ? 'row' : 'rows')
    : 'typed';

/* ---- sales side: the export's sale set and dates (Revenue::saleClause), from what each order stored ---- */
[$saleSql, $saleParams] = Revenue::saleClause('o');
$sales = Database::one(
    "SELECT COALESCE(SUM(o.total), 0)           AS gross,
            COALESCE(SUM(o.vat_amount), 0)      AS vat,
            COALESCE(SUM(o.withholding_tax), 0) AS discounts
       FROM orders o
      WHERE $saleSql AND o.date BETWEEN ? AND ?",
    array_merge($saleParams, [$from, $to])
);

/* Refunds paid out in the period, the same query as the export's "refunds" line. */
[$refClause, $refParams] = Revenue::refundClause('r');
$refDate = Revenue::refundDateSql('r');
$refunds = (float) Database::scalar(
    "SELECT COALESCE(SUM(r.refund_amount), 0) FROM product_returns r WHERE $refClause AND $refDate BETWEEN ? AND ?",
    array_merge($refParams, [$from, $to])
);

$gross     = round((float) $sales['gross'], 2);
$vat       = round((float) $sales['vat'], 2);
$discounts = round((float) $sales['discounts'], 2);
$refunds   = round($refunds, 2);
/* orders.total is VAT-inclusive and before the retailer discount (Tax::compute keeps it apart), so both come off here. */
$netSales  = round($gross - $refunds - $vat - $discounts, 2);
$totalExp  = round(array_sum($expenses), 2);
$netIncome = round($netSales - $totalExp, 2);

/* Lines in print order; kind: line, less (subtracted), total (after a rule). */
$lines = [
    ['key' => 'gross',     'label' => 'Gross sales',                       'amount' => $gross,     'kind' => 'line'],
    ['key' => 'refunds',   'label' => 'Less: refunds paid in the period',  'amount' => $refunds,   'kind' => 'less'],
    ['key' => 'vat',       'label' => 'Less: output VAT',                  'amount' => $vat,       'kind' => 'less'],
    ['key' => 'discounts', 'label' => 'Less: retailer discounts',          'amount' => $discounts, 'kind' => 'less'],
    ['key' => 'netSales',  'label' => 'Net sales (VAT-exclusive)',         'amount' => $netSales,  'kind' => 'total'],
];
foreach (EXPENSE_LABELS as $key => $label) {
    $lines[] = ['key' => "exp.$key", 'label' => "Less: $label", 'amount' => $expenses[$key], 'kind' => 'less', 'indent' => true];
}
$lines[] = ['key' => 'expenses', 'label' => 'Total expenses', 'amount' => $totalExp, 'kind' => 'less'];
$lines[] = [
    'key'    => 'netIncome',
    'label'  => $netIncome < 0 ? 'Net loss (before income tax)' : 'Net income (before income tax)',
    'amount' => $netIncome,
    'kind'   => 'total',
];

$peso = static fn(float $n): string => ($n < 0 ? '-' : '') . '₱' . number_format(abs($n), 2);
Database::run(
    'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description) VALUES (NOW(), ?, ?, ?, ?)',
    [$user['name'], $user['id'], 'report', sprintf(
        'Net income report generated for %s–%s: net sales %s, expenses %s, %s %s (source: %s).',
        $from, $to, $peso($netSales), $peso($totalExp), $netIncome < 0 ? 'net loss' : 'net income',
        $peso(abs($netIncome)), $sourceText
    )]
);

Response::ok([
    'range'     => ['from' => $from, 'to' => $to],
    'lines'     => $lines,
    'netIncome' => $netIncome,
    'isLoss'    => $netIncome < 0,
    'expenses'  => $expenses,
    'source'    => ['type' => $type, 'text' => $sourceText],
    'enteredBy' => $user['name'],
    'enteredAt' => date('Y-m-d H:i'),
]);
