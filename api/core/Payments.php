<?php
declare(strict_types=1);

/**
 * Payments — the one place that decides what a payment means.
 *
 * DECISION I8: one function, one table, one transaction.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two checkout endpoints each worked out the payment columns for themselves,
 * with the same expression copy-pasted into both:
 *
 *     pos/checkout.php   $refNum !== null ? 1 : 0      // proof_uploaded
 *     shop/checkout.php  $refNum !== null ? 1 : 0      // proof_uploaded
 *
 * Duplicated logic drifts, and this pair had already drifted in the way that
 * matters: pos/checkout.php hardcoded pay_verified = 1 for every sale, which is
 * right for cash in hand and wrong for a Net-30 retailer who has not paid
 * anything yet. The POS offered Net 30/60/90 and the endpoint refused them, so
 * the question never came up — the order simply failed, silently.
 *
 * Both endpoints now ask this class. There is one definition of what each
 * payment method implies, and adding a method means changing one file.
 *
 * WHAT A "PAYMENT" IS HERE
 * ------------------------
 * There is no `payments` table in this schema and this file does not invent
 * one. Payment state lives in two places that already exist:
 *
 *   orders.pay_verified / proof_*   — for money paid at or around the sale
 *   payment_accounts                — a receivable, for money owed on terms
 *
 * An immediate sale touches the first. A credit sale touches both: the order
 * records that nothing has been verified as paid, and a receivable is opened
 * for the amount. That is the write which was missing entirely — every row in
 * payment_accounts was seeded, and the only statement in the codebase that
 * touched the table was `UPDATE ... SET paid = ?`. A balance could be settled
 * and could never be raised.
 */

final class Payments
{
    /** Paid at the point of sale, or claimed to be and awaiting verification. */
    public const IMMEDIATE = ['cash', 'gcash', 'bank'];

    /** Paid later, on terms. The value is the number of days until due. */
    public const CREDIT = ['net30' => 30, 'net60' => 60, 'net90' => 90];

    /**
     * Methods a caller may accept.
     *
     * Credit terms are offered only to a retailer, and only where a retailer
     * can actually be named — the storefront has no retailer selection, so it
     * passes false. Returning the list from here rather than writing it out at
     * each call site is what stops the client's list and the server's list
     * drifting apart again.
     */
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

    /** 'net30' -> 'Net 30', for payment_accounts.scheme and for audit text. */
    public static function schemeLabel(string $method): string
    {
        return self::isCredit($method)
            ? 'Net ' . self::termDays($method)
            : ucfirst($method);
    }

    /**
     * The payment-related columns for an `orders` INSERT.
     *
     * Returned as an array rather than written here, because the order row does
     * not exist yet — the caller is mid-INSERT. One place decides the values;
     * the caller places them.
     *
     * `$proofPath` is the uploaded reference image, or null. `$refNum` is the
     * typed reference number, or null.
     *
     * ON `proof_uploaded`
     * -------------------
     * It means "the customer has supplied something for staff to check" — a
     * reference number, an image, or both. That is exactly what it meant
     * before, when a reference number was the only thing that could be
     * supplied, so no existing row or screen changes meaning. The name is
     * poor and predates images; it is kept because the Payment Verification
     * screen filters on it and renaming a column to fix a comment is how a
     * working screen goes dark.
     *
     * ON `pay_verified`
     * -----------------
     *   cash at the till      1  — the cashier is holding the money
     *   gcash/bank at the till 1  — the cashier watched the transfer land
     *   gcash/bank online     0  — a claim, until staff verify it
     *   any credit method     0  — nothing has been paid at all
     *
     * The old POS code hardcoded 1 for every method it could reach, which was
     * correct only because it could not reach a credit method.
     */
    public static function orderFields(
        string $method,
        ?string $refNum,
        ?string $proofPath,
        float $total,
        bool $atTill
    ): array {
        $hasProof = ($refNum !== null && $refNum !== '') || ($proofPath !== null && $proofPath !== '');

        if (self::isCredit($method)) {
            /* Nothing has been paid. There is no proof to hold and no amount
               claimed — the amount owed lives on the receivable, not here. */
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
            /* The amount the customer says they sent. Compared against the
               order total on the Payment Verification screen, so it must be
               the real total rather than whatever the client believed. */
            'proof_amount'     => $hasProof ? $total : 0.0,
        ];
    }

