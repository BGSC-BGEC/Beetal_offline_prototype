import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CFG } from '../shared/config.ts';
import type { IndoorMap } from '../shared/indoor.ts';
import { addPlayer, completeTaskSet, kill, newGame, resolveWindow, start, tick, validateClaim, type Claim, type Game } from './rules.ts';

const cfg = structuredClone(DEFAULT_CFG);
// rng that always picks index 0 of the candidate list
const first = () => 0;

function game(n: number): Game {
  const g = newGame(cfg);
  for (let i = 0; i < n; i++) addPlayer(g, 'p' + i, 'P' + i, false);
  return g;
}

const uwbClaim = (a: string, t: string, recvAt = 0): Claim => ({ attackerId: a, targetId: t, m: { method: 'uwb', d: 0.5, az: 0 }, recvAt });

test('start possesses one player and starts the 2-min timer', () => {
  const g = game(4);
  const fx = start(g, 1000, first);
  assert.equal(g.hostId, 'p0');
  assert.equal(g.timerEndsAt, 1000 + cfg.possessionMs);
  assert.deepEqual(fx.map(e => e.type), ['possessed', 'bell', 'ping']);
  const ping = fx.find(e => e.type === 'ping');
  assert.ok(ping && ping.type === 'ping');
  assert.equal(ping.exitedId, null);
  assert.equal(ping.snapshot.length, 4);
  assert.ok(ping.snapshot.every(p => !p.exited));
});

test('killing the host = players win, survivors split', () => {
  const g = game(4); start(g, 0, first);
  const fx = kill(g, 'p0', 'player', 10, first);
  assert.equal(g.result?.kind, 'players');
  assert.deepEqual(g.result!.winners, ['p1', 'p2', 'p3']);
  assert.ok(fx.some(e => e.type === 'scream'));
});

test('player kill of non-host transfers to someone different without granting immunity', () => {
  const g = game(4); start(g, 0, first);
  kill(g, 'p1', 'player', 10, first);
  assert.equal(g.players.p0.immuneUntil, 0);
  assert.equal(g.hostId, 'p2'); // first eligible survivor other than the previous host
  assert.equal(g.timerEndsAt, 10 + cfg.possessionMs);
});

test('ghost kill: previous host immune 10 s and cannot be picked', () => {
  const g = game(4); start(g, 0, first);
  const fx = kill(g, 'p1', 'ghost', 10, first);
  assert.equal(g.players.p0.immuneUntil, 10 + cfg.immunityMs);
  assert.equal(g.hostId, 'p2');
  const ping = fx.find(e => e.type === 'ping');
  assert.ok(ping && ping.type === 'ping' && ping.exitedId === 'p0');
  assert.ok(fx.some(e => e.type === 'released' && e.id === 'p0'));
});

test('3 players: any non-host kill ends in Ghost win for the host at that moment', () => {
  for (const [killer, victim] of [['p1', 'p2'], ['p0', 'p2'], ['p2', 'p1']]) {
    const g = game(3); start(g, 0, first); // host p0
    resolveWindow(g, [uwbClaim(killer, victim)], {}, 10, first);
    assert.equal(g.result?.kind, 'ghost', `${killer} kills ${victim}`);
    assert.deepEqual(g.result!.winners, ['p0']);
  }
});

test('3 players: host sacrifices -> ghost moves, new host wins', () => {
  const g = game(3); start(g, 0, first);
  tick(g, cfg.possessionMs, first);
  assert.equal(g.players.p0.alive, false);
  assert.equal(g.result?.kind, 'ghost');
  assert.deepEqual(g.result!.winners, ['p1']);
});

test('timer expiry kills host and transfers', () => {
  const g = game(5); start(g, 0, first);
  assert.equal(tick(g, cfg.possessionMs - 1, first).length, 0);
  tick(g, cfg.possessionMs, first);
  assert.equal(g.players.p0.alive, false);
  assert.equal(g.hostId, 'p1');
});

test('task set: transfer + immunity; all living immune = Divya Vijaya', () => {
  const g = game(3); start(g, 0, first);
  completeTaskSet(g, 1, first); // p0 immune, host p1
  completeTaskSet(g, 2, first); // p1 immune, host p2
  assert.equal(g.hostId, 'p2');
  completeTaskSet(g, 3, first); // p2 immune -> nobody left
  assert.equal(g.result?.kind, 'divya');
  assert.equal(g.result!.winners.length, 3);
});

