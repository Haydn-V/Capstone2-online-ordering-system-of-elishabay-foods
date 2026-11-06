<?php
declare(strict_types=1);

/** Reads an expenses spreadsheet (.xlsx, .xls, .csv, .ods) and works out which column holds the amounts, which the
    description and category, which rows are totals to skip, and the totals per expense category. No database and no
    $_FILES, so tools/expense-import-test.php can run it from the command line. The browser has a copy of the mapping
    rules (EXPENSE_RULES in assets/js/portal/sales-export.js); keep the keyword lists the same in both. */

use PhpOffice\PhpSpreadsheet\Cell\Cell;
use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\RichText\RichText;
use PhpOffice\PhpSpreadsheet\Shared\Date as XlDate;

/** A file the importer refuses; the message is shown to the user as is. */
final class ExpenseImportException extends RuntimeException {}

final class ExpenseImport
{
    public const MAX_BYTES   = 2 * 1024 * 1024;
    public const MAX_ROWS    = 2000;
    public const MAX_COLS    = 30;
    public const HEADER_SCAN = 15;

    /** Extension => PhpSpreadsheet reader. */
    public const TYPES = ['xlsx' => 'Xlsx', 'xls' => 'Xls', 'csv' => 'Csv', 'ods' => 'Ods'];

    public const CATEGORIES = ['materials', 'salaries', 'utilities', 'delivery', 'other'];

    /** Header words, matched as whole words after normalize(). */
    public const HEADER_WORDS = [
        'amount'      => ['amount', 'total', 'cost', 'expense', 'expenses', 'halaga', 'debit', 'value', 'php', '₱',
                          'net amount', 'total cost', 'amount paid'],
        'description' => ['description', 'particulars', 'item', 'details', 'expense', 'purpose', 'remarks', 'payee',
                          'paid to', 'name'],
        'category'    => ['category', 'type', 'account', 'classification', 'kind', 'uri'],
        'date'        => ['date', 'petsa', 'day', 'txn date'],
        /* Never the amount column, even when numeric. */
        'exclude'     => ['qty', 'quantity', 'pcs', 'unit', 'units', 'no', '#', 'ref', 'reference', 'or no',
                          'invoice no', 'receipt', 'date', 'percent', '%'],
    ];

    /** A row whose description or first text cell has one of these is a total, not an expense. */
    public const TOTAL_WORDS = ['total', 'subtotal', 'sub total', 'grand total', 'kabuuan', 'sum', 'balance forward',
                                'carried forward', 'beginning balance'];

    /** Category guess from a category cell or the description; a plural (-s/-es) also matches. */
    public const CATEGORY_WORDS = [
        'materials' => ['bangus', 'fish', 'milkfish', 'tuyo', 'oil', 'olive', 'garlic', 'vinegar', 'suka', 'spice',
                        'ingredient', 'bottle', 'jar', 'lid', 'cap', 'label', 'sticker', 'packaging', 'box', 'carton',
                        'plastic', 'raw', 'material', 'materials'],
        'salaries'  => ['salary', 'salaries', 'wage', 'wages', 'sweldo', 'sahod', 'payroll', 'allowance', '13th', 'sss',
                        'philhealth', 'pag ibig', 'pagibig', 'overtime', 'ot'],
        'utilities' => ['meralco', 'electric', 'electricity', 'kuryente', 'water', 'tubig', 'maynilad', 'rent', 'upa',
                        'internet', 'pldt', 'globe', 'converge', 'lpg', 'gas', 'phone', 'load', 'utility', 'utilities'],
        'delivery'  => ['lbc', 'courier', 'shipping', 'delivery', 'freight', 'jnt', 'j&t', 'lalamove', 'grab',
                        'transport', 'fare', 'toll', 'fuel', 'diesel', 'gasoline'],
    ];

    /* ------------------------------------------------------------------ reading */

