<?php
declare(strict_types=1);

/** POST /api/shipping/save.php (needs shipping.manage) replaces the zones and/or weight brackets in one transaction, affecting only future orders. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('POST');
$actor = Rbac::require('shipping.manage');

if (!Shipping::ready()) {
    Response::error('MIGRATION_NEEDED', 'Run db/migrations/021-shipping-fees.sql first.', 409);
}

$in = Response::input();
$errors = [];

/* Ceilings — mirrored in assets/js/portal/shipping.js (SHIP_LIMITS). */
const LIM_KM = 5000; const LIM_KG = 1000; const LIM_FEE = 10000; const LIM_PER_KG = 1000;

/* Rows must ascend without overlapping, only the last may be open-ended, and at least one must be active. */
$ordered = static function (array $rows, string $label, int $activeAt): ?string {
    $n = count($rows);
    foreach ($rows as $i => $r) {
        if ($r[1] === null && $i !== $n - 1) {
            return 'Row ' . ($i + 1) . ': only the last ' . $label . ' can be open-ended.';
        }
        if ($i > 0 && $rows[$i - 1][1] !== null && $r[0] <= $rows[$i - 1][1]) {
            return 'Row ' . ($i + 1) . ': starts inside row ' . $i . '. ' . ucfirst($label) . 's must go up without overlapping.';
        }
    }
    foreach ($rows as $r) {
        if ($r[$activeAt] === 1) {
            return null;
        }
    }
    return 'At least one ' . $label . ' must be active.';
};

$num = static function ($v, bool $nullable = false): ?float {
    if ($nullable && ($v === null || $v === '')) {
        return null;
    }
    return is_numeric($v) && (float) $v >= 0 ? round((float) $v, 2) : -1.0;
};

/* ---- zones ---- */
$zones = null;
if (isset($in['zones'])) {
    if (!is_array($in['zones']) || $in['zones'] === [] || count($in['zones']) > 30) {
        $errors['zones'] = 'Keep between 1 and 30 zones.';
    } else {
        $zones = [];
        foreach (array_values($in['zones']) as $i => $z) {
            $n    = $i + 1;
            $name = trim((string) ($z['name'] ?? ''));
            $min  = $num($z['minKm'] ?? null);
            $max  = $num($z['maxKm'] ?? null, true);
            $fee  = $num($z['baseFee'] ?? null);
            if ($name === '' || mb_strlen($name) > 40) { $errors['zones'] = "Zone row $n needs a name (up to 40 characters)."; break; }
            if ($min < 0 || $fee < 0 || ($max !== null && $max < 0)) { $errors['zones'] = "Zone row $n: distances and fees must be numbers of 0 or more."; break; }
            if ($min > LIM_KM || ($max !== null && $max > LIM_KM)) { $errors['zones'] = "Zone row $n: distances cannot exceed " . LIM_KM . " km."; break; }
            if ($fee > LIM_FEE) { $errors['zones'] = "Zone row $n: the base fee cannot exceed ₱" . number_format(LIM_FEE) . "."; break; }
            if ($max !== null && $max < $min) { $errors['zones'] = "Zone row $n: the maximum km is below the minimum."; break; }
            /* Delivery time in working days (migration 038). */
            $dMin = (int) ($z['etaMinDays'] ?? 0);
            $dMax = (int) ($z['etaMaxDays'] ?? 0);
            if (Shipping::etaReady() && ($dMin < 1 || $dMax < $dMin || $dMax > 60)) { $errors['zones'] = "Zone row $n: delivery days must be 1 to 60, and the longest at least the shortest."; break; }
            foreach ($zones as $prev) {
                if (strcasecmp($prev[0], $name) === 0) { $errors['zones'] = "Zone row $n: the name \"$name\" is used twice."; break 2; }
            }
            $zones[] = [$name, $min, $max, $fee, !empty($z['active']) ? 1 : 0, $dMin, $dMax];
        }
        if (!isset($errors['zones'])) {
            $msg = $ordered(array_map(static fn($z) => [$z[1], $z[2], $z[4]], $zones), 'zone', 2);
            if ($msg !== null) { $errors['zones'] = $msg; }
        }
    }
}