test('immunity expires', () => {
  const g = game(3); start(g, 0, first);
  completeTaskSet(g, 0, first); // p0 immune until 10000, host p1
  completeTaskSet(g, cfg.immunityMs, first); // p0 eligible again, p1 now immune
  assert.equal(g.hostId, 'p0');
});

test('concurrent kills: ghost kill wins, claim against host voided', () => {
  const g = game(5); start(g, 0, first); // host p0
  const { rejected } = resolveWindow(g, [uwbClaim('p1', 'p0', 1), uwbClaim('p0', 'p2', 5)], {}, 10, first);
  assert.equal(g.players.p2.alive, false);
  assert.equal(g.players.p0.alive, true);
  assert.equal(rejected[0].reason, 'ghost-priority');
  assert.equal(g.result, null);
});

test('cooldown and range validation', () => {
  const g = game(5); start(g, 0, first);
  resolveWindow(g, [uwbClaim('p1', 'p2')], {}, 10, first);
  const r1 = resolveWindow(g, [uwbClaim('p1', 'p3')], {}, 20, first);
  assert.equal(r1.rejected[0].reason, 'cooldown');
  const weak: Claim = { attackerId: 'p3', targetId: 'p4', m: { method: 'ble', near: { p4: -80 } }, recvAt: 0 };
  assert.equal(resolveWindow(g, [weak], {}, 30, first).rejected[0].reason, 'range');
  const wide: Claim = { attackerId: 'p3', targetId: 'p4', m: { method: 'uwb', d: 1, az: 70 }, recvAt: 0 };
  assert.equal(resolveWindow(g, [wide], {}, 30, first).rejected[0].reason, 'angle');
});

test('ghost has the shorter range', () => {
  const g = game(5); start(g, 0, first); // host p0
  const at12 = (a: string, t: string): Claim => ({ attackerId: a, targetId: t, m: { method: 'uwb', d: 1.2, az: 0 }, recvAt: 0 });
  assert.equal(resolveWindow(g, [at12('p0', 'p1')], {}, 10, first).rejected[0].reason, 'range');
  assert.equal(resolveWindow(g, [at12('p2', 'p3')], {}, 10, first).rejected.length, 0);
});

test('reverse reading and GPS sanity reject bogus claims', () => {
  const g = game(4); start(g, 0, first);
  const nbrs = { p2: { p1: { uwbD: 5, t: 100 } } };
  assert.equal(resolveWindow(g, [uwbClaim('p1', 'p2')], nbrs, 100, first).rejected[0].reason, 'reverse');
  g.players.p1.pos = { lat: 19, lon: 72, acc: 3 };
  g.players.p2.pos = { lat: 19.001, lon: 72, acc: 3 }; // ~111 m away
  assert.equal(resolveWindow(g, [uwbClaim('p1', 'p2')], {}, 100, first).rejected[0].reason, 'gps');
});

test('immunity blocks possession, but does not block attacks or death', () => {
  const g = game(5); start(g, 0, first);
  g.players.p1.immuneUntil = 10_000;
  g.players.p2.immuneUntil = 10_000;
  assert.equal(validateClaim(g, uwbClaim('p1', 'p2'), {}, 100), null);
  kill(g, 'p2', 'player', 100, first);
  assert.equal(g.players.p2.alive, false);
  assert.equal(g.hostId, 'p3');
});

test('transfer ends in Divya Vijaya when no different unprotected host exists', () => {
  const g = game(4); start(g, 0, first);
  g.players.p2.immuneUntil = 10_000;
  g.players.p3.immuneUntil = 10_000;
  kill(g, 'p1', 'player', 100, first);
  assert.equal(g.result?.kind, 'divya');
});

test('UWB claims need a finite angle inside the cone', () => {
  const g = game(4); start(g, 0, first);
  const claim = uwbClaim('p1', 'p2');
  for (const m of [{ method: 'uwb', d: 0.5 }, { method: 'uwb', d: 0.5, az: NaN }] as Claim['m'][])
    assert.equal(validateClaim(g, { ...claim, m }, {}, 100), 'direction');
  assert.equal(validateClaim(g, { ...claim, m: { method: 'uwb', d: 0.5, az: 45 } }, {}, 100), null);
  assert.equal(validateClaim(g, { ...claim, m: { method: 'uwb', d: 0.5, az: -46 } }, {}, 100), 'angle');
  for (const d of [NaN, Infinity, -1]) assert.equal(validateClaim(g, { ...claim, m: { method: 'uwb', d, az: 0 } }, {}, 100), 'range');
});