    /** Load every sheet as a grid of trimmed strings / numbers (dates as Y-m-d), capped at MAX_ROWS x MAX_COLS. */
    public static function read(string $path, string $originalName): array
    {
        $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        if (!isset(self::TYPES[$ext])) {
            throw new ExpenseImportException("This file type isn't supported. Upload .xlsx, .xls, .csv or .ods.");
        }
        if (!is_file($path) || filesize($path) === 0) {
            throw new ExpenseImportException('The file is empty.');
        }
        if (filesize($path) > self::MAX_BYTES) {
            throw new ExpenseImportException('The file is larger than 2 MB.');
        }

        /* .xlsx and .ods are zip files; without PHP's zip extension they cannot be opened at all. */
        if (in_array($ext, ['xlsx', 'ods'], true) && !class_exists('ZipArchive')) {
            throw new ExpenseImportException('This server cannot read .xlsx or .ods files yet (the PHP zip extension is off). Upload .csv or .xls, or ask the administrator to enable zip.');
        }
        $reader = IOFactory::createReader(self::TYPES[$ext]);
        /* The real type must match the extension: a renamed text file fails here or on load. */
        if (!$reader->canRead($path)) {
            throw new ExpenseImportException("This file type isn't supported. Upload .xlsx, .xls, .csv or .ods.");
        }
        try {
            $book = $reader->load($path);
        } catch (Throwable $e) {
            throw new ExpenseImportException("We couldn't open this file. Save it again as .xlsx, .xls, .csv or .ods and retry.");
        }

        $sheets = [];
        foreach ($book->getWorksheetIterator() as $ws) {
            $maxRow = $ws->getHighestDataRow();
            $maxCol = Coordinate::columnIndexFromString($ws->getHighestDataColumn());
            if ($maxCol > self::MAX_COLS) {
                throw new ExpenseImportException(sprintf('Sheet "%s" has more than %d columns.', $ws->getTitle(), self::MAX_COLS));
            }
            if ($maxRow > self::MAX_ROWS) {
                throw new ExpenseImportException(sprintf('Sheet "%s" has more than %s rows.', $ws->getTitle(), number_format(self::MAX_ROWS)));
            }
            $grid = [];
            for ($r = 1; $r <= $maxRow; $r++) {
                $row = [];
                for ($c = 1; $c <= $maxCol; $c++) {
                    $row[] = self::cellValue($ws->getCell([$c, $r]));
                }
                $grid[] = $row;
            }
            /* Trailing empty rows add nothing. */
            while ($grid && self::isEmptyRow(end($grid))) {
                array_pop($grid);
            }
            $sheets[] = ['name' => $ws->getTitle(), 'grid' => $grid];
        }
        $book->disconnectWorksheets();
        return $sheets;
    }

    /** One cell: the calculated value of a formula, a date as Y-m-d, text trimmed; merged cells keep only the top-left value. */
    private static function cellValue(Cell $cell): string|int|float
    {
        try {
            $v = $cell->getCalculatedValue();
        } catch (Throwable) {
            $v = $cell->getOldCalculatedValue();
        }
        if ($v instanceof RichText) {
            $v = $v->getPlainText();
        }
        if ($v === null || is_bool($v)) {
            return '';
        }
        if ((is_int($v) || is_float($v)) && XlDate::isDateTime($cell)) {
            try {
                return XlDate::excelToDateTimeObject((float) $v)->format('Y-m-d');
            } catch (Throwable) {
                return $v;
            }
        }
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        return trim((string) $v);
    }

    /* ------------------------------------------------------------------ rules */

    /** Lowercase, punctuation as spaces (₱ % # & kept), single spaces. */
    public static function normalize(string $s): string
    {
        $s = mb_strtolower($s);
        $s = str_replace(['₱', '%', '#'], [' ₱ ', ' % ', ' # '], $s);
        $s = preg_replace('/[^\p{L}\p{N}₱%#&]+/u', ' ', $s) ?? '';
        return trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    }

    /** Whether $phrase occurs as whole words in normalized $text; $plural also accepts -s / -es on the last word. */
    public static function hasPhrase(string $text, string $phrase, bool $plural = false): bool
    {
        $p = preg_quote(self::normalize($phrase), '/');
        if ($p === '') {
            return false;
        }
        return (bool) preg_match('/(?:^| )' . $p . ($plural ? '(?:e?s)?' : '') . '(?= |$)/u', $text);
    }

    private static function hasAny(string $text, array $phrases, bool $plural = false): bool
    {
        foreach ($phrases as $p) {
            if (self::hasPhrase($text, $p, $plural)) {
                return true;
            }
        }
        return false;
    }

