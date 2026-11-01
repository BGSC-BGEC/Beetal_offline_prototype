// Betaal game server. Many rooms, each joined by a 4-letter code. The first phone in a room owns it
// (host controls); the GM page at / can watch and drive any room for debugging.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_CFG, type Cfg } from '../shared/config.ts';
import { bleOffsets } from '../shared/math.ts';
import type { ClientMsg, HistoryEntry, HostCmd, PublicPlayer, ServerMsg } from '../shared/protocol.ts';
import {
  addPlayer, completeTaskSet, kill, newGame, resolveWindow, start, tick,
  type Claim, type Effect, type Game, type NbrTable,
} from './rules.ts';

const MAX_PLAYERS = 10;
const COUNTDOWN_MS = 10_000;
const DROP_MS = 60_000;          // disconnected this long during a hunt = eliminated
const ROOM_IDLE_MS = 30 * 60_000; // nobody connected this long = room deleted
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O

type Room = {
  code: string; cfg: Cfg; g: Game; bleRoom: number;
  nbrs: NbrTable;
  sockets: Map<string, WebSocket>;    // playerId -> socket (connected only)
  lastSeen: Map<string, number>;      // playerId -> last time connected
  ready: Set<string>;
  ownerId: string | null;
  calib: Record<string, number[]>;
  claims: Claim[]; windowTimer: NodeJS.Timeout | null;
  countdownEndsAt: number | null;
  startedAt: number; history: HistoryEntry[];
  gms: Set<WebSocket>;
  leaving: string | null; // player being removed for disconnecting (labels the kill in history)
};

