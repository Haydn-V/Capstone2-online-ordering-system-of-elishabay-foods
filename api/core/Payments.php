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

    /**
     * Everything derived about one credit account.
     *
     * `$daysPastDue` is DATEDIFF(CURDATE(), due_date) computed in SQL by the
     * caller — positive when late. Derived at read time and never stored, so an
     * account does not sit at "3 days late" forever because nobody reopened the
     * screen.
     *
     * A paid account is never overdue and never carries a penalty, whatever the
     * date says.
     */
    public static function accountStanding(
        float $balance,
        int $daysPastDue,
        bool $paid,
        ?float $rate = null
    ): array {
        $rate    = $rate ?? self::penaltyRate();
        $overdue = !$paid && $daysPastDue > 0;

        /* Flat percentage on the outstanding balance once overdue — not
           compounding per day, which would need a documented business rule
           nobody has written. */
        $penalty = $overdue ? round($balance * ($rate / 100), 2) : 0.0;

        return [
            'overdue'     => $overdue,
            'daysPastDue' => $daysPastDue,
            'penalty'     => $penalty,
            'totalDue'    => $paid ? 0.0 : round($balance + $penalty, 2),
            'rate'        => $rate,
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
