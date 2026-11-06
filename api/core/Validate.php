<?php
declare(strict_types=1);

/** Input validation that treats every client value as untrusted and collects all errors so a form can show them at once. */
final class Validate
{
    private array $data;
    private array $errors = [];
    private array $clean  = [];

    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public static function check(array $data): self
    {
        return new self($data);
    }

    private function raw(string $field)
    {
        $v = $this->data[$field] ?? null;
        return is_string($v) ? trim($v) : $v;
    }

    private function fail(string $field, string $message): void
    {
        /* Keep only the first message per field. */
        $this->errors[$field] ??= $message;
    }

    public function required(string $field, string $label): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '' || $v === []) {
            $this->fail($field, "$label is required.");
        } else {
            $this->clean[$field] = $v;
        }
        return $this;
    }

    public function optional(string $field): self
    {
        $v = $this->raw($field);
        $this->clean[$field] = ($v === '' ? null : $v);
        return $this;
    }

    public function email(string $field, string $label): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            $this->fail($field, "$label is required.");
        } elseif (!filter_var($v, FILTER_VALIDATE_EMAIL)) {
            $this->fail($field, "Enter a valid email address.");
        } else {
            $this->clean[$field] = $v;
        }
        return $this;
    }

    public function maxLen(string $field, int $max, string $label): self
    {
        $v = $this->raw($field);
        if (is_string($v) && mb_strlen($v) > $max) {
            $this->fail($field, "$label must be $max characters or fewer.");
        }
        return $this;
    }

    public function int(string $field, string $label, ?int $min = null, ?int $max = null): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            $this->fail($field, "$label is required.");
            return $this;
        }
        if (filter_var($v, FILTER_VALIDATE_INT) === false) {
            $this->fail($field, "$label must be a whole number.");
            return $this;
        }
        $n = (int) $v;
        if ($min !== null && $n < $min) {
            $this->fail($field, "$label cannot be less than $min.");
        } elseif ($max !== null && $n > $max) {
            $this->fail($field, "$label cannot be more than $max.");
        } else {
            $this->clean[$field] = $n;
        }
        return $this;
    }

    public function decimal(string $field, string $label, float $min = 0): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            $this->fail($field, "$label is required.");
            return $this;
        }
        if (!is_numeric($v)) {
            $this->fail($field, "$label must be a number.");
            return $this;
        }
        $n = (float) $v;
        if ($n < $min) {
            $this->fail($field, "$label cannot be less than $min.");
        } else {
            $this->clean[$field] = round($n, 2);
        }
        return $this;
    }

    /** Value must be one of a fixed set — the guard for every ENUM column. */
    public function in(string $field, array $allowed, string $label): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            $this->fail($field, "$label is required.");
        } elseif (!in_array($v, $allowed, true)) {
            $this->fail($field, "$label must be one of: " . implode(', ', $allowed) . '.');
        } else {
            $this->clean[$field] = $v;
        }
        return $this;
    }

    public function date(string $field, string $label): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            $this->fail($field, "$label is required.");
            return $this;
        }
        $d = DateTime::createFromFormat('Y-m-d', $v);
        if (!$d || $d->format('Y-m-d') !== $v) {
            $this->fail($field, "$label must be a date in YYYY-MM-DD form.");
        } else {
            $this->clean[$field] = $v;
        }
        return $this;
    }

    public function failed(): bool
    {
        return $this->errors !== [];
    }

    /** Stop with 422 if anything failed, otherwise return only the validated values. */
    public function values(): array
    {
        if ($this->failed()) {
            Response::validation('Please correct the highlighted fields.', $this->errors);
        }
        return $this->clean;
    }

    /* ---- paging, used by every list endpoint ---- */

    public static function paging(array $query, int $defaultLimit = 25, int $maxLimit = 200): array
    {
        $page  = max(1, (int) ($query['page'] ?? 1));
        $limit = (int) ($query['limit'] ?? $defaultLimit);
        /* Clamp an oversized page limit instead of rejecting it. */
        $limit = max(1, min($limit, $maxLimit));
        return ['page' => $page, 'limit' => $limit, 'offset' => ($page - 1) * $limit];
    }
}
