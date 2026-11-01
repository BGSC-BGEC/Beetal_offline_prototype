// Authoritative game rules. Pure: no I/O, no clocks, no Math.random.
// Every function takes `now` and `rng` and returns Effects for the server to send.
import type { Cfg, Role } from '../shared/config.ts';
import { bleThresholdDb, blur, enu, type LatLon } from '../shared/math.ts';
import type { Measurement, Snapshot } from '../shared/protocol.ts';
export type { Measurement, Snapshot };

export type Phase = 'LOBBY' | 'CALIBRATION' | 'COUNTDOWN' | 'HUNT' | 'RESULTS';
export type Cause = 'ghost' | 'player' | 'timer';

export type Player = {
  id: string; name: string; idx: number;
  alive: boolean; uwb: boolean; bleOffset: number;
  immuneUntil: number; cooldownUntil: number;
  pos?: LatLon;
};

export type Result =
  | { kind: 'players'; winners: string[]; ghostHost: string }
  | { kind: 'ghost'; winners: string[]; ghostHost: string }
  | { kind: 'divya'; winners: string[] };

export type Game = {
  phase: Phase; cfg: Cfg;
  players: Record<string, Player>;
  hostId: string | null; timerEndsAt: number; storyId: number;
  result: Result | null;
};

export type Effect =
  | { type: 'possessed'; id: string; endsAt: number; storyId: number }
  | { type: 'released'; id: string }
  | { type: 'bell'; hostId: string; at?: LatLon }
  | { type: 'scream'; victimId: string; cause: Cause; by?: string; at?: LatLon }
  | { type: 'ping'; snapshot: Snapshot; exitedId: string | null }
  | { type: 'end'; result: Result };

export type Rng = () => number; // [0,1)

export function newGame(cfg: Cfg): Game {
  return { phase: 'LOBBY', cfg, players: {}, hostId: null, timerEndsAt: 0, storyId: 0, result: null };
}

export function addPlayer(g: Game, id: string, name: string, uwb: boolean): Player {
  const idx = Math.max(-1, ...Object.values(g.players).map(p => p.idx)) + 1; // unique even after leaves
  const p: Player = {
    id, name, idx, alive: true, uwb, bleOffset: 0,
    immuneUntil: 0, cooldownUntil: 0,
  };
  g.players[id] = p;
  return p;
}

const alive = (g: Game) => Object.values(g.players).filter(p => p.alive);
const pick = <T>(xs: T[], rng: Rng) => xs[Math.floor(rng() * xs.length)];

export function start(g: Game, now: number, rng: Rng): Effect[] {
  if (alive(g).length < 3) throw new Error('need >= 3 players');
  g.phase = 'HUNT';
  const fx: Effect[] = [];
  possess(g, pick(alive(g), rng).id, now, rng, fx);
  return fx;
}

function possess(g: Game, id: string, now: number, rng: Rng, fx: Effect[]) {
  g.hostId = id;
  g.timerEndsAt = now + g.cfg.possessionMs;
  g.storyId = Math.floor(rng() * g.cfg.stories);
  fx.push({ type: 'possessed', id, endsAt: g.timerEndsAt, storyId: g.storyId });
  const pos = g.players[id].pos;
  fx.push({ type: 'bell', hostId: id, at: pos && blur(pos, g.cfg.audio.bellBlurM, rng) });
}

function end(g: Game, result: Result, fx: Effect[]) {
  g.phase = 'RESULTS';
  g.result = result;
  fx.push({ type: 'end', result });
}

/**
 * Move the Ghost. `immunity` grants the outgoing host 10 s (ghost kill / task set).
 * Outgoing host stays eligible when not immune (player-initiated kill) — GDD 4.4.
 */
function transfer(g: Game, now: number, rng: Rng, immunity: boolean, fx: Effect[]) {
  const prev = g.hostId;
  if (prev && immunity && g.players[prev].alive) g.players[prev].immuneUntil = now + g.cfg.immunityMs;
  if (prev && g.players[prev].alive) fx.push({ type: 'released', id: prev });

  const candidates = alive(g).filter(p => p.immuneUntil <= now);
  if (!candidates.length) {
    g.hostId = null;
    return end(g, { kind: 'divya', winners: alive(g).map(p => p.id) }, fx);
  }
  possess(g, pick(candidates, rng).id, now, rng, fx);
  fx.push({
    type: 'ping', exitedId: prev,
    snapshot: alive(g).map(p => ({
      id: p.id, name: p.name, pos: p.pos, immune: p.immuneUntil > now, exited: p.id === prev,
    })),
  });
}