    /** Money from a cell: numbers; ₱ / PHP / a leading P; thousands commas; (1,234.50) and -1234.5 as negative. Null when not money. */
    public static function money(mixed $v): ?float
    {
        if (is_int($v) || is_float($v)) {
            return round((float) $v, 2);
        }
        if (!is_string($v)) {
            return null;
        }
        $s = trim($v);
        if ($s === '' || in_array(mb_strtolower($s), ['-', '—', 'n/a'], true)) {
            return null;
        }
        $neg = false;
        if (preg_match('/^\((.*)\)$/u', $s, $m)) {
            $neg = true;
            $s = trim($m[1]);
        }
        if (str_starts_with($s, '-')) {
            $neg = !$neg;
            $s = trim(substr($s, 1));
        }
        $s = preg_replace('/^(₱|php|p)\s*/iu', '', $s) ?? '';
        $s = str_replace(' ', '', $s);
        if (str_starts_with($s, '-')) {   /* ₱-500 */
            $neg = !$neg;
            $s = substr($s, 1);
        }
        /* 1,234.50 or 1234.5; European 1.234,50 is not supported. */
        if (!preg_match('/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/', $s)) {
            return null;
        }
        $n = (float) str_replace(',', '', $s);
        return round($neg ? -$n : $n, 2);
    }

    /** Category from text: the category with the most keyword hits; a tie goes to the earlier category; no hit is "other". */
    public static function guessCategory(string $text): ?string
    {
        $t = self::normalize($text);
        if ($t === '') {
            return null;
        }
        $best = null;
        $bestHits = 0;
        foreach (self::CATEGORY_WORDS as $cat => $words) {
            $hits = 0;
            foreach ($words as $w) {
                if (self::hasPhrase($t, $w, true)) {
                    $hits++;
                }
            }
            if ($hits > $bestHits) {
                $best = $cat;
                $bestHits = $hits;
            }
        }
        return $best;
    }

    /** A header cell: short text made only of header words (so a title or an expense line never counts). */
    private static function isHeaderCell(mixed $v): bool
    {
        if (!is_string($v) || $v === '' || mb_strlen($v) > 30 || self::money($v) !== null) {
            return false;
        }
        $t = self::normalize($v);
        if ($t === '') {
            return false;
        }
        static $tokens = null;
        if ($tokens === null) {
            $tokens = [];
            foreach (self::HEADER_WORDS as $list) {
                foreach ($list as $phrase) {
                    foreach (explode(' ', self::normalize($phrase)) as $tok) {
                        $tokens[$tok] = true;
                    }
                }
            }
        }
        foreach (explode(' ', $t) as $tok) {
            if (!isset($tokens[$tok])) {
                return false;
            }
        }
        return true;
    }

    private static function isEmptyRow(array $row): bool
    {
        foreach ($row as $v) {
            if ($v !== '' && $v !== null) {
                return false;
            }
        }
        return true;
    }

