import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CFG } from './config.ts';
import {
  backAxisHeading, bleDistance, bleOffsets, bleThresholdDb, enu, makeGravityFilter, makeSwingDetector,
  quatToMatrix, selectTarget, spatialize, wrap180, blur,
} from './math.ts';

const cfg = DEFAULT_CFG;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const L = { lat: 19.0, lon: 72.8, acc: 3 };
const north = (m: number) => ({ lat: L.lat + m / 111_320, lon: L.lon, acc: 3 });
const east = (m: number) => ({ lat: L.lat, lon: L.lon + m / (111_320 * Math.cos((L.lat * Math.PI) / 180)), acc: 3 });

test('wrap180', () => {
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(-180), 180);
  assert.equal(wrap180(45), 45);
});

test('enu distance and bearing', () => {
  const n = enu(L, north(20));
  near(n.d, 20, 1e-3); near(n.bearing, 0, 1e-6);
  const e = enu(L, east(10));
  near(e.d, 10, 1e-3); near(e.bearing, 90, 1e-6);
});

test('back-axis heading: phone upright, camera pointing north/east', () => {
  // Upright portrait facing north: device x=East, y=Up, z=South (screen towards user = south).
  const facingNorth = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  near(backAxisHeading(facingNorth), 0);
  // Rotate 90° clockwise about Up: camera points East.
  const facingEast = [[0, 0, -1], [-1, 0, 0], [0, 1, 0]];
  near(backAxisHeading(facingEast), 90);
  // identity quaternion = phone flat, screen up, top edge pointing north -> facing north
  near(backAxisHeading(quatToMatrix(0, 0, 0, 1)), 0);
  // flat, rotated 90° clockwise (top edge east): quaternion about Up by -90°
  near(backAxisHeading(quatToMatrix(0, 0, -Math.SQRT1_2, Math.SQRT1_2)), 90);
  // tilted 45° between flat and upright, facing north: still north
  near(backAxisHeading(quatToMatrix(Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8))), 0);
});

test('spatialize: huddled group (inside blindM) hears it centred, full volume, unmuffled', () => {
  for (const src of [east(4), north(-11), east(-11)]) {
    const s = spatialize(L, 0, src, 'bell', cfg);
    near(s.pan, 0); near(s.gain, 1); near(s.cutoffHz, 20_000);
  }
});

test('spatialize: direction fades in between blindM and dirFullM', () => {
  near(spatialize(L, 0, east(21), 'bell', cfg).pan, 0.5, 1e-3);   // halfway
  near(spatialize(L, 0, east(30), 'bell', cfg).pan, 1, 1e-3);     // facing north, source east = right
  near(spatialize(L, 180, east(30), 'bell', cfg).pan, -1, 1e-3);  // facing south = left
  near(spatialize(L, 0, north(-30), 'bell', cfg).cutoffHz, cfg.audio.behindHz, 1);
});

test('spatialize: gain curve and hearing range', () => {
  near(spatialize(L, 0, north(24), 'bell', cfg).gain, 0.5, 1e-3);
  near(spatialize(L, 0, north(50), 'bell', cfg).gain, (12 / 50) * (5 / 15), 1e-3);
  assert.equal(spatialize(L, 0, north(56), 'bell', cfg).gain, 0);
  assert.ok(spatialize(L, 0, north(56), 'scream', cfg).gain > 0); // scream carries further
});

test('blur stays within radius', () => {
  let x = 0.123;
  const rng = () => (x = (x * 9301 + 49297) % 233280 / 233280);
  for (let i = 0; i < 200; i++) assert.ok(enu(L, blur(L, 6, rng)).d <= 6 + 1e-6);
});

test('BLE model round-trips and thresholds match radius', () => {
  near(bleDistance(cfg.ble.A1, cfg), 1);
  near(bleDistance(bleThresholdDb(1.5, cfg), cfg), 1.5);
  near(bleThresholdDb(1.5, cfg), cfg.ble.A1 - 3.5218, 1e-3);
  const o = bleOffsets({ a: -55, b: -60, c: -58 });
  assert.deepEqual(o, { a: 3, b: -2, c: 0 });
});