/* ---- weight brackets ---- */
$weights = null;
if (isset($in['weights'])) {
    if (!is_array($in['weights']) || $in['weights'] === [] || count($in['weights']) > 30) {
        $errors['weights'] = 'Keep between 1 and 30 weight brackets.';
    } else {
        $weights = [];
        foreach (array_values($in['weights']) as $i => $w) {
            $n   = $i + 1;
            $min = $num($w['minKg'] ?? null);
            $max = $num($w['maxKg'] ?? null, true);
            $fee = $num($w['fee'] ?? null);
            $per = $num($w['perKgAbove'] ?? 0);
            if ($min < 0 || $fee < 0 || $per < 0 || ($max !== null && $max < 0)) { $errors['weights'] = "Weight row $n: values must be numbers of 0 or more."; break; }
            if ($min > LIM_KG || ($max !== null && $max > LIM_KG)) { $errors['weights'] = "Weight row $n: weights cannot exceed " . LIM_KG . " kg."; break; }
            if ($fee > LIM_FEE || $per > LIM_PER_KG) { $errors['weights'] = "Weight row $n: the fee is too large (max ₱" . number_format(LIM_FEE) . ", ₱" . number_format(LIM_PER_KG) . " per kg)."; break; }
            if ($max !== null && $max < $min) { $errors['weights'] = "Weight row $n: the maximum kg is below the minimum."; break; }
            $weights[] = [$min, $max, $fee, $per, !empty($w['active']) ? 1 : 0];
        }
        if (!isset($errors['weights'])) {
            $msg = $ordered(array_map(static fn($w) => [$w[0], $w[1], $w[4]], $weights), 'weight bracket', 2);
            if ($msg !== null) { $errors['weights'] = $msg; }
        }
    }
}

/* ---- packing days and island / remote areas (migration 038) ---- */
$packDays = null;
if (isset($in['packDays'])) {
    $packDays = (int) $in['packDays'];
    if ((string) $in['packDays'] === '' || $packDays < 0 || $packDays > 14) { $errors['packDays'] = 'Packing time must be 0 to 14 days.'; }
}
$remote = null;
if (isset($in['remoteAreas'])) {
    if (!Shipping::etaReady()) {
        Response::error('MIGRATION_NEEDED', 'Run db/migrations/038-delivery-eta-remote-areas.sql first.', 409);
    }
    $known  = Shipping::destinations();
    $remote = [];
    foreach (array_values(is_array($in['remoteAreas']) ? $in['remoteAreas'] : []) as $i => $r) {
        $n    = $i + 1;
        $dest = trim((string) ($r['destination'] ?? ''));
        $fee  = $num($r['extraFee'] ?? null);
        $dMin = (int) ($r['extraMinDays'] ?? -1);
        $dMax = (int) ($r['extraMaxDays'] ?? -1);
        $note = trim((string) ($r['note'] ?? ''));
        if (!in_array($dest, $known, true)) { $errors['remoteAreas'] = "Remote area row $n: choose a destination from the list."; break; }
        if (isset($remote[$dest])) { $errors['remoteAreas'] = "Remote area row $n: $dest is listed twice."; break; }
        if ($fee < 0 || $fee > LIM_FEE) { $errors['remoteAreas'] = "Remote area row $n: the extra fee must be 0 to ₱" . number_format(LIM_FEE) . "."; break; }
        if ($dMin < 0 || $dMax < $dMin || $dMax > 60) { $errors['remoteAreas'] = "Remote area row $n: extra days must be 0 to 60, and the longest at least the shortest."; break; }
        if (mb_strlen($note) > 255) { $errors['remoteAreas'] = "Remote area row $n: keep the note under 255 characters."; break; }
        $remote[$dest] = [$dest, $fee, $dMin, $dMax, !empty($r['paused']) ? 1 : 0, $note === '' ? null : $note];
    }
}