test('indoor hits reject missing fixes, other floors, walls and stale positions', () => {
  const g = game(4); start(g, 0, first);
  const arena: IndoorMap = {
    id: 'studio', name: 'Studio', northDeg: 0, phoneHeightM: 1.2,
    floors: [0, 3].map((z, i) => ({ id: `f${i}`, name: `Floor ${i}`, z, width: 20, depth: 20, walls: [], markers: [] })),
    accessPoints: [], fingerprints: [],
  };
  g.arena = arena;
  const c = uwbClaim('p1', 'p2');
  assert.equal(validateClaim(g, c, {}, 100), 'position');
  g.players.p1.pos = { mapId: arena.id, floorId: 'f0', x: 2, y: 2, z: 0, acc: 1, source: 'rtt' };
  g.players.p2.pos = { ...g.players.p1.pos, x: 2.5 };
  g.players.p1.posAt = g.players.p2.posAt = 100;
  assert.equal(validateClaim(g, c, {}, 100), null);
  g.players.p2.pos = { ...g.players.p2.pos, floorId: 'f1', z: 3 };
  assert.equal(validateClaim(g, c, {}, 100), 'floor');
  g.players.p2.pos = { ...g.players.p2.pos, floorId: 'f0', z: 0 };
  arena.floors[0].walls.push({ a: { x: 2.25, y: 0 }, b: { x: 2.25, y: 4 } });
  assert.equal(validateClaim(g, c, {}, 100), 'wall');
  arena.floors[0].walls = [];
  assert.equal(validateClaim(g, c, {}, 100 + cfg.indoor.posFreshMs + 1), 'position');
  g.players.p2.pos = { ...g.players.p2.pos, mapId: 'other' };
  assert.equal(validateClaim(g, c, {}, 100), 'position');
});

test('BLE: a lone peer in range is hit; a crowd needs the position cone to leave exactly one', () => {
  const g = game(5); start(g, 0, first); // host p0
  const ble = (near: Record<string, number>, heading?: number): Claim =>
    ({ attackerId: 'p1', targetId: Object.keys(near)[0], m: { method: 'ble', near, heading }, recvAt: 0 });
  assert.equal(validateClaim(g, ble({ p2: -50 }), {}, 100), null);
  assert.equal(validateClaim(g, ble({ p2: -50, p3: -51 }), {}, 100), 'crowded'); // no positions/heading
  // indoor-quality fixes: p2 3 m north of p1, p3 3 m south. Facing north picks p2 even though p3 is louder.
  const at = (y: number) => ({ mapId: 'm', floorId: 'f0', x: 5, y, z: 0, acc: 0.5, source: 'rtt' as const });
  g.players.p1.pos = at(5); g.players.p2.pos = at(8); g.players.p3.pos = at(2);
  const c = ble({ p3: -50, p2: -51 }, 0);
  assert.equal(validateClaim(g, c, {}, 100), null);
  assert.equal(c.targetId, 'p2');
  assert.equal(validateClaim(g, ble({ p2: -50, p3: -51 }, 90), {}, 100), 'angle'); // both outside the cone
  // GPS-grade fixes are too coarse for a cone at melee range: crowd stays ambiguous
  g.players.p2.pos = { ...at(8), acc: 5 }; g.players.p3.pos = { ...at(2), acc: 5 };
  assert.equal(validateClaim(g, ble({ p3: -50, p2: -51 }, 0), {}, 100), 'crowded');
  assert.equal(validateClaim(g, ble({ p2: -90 }), {}, 100), 'range');
});

test('indoor: walls only block hits when both fixes are precise', () => {
  const g = game(4); start(g, 0, first);
  g.arena = {
    id: 'm', name: 'M', northDeg: 0, phoneHeightM: 1.2, accessPoints: [], fingerprints: [],
    floors: [{ id: 'f0', name: 'G', z: 0, width: 10, depth: 10, markers: [], walls: [{ a: { x: 5, y: 0 }, b: { x: 5, y: 10 } }] }],
  };
  g.players.p1.pos = { mapId: 'm', floorId: 'f0', x: 4.5, y: 5, z: 0, acc: 1, source: 'rtt' };
  g.players.p2.pos = { ...g.players.p1.pos, x: 5.5 };
  g.players.p1.posAt = g.players.p2.posAt = 100;
  assert.equal(validateClaim(g, uwbClaim('p1', 'p2'), {}, 100), 'wall');
  g.players.p2.pos = { ...g.players.p2.pos, acc: 4, source: 'fingerprint' };
  assert.equal(validateClaim(g, uwbClaim('p1', 'p2'), {}, 100), null);
});