test('accelerometer fallback removes gravity in different grips and preserves a forward thrust', () => {
  for (const g of [{ x: 0, y: 9.81, z: 0 }, { x: 0, y: 0, z: -9.81 }, { x: 3, y: 8, z: -4 }]) {
    const filter = makeGravityFilter();
    const swing = makeSwingDetector(cfg);
    for (let t = 0; t <= 1200; t += 16) {
      const linear = filter({ ...g, t });
      if (t < 1000) assert.equal(linear, null);
      if (linear) {
        near(linear.x, 0); near(linear.y, 0); near(linear.z, 0);
        assert.equal(swing(linear), false);
      }
    }
    const push = filter({ ...g, z: g.z - 6, t: 1216 });
    assert.ok(push);
    assert.equal(swing(push), false);
    const peak = filter({ ...g, z: g.z - 16, t: 1232 });
    assert.ok(peak);
    assert.equal(swing(peak), true);
    assert.equal(swing(filter({ ...g, z: g.z - 16, t: 1248 })!), false);
    assert.equal(filter({ ...g, t: 3000 }), null); // pause resets the estimate and warmup
    assert.equal(filter({ ...g, t: 2900 }), null); // out-of-order sample also resets
  }
});

test('accelerometer fallback rejects vertical bounce and slow pushes', () => {
  for (const motion of ['bounce', 'slow']) {
    const filter = makeGravityFilter();
    const swing = makeSwingDetector(cfg);
    let hits = 0;
    for (let i = 0; i < 130; i++) {
      const active = i >= 80 && i < 110;
      const linear = filter({ x: 0, y: 9.81 + (active && motion === 'bounce' ? 20 : 0),
        z: !active ? 0 : motion === 'bounce' ? -14 : -(4 + (i - 80) * 0.5), t: i * 16 });
      if (linear && swing(linear)) hits++;
    }
    assert.equal(hits, 0);
  }
});

test('swing: forward stab triggers once, running/sideways does not', () => {
  const det = makeSwingDetector(cfg);
  const fire = (samples: [number, number, number][]) =>
    samples.map(([x, y, z], i) => det({ x, y, z, t: i * 16 })).filter(Boolean).length;
  assert.equal(fire([[0, 0, 0], [0, 1, -6], [0, 1, -14], [0, 1, -16], [0, 0, -2]]), 1);
  assert.equal(fire([[0, 0, 0], [0, 12, -6], [0, 15, -13], [0, 0, 0]]), 0); // vertical bounce dominates
  // slow push: rises for > 250 ms before reaching peak
  const slow: [number, number, number][] = Array.from({ length: 20 }, (_, i) => [0, 0, -(4 + i * 0.5)]);
  assert.equal(fire([[0, 0, 0], ...slow, [0, 0, 0]]), 0);
});

test('swing settings can change live without resetting the detector', () => {
  const det = makeSwingDetector(cfg);
  assert.equal(det({ x: 0, y: 0, z: -10, t: 0 }), false);
  assert.equal(det({ x: 0, y: 0, z: -10, t: 16 }, { peak: 8, dominance: 2, windowMs: 250 }), true);
  det({ x: 0, y: 0, z: 0, t: 32 });
  assert.equal(det({ x: 0, y: 0, z: -14, t: 48 }, { peak: 20, dominance: 2, windowMs: 250 }), false);
  assert.equal(det({ x: 6, y: 0, z: -14, t: 64 }, { peak: 12, dominance: 3, windowMs: 250 }), false);
  assert.equal(det({ x: 6, y: 0, z: -14, t: 80 }, { peak: 12, dominance: 2, windowMs: 250 }), true);
  det({ x: 0, y: 0, z: 0, t: 96 });
  det({ x: 0, y: 0, z: -4, t: 112 });
  assert.equal(det({ x: 0, y: 0, z: -14, t: 300 }, { peak: 12, dominance: 2, windowMs: 100 }), false);
  assert.equal(det({ x: 0, y: 0, z: -14, t: 316 }, { peak: 12, dominance: 2, windowMs: 250 }), true);
});

