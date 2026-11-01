// Fake players for solo testing: `node server/bots.ts <ROOMCODE> [count] [ws://host:8787]`.
// Bots join the room and ready up; the host phone then presses Start.
// Bots stand in a ring around the first real player's GPS fix (or a fixed point), wander slowly,
// and now and then claim kills on each other, so a single phone hears bells/screams and sees pings.
// They don't advertise BLE, so a real phone can't stab them — that needs real phones.
import { WebSocket } from 'ws';

const CODE = process.argv[2];
const N = Number(process.argv[3] ?? 3);
const URL = process.argv[4] ?? 'ws://localhost:8787';
if (!CODE) { console.error('usage: node server/bots.ts <ROOMCODE> [count] [ws-url]'); process.exit(1); }
let center = { lat: Number(process.env.LAT ?? 19.076), lon: Number(process.env.LON ?? 72.8777) };
const M = 1 / 111_320;

type Bot = { ws: WebSocket; id?: string; name: string; angle: number; r: number; possessed: boolean; alive: boolean };
const bots: Bot[] = [];
const others = new Map<string, { alive: boolean }>();

for (let i = 0; i < N; i++) {
  const b: Bot = { ws: new WebSocket(URL), name: `Bot${i + 1}`, angle: (i / N) * 2 * Math.PI, r: 10 + 5 * i, possessed: false, alive: true };
  bots.push(b);
  b.ws.on('open', () => b.ws.send(JSON.stringify({ t: 'join', code: CODE, name: b.name, uwb: false })));
  b.ws.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.t === 'welcome') { b.id = m.id; b.ws.send(JSON.stringify({ t: 'ready', on: true })); }
    if (m.t === 'error') console.log(`${b.name}: ${m.msg}`);
    if (m.t === 'possessed') { b.possessed = true; console.log(`${b.name} is possessed`); }
    if (m.t === 'released') b.possessed = false;
    if ((m.t === 'welcome' || m.t === 'map') && m.arena) { console.error('Bots simulate outdoor GPS only. Use real phones for an indoor room.'); b.ws.close(); return; }
    if (m.t === 'state') {
      if (m.phase === 'LOBBY' && !m.players.find((p: any) => p.id === b.id)?.ready) b.ws.send(JSON.stringify({ t: 'ready', on: true }));
      if (m.phase === 'LOBBY') { b.alive = true; b.possessed = false; }
      for (const p of m.players) {
        others.set(p.id, { alive: p.alive });
        if (p.id === b.id) b.alive = p.alive;
      }
    }
    if (m.t === 'ping' && bots[0] === b) {
      // follow the real player(s): re-centre on the first non-bot position in the snapshot
      const real = m.snapshot.find((s: any) => s.pos && !bots.some(x => x.id === s.id));
      if (real) center = { lat: real.pos.lat, lon: real.pos.lon };
    }
    if (m.t === 'end') console.log('END', m.result.kind);
  });
}

// wander + report position 1 Hz
setInterval(() => {
  for (const b of bots) {
    if (!b.id || b.ws.readyState !== WebSocket.OPEN) continue;
    b.angle += 0.03;
    const lat = center.lat + b.r * Math.cos(b.angle) * M;
    const lon = center.lon + b.r * Math.sin(b.angle) * M / Math.cos((center.lat * Math.PI) / 180);
    b.ws.send(JSON.stringify({ t: 'pos', lat, lon, acc: 4 }));
  }
}, 1000);

// every ~15 s one living bot (the possessed one, if any, more often) stabs another living bot
setInterval(() => {
  const living = bots.filter(b => b.alive && b.id);
  if (living.length < 2 || Math.random() < 0.4) return;
  const attacker = living.find(b => b.possessed) ?? living[Math.floor(Math.random() * living.length)];
  const target = living.filter(b => b !== attacker)[Math.floor(Math.random() * (living.length - 1))];
  // pretend they met: close in GPS too, so the server's GPS sanity check passes
  target.angle = attacker.angle; target.r = attacker.r;
  setTimeout(() => {
    attacker.ws.send(JSON.stringify({ t: 'kill', targetId: target.id, m: { method: 'ble', near: { [target.id as string]: -50 } } }));
    console.log(`${attacker.name} stabs ${target.name}`);
  }, 1500);
}, 15_000);

console.log(`${N} bots -> room ${CODE} at ${URL}`);
