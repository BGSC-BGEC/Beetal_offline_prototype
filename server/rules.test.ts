import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CFG } from '../shared/config.ts';
import { addPlayer, completeTaskSet, kill, newGame, resolveWindow, start, tick, type Claim, type Game } from './rules.ts';

const cfg = structuredClone(DEFAULT_CFG);
// rng that always picks index 0 of the candidate list
const first = () => 0;

function game(n: number): Game {
  const g = newGame(cfg);
  for (let i = 0; i < n; i++) addPlayer(g, 'p' + i, 'P' + i, false);
  return g;
}

const bleClaim = (a: string, t: string, recvAt = 0): Claim => ({ attackerId: a, targetId: t, m: { method: 'ble', rssiC: -50 }, recvAt });

test('start possesses one player and starts the 2-min timer', () => {
  const g = game(4);
  const fx = start(g, 1000, first);
  assert.equal(g.hostId, 'p0');
  assert.equal(g.timerEndsAt, 1000 + cfg.possessionMs);
  assert.deepEqual(fx.map(e => e.type), ['possessed', 'bell']);
});

test('killing the host = players win, survivors split', () => {
  const g = game(4); start(g, 0, first);
  const fx = kill(g, 'p0', 'player', 10, first);
  assert.equal(g.result?.kind, 'players');
  assert.deepEqual(g.result!.winners, ['p1', 'p2', 'p3']);
  assert.ok(fx.some(e => e.type === 'scream'));
});

test('player kill of non-host: transfer, no immunity, previous host still eligible', () => {
  const g = game(4); start(g, 0, first);
  kill(g, 'p1', 'player', 10, first);
  assert.equal(g.players.p0.immuneUntil, 0);
  assert.equal(g.hostId, 'p0'); // re-possessed (first candidate), timer restarted
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
    resolveWindow(g, [bleClaim(killer, victim)], {}, 10, first);
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
  const { rejected } = resolveWindow(g, [bleClaim('p1', 'p0', 1), bleClaim('p0', 'p2', 5)], {}, 10, first);
  assert.equal(g.players.p2.alive, false);
  assert.equal(g.players.p0.alive, true);
  assert.equal(rejected[0].reason, 'ghost-priority');
  assert.equal(g.result, null);
});

test('cooldown and range validation', () => {
  const g = game(5); start(g, 0, first);
  resolveWindow(g, [bleClaim('p1', 'p2')], {}, 10, first);
  const r1 = resolveWindow(g, [bleClaim('p1', 'p3')], {}, 20, first);
  assert.equal(r1.rejected[0].reason, 'cooldown');
  const weak: Claim = { attackerId: 'p3', targetId: 'p4', m: { method: 'ble', rssiC: -80 }, recvAt: 0 };
  assert.equal(resolveWindow(g, [weak], {}, 30, first).rejected[0].reason, 'range');
  const wide: Claim = { attackerId: 'p3', targetId: 'p4', m: { method: 'uwb', d: 1, az: 70 }, recvAt: 0 };
  assert.equal(resolveWindow(g, [wide], {}, 30, first).rejected[0].reason, 'angle');
});

test('ghost has the shorter range', () => {
  const g = game(5); start(g, 0, first); // host p0
  const at12 = (a: string, t: string): Claim => ({ attackerId: a, targetId: t, m: { method: 'uwb', d: 1.2 }, recvAt: 0 });
  assert.equal(resolveWindow(g, [at12('p0', 'p1')], {}, 10, first).rejected[0].reason, 'range');
  assert.equal(resolveWindow(g, [at12('p2', 'p3')], {}, 10, first).rejected.length, 0);
});

test('reverse reading and GPS sanity reject bogus claims', () => {
  const g = game(4); start(g, 0, first);
  const nbrs = { p2: { p1: { rssiC: -90, t: 100 } } };
  assert.equal(resolveWindow(g, [bleClaim('p1', 'p2')], nbrs, 100, first).rejected[0].reason, 'reverse');
  g.players.p1.pos = { lat: 19, lon: 72, acc: 3 };
  g.players.p2.pos = { lat: 19.001, lon: 72, acc: 3 }; // ~111 m away
  assert.equal(resolveWindow(g, [bleClaim('p1', 'p2')], {}, 100, first).rejected[0].reason, 'gps');
});