test('selectTarget: UWB nearest in cone, else every BLE peer in range for the server to resolve', () => {
  const now = 1000;
  const uwbPick = selectTarget([
    { id: 'a', offset: 0, uwb: { d: 1.2, az: 10, t: now } },
    { id: 'b', offset: 0, uwb: { d: 0.8, az: 80, t: now } }, // out of cone
  ], 'vikram', 0, true, now, cfg);
  assert.deepEqual(uwbPick, { targetId: 'a', m: { method: 'uwb', d: 1.2, az: 10 } });
  // UWB peer outside the cone is not retried over BLE
  assert.deepEqual(selectTarget([{ id: 'a', offset: 0, rssi: -50, uwb: { d: 0.5, az: 46, t: now } }], 'vikram', 0, true, now, cfg), { miss: 'none' });

  const crowd = selectTarget([{ id: 'a', offset: 0, rssi: -56 }, { id: 'b', offset: 0, rssi: -55 }, { id: 'c', offset: 0, rssi: -80 }], 'vikram', 0, false, now, cfg, 30);
  assert.deepEqual(crowd, { targetId: 'b', m: { method: 'ble', near: { a: -56, b: -55 }, heading: 30 } });

  // -58 corrected = 1 m: fine for vikram (1.5), too far for ghost (0.75)
  assert.ok('targetId' in selectTarget([{ id: 'a', offset: 0, rssi: -58 }], 'vikram', 0, false, now, cfg));
  assert.deepEqual(selectTarget([{ id: 'a', offset: 0, rssi: -58 }], 'ghost', 0, false, now, cfg), { miss: 'none' });

  // stale or angle-less UWB falls back to BLE signal strength
  const stale = selectTarget([{ id: 'a', offset: 0, rssi: -55, uwb: { d: 0.5, t: 0 } }], 'vikram', 0, true, now, cfg);
  assert.deepEqual(stale, { targetId: 'a', m: { method: 'ble', near: { a: -55 } } });
  assert.deepEqual(selectTarget([{ id: 'a', offset: 0, uwb: { d: 0.5, t: now } }], 'vikram', 0, true, now, cfg), { miss: 'none' });
  assert.deepEqual(selectTarget([], 'vikram', 0, false, now, cfg), { miss: 'none' });
});

test('coneCheck answers only when position error is smaller than the separation', async () => {
  const { coneCheck } = await import('./math.ts');
  const at = (x: number, y: number, acc = 0.5, floorId = 'f0') => ({ mapId: 'm', floorId, x, y, z: 0, acc, source: 'rtt' as const });
  assert.equal(coneCheck(at(0, 0), at(0, 3), 0, 45), 'in');
  assert.equal(coneCheck(at(0, 0), at(0, -3), 0, 45), 'out');
  assert.equal(coneCheck(at(0, 0), at(3, 3), 0, 45), 'unknown'); // on the edge
  assert.equal(coneCheck(at(0, 0, 3), at(0, 3, 3), 0, 45), 'unknown');
  assert.equal(coneCheck(at(0, 0), at(0, 1, 0.5, 'f1'), 0, 45), 'out');
});

test('toRadar: facing east puts an eastern point straight ahead', async () => {
  const { toRadar } = await import('./math.ts');
  const r = toRadar(L, 90, east(10));
  near(r.x, 0, 1e-3); near(r.y, 10, 1e-3);
  const n = toRadar(L, 90, north(10)); // north is to the left when facing east
  near(n.x, -10, 1e-3); near(n.y, 0, 1e-3);
});