$holidays = null;
if (isset($in['holidays'])) {
    $holidays = [];
    foreach (array_values(is_array($in['holidays']) ? $in['holidays'] : []) as $i => $h) {
        $n    = $i + 1;
        $date = trim((string) ($h['date'] ?? ''));
        $name = trim((string) ($h['name'] ?? ''));
        $d    = DateTime::createFromFormat('Y-m-d', $date);
        if (!$d || $d->format('Y-m-d') !== $date) { $errors['holidays'] = "Holiday row $n: pick a date."; break; }
        if ($name === '' || mb_strlen($name) > 80) { $errors['holidays'] = "Holiday row $n: give it a name (up to 80 characters)."; break; }
        if (isset($holidays[$date])) { $errors['holidays'] = "Holiday row $n: " . date('M j, Y', strtotime($date)) . ' is listed twice.'; break; }
        $holidays[$date] = [$date, $name];
    }
    if (count($holidays) > 400) { $errors['holidays'] = 'Keep the holiday list under 400 days.'; }
}

if ($errors) {
    Response::validation('Check the shipping rates.', $errors);
}
if ($zones === null && $weights === null && $packDays === null && $remote === null && $holidays === null) {
    Response::badRequest('Send zones, weights, packing days and/or remote areas.');
}

$pdo = Database::pdo();
try {
    $pdo->beginTransaction();
    if ($zones !== null) {
        Database::run('DELETE FROM shipping_zones');
        foreach ($zones as $z) {
            if (Shipping::etaReady()) {
                Database::run('INSERT INTO shipping_zones (name, min_km, max_km, base_fee, active, eta_min_days, eta_max_days)
                               VALUES (?, ?, ?, ?, ?, ?, ?)', $z);
            } else {
                Database::run('INSERT INTO shipping_zones (name, min_km, max_km, base_fee, active) VALUES (?, ?, ?, ?, ?)', array_slice($z, 0, 5));
            }
        }
    }
    if ($weights !== null) {
        Database::run('DELETE FROM shipping_weight_fees');
        foreach ($weights as $w) {
            Database::run('INSERT INTO shipping_weight_fees (min_kg, max_kg, fee, per_kg_above, active) VALUES (?, ?, ?, ?, ?)', $w);
        }
    }
    if ($packDays !== null) {
        Database::run("INSERT INTO settings (key_name, value_text) VALUES ('shipping_pack_days', ?)
                       ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)", [(string) $packDays]);
    }
    if ($remote !== null) {
        Database::run('DELETE FROM shipping_remote_areas');
        foreach ($remote as $r) {
            Database::run('INSERT INTO shipping_remote_areas (destination, extra_fee, extra_min_days, extra_max_days, paused, note)
                           VALUES (?, ?, ?, ?, ?, ?)', $r);
        }
    }
    if ($holidays !== null && Database::hasTable('shipping_holidays')) {
        Database::run('DELETE FROM shipping_holidays');
        foreach ($holidays as $h) {
            Database::run('INSERT INTO shipping_holidays (holiday_date, name) VALUES (?, ?)', $h);
        }
    }
    $paused = $remote !== null ? array_keys(array_filter($remote, static fn($r) => $r[4] === 1)) : [];
    Database::run(
        'INSERT INTO audit_logs (ts, actor, actor_user_id, type, description) VALUES (NOW(), ?, ?, ?, ?)',
        [$actor['name'], $actor['id'], 'system', sprintf('Updated shipping rates: %s.',
            implode(', ', array_filter([
                $zones !== null ? count($zones) . ' zone(s)' : null,
                $weights !== null ? count($weights) . ' weight bracket(s)' : null,
                $packDays !== null ? "packing time {$packDays} day(s)" : null,
                $remote !== null ? count($remote) . ' remote area(s)' . ($paused ? ' (paused: ' . implode(', ', $paused) . ')' : '') : null,
                $holidays !== null ? count($holidays) . ' holiday(s)' : null,
            ])))]
    );
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    throw $e;
}

Response::ok(['saved' => true]);
