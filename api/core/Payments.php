<?php
declare(strict_types=1);

/** Payments decides what each payment method means for an order in one place: an immediate sale sets the order's payment columns, while a credit (Net) sale also opens a receivable in payment_accounts. */

final class Payments
{
    /** Paid at the point of sale, or claimed to be and awaiting verification. */
    public const IMMEDIATE = ['cash', 'gcash', 'bank'];

    /** Credit terms paid later; the value is the number of days until due. */
    public const CREDIT = ['net30' => 30, 'net60' => 60, 'net90' => 90];

    /** Payment methods a caller may accept, with credit terms only when a retailer can be named. */
    public static function methods(bool $allowCredit): array
    {
        return $allowCredit
            ? array_merge(self::IMMEDIATE, array_keys(self::CREDIT))
            : self::IMMEDIATE;
    }

    public static function isCredit(string $method): bool
    {
        return isset(self::CREDIT[$method]);
    }

    /** Days until due for a credit method; 0 for anything immediate. */
    public static function termDays(string $method): int
    {
        return self::CREDIT[$method] ?? 0;
    }

    /** Check a GCash or bank reference number: GCash is 13 digits, bank is 6–20 letters or digits (spaces and
        dashes dropped), and a reference already on any order or non-rejected payment cannot be used again.
        Returns [cleaned reference, error or null]; other methods pass through untouched. */
    public static function checkRef(string $method, ?string $ref): array
    {
        if ($ref === null || !in_array($method, ['gcash', 'bank'], true)) {
            return [$ref, null];
        }
        $clean = strtoupper(str_replace([' ', '-'], '', $ref));
        if ($method === 'gcash' && !preg_match('/^\d{13}$/', $clean)) {
            return [$clean, 'GCash reference numbers are 13 digits.'];
        }
        if ($method === 'bank' && !preg_match('/^[A-Z0-9]{6,20}$/', $clean)) {
            return [$clean, "Enter the 6–20 character reference from your bank's confirmation."];
        }
        /* Older rows are compared the same way (spaces and dashes ignored), never changed. */
        $norm = "REPLACE(REPLACE(UPPER(%s), ' ', ''), '-', '')";
        $used = (int) Database::scalar(
            'SELECT (SELECT COUNT(*) FROM orders WHERE ' . sprintf($norm, 'proof_ref_num') . ' = ?)
                  + (SELECT COUNT(*) FROM credit_payments WHERE status <> ? AND ' . sprintf($norm, 'ref_num') . ' = ?)',
            [$clean, 'rejected', $clean]
        );
        return $used > 0 ? [$clean, 'This reference number has already been used. Check it against your receipt.'] : [$clean, null];
    }

    /** 'net30' -> 'Net 30', for payment_accounts.scheme and for audit text. */
    public static function schemeLabel(string $method): string
    {
        return self::isCredit($method)
            ? 'Net ' . self::termDays($method)
            : ucfirst($method);
    }

    /** Payment columns for an orders INSERT: proof_uploaded means the customer supplied a reference or image to check, and pay_verified is 1 only when staff saw the money at the till (never for online or credit). */
    public static function orderFields(
        string $method,
        ?string $refNum,
        ?string $proofPath,
        float $total,
        bool $atTill
    ): array {
        $hasProof = ($refNum !== null && $refNum !== '') || ($proofPath !== null && $proofPath !== '');

        if (self::isCredit($method)) {
            /* Credit sale: nothing paid yet, so no proof or amount here; the amount owed lives on the receivable. */
            return [
                'pay_verified'     => 0,
                'proof_uploaded'   => 0,
                'proof_ref_num'    => null,
                'proof_image_path' => null,
                'proof_amount'     => 0.0,
            ];
        }

        return [
            'pay_verified'     => $atTill ? 1 : 0,
            'proof_uploaded'   => $hasProof ? 1 : 0,
            'proof_ref_num'    => $refNum,
            'proof_image_path' => $proofPath,
            /* The amount the customer says they sent, set to the real order total so Payment Verification compares correctly. */
            'proof_amount'     => $hasProof ? $total : 0.0,
        ];
    }

