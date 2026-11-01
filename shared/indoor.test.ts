import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateFingerprint, locateRtt, locateRtt3D, relativeHeight, validIndoorMap, validIndoorPosition, wallBetween, type IndoorMap } from './indoor.ts';
import { blur, enu, spatialize } from './math.ts';
import { DEFAULT_CFG } from './config.ts';

function map(): IndoorMap {
  return {
    id: 'studio', name: 'Studio', northDeg: 0, phoneHeightM: 1.2,
    floors: [0, 3].map((z, i) => ({ id: `f${i}`, name: `Floor ${i}`, z, width: 20, depth: 20, walls: [], markers: [{ id: 'entry', name: 'Entry', x: 1, y: 1 }] })),
    accessPoints: [{ bssid: '00:00:00:00:00:01', x: 0, y: 0, z: 2.5 }, { bssid: '00:00:00:00:00:02', x: 20, y: 0, z: 2.5 }, { bssid: '00:00:00:00:00:03', x: 0, y: 20, z: 5.5 }],
    fingerprints: [],
  };
}

test('imported indoor maps reject invalid geometry, identifiers and fingerprint data', () => {
  assert.equal(validIndoorMap(map()), true);
  for (const mutate of [
    (m: any) => { m.floors[0].width = NaN; },
    (m: any) => { m.floors[0].markers[0].x = 21; },
    (m: any) => { m.floors[0].walls = [{ a: { x: -1, y: 0 }, b: { x: 2, y: 2 } }]; },
    (m: any) => { m.floors[1].id = 'f0'; },
    (m: any) => { m.id = 'invalid:marker:format'; },
    (m: any) => { m.accessPoints[0].bssid = 'not-a-mac'; },
    (m: any) => { m.phoneHeightM = 0; },
    (m: any) => { m.fingerprints = [{ floorId: 'missing', x: 1, y: 1, readings: [] }]; },
  ]) { const m = map(); mutate(m); assert.equal(validIndoorMap(m), false); }
  assert.equal(validIndoorMap(null), false);
});

test('RTT solves a known-floor position using measured AP heights and rejects insufficient geometry', () => {
  const m = map(), floor = m.floors[0];
  const ranges = m.accessPoints.map(ap => ({ bssid: ap.bssid, d: Math.hypot(4 - ap.x, 7 - ap.y, floor.z + m.phoneHeightM - ap.z), error: 0.1 }));
  const p = locateRtt(m, floor, ranges)!;
  assert.ok(p);
  assert.ok(Math.abs(p.x - 4) < 1e-6 && Math.abs(p.y - 7) < 1e-6);
  assert.equal(p.z, 0); assert.ok(p.acc >= 1);
  assert.equal(locateRtt(m, floor, ranges.slice(0, 2)), null);
  m.accessPoints[2] = { ...m.accessPoints[2], x: 10, y: 0 };
  assert.equal(locateRtt(m, floor, ranges), null);
});

test('fingerprints require three overlapping signals and reject ambiguous places', () => {
  const m = map(), floor = m.floors[0];
  const readings = m.accessPoints.map((ap, i) => ({ bssid: ap.bssid, rssi: -50 - 10 * i, rtt: false, t: 0 }));
  m.fingerprints.push({ floorId: floor.id, x: 4, y: 6, readings });
  assert.equal(locateFingerprint(m, floor, readings)?.x, 4);
  assert.ok(locateFingerprint(m, floor, readings)!.acc >= 4);
  assert.equal(locateFingerprint(m, floor, readings.slice(0, 2)), null);
  assert.equal(locateFingerprint(m, m.floors[1], readings), null);
  m.fingerprints.push({ floorId: floor.id, x: 14, y: 16, readings });
  assert.equal(locateFingerprint(m, floor, readings), null);
});

test('full 3D RTT recovers height/floor and rejects coplanar responders', () => {
  const m = map();
  m.accessPoints.push({ bssid: '00:00:00:00:00:04', x: 20, y: 20, z: 8.5 });
  const ranges = m.accessPoints.map(ap => ({ bssid: ap.bssid, d: Math.hypot(4 - ap.x, 7 - ap.y, 3 + m.phoneHeightM - ap.z), error: 0.1 }));
  const p = locateRtt3D(m, ranges)!;
  assert.ok(p);
  assert.ok(Math.abs(p.x - 4) < 1e-6 && Math.abs(p.y - 7) < 1e-6 && Math.abs(p.z - 3) < 1e-6);
  assert.equal(p.floorId, 'f1');
  assert.equal(locateRtt3D(m, ranges.slice(0, 3)), null);
  for (const ap of m.accessPoints) ap.z = 2.5;
  assert.equal(locateRtt3D(m, ranges), null);
});

test('indoor position validation and 3D distances keep coordinate frames and floors separate', () => {
  const m = map();
  const a = { mapId: m.id, floorId: 'f0', x: 2, y: 3, z: 0, acc: 0.5, source: 'marker' as const };
  const b = { ...a, floorId: 'f1', z: 3 };
  assert.equal(validIndoorPosition(a, m), true);
  assert.equal(validIndoorPosition({ ...a, x: -1 }, m), false);
  assert.equal(validIndoorPosition({ ...a, mapId: 'elsewhere' }, m), false);
  assert.equal(validIndoorPosition({ ...a, acc: NaN }, m), false);
  assert.equal(enu(a, b).d, 3);
  assert.equal(enu(a, { lat: 19, lon: 72, acc: 3 }).d, Infinity);
  assert.equal(spatialize(a, 0, { ...b, mapId: 'elsewhere' }, 'bell', DEFAULT_CFG).gain, 0);
  const moved = blur(a, 6, () => 0.5);
  assert.ok('mapId' in moved && moved.floorId === a.floorId && moved.z === a.z);
});

test('wall intersections include endpoints but permit a door gap and disjoint collinear lines', () => {
  const wall = { a: { x: 5, y: 0 }, b: { x: 5, y: 4 } };
  assert.equal(wallBetween({ x: 4, y: 2 }, { x: 6, y: 2 }, [wall]), true);
  assert.equal(wallBetween({ x: 4, y: 4 }, { x: 5, y: 4 }, [wall]), true);
  assert.equal(wallBetween({ x: 4, y: 5 }, { x: 6, y: 5 }, [wall]), false);
  assert.equal(wallBetween({ x: 5, y: 6 }, { x: 5, y: 7 }, [wall]), false);
});

test('pressure indicates relative height without asserting a floor identity', () => {
  assert.equal(relativeHeight(1013.25, 1013.25), 0);
  assert.ok(relativeHeight(1013.25, 1012.9) > 2 && relativeHeight(1013.25, 1012.9) < 4);
});

