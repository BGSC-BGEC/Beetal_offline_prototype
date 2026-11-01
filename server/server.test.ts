// End-to-end over real sockets: rooms, lobby, host controls, a full possession/kill cycle, reconnect, results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from './server.ts';

const PORT = 18787;

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const inbox: any[] = [];
  ws.on('message', d => inbox.push(JSON.parse(String(d))));
  const open = new Promise(r => ws.on('open', r));
  const wait = async (pred: (m: any) => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('timeout waiting for message');
  };
  const last = (t: string) => [...inbox].reverse().find(m => m.t === t);
  return { ws, inbox, open, wait, last, send: (m: object) => ws.send(JSON.stringify(m)) };
}

test('create, join by code, ready-up, host start, countdown, kill, reconnect, results with history', async () => {
  const srv = startServer(PORT, () => 0, 50); // rng 0 = first candidate; 50 ms countdown
  try {
    const host = client(); await host.open;
    host.send({ t: 'create', name: 'Host', uwb: false });
    const hw = await host.wait(m => m.t === 'welcome');
    assert.equal(hw.protocolVersion, 2);
    assert.match(hw.code, /^[A-Z]{4}$/);

    const bad = client(); await bad.open;
    bad.send({ t: 'join', code: 'ZZZZ', name: 'x', uwb: false });
    assert.equal((await bad.wait(m => m.t === 'error')).msg, 'No game with that code');

    const p1 = client(), p2 = client();
    await Promise.all([p1.open, p2.open]);
    p1.send({ t: 'join', code: hw.code.toLowerCase(), name: 'A', uwb: false });
    p2.send({ t: 'join', code: hw.code, name: 'B', uwb: false });
    const w1 = await p1.wait(m => m.t === 'welcome');
    const w2 = await p2.wait(m => m.t === 'welcome');
    for (const c of [host, p1, p2]) c.send({ t: 'pos', lat: 19, lon: 72.8, acc: 3 });

    // non-host can't start; host can't start until everyone is ready
    p1.send({ t: 'host', cmd: 'start' });
    assert.equal((await p1.wait(m => m.t === 'error')).msg, 'Only the host can do that');
    host.send({ t: 'host', cmd: 'start' });
    assert.equal((await host.wait(m => m.t === 'error')).msg, 'Everyone must be ready');

    host.send({ t: 'host', cmd: 'setTimer', sec: 90 });
    host.send({ t: 'host', cmd: 'cfg', patch: { swing: { peak: null } } });
    assert.equal((await host.wait(m => m.t === 'error')).msg, 'Invalid strike settings');
    host.send({ t: 'host', cmd: 'cfg', patch: { swing: { peak: 14 } } });
    const cfg = await p1.wait(m => m.t === 'cfg');
    assert.equal(cfg.cfg.swing.peak, 14);
    assert.equal(cfg.cfg.swing.dominance, 2);
    for (const c of [host, p1, p2]) c.send({ t: 'ready', on: true });
    await host.wait(m => m.t === 'state' && m.players.every((p: any) => p.ready) && m.possessionSec === 90);
    host.send({ t: 'host', cmd: 'start' });
    await p1.wait(m => m.t === 'state' && m.phase === 'COUNTDOWN');

    // host (first player) is possessed after the countdown
    const pos = await host.wait(m => m.t === 'possessed');
    assert.ok(pos.endsAt - Date.now() > 85_000);
    const bell = await p1.wait(m => m.t === 'event' && m.kind === 'bell');
    assert.equal(bell.self, false);
    assert.ok(!JSON.stringify(bell).includes(hw.id), 'bell must not leak host id');
    const ping = await p1.wait(m => m.t === 'ping');
    assert.equal(ping.snapshot.length, 3);
    assert.ok(ping.snapshot.every((p: any) => p.pos && !p.exited));
    assert.ok(ping.until > Date.now());

    // p1 drops and reconnects with its token mid-game
    p1.ws.close();
    const p1b = client(); await p1b.open;
    p1b.send({ t: 'join', name: 'A', uwb: false, token: w1.token });
    assert.equal((await p1b.wait(m => m.t === 'welcome')).id, w1.id);

    // Two peers inside BLE range and no heading to tell them apart: too crowded, no kill.
    host.send({ t: 'kill', targetId: w2.id, m: { method: 'ble', near: { [w1.id]: -52, [w2.id]: -52 } } });
    const rejected = await host.wait(m => m.t === 'killResult');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'crowded');

    // Ghost (host) stabs B with distance + angle, 3 alive -> 2 left -> Ghost wins
    host.send({ t: 'kill', targetId: w2.id, m: { method: 'uwb', d: 0.5, az: 0 } });
    assert.equal((await host.wait(m => m.t === 'killResult')).ok, true);
    const end = await p1b.wait(m => m.t === 'end');
    assert.equal(end.result.kind, 'ghost');
    assert.deepEqual(end.result.winners, [hw.id]);
    assert.deepEqual(end.history.map((h: any) => h.kind), ['possessed', 'kill']);
    assert.equal(end.history[1].by, hw.id);

    // play again -> same room back in lobby, nobody ready
    host.send({ t: 'host', cmd: 'reset' });
    const st = await p1b.wait(m => m.t === 'state' && m.phase === 'LOBBY');
    assert.ok(st.players.every((p: any) => !p.ready && p.alive));

    const map = {
      id: 'studio', name: 'Studio', northDeg: 0, phoneHeightM: 1.2,
      floors: [{ id: 'f0', name: 'Ground', z: 0, width: 20, depth: 20, walls: [], markers: [{ id: 'entry', name: 'Entry', x: 1, y: 1 }] }],
      accessPoints: [], fingerprints: [],
    };
    p1b.send({ t: 'host', cmd: 'setMap', map });
    assert.equal((await p1b.wait(m => m.t === 'error')).msg, 'Only the host can do that');
    host.send({ t: 'host', cmd: 'setMap', map: { ...map, floors: [] } });
    assert.equal((await host.wait(m => m.t === 'error')).msg, 'Invalid indoor map');
    host.send({ t: 'host', cmd: 'setMap', map });
    assert.deepEqual((await p1b.wait(m => m.t === 'map')).arena, map);
    const room = srv.rooms.get(hw.code)!;
    assert.equal(room.g.players[hw.id].pos, undefined, 'changing the coordinate frame discards GPS fixes');
    host.send({ t: 'host', cmd: 'start' });
    assert.equal((await host.wait(m => m.t === 'error')).msg, 'Everyone needs a fresh indoor marker or Wi-Fi fix before starting');
    host.send({ t: 'pos', mapId: 'studio', floorId: 'f0', x: 1, y: 1, z: 0, acc: 0.5, source: 'marker' });
    host.send({ t: 'host', cmd: 'setTimer', sec: 91 });
    await host.wait(m => m.t === 'state' && m.possessionSec === 91);
    assert.equal('mapId' in room.g.players[hw.id].pos!, true);
    host.send({ t: 'pos', mapId: 'studio', floorId: 'f0', x: -50, y: 1, z: 0, acc: 0.5, source: 'marker' });
    host.send({ t: 'host', cmd: 'setTimer', sec: 92 });
    await host.wait(m => m.t === 'state' && m.possessionSec === 92);
    assert.equal((room.g.players[hw.id].pos as any).x, 1, 'invalid indoor positions must not replace a valid fix');
    host.send({ t: 'host', cmd: 'setMap', map: null });
    assert.equal((await p1b.wait(m => m.t === 'map')).arena, null);

    // leaving in the lobby removes you; host leaving hands over host
    host.send({ t: 'leave' });
    await host.wait(m => m.t === 'left');
    const st2 = await p1b.wait(m => m.t === 'state' && m.players.length === 2);
    assert.notEqual(st2.ownerId, hw.id);

    [host, bad, p1b, p2].forEach(c => c.ws.close());
  } finally { srv.close(); }
});