    /**
     * Open a receivable for a credit sale.
     *
     * MUST be called inside the caller's transaction, alongside the order
     * INSERT. A sale recorded without its receivable is money the business
     * cannot see it is owed, and a receivable without its sale is a debt
     * nobody can explain — either half alone is worse than neither.
     *
     * One row per credit sale, which is the shape the table already has:
     * pay-01 and pay-04 are two Net-30 rows for the same customer, one settled
     * and one not. No new concept is introduced here.
     *
     * The due date is computed by the database with CURDATE(), not in PHP and
     * certainly not in the browser — D1, and the same reason `isOverdue()` was
     * moved server-side after it spent two months frozen against a hardcoded
     * date.
     */
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

    /* ------------------------------------------------------------------
       Retailer credit: overdue and penalty
       ------------------------------------------------------------------
       Moved here from api/payments/list.php when the customer-facing
       api/shop/my-payments.php needed the same numbers.

       It was three lines and it would have been quicker to copy them. That is
       exactly the mistake this codebase has already paid for twice — the stock
       quartet and the `proof_uploaded` expression both drifted after being
       written out in more than one place. A retailer who is shown a penalty
       that differs by a peso from what the cashier is looking at will not
       assume it is a rounding rule; they will assume they are being
       overcharged, and the feature becomes worse than not having it.
       ------------------------------------------------------------------ */

    /** The configured penalty percentage. Read from settings, never hardcoded. */
    public static function penaltyRate(): float
    {
        return (float) (Database::scalar(
            "SELECT value_text FROM settings WHERE key_name = 'penalty_rate'"
        ) ?? 2);
    }

    /* ==================================================================
       Payments toward a Net account — credit_payments (migration 013)
       ==================================================================
       payment_accounts.balance is what the sale BILLED and never changes.
       Everything else is derived from payment rows, so every figure on every
       screen can be explained line by line:

         paid so far   SUM of VERIFIED payments (legacy rows included — that
                       money did arrive; see migration 013)
         pending       SUM of payments a retailer has sent that staff have not
                       checked yet
         penalty       once past due, the penalty rate × what was STILL UNPAID
                       ON THE DUE DATE. Paying part early lowers it; paying after
                       the due date does not erase it. Decided 2026-09-11.
         remaining     billed + penalty − paid so far
         settled       remaining is zero. payment_accounts.paid mirrors this and
                       is written ONLY by refreshAccount(), never by hand.

       The retailer's Payment Schemes page, the staff Payment Scheme screen,
       checkout's overdue check and the POS retailer picker all read
       describeAccount(). A penalty worked out in two places is a penalty that
       eventually disagrees with itself, in front of the customer.
       ================================================================== */

    /** How a payment toward an account may arrive. Cash only at the counter. */
    public const PAYMENT_METHODS = ['gcash', 'bank', 'cash'];

    /**
     * SELECT for accounts with their payment sums, ready for a WHERE / ORDER BY.
     *
     * The sums come from a derived table rather than a join-and-group on the
     * outer query, so callers can add any WHERE without an aggregate getting in
     * the way. `paid_by_due` needs the account's own due date, hence the inner
     * join back to payment_accounts.
     */
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