    /** A cancelled order owes nothing, so close its Net account inside the caller's transaction: payments still
        waiting are rejected, and the account is removed when nothing was paid, or else billed only what was paid
        (and marked settled) so the money already received stays on record for a refund. */
    public static function closeForCancelledOrder(string $orderId): void
    {
        $acct = Database::one('SELECT id FROM payment_accounts WHERE order_id = ? FOR UPDATE', [$orderId]);
        if ($acct === null) {
            return;
        }
        Database::run(
            "UPDATE credit_payments SET status = 'rejected', reject_reason = 'The order was cancelled.', decided_at = NOW()
              WHERE account_id = ? AND status = 'pending'",
            [$acct['id']]
        );
        $paid = (float) Database::scalar(
            "SELECT COALESCE(SUM(amount), 0) FROM credit_payments WHERE account_id = ? AND status = 'verified'",
            [$acct['id']]
        );
        if ($paid <= 0) {
            Database::run('DELETE FROM credit_payments WHERE account_id = ?', [$acct['id']]);
            Database::run('DELETE FROM payment_accounts WHERE id = ?', [$acct['id']]);
        } else {
            Database::run('UPDATE payment_accounts SET balance = ?, paid = 1 WHERE id = ?', [$paid, $acct['id']]);
        }
    }

    /** Open a receivable for a credit sale inside the caller's transaction (alongside the order), with the due date computed by the database. */
    public static function openCreditAccount(
        string $orderId,
        array $customer,
        string $method,
        float $total
    ): array {
        if (!self::isCredit($method)) {
            throw new InvalidArgumentException("openCreditAccount called with immediate method '{$method}'.");
        }

        $days = self::termDays($method);
        $id   = self::nextAccountId();

        Database::run(
            'INSERT INTO payment_accounts
                    (id, customer_id, order_id, name, email, scheme, balance, due_date, paid)
             VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 0)',
            [
                $id,
                $customer['id'],
                $orderId,
                $customer['name'],
                $customer['email'] ?? null,
                self::schemeLabel($method),
                $total,
                $days,
            ]
        );

        $row = Database::one(
            'SELECT id, scheme, balance, due_date FROM payment_accounts WHERE id = ?',
            [$id]
        );

