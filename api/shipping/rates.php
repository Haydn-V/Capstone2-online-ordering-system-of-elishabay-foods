<?php
declare(strict_types=1);

/** GET /api/shipping/rates.php returns active zones, weight brackets and destinations (?all=1 includes inactive rules for shipping.manage); rates are public. */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

if (!Shipping::ready()) {
    Response::ok(['ready' => false, 'zones' => [], 'weights' => [], 'destinations' => Shipping::destinations()]);
}

$all = !empty($_GET['all']);
if ($all) {
    Rbac::require('shipping.manage');
}

$num = static fn($v) => $v === null ? null : (float) $v;

Response::ok([
    'ready'        => true,
    'origin'       => Shipping::ORIGIN_NAME,
    'roadFactor'   => Shipping::ROAD_FACTOR,
    'zones'        => array_map(static fn(array $z): array => [
        'id' => (int) $z['id'], 'name' => $z['name'], 'minKm' => $num($z['min_km']), 'maxKm' => $num($z['max_km']),
        'baseFee' => (float) $z['base_fee'], 'active' => (int) $z['active'] === 1,
        /* Delivery time in working days (migration 038). */
        'etaMinDays' => isset($z['eta_min_days']) ? (int) $z['eta_min_days'] : null,
        'etaMaxDays' => isset($z['eta_max_days']) ? (int) $z['eta_max_days'] : null,
    ], Shipping::zones(!$all)),
    'weights'      => array_map(static fn(array $w): array => [
        'id' => (int) $w['id'], 'minKg' => $num($w['min_kg']), 'maxKg' => $num($w['max_kg']),
        'fee' => (float) $w['fee'], 'perKgAbove' => (float) $w['per_kg_above'], 'active' => (int) $w['active'] === 1,
    ], Shipping::weightFees(!$all)),
    'destinations' => Shipping::destinations(),
    /* Arrival estimates and island/remote areas (migration 038). */
    'etaReady'     => Shipping::etaReady(),
    'packDays'     => Shipping::packDays(),
    'remoteAreas'  => array_map(static fn(array $r): array => [
        'destination' => $r['destination'], 'extraFee' => (float) $r['extra_fee'],
        'extraMinDays' => (int) $r['extra_min_days'], 'extraMaxDays' => (int) $r['extra_max_days'],
        'paused' => (int) $r['paused'] === 1, 'note' => $r['note'],
    ], Shipping::remoteAreas()),
    /* Days with no pickup or delivery, skipped by the estimate like Sundays. */
    'holidays'     => array_map(static fn(string $d, string $n): array => ['date' => $d, 'name' => $n],
        array_keys(Shipping::holidays()), array_values(Shipping::holidays())),
]);
