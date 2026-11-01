import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CFG } from './config.ts';
import {
  backAxisHeading, bleDistance, bleOffsets, bleThresholdDb, enu, makeSwingDetector,
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

test('selectTarget: UWB nearest in cone, BLE strongest, crowded, none', () => {
  const now = 1000;
  const uwbPick = selectTarget([
    { id: 'a', offset: 0, uwb: { d: 1.2, az: 10, t: now } },
    { id: 'b', offset: 0, uwb: { d: 0.8, az: 80, t: now } }, // out of cone
  ], 'vikram', 0, true, now, cfg);
  assert.deepEqual('id' in uwbPick && uwbPick.id, 'a');

  const blePick = selectTarget([{ id: 'a', offset: 0, rssi: -55 }, { id: 'b', offset: 0, rssi: -65 }], 'vikram', 0, false, now, cfg);
  assert.equal('id' in blePick && blePick.id, 'a');

  const crowded = selectTarget([{ id: 'a', offset: 0, rssi: -55 }, { id: 'b', offset: 0, rssi: -56 }], 'vikram', 0, false, now, cfg);
  assert.deepEqual(crowded, { miss: 'crowded' });

  // -58 corrected = 1 m: fine for vikram (1.5), too far for ghost (0.75)
  assert.ok('id' in selectTarget([{ id: 'a', offset: 0, rssi: -58 }], 'vikram', 0, false, now, cfg));
  assert.deepEqual(selectTarget([{ id: 'a', offset: 0, rssi: -58 }], 'ghost', 0, false, now, cfg), { miss: 'none' });

  // stale UWB falls back to BLE
  const stale = selectTarget([{ id: 'a', offset: 0, rssi: -55, uwb: { d: 0.5, t: 0 } }], 'vikram', 0, true, now, cfg);
  assert.equal('method' in stale && stale.method, 'ble');
});

test('toRadar: facing east puts an eastern point straight ahead', async () => {
  const { toRadar } = await import('./math.ts');
  const r = toRadar(L, 90, east(10));
  near(r.x, 0, 1e-3); near(r.y, 10, 1e-3);
  const n = toRadar(L, 90, north(10)); // north is to the left when facing east
  near(n.x, -10, 1e-3); near(n.y, 0, 1e-3);
});