        return [
            'id'      => $row['id'],
            'scheme'  => $row['scheme'],
            'balance' => (float) $row['balance'],
            'dueDate' => $row['due_date'],
        ];
    }

    /* Retailer tiers and credit budgets: a tier's budget is the most a retailer may owe on Net terms at once (settings credit_limit_*; Super Admin edits them). */
    public const TIERS = ['Bronze', 'Silver', 'Gold'];
    public const TIER_DEFAULTS = ['Bronze' => 20000.0, 'Silver' => 50000.0, 'Gold' => 100000.0];

    /** Budget per tier, falling back to the defaults for a missing or invalid setting. */
    public static function creditLimits(): array
    {
        $stored = [];
        foreach (Database::all("SELECT key_name, value_text FROM settings WHERE key_name LIKE 'credit_limit_%'") as $r) {
            $stored[$r['key_name']] = $r['value_text'];
        }
        $out = [];
        foreach (self::TIER_DEFAULTS as $tier => $fallback) {
            $raw = $stored['credit_limit_' . strtolower($tier)] ?? null;
            $out[$tier] = is_numeric($raw) && (float) $raw >= 0 ? (float) $raw : $fallback;
        }
        return $out;
    }

    /** A retailer's tier, Bronze when none was ever set. */
    public static function tierFor(string $customerId): string
    {
        $tier = Database::scalar('SELECT retailer_tier FROM customers WHERE id = ?', [$customerId]);
        return in_array($tier, self::TIERS, true) ? $tier : 'Bronze';
    }

    /** What the retailer still owes across open Net accounts (penalties included), ignoring cancelled orders. */
    public static function creditUsed(string $customerId): float
    {
        $rate = self::penaltyRate();
        $used = 0.0;
        foreach (Database::all(
            self::accountSelect()
            . " LEFT JOIN orders o ON o.id = pa.order_id
               WHERE pa.customer_id = ? AND pa.paid = 0 AND (o.status IS NULL OR o.status <> 'cancelled')",
            [$customerId]
        ) as $r) {
            $a = self::describeAccount($r, $rate);
            if (!$a['settled']) { $used += $a['remaining']; }
        }
        return round($used, 2);
    }

    /** Tier, budget, amount used and amount left for one retailer. */
    public static function creditStanding(string $customerId): array
    {
        $tier  = self::tierFor($customerId);
        $limit = self::creditLimits()[$tier];
        $used  = self::creditUsed($customerId);
        return [
            'tier'      => $tier,
            'limit'     => $limit,
            'used'      => $used,
            'available' => max(0.0, round($limit - $used, 2)),
        ];
    }

    /** Why a new Net order of this amount cannot be placed (budget would be passed), or null when it fits. */
    public static function creditProblem(string $customerId, float $amount, bool $forStaff = false): ?string
    {
        $s = self::creditStanding($customerId);
        if (round($s['used'] + $amount, 2) <= $s['limit']) {
            return null;
        }
        $peso = static fn(float $n): string => '₱' . number_format($n, 2);
        return sprintf(
            '%s %s tier credit budget is %s, with %s still unpaid on Net terms, so only %s is left for a new Net order (this one is %s). '
            . '%s',
            $forStaff ? 'This retailer\'s' : 'Your',
            $s['tier'], $peso($s['limit']), $peso($s['used']), $peso($s['available']), $peso($amount),
            $forStaff
                ? 'Collect payment on their open Net balances first, or take this sale as cash, GCash or bank transfer.'
                : 'Pay your open Net balances first, or place this order on cash, GCash or bank transfer.'
        );
    }

    /* Retailer credit overdue and penalty rules, kept here so the retailer and staff screens always show the same amounts. */

    /** The configured late-payment penalty percentage, read from settings (one rate for every term). */
    public static function penaltyRate(): float
    {
        return (float) (Database::scalar(
            "SELECT value_text FROM settings WHERE key_name = 'penalty_rate'"
        ) ?? 2);
    }

    /* Interest for buying on terms: a Net order is money lent to the retailer, so the amount they owe is the amount due
       plus a one-time interest at the term's rate (Net 30 / 60 / 90, set by the Super Admin). It is shown in the checkout
       breakdown, stored on the order (term_interest_rate, term_interest, migration 037) and billed on the Net account. */
    public const INTEREST_DEFAULTS = ['net30' => 2.0, 'net60' => 3.0, 'net90' => 4.0];

    /** @return array<string,float> term => interest % */
    public static function interestRates(): array
    {
        $out = [];
        foreach (self::INTEREST_DEFAULTS as $term => $default) {
            $v = Database::scalar('SELECT value_text FROM settings WHERE key_name = ?', ["interest_rate_{$term}"]);
            $out[$term] = (float) ($v ?? $default);
        }
        return $out;
    }

    /** Whether orders can store the interest (migration 037 run). */
    public static function interestReady(): bool
    {
        static $ready = null;
        return $ready ??= Database::hasColumn('orders', 'term_interest');
    }

    /** Add the term's interest to a breakdown (Tax::compute, after the delivery fee): termInterestRate, termInterest,
        and a higher amountDue. Anything but a Net method, or before migration 037, adds nothing. */
    public static function applyInterest(array $tax, string $method): array
    {
        $tax['termInterestRate'] = null;
        $tax['termInterest']     = 0.0;
        if (!self::isCredit($method) || !self::interestReady()) {
            return $tax;
        }
        $rate = self::interestRates()[$method] ?? 0.0;
        if ($rate <= 0) {
            return $tax;
        }
        $interest = round((float) $tax['amountDue'] * $rate / 100, 2);
        $tax['termInterestRate'] = $rate;
        $tax['termInterest']     = $interest;
        $tax['termScheme']       = self::schemeLabel($method);
        $tax['amountDue']        = round((float) $tax['amountDue'] + $interest, 2);
        return $tax;
    }

    /** Write the interest onto an order just inserted. */
    public static function saveInterestOnOrder(string $orderId, array $tax): void
    {
        if (!self::interestReady() || empty($tax['termInterest'])) {
            return;
        }
        Database::run('UPDATE orders SET term_interest_rate = ?, term_interest = ? WHERE id = ?',
            [$tax['termInterestRate'], $tax['termInterest'], $orderId]);
    }

    /** SQL for what the buyer pays on an order: total, less the retailer discount, plus any term interest. */
    public static function dueSql(string $alias = 'o'): string
    {
        return "({$alias}.total - COALESCE({$alias}.withholding_tax, 0)"
            . (self::interestReady() ? " + COALESCE({$alias}.term_interest, 0)" : '') . ')';
    }

    /* Net account figures are derived from credit_payments: paid = verified payments, pending = unchecked payments, penalty = rate x amount still unpaid on the due date, remaining = billed + penalty - paid, and only refreshAccount() writes payment_accounts.paid. */

    /** Ways a payment toward an account may arrive (cash only at the counter). */
    public const PAYMENT_METHODS = ['gcash', 'bank', 'cash'];

    /** SELECT for accounts with their payment totals from a derived table, so callers can add any WHERE or ORDER BY. */
    public static function accountSelect(): string
    {
        return "SELECT pa.id, pa.customer_id, pa.order_id, pa.name, pa.email, pa.scheme,
                       pa.balance, pa.due_date, pa.paid, pa.created_at,
                       DATEDIFF(CURDATE(), pa.due_date)  AS days_past_due,
                       COALESCE(s.paid_amt, 0)      AS paid_amt,
                       COALESCE(s.paid_by_due, 0)   AS paid_by_due,
                       COALESCE(s.pending_amt, 0)   AS pending_amt,
                       COALESCE(s.pending_count, 0) AS pending_count
                  FROM payment_accounts pa
                  LEFT JOIN (
                      SELECT cp.account_id,
                             SUM(CASE WHEN cp.status = 'verified' THEN cp.amount ELSE 0 END) AS paid_amt,
                             SUM(CASE WHEN cp.status = 'verified' AND cp.paid_date <= a.due_date
                                      THEN cp.amount ELSE 0 END)                             AS paid_by_due,
                             SUM(CASE WHEN cp.status = 'pending'  THEN cp.amount ELSE 0 END) AS pending_amt,
                             SUM(cp.status = 'pending')                                      AS pending_count
                        FROM credit_payments cp
                        JOIN payment_accounts a ON a.id = cp.account_id
                       GROUP BY cp.account_id
                  ) s ON s.account_id = pa.id";
    }

    /** Money figures for one account (pure arithmetic), with days past due computed at read time. */
    public static function figures(
        float $billed,
        float $paid,
        float $paidByDue,
        float $pending,
        int $daysPastDue,
        ?float $rate = null
    ): array {
        $rate        = $rate ?? self::penaltyRate();
        $pastDue     = $daysPastDue > 0;
        $unpaidAtDue = max(0.0, round($billed - $paidByDue, 2));
        /* A flat one-time penalty percentage, not compounding daily. */
        $penalty     = ($pastDue && $unpaidAtDue > 0) ? round($unpaidAtDue * ($rate / 100), 2) : 0.0;
        $owed        = round($billed + $penalty, 2);
        $remaining   = max(0.0, round($owed - $paid, 2));
        $settled     = $remaining <= 0.0;
        $overdue     = !$settled && $pastDue;
        /* What can still be sent: pending payments count against it so the same final amount cannot be submitted twice. */
        $payable     = max(0.0, round($remaining - $pending, 2));

        return [
            'billed'        => round($billed, 2),
            'paidAmount'    => round($paid, 2),
            'pendingAmount' => round($pending, 2),
            'penalty'       => $penalty,
            'owed'          => $owed,
            'remaining'     => $remaining,
            'payable'       => $payable,
            'settled'       => $settled,
            'overdue'       => $overdue,
            'daysPastDue'   => $overdue ? $daysPastDue : 0,
            'daysUntilDue'  => -$daysPastDue,
            'rate'          => $rate,
            'state'         => $settled ? 'paid'
                             : ($overdue ? 'overdue' : ($paid > 0 ? 'partial' : 'pending')),
            /* Older field names kept for screens that still read them: balance = billed, paid = settled, totalDue = remaining. */
            'balance'       => round($billed, 2),
            'paid'          => $settled,
            'totalDue'      => $remaining,
        ];
    }

    /** One row from accountSelect(), described for an API response. */
    public static function describeAccount(array $r, ?float $rate = null): array
    {
        return [
            'id'           => $r['id'],
            'customerId'   => $r['customer_id'],
            'orderId'      => $r['order_id'],
            'name'         => $r['name'],
            'email'        => $r['email'],
            'scheme'       => $r['scheme'],
            'dueDate'      => $r['due_date'],
            'openedAt'     => $r['created_at'],
            'pendingCount' => (int) $r['pending_count'],
        ] + self::figures(
            (float) $r['balance'],
            (float) $r['paid_amt'],
            (float) $r['paid_by_due'],
            (float) $r['pending_amt'],
            (int) $r['days_past_due'],
            $rate
        );
    }

    /** Lock the account row for the rest of the transaction so simultaneous payments cannot push the balance below zero. */
    public static function lockAccount(string $id): ?array
    {
        if (!Database::scalar('SELECT id FROM payment_accounts WHERE id = ? FOR UPDATE', [$id])) {
            return null;
        }
        $row = Database::one(self::accountSelect() . ' WHERE pa.id = ?', [$id]);
        return $row === null ? null : self::describeAccount($row);
    }

    /** Why an amount cannot be paid toward an account (or null if it can), with one wording for retailer and cashier. */
    public static function amountProblem(float $amount, array $acct): ?string
    {
        if ($amount <= 0) {
            return 'Enter an amount greater than zero.';
        }
        if (abs(round($amount, 2) - $amount) > 0.000001) {
            return 'Use at most two decimal places.';
        }
        if ($acct['settled']) {
            return 'This account is already fully paid.';
        }
        if ($amount > $acct['payable'] + 0.004) {
            return $acct['pendingAmount'] > 0
                ? sprintf('Only ₱%s is left to pay — ₱%s already sent is waiting for review.',
                    number_format($acct['payable'], 2), number_format($acct['pendingAmount'], 2))
                : sprintf('Only ₱%s is left to pay.', number_format($acct['payable'], 2));
        }
        return null;
    }

    /** Record one payment inside the caller's transaction (after lockAccount() and amountProblem()): customer payments start pending, staff payments are verified at once; returns the new id. */
    public static function addPayment(
        array $acct,
        float $amount,
        ?string $method,
        ?string $refNum,
        ?string $proofPath,
        string $source,
        ?array $staff,
        ?string $note = null,
        ?string $paidDate = null
    ): int {
        $verified = $source === 'staff';
        Database::run(
            'INSERT INTO credit_payments
                    (account_id, customer_id, amount, method, ref_num, proof_image_path,
                     status, source, paid_date, note, submitted_at, decided_by, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, NOW(), ?, ' . ($verified ? 'NOW()' : 'NULL') . ')',
            [
                $acct['id'], $acct['customerId'], round($amount, 2), $method, $refNum, $proofPath,
                $verified ? 'verified' : 'pending', $source, $paidDate, $note,
                $verified && $staff ? $staff['id'] : null,
            ]
        );
        $id = (int) Database::pdo()->lastInsertId();
        if ($verified) {
            self::refreshAccount($acct['id']);
        }
        return $id;
    }

    /** Recompute an account and update payment_accounts.paid (the only writer of that column) after any payment is verified or rejected. */
    public static function refreshAccount(string $accountId): ?array
    {
        $row = Database::one(self::accountSelect() . ' WHERE pa.id = ?', [$accountId]);
        if ($row === null) {
            return null;
        }
        $acct = self::describeAccount($row);
        $flag = $acct['settled'] ? 1 : 0;
        if ((int) $row['paid'] !== $flag) {
            Database::run('UPDATE payment_accounts SET paid = ? WHERE id = ?', [$flag, $accountId]);
        }
        return $acct;
    }

    /** The compact shape an ORDER carries about its Net account. */
    public static function creditSummary(array $a): array
    {
        return [
            'accountId'     => $a['id'],
            'scheme'        => $a['scheme'],
            'dueDate'       => $a['dueDate'],
            'billed'        => $a['billed'],
            'owed'          => $a['owed'],
            'paidAmount'    => $a['paidAmount'],
            'pendingAmount' => $a['pendingAmount'],
            'remaining'     => $a['remaining'],
            'settled'       => $a['settled'],
            'overdue'       => $a['overdue'],
            'state'         => $a['state'],
        ];
    }

    /** Every payment on one account, newest first. */
    public static function paymentsFor(string $accountId): array
    {
        return array_map(
            [self::class, 'describePayment'],
            Database::all(
                'SELECT cp.*, u.name AS decided_by_name
                   FROM credit_payments cp
                   LEFT JOIN users u ON u.id = cp.decided_by
                  WHERE cp.account_id = ?
                  ORDER BY cp.paid_date DESC, cp.id DESC',
                [$accountId]
            )
        );
    }

    public static function describePayment(array $r): array
    {
        return [
            'id'           => (int) $r['id'],
            'accountId'    => $r['account_id'],
            'amount'       => (float) $r['amount'],
            'method'       => $r['method'],
            'refNum'       => $r['ref_num'],
            'proof'        => $r['proof_image_path'],
            'status'       => $r['status'],
            'source'       => $r['source'],
            'paidDate'     => $r['paid_date'],
            'submittedAt'  => $r['submitted_at'],
            'note'         => $r['note'],
            'rejectReason' => $r['reject_reason'],
            'decidedBy'    => $r['decided_by_name'] ?? null,
            'decidedAt'    => $r['decided_at'],
        ];
    }

    /** Next pay-NN id using MAX (not COUNT), inside the caller's transaction so two cashiers cannot get the same id. */
    private static function nextAccountId(): string
    {
        $max = (int) Database::scalar(
            "SELECT COALESCE(MAX(CAST(SUBSTRING(id, 5) AS UNSIGNED)), 0)
               FROM payment_accounts
              WHERE id REGEXP '^pay-[0-9]+$'"
        );
        return 'pay-' . str_pad((string) ($max + 1), 2, '0', STR_PAD_LEFT);
    }
}