export function startServer(port: number, rng: () => number = Math.random, countdownMs = COUNTDOWN_MS) {
  const rooms = new Map<string, Room>();
  const tokenRoom = new Map<string, string>(); // playerId/token -> room code
  const watchers = new Set<WebSocket>();        // GM pages (get the room list)

  const send = (ws: WebSocket | undefined, m: ServerMsg | object) =>
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  function newCode(): string {
    for (;;) {
      const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]).join('');
      if (!rooms.has(c)) return c;
    }
  }

  function makeRoom(): Room {
    const cfg: Cfg = structuredClone(DEFAULT_CFG);
    const r: Room = {
      code: newCode(), cfg, g: newGame(cfg), bleRoom: Math.floor(rng() * 0xffff),
      nbrs: {}, sockets: new Map(), lastSeen: new Map(), ready: new Set(), ownerId: null,
      calib: {}, claims: [], windowTimer: null, countdownEndsAt: null, startedAt: 0, history: [], gms: new Set(), leaving: null,
    };
    rooms.set(r.code, r);
    return r;
  }

  // ---------- state broadcast ----------
  function publicState(r: Room): ServerMsg {
    const now = Date.now();
    const players: PublicPlayer[] = Object.values(r.g.players).map(p => ({
      id: p.id, name: p.name, idx: p.idx, alive: p.alive, immune: p.immuneUntil > now, uwb: p.uwb, bleOffset: p.bleOffset,
      ready: r.ready.has(p.id), connected: r.sockets.has(p.id), calibrated: (r.calib[p.id]?.length ?? 0) > 0,
    }));
    return {
      t: 'state', code: r.code, phase: r.g.phase, players, ownerId: r.ownerId,
      countdownEndsAt: r.countdownEndsAt, possessionSec: r.cfg.possessionMs / 1000,
    };
  }
  function broadcast(r: Room) {
    const st = publicState(r);
    r.sockets.forEach(ws => send(ws, st));
    const gm = JSON.stringify({ t: 'gmState', now: Date.now(), code: r.code, game: r.g, nbrs: r.nbrs, ownerId: r.ownerId, calib: r.calib, ready: [...r.ready] });
    r.gms.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(gm));
  }
  function roomList() {
    const list = [...rooms.values()].map(r => ({ code: r.code, phase: r.g.phase, players: Object.keys(r.g.players).length }));
    watchers.forEach(ws => send(ws, { t: 'rooms', list }));
  }

  // ---------- effects -> messages (+ history) ----------
  function dispatch(r: Room, fx: Effect[]) {
    const now = Date.now();
    const at = () => now - r.startedAt;
    for (const e of fx) {
      switch (e.type) {
        case 'possessed':
          r.history.push({ at: at(), kind: 'possessed', id: e.id });
          send(r.sockets.get(e.id), { t: 'possessed', endsAt: e.endsAt, storyId: e.storyId });
          break;
        case 'released': send(r.sockets.get(e.id), { t: 'released' }); break;
        case 'bell': r.sockets.forEach((ws, id) => send(ws, { t: 'event', kind: 'bell', at: e.at, self: id === e.hostId })); break;
        case 'scream':
          r.history.push({ at: at(), kind: 'kill', victim: e.victimId, by: e.by, cause: r.leaving === e.victimId ? 'left' : e.cause });
          r.sockets.forEach((ws, id) => send(ws, { t: 'event', kind: 'scream', at: e.at, self: id === e.victimId }));
          break;
        case 'ping': r.sockets.forEach(ws => send(ws, { t: 'ping', snapshot: e.snapshot, until: now + r.cfg.pingMs })); break;
        case 'end':
          r.ready.clear();
          r.sockets.forEach(ws => send(ws, { t: 'end', result: e.result, history: r.history }));
          break;
      }
    }
    if (fx.length) broadcast(r);
  }

  function flushWindow(r: Room) {
    r.windowTimer = null;
    const batch = r.claims; r.claims = [];
    const { fx, rejected } = resolveWindow(r.g, batch, r.nbrs, Date.now(), rng);
    for (const c of batch) {
      const rej = rejected.find(x => x.claim === c);
      send(r.sockets.get(c.attackerId), { t: 'killResult', ok: !rej, targetId: c.targetId, reason: rej?.reason });
    }
    dispatch(r, fx);
  }

  // ---------- host commands (owner phone or GM page) ----------
  function hostCmd(r: Room, m: HostCmd, fromGm: boolean): string | null {
    const g = r.g;
    const now = Date.now();
    switch (m.cmd) {
      case 'start': {
        if (g.phase !== 'LOBBY' && g.phase !== 'CALIBRATION') return 'Game already running';
        const ps = Object.values(g.players);
        if (ps.length < 3) return 'Need at least 3 players';
        if (!fromGm && ps.some(p => !r.ready.has(p.id))) return 'Everyone must be ready';
        g.phase = 'COUNTDOWN';
        r.countdownEndsAt = now + countdownMs;
        break;
      }
      case 'setTimer':
        if (g.phase !== 'LOBBY') return 'Only in the lobby';
        r.cfg.possessionMs = Math.min(300, Math.max(60, Math.round(m.sec))) * 1000;
        break;
      case 'calibStart':
        if (g.phase !== 'LOBBY') return 'Only in the lobby';
        g.phase = 'CALIBRATION';
        for (const k in r.calib) delete r.calib[k];
        for (const p of Object.values(g.players)) p.bleOffset = 0; // phones report raw RSSI while calibrating
        break;
      case 'calibFinish': {
        if (g.phase !== 'CALIBRATION') return 'Not calibrating';
        const C = Object.fromEntries(Object.entries(r.calib).map(([id, xs]) => [id, xs.reduce((a, b) => a + b, 0) / xs.length]));
        // ponytail: reference (owner) phone assumed typical, offset 0; fine for one studio fleet
        for (const [id, o] of Object.entries(bleOffsets(C))) if (g.players[id]) g.players[id].bleOffset = o;
        g.phase = 'LOBBY';
        break;
      }
      case 'reset': {
        if (g.phase !== 'RESULTS' && !fromGm) return 'Game still running';
        const old = g.players;
        r.g = newGame(r.cfg);
        for (const p of Object.values(old)) {
          if (!r.sockets.has(p.id)) { tokenRoom.delete(p.id); continue; } // drop players who left
          Object.assign(addPlayer(r.g, p.id, p.name, p.uwb), { bleOffset: p.bleOffset, pos: p.pos, idx: p.idx });
        }
        r.ready.clear(); r.history = []; r.countdownEndsAt = null; r.nbrs = {};
        break;
      }
      case 'task':
        if (g.phase !== 'HUNT') return 'Not in a hunt';
        r.history.push({ at: now - r.startedAt, kind: 'task' });
        dispatch(r, completeTaskSet(g, now, rng));
        break;
      case 'setRef': r.ownerId = m.id; break;
      case 'cfg':
        for (const [k, v] of Object.entries(m.patch)) (r.cfg as any)[k] = typeof v === 'object' ? { ...(r.cfg as any)[k], ...v } : v;
        r.sockets.forEach(ws => send(ws, { t: 'cfg', cfg: r.cfg }));
        break;
    }
    broadcast(r);
    return null;
  }

  // ---------- player messages inside a room ----------
  function onPlayer(r: Room, id: string, m: ClientMsg, ws: WebSocket) {
    const now = Date.now();
    const p = r.g.players[id];
    if (!p) return;
    switch (m.t) {
      case 'ready':
        if (r.g.phase !== 'LOBBY') break;
        m.on ? r.ready.add(id) : r.ready.delete(id);
        broadcast(r);
        break;
      case 'host': {
        if (id !== r.ownerId) return send(ws, { t: 'error', msg: 'Only the host can do that' });
        const err = hostCmd(r, m, false);
        if (err) send(ws, { t: 'error', msg: err });
        break;
      }
      case 'pos': p.pos = { lat: m.lat, lon: m.lon, acc: m.acc }; break;
      case 'nbr': {
        const row: NbrTable[string] = (r.nbrs[id] = {});
        for (const [peer, x] of Object.entries(m.peers)) row[peer] = { ...x, t: now };
        break;
      }
      case 'kill':
        r.claims.push({ attackerId: id, targetId: m.targetId, m: m.m, recvAt: now });
        r.windowTimer ??= setTimeout(() => flushWindow(r), r.cfg.killWindowMs);
        break;
      case 'calib': {
        // Player stood 1 m from the reference (owner) phone: its reading of ref + ref's live reading of it.
        const ref = r.ownerId;
        if (r.g.phase !== 'CALIBRATION' || !ref || id === ref || m.peerId !== ref) break;
        const xs = (r.calib[id] ??= []);
        xs.push(m.rssi);
        const rev = r.nbrs[ref]?.[id];
        if (rev?.rssiC !== undefined && now - rev.t <= r.cfg.ble.staleMs) xs.push(rev.rssiC);
        broadcast(r);
        break;
      }
      case 'uwbOob': send(r.sockets.get(m.to), { t: 'uwbOob', from: id, data: m.data }); break;
      case 'leave': leave(r, id); send(ws, { t: 'left' }); break;
    }
  }

  function removePlayer(r: Room, id: string) {
    delete r.g.players[id];
    r.ready.delete(id); r.sockets.delete(id); r.lastSeen.delete(id); tokenRoom.delete(id);
    if (r.ownerId === id) r.ownerId = Object.keys(r.g.players)[0] ?? null;
  }

  function leave(r: Room, id: string) {
    if (r.g.phase === 'HUNT' || r.g.phase === 'COUNTDOWN') {
      // Mid-game exit counts as a death so the rules stay consistent.
      r.sockets.delete(id);
      r.lastSeen.set(id, 0);
      dropIfGone(r, Date.now());
    } else removePlayer(r, id);
    if (!r.sockets.size && !Object.keys(r.g.players).length) rooms.delete(r.code);
    broadcast(r); roomList();
  }

  function dropIfGone(r: Room, now: number) {
    if (r.g.phase !== 'HUNT') return;
    for (const p of Object.values(r.g.players)) {
      if (!p.alive || r.sockets.has(p.id)) continue;
      if (now - (r.lastSeen.get(p.id) ?? now) < DROP_MS) continue;
      r.leaving = p.id;
      dispatch(r, kill(r.g, p.id, r.g.hostId === p.id ? 'timer' : 'player', now, rng));
      r.leaving = null;
    }
  }

  function attach(r: Room, id: string, ws: WebSocket) {
    const old = r.sockets.get(id);
    if (old && old !== ws) old.close(4001, 'replaced');
    r.sockets.set(id, ws);
    r.lastSeen.set(id, Date.now());
    tokenRoom.set(id, r.code);
    if (!r.ownerId || !r.g.players[r.ownerId]) r.ownerId = id;
    const p = r.g.players[id];
    send(ws, { t: 'welcome', id, idx: p.idx, token: id, code: r.code, cfg: r.cfg, room: r.bleRoom });
    if (r.g.hostId === id && r.g.phase === 'HUNT') send(ws, { t: 'possessed', endsAt: r.g.timerEndsAt, storyId: r.g.storyId });
    if (r.g.result) send(ws, { t: 'end', result: r.g.result, history: r.history });
    broadcast(r); roomList();
  }

  // ---------- HTTP + WebSocket ----------
  const http = createServer((req, res) => {
    if (req.url === '/' || req.url === '/gm') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(readFileSync(new URL('./gm.html', import.meta.url)));
    } else if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
    else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', ws => {
    let id: string | null = null;
    let room: Room | null = null;
    let gmRoom: Room | null = null;

    ws.on('message', raw => {
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === 'sync') return send(ws, { t: 'sync', c: m.c, s: Date.now() });

      if (m.t === 'gm') {
        watchers.add(ws);
        if (m.cmd === 'watch') {
          gmRoom?.gms.delete(ws);
          gmRoom = m.code ? rooms.get(m.code) ?? null : null;
          gmRoom?.gms.add(ws);
          if (gmRoom) broadcast(gmRoom);
          return roomList();
        }
        if (gmRoom) hostCmd(gmRoom, m, true);
        return;
      }

      if (m.t === 'create' || m.t === 'join') {
        if (room && id) return; // already in a room on this socket
        // Reconnect: token identifies the player in whatever room they were in.
        const token = m.t === 'join' ? m.token : undefined;
        const tokenCode = token ? tokenRoom.get(token) : undefined;
        if (token && tokenCode && rooms.get(tokenCode)?.g.players[token]) {
          room = rooms.get(tokenCode)!; id = token;
          return attach(room, id, ws);
        }
        const name = String(m.name ?? '').trim().slice(0, 16) || 'Player';
        if (m.t === 'create') room = makeRoom();
        else {
          room = rooms.get(String(m.code ?? '').toUpperCase().trim()) ?? null;
          if (!room) return send(ws, { t: 'error', msg: 'No game with that code' });
          if (room.g.phase !== 'LOBBY') { room = null; return send(ws, { t: 'error', msg: 'That game has already started' }); }
          if (Object.keys(room.g.players).length >= MAX_PLAYERS) { room = null; return send(ws, { t: 'error', msg: 'That game is full' }); }
        }
        const newId = randomUUID();
        id = newId;
        addPlayer(room.g, newId, name, !!m.uwb);
        return attach(room, newId, ws);
      }

      if (room && id) onPlayer(room, id, m, ws);
      if (m.t === 'leave') { room = null; id = null; }
    });

    ws.on('close', () => {
      watchers.delete(ws);
      gmRoom?.gms.delete(ws);
      if (!room || !id || room.sockets.get(id) !== ws) return;
      room.sockets.delete(id);
      room.lastSeen.set(id, Date.now());
      if (room.ownerId === id) {
        // hand host controls to someone still connected
        room.ownerId = [...room.sockets.keys()][0] ?? room.ownerId;
      }
      broadcast(room);
    });
  });

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) {
      if (r.g.phase === 'COUNTDOWN' && r.countdownEndsAt && now >= r.countdownEndsAt) {
        r.countdownEndsAt = null;
        r.startedAt = now; r.history = [];
        dispatch(r, start(r.g, now, rng));
      }
      dispatch(r, tick(r.g, now, rng));
      dropIfGone(r, now);
      const lastAny = Math.max(0, ...r.lastSeen.values());
      if (!r.sockets.size && now - lastAny > ROOM_IDLE_MS) {
        for (const pid of Object.keys(r.g.players)) tokenRoom.delete(pid);
        rooms.delete(r.code);
        roomList();
      }
    }
  }, 200);
  const stateTicker = setInterval(() => rooms.forEach(broadcast), 1000);

  const onListenError = (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${port} is already in use (another Betaal server running?). Stop it, or run: PORT=${port + 1} npm run server`);
    process.exit(1);
  };
  http.on('error', onListenError);
  wss.on('error', onListenError); // ws re-emits the http error
  http.listen(port, () => console.log(`Betaal server on :${port}  (GM page: http://localhost:${port}/)`));

  return {
    http,
    rooms,
    close() { clearInterval(ticker); clearInterval(stateTicker); wss.close(); http.close(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(Number(process.env.PORT ?? 8787));
}