    private static function isText(mixed $v): bool
    {
        return is_string($v) && $v !== '' && self::money($v) === null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $v);
    }

    private static function colName(int $i): string
    {
        return 'Column ' . Coordinate::stringFromColumnIndex($i + 1);
    }

    /* ------------------------------------------------------------------ detection */

    /** Header row, columns, suggested mapping and confidence for one sheet's grid. */
    public static function detectSheet(array $grid): array
    {
        $width = 0;
        foreach ($grid as $row) {
            $width = max($width, count($row));
        }

        /* 1. Header: the best of the first HEADER_SCAN non-empty rows, scored by header cells. */
        $header = null;
        $bestScore = 0;
        $seen = 0;
        foreach ($grid as $i => $row) {
            if (self::isEmptyRow($row)) {
                continue;
            }
            if (++$seen > self::HEADER_SCAN) {
                break;
            }
            $score = count(array_filter($row, [self::class, 'isHeaderCell']));
            if ($score > $bestScore) {
                $bestScore = $score;
                $header = $i;
            }
        }

        $labels = [];
        for ($c = 0; $c < $width; $c++) {
            $h = $header !== null ? ($grid[$header][$c] ?? '') : '';
            $labels[$c] = is_string($h) && $h !== '' ? $h : ($h !== '' ? (string) $h : self::colName($c));
        }
        $norm = array_map(
            static fn(int $c): string => $header !== null ? self::normalize((string) ($grid[$header][$c] ?? '')) : '',
            range(0, max(0, $width - 1))
        );

        $data = self::dataRows($grid, $header);
        $n = max(1, count($data));

        /* 2. Amount: mostly money, not an excluded header; header words and being rightmost add to the score. */
        $cands = [];
        for ($c = 0; $c < $width; $c++) {
            if ($header !== null && self::hasAny($norm[$c], self::HEADER_WORDS['exclude'])) {
                continue;
            }
            $hits = 0;
            foreach ($data as $i) {
                if (self::money($grid[$i][$c] ?? '') !== null) {
                    $hits++;
                }
            }
            $share = $hits / $n;
            if ($share >= 0.6) {
                $cands[$c] = $share + (self::hasAny($norm[$c], self::HEADER_WORDS['amount']) ? 1.0 : 0.0);
            }
        }
        if ($cands) {
            $cands[max(array_keys($cands))] += 0.3;
        }
        arsort($cands);
        $amount = $cands ? array_key_first($cands) : null;
        $confidence = $amount === null ? 'none' : 'high';
        if (count($cands) > 1) {
            $top = reset($cands);
            $close = array_keys(array_filter($cands, static fn(float $s): bool => $top - $s <= 0.1));
            if (count($close) > 1) {
                $confidence = 'check';
                foreach ($close as $c) {
                    if (self::hasAny($norm[$c], ['amount', 'total', 'halaga'])) {
                        $amount = $c;
                        break;
                    }
                }
            }
        }

        /* No single amount column: maybe one column per category (salaries | raw materials | …) with amounts below. */
        if ($amount === null && ($wide = self::detectColumns($grid)) !== null) {
            return $wide;
        }

        /* 3. Description: a description header, else the leftmost column that is mostly plain text. */
        $desc = null;
        for ($c = 0; $c < $width; $c++) {
            if ($c !== $amount && $header !== null && self::hasAny($norm[$c], self::HEADER_WORDS['description'])) {
                $desc = $c;
                break;
            }
        }
        if ($desc === null) {
            for ($c = 0; $c < $width; $c++) {
                if ($c === $amount) {
                    continue;
                }
                $text = 0;
                foreach ($data as $i) {
                    if (self::isText($grid[$i][$c] ?? '')) {
                        $text++;
                    }
                }
                if ($text / $n >= 0.5) {
                    $desc = $c;
                    break;
                }
            }
        }

        /* 4. Category (optional): a category header. */
        $cat = null;
        for ($c = 0; $c < $width; $c++) {
            if ($c !== $amount && $c !== $desc && $header !== null && self::hasAny($norm[$c], self::HEADER_WORDS['category'])) {
                $cat = $c;
                break;
            }
        }

        return [
            'headerRow'  => $header === null ? null : $header + 1,
            'columns'    => array_map(static fn(int $c): array => ['index' => $c, 'label' => $labels[$c]], array_keys($labels)),
            'mapping'    => ['amount' => $amount, 'description' => $desc, 'category' => $cat],
            'confidence' => $confidence,
        ];
    }

    /** "Category per column" layout: a row of category names (at least two that name a category, or "other") with
        money under them. Returns the same shape as detectSheet() with mapping.columns set, or null. */
    private static function detectColumns(array $grid): ?array
    {
        $seen = 0;
        foreach ($grid as $i => $row) {
            if (self::isEmptyRow($row)) {
                continue;
            }
            if (++$seen > self::HEADER_SCAN) {
                break;
            }
            $cols = [];
            foreach ($row as $c => $v) {
                if (self::isText($v) && (self::guessCategory($v) !== null || self::hasPhrase(self::normalize($v), 'other'))) {
                    $cols[] = $c;
                }
            }
            if (count($cols) < 2) {
                continue;
            }
            /* Money under at least two of those columns. */
            $data = self::dataRows($grid, $i);
            if ($data === []) {
                continue;
            }
            $withMoney = array_values(array_filter($cols, static function (int $c) use ($grid, $data): bool {
                $hits = 0;
                foreach ($data as $r) {
                    if (self::money($grid[$r][$c] ?? '') !== null) {
                        $hits++;
                    }
                }
                return $hits / count($data) >= 0.6;
            }));
            if (count($withMoney) < 2) {
                continue;
            }
            $width = 0;
            foreach ($grid as $r) {
                $width = max($width, count($r));
            }
            $columns = [];
            for ($c = 0; $c < $width; $c++) {
                $h = $row[$c] ?? '';
                $columns[] = ['index' => $c, 'label' => $h !== '' ? (string) $h : self::colName($c)];
            }
            return [
                'headerRow'  => $i + 1,
                'columns'    => $columns,
                'mapping'    => ['amount' => null, 'description' => null, 'category' => null, 'columns' => $withMoney],
                'confidence' => 'check',
            ];
        }
        return null;
    }

    /** Row indexes after the header that have anything in them. */
    private static function dataRows(array $grid, ?int $header): array
    {
        $out = [];
        foreach ($grid as $i => $row) {
            if (($header === null || $i > $header) && !self::isEmptyRow($row)) {
                $out[] = $i;
            }
        }
        return $out;
    }

    /** Apply a mapping: counted rows, skipped rows with a reason, and totals per category. $headerRow is 1-based or null. */
    public static function apply(array $grid, ?int $headerRow, array $mapping): array
    {
        $header = $headerRow === null ? null : $headerRow - 1;
        $a = $mapping['amount'] ?? null;
        $d = $mapping['description'] ?? null;
        $k = $mapping['category'] ?? null;

        $rows = [];
        $skipped = [];
        $totals = array_fill_keys(self::CATEGORIES, 0.0);

        /* Category per column: every amount under a category column counts toward that column's category. */
        $wide = $mapping['columns'] ?? null;
        if (is_array($wide) && $wide !== []) {
            $head = $header !== null ? $grid[$header] : [];
            foreach (self::dataRows($grid, $header) as $i) {
                $row = $grid[$i];
                $firstText = '';
                foreach ($row as $v) {
                    if (self::isText($v)) { $firstText = $v; break; }
                }
                if (self::hasAny(self::normalize($firstText), self::TOTAL_WORDS)) {
                    $skipped[] = ['row' => $i + 1, 'reason' => 'total row', 'text' => $firstText];
                    continue;
                }
                $found = 0;
                foreach ($wide as $c) {
                    $amt = self::money($row[$c] ?? '');
                    if ($amt === null) {
                        continue;
                    }
                    $label = trim((string) ($head[$c] ?? ''));
                    $category = self::guessCategory($label) ?? 'other';
                    $rows[] = ['row' => $i + 1, 'description' => $label, 'amount' => $amt, 'category' => $category, 'skip' => null];
                    $totals[$category] += $amt;
                    $found++;
                }
                if ($found === 0) {
                    $skipped[] = ['row' => $i + 1, 'reason' => 'no amount', 'text' => $firstText];
                }
            }
            $totals = array_map(static fn(float $v): float => round($v, 2), $totals);
            $totals['all'] = round(array_sum($totals), 2);
            return ['rows' => $rows, 'skipped' => $skipped, 'totals' => $totals];
        }

        foreach (self::dataRows($grid, $header) as $i) {
            $row = $grid[$i];
            $firstText = '';
            foreach ($row as $c => $v) {
                if ($c !== $a && self::isText($v)) {
                    $firstText = $v;
                    break;
                }
            }
            $desc = $d !== null ? trim((string) ($row[$d] ?? '')) : $firstText;
            $label = $desc !== '' ? $desc : $firstText;

            if (self::hasAny(self::normalize($desc), self::TOTAL_WORDS)
                || self::hasAny(self::normalize($firstText), self::TOTAL_WORDS)) {
                $skipped[] = ['row' => $i + 1, 'reason' => 'total row', 'text' => $label];
                continue;
            }
            $amt = $a !== null ? self::money($row[$a] ?? '') : null;
            if ($amt === null) {
                $skipped[] = ['row' => $i + 1, 'reason' => 'no amount', 'text' => $label];
                continue;
            }
            /* The category cell first; an empty or unknown one falls back to the description. */
            $category = null;
            if ($k !== null && trim((string) ($row[$k] ?? '')) !== '') {
                $category = self::guessCategory((string) $row[$k]);
            }
            $category ??= self::guessCategory($desc) ?? 'other';

            $rows[] = ['row' => $i + 1, 'description' => $desc, 'amount' => $amt, 'category' => $category, 'skip' => null];
            $totals[$category] += $amt;
        }

        $totals = array_map(static fn(float $v): float => round($v, 2), $totals);
        $totals['all'] = round(array_sum($totals), 2);
        return ['rows' => $rows, 'skipped' => $skipped, 'totals' => $totals];
    }

    /** Detect every sheet, suggest the first one with an amount column (or use $sheet), and apply its mapping. */
    public static function detect(array $sheets, ?int $sheet = null): array
    {
        if ($sheets === []) {
            throw new ExpenseImportException('The file has no sheets.');
        }
        $found = array_map(static fn(array $s): array => self::detectSheet($s['grid']), $sheets);
        if ($sheet === null || !isset($sheets[$sheet])) {
            $sheet = 0;
            foreach ($found as $i => $f) {
                if ($f['confidence'] !== 'none') {
                    $sheet = $i;
                    break;
                }
            }
        }
        $f = $found[$sheet];
        return [
            'sheets'     => array_column($sheets, 'name'),
            'sheet'      => $sheet,
            'headerRow'  => $f['headerRow'],
            'columns'    => $f['columns'],
            'mapping'    => $f['mapping'],
            'confidence' => $f['confidence'],
        ] + self::apply($sheets[$sheet]['grid'], $f['headerRow'], $f['mapping']);
    }
}