    /**
     * The money figures for one account. Pure arithmetic — no queries.
     *
     * `$daysPastDue` is DATEDIFF(CURDATE(), due_date), positive when late.
     * Derived at read time and never stored, so an account cannot sit at
     * "3 days late" because nobody reopened a screen.
     */
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
        /* Flat percentage, charged once — not compounding per day, which would
           need a documented business rule nobody has written. */
        $penalty     = ($pastDue && $unpaidAtDue > 0) ? round($unpaidAtDue * ($rate / 100), 2) : 0.0;
        $owed        = round($billed + $penalty, 2);
        $remaining   = max(0.0, round($owed - $paid, 2));
        $settled     = $remaining <= 0.0;
        $overdue     = !$settled && $pastDue;
        /* What may still be SENT: payments already waiting for review count
           against it, so two screenshots for the same last ₱5,000 cannot both
           be submitted. */
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
            /* The names screens written before instalments already read, kept
               with their nearest honest meaning so nothing goes blank:
               balance = billed, paid = settled, totalDue = what is left. */
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

    /**
     * Lock an account for the rest of the caller's transaction and describe it.
     *
     * Two staff verifying the last two payments at once, or a retailer sending
     * a payment while a cashier records one, must not both see the same
     * "remaining" and together take it below zero. The row lock serialises them.
     */
    public static function lockAccount(string $id): ?array
    {
        if (!Database::scalar('SELECT id FROM payment_accounts WHERE id = ? FOR UPDATE', [$id])) {
            return null;
        }
        $row = Database::one(self::accountSelect() . ' WHERE pa.id = ?', [$id]);
        return $row === null ? null : self::describeAccount($row);
    }

    /**
     * Why an amount cannot be paid toward an account, or null if it can.
     * One wording for the retailer's form and the cashier's.
     */
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

    /**
     * Record one payment. MUST run inside the caller's transaction, after
     * lockAccount() and amountProblem().
     *
     *   customer  sent from the Payment Schemes page — starts `pending`
     *   staff     recorded at the counter — `verified` at once, by that person
     *
     * `$paidDate` is the revenue date: the day the money was paid. NULL means
     * today. Returns the new payment's id.
     */
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

    /**
     * Re-derive an account and write payment_accounts.paid to match.
     *
     * The ONLY writer of that column. Called after any payment is verified or
     * rejected, so a rejection that takes an account back below its total
     * reopens it without anyone flipping a flag.
     */
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

    /**
     * The tax a withholding retailer kept from a Net sale, recorded as a
     * verified payment on its account.
     *
     * A withholding agent pays the seller the sale LESS the tax, and remits
     * that tax to the BIR on the seller's behalf (BIR Form 2307). The buyer has
     * therefore settled that part at the moment of sale — just not in cash to
     * this business. Recording it as a payment is what keeps the account right:
     * the retailer owes the cash part, the balance billed is still the full
     * sale, and revenue (which counts verified payments) still counts all of
     * it rather than losing the withheld share forever.
     *
     * Call inside the transaction that opened the account.
     */
    public static function recordWithholding(
        string $accountId,
        ?string $customerId,
        float $amount,
        float $rate,
        ?array $staff
    ): void {
        if ($amount <= 0) {
            return;
        }
        Database::run(
            "INSERT INTO credit_payments
                    (account_id, customer_id, amount, method, ref_num, proof_image_path,
                     status, source, paid_date, note, decided_by, decided_at)
             VALUES (?, ?, ?, NULL, NULL, NULL, 'verified', 'withholding', CURDATE(), ?, ?, NOW())",
            [
                $accountId, $customerId, round($amount, 2),
                sprintf('Withholding tax (%s%%) kept by the buyer and remitted to the BIR — BIR Form 2307.',
                    rtrim(rtrim(number_format($rate, 2), '0'), '.')),
                $staff['id'] ?? null,
            ]
        );
        self::refreshAccount($accountId);
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

    /**
     * Next id in the seeded `pay-NN` sequence.
     *
     * Derived from MAX rather than COUNT: COUNT collides the moment a row is
     * deleted, and this is a primary key. Zero-padded to two digits to match
     * pay-01..pay-04, and allowed to run past two digits rather than wrapping.
     *
     * Called inside the caller's transaction, so the read and the INSERT that
     * follows cannot be interleaved by another cashier.
     */
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