/** Any death. End checks run BEFORE the transfer (GDD 3.2 worked example). */
export function kill(g: Game, victimId: string, cause: Cause, now: number, rng: Rng, by?: string): Effect[] {
  const fx: Effect[] = [];
  const v = g.players[victimId];
  if (g.phase !== 'HUNT' || !v?.alive) return fx;
  v.alive = false;
  fx.push({ type: 'scream', victimId, cause, by, at: v.pos });

  const host = g.hostId!;
  if (victimId === host && cause === 'player') {
    end(g, { kind: 'players', winners: alive(g).map(p => p.id), ghostHost: host }, fx);
    return fx;
  }
  if (alive(g).length === 2 && victimId !== host) {
    end(g, { kind: 'ghost', winners: [host], ghostHost: host }, fx);
    return fx;
  }
  // Host sacrificed (timer) with 3 left: transfer first, the new host wins (approved default).
  transfer(g, now, rng, cause === 'ghost', fx);
  if (g.phase === 'HUNT' && alive(g).length === 2) {
    end(g, { kind: 'ghost', winners: [g.hostId!], ghostHost: g.hostId! }, fx);
  }
  return fx;
}

/** Stand-in for a completed task set (GM button until mini-games exist). */
export function completeTaskSet(g: Game, now: number, rng: Rng): Effect[] {
  const fx: Effect[] = [];
  if (g.phase === 'HUNT') transfer(g, now, rng, true, fx);
  return fx;
}

export function tick(g: Game, now: number, rng: Rng): Effect[] {
  if (g.phase === 'HUNT' && g.hostId && now >= g.timerEndsAt) return kill(g, g.hostId, 'timer', now, rng);
  return [];
}

// ---------- kill claims ----------

export type Claim = { attackerId: string; targetId: string; m: Measurement; recvAt: number };
/** What a phone last reported about one neighbour. */
export type NbrReading = { rssiC?: number; uwbD?: number; t: number };
export type NbrTable = Record<string, Record<string, NbrReading>>; // [reporter][peer]

const role = (g: Game, id: string): Role => (g.hostId === id ? 'ghost' : 'vikram');

/** Null = valid. Otherwise reason string. Checks measurement, reverse reading, GPS sanity. */
export function validateClaim(g: Game, c: Claim, nbrs: NbrTable, now: number): string | null {
  const a = g.players[c.attackerId], t = g.players[c.targetId];
  if (!a?.alive || !t?.alive) return 'dead';
  if (a.id === t.id) return 'self';
  if (now < a.cooldownUntil) return 'cooldown';
  const cfg = g.cfg, R = c.m.method === 'uwb' ? cfg.uwb.killR[role(g, a.id)] : cfg.ble.killR[role(g, a.id)];

  const rev = nbrs[t.id]?.[a.id];
  const revFresh = rev && now - rev.t <= cfg.ble.staleMs;
  if (c.m.method === 'uwb') {
    if (c.m.d > R) return 'range';
    if (c.m.az !== undefined && Math.abs(c.m.az) > cfg.uwb.coneDeg) return 'angle';
    if (revFresh && rev.uwbD !== undefined && rev.uwbD > R + cfg.uwb.reverseSlackM) return 'reverse';
  } else {
    const th = bleThresholdDb(R, cfg);
    if (c.m.rssiC < th) return 'range';
    if (revFresh && rev.rssiC !== undefined && rev.rssiC < th - cfg.ble.reverseSlackDb) return 'reverse';
  }
  if (a.pos && t.pos && enu(a.pos, t.pos).d > R + a.pos.acc + t.pos.acc + cfg.gpsSanitySlackM) return 'gps';
  return null;
}

/**
 * Resolve every claim received in one kill window (GDD 6.3).
 * Host's claims first; claims against a host who landed a kill this window are void.
 */
export function resolveWindow(g: Game, claims: Claim[], nbrs: NbrTable, now: number, rng: Rng) {
  const fx: Effect[] = [];
  const rejected: { claim: Claim; reason: string }[] = [];
  const hostAtStart = g.hostId;
  const ordered = [...claims].sort((x, y) =>
    Number(y.attackerId === hostAtStart) - Number(x.attackerId === hostAtStart) || x.recvAt - y.recvAt);
  let hostKilled = false;

  for (const c of ordered) {
    if (g.phase !== 'HUNT') { rejected.push({ claim: c, reason: 'ended' }); continue; }
    if (hostKilled && c.targetId === hostAtStart) { rejected.push({ claim: c, reason: 'ghost-priority' }); continue; }
    const reason = validateClaim(g, c, nbrs, now);
    if (reason) { rejected.push({ claim: c, reason }); continue; }
    g.players[c.attackerId].cooldownUntil = now + g.cfg.cooldownMs;
    const cause: Cause = c.attackerId === g.hostId ? 'ghost' : 'player';
    if (c.attackerId === hostAtStart) hostKilled = true;
    fx.push(...kill(g, c.targetId, cause, now, rng, c.attackerId));
  }
  return { fx, rejected };
}
