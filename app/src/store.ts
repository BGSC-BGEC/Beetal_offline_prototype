// App state + server connection. One module-level store, read with useStore().
import { useSyncExternalStore } from 'react';
import { DEFAULT_CFG, type Cfg } from '../../shared/config.ts';
import type { Position } from '../../shared/math.ts';
import type { ClientMsg, HistoryEntry, HostCmd, MapCmd, PublicPlayer, Result, ServerMsg, Snapshot } from '../../shared/protocol.ts';
import type { IndoorMap, WifiReading } from '../../shared/indoor.ts';
import { getPrefs, savePrefs } from './prefs';
import type { IndoorCapabilities, SensorStatus } from '../modules/betaal';

export type State = {
  online: boolean;                // socket open
  serverCompatible: boolean;
  me: { id: string; idx: number } | null; // in a room
  code: string | null; room: number; cfg: Cfg;
  phase: string; players: PublicPlayer[]; ownerId: string | null;
  countdownEndsAt: number | null; possessionSec: number;
  possessed: { endsAt: number } | null;
  ping: { snapshot: Snapshot; until: number } | null;
  deaths: Position[];
  fallen: { name: string; left: number; from: number; until: number } | null; // "X has fallen" reveal
  result: Result | null; history: HistoryEntry[];
  pos: Position | null; heading: number; compassOk: boolean;
  sensors: SensorStatus | null;
  arena: IndoorMap | null;
  indoorCapabilities: IndoorCapabilities | null; wifi: WifiReading[];
  indoorNote: string; suggestedFloor: string | null;
  toast: { text: string; until: number } | null;
  busy: boolean;                  // waiting on create/join
};

/** A death plays: scream (spatial) first, then the afterKillDrama sting with the on-screen reveal. */
export const FALLEN_DELAY_MS = 2500; // scream's loud body is ~2.8 s once leading silence is trimmed
export const FALLEN_SHOW_MS = 5500;

const initial: State = {
  online: false, serverCompatible: false, me: null, code: null, room: 0, cfg: DEFAULT_CFG,
  phase: 'LOBBY', players: [], ownerId: null, countdownEndsAt: null, possessionSec: 120,
  possessed: null, ping: null, deaths: [], fallen: null, result: null, history: [],
  pos: null, heading: 0, compassOk: true, sensors: null, arena: null, toast: null, busy: false,
  indoorCapabilities: null, wifi: [], indoorNote: 'Indoor positioning has not been configured.', suggestedFloor: null,
};
let state = initial;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<State>) { state = { ...state, ...patch }; subs.forEach(f => f()); }
export const useStore = () => useSyncExternalStore(cb => (subs.add(cb), () => subs.delete(cb)), get);
export const toast = (text: string, ms = 2800) => set({ toast: { text, until: Date.now() + ms } });

export const myPlayer = () => state.players.find(p => p.id === state.me?.id);
export const amAlive = () => !!myPlayer()?.alive;
export const amOwner = () => !!state.me && state.ownerId === state.me.id;
export const nameOf = (id?: string) => state.players.find(p => p.id === id)?.name ?? '?';

// ---------- clock sync: serverNow ≈ Date.now() + offset ----------
let offset = 0;
const samples: { rtt: number; off: number }[] = [];
export const serverNow = () => Date.now() + offset;

// ---------- socket ----------
let ws: WebSocket | null = null;
let url = '';
let autoRejoin = false;
let retry: ReturnType<typeof setTimeout> | null = null;
const handlers = new Set<(m: ServerMsg) => void>();
export const onMessage = (f: (m: ServerMsg) => void) => (handlers.add(f), () => { handlers.delete(f); });
export const send = (m: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

let uwbCapable = false;
export function setUwbCapable(v: boolean) { uwbCapable = v; }

/** (Re)connect to the server in prefs. Rejoins your room automatically if you were in one. */
export function connect() {
  url = getPrefs().serverUrl.trim();
  if (retry) clearTimeout(retry);
  ws?.close();
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    set({ online: true });
    send({ t: 'sync', c: Date.now() });
    const token = getPrefs().token;
    if (token) { autoRejoin = true; send({ t: 'join', name: getPrefs().name, uwb: uwbCapable, token }); }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    set({ online: false });
    retry = setTimeout(connect, 2000);
  };
  sock.onerror = () => {};
  sock.onmessage = ev => {
    if (ws !== sock) return;
    const m: ServerMsg = JSON.parse(String(ev.data));
    reduce(m);
    handlers.forEach(h => h(m));
  };
}

setInterval(() => send({ t: 'sync', c: Date.now() }), 10_000);

export function createRoom() { set({ busy: true }); send({ t: 'create', name: getPrefs().name, uwb: uwbCapable }); }
export function joinRoom(code: string) { set({ busy: true }); send({ t: 'join', code, name: getPrefs().name, uwb: uwbCapable }); }
export function setReady(on: boolean) { if (!state.serverCompatible) return toast('Update the game server before playing this build.'); send({ t: 'ready', on }); }
export function host(cmd: HostCmd | MapCmd) { if (!state.serverCompatible) return toast('Update the game server before using this build.'); send({ t: 'host', ...cmd } as ClientMsg); }
export function leaveRoom() { send({ t: 'leave' }); clearRoom(); }

function clearRoom() {
  savePrefs({ token: null });
  set({
    me: null, code: null, players: [], ownerId: null, possessed: null, ping: null, deaths: [], result: null,
    history: [], phase: 'LOBBY', countdownEndsAt: null, fallen: null, arena: null, pos: null,
  });
}

function reduce(m: ServerMsg) {
  switch (m.t) {
    case 'welcome':
      autoRejoin = false;
      savePrefs({ token: m.token });
      set({ me: { id: m.id, idx: m.idx }, code: m.code, cfg: m.cfg, room: m.room, arena: m.arena ?? null, busy: false, serverCompatible: m.protocolVersion === 2 });
      break;
    case 'error':
      set({ busy: false });
      if (autoRejoin) { autoRejoin = false; savePrefs({ token: null }); break; } // old room is gone; stay quiet
      toast(m.msg);
      break;
    case 'left': clearRoom(); break;
    case 'state': {
      // Someone died since last state -> "X has fallen" banner.
      const before = new Map(state.players.map(p => [p.id, p.alive]));
      const fallen = m.players.find(p => before.get(p.id) === true && !p.alive);
      if (m.phase === 'LOBBY' && state.phase === 'RESULTS') {
        set({ result: null, history: [], deaths: [], possessed: null, ping: null }); // play again
      }
      const meAlive = m.players.find(p => p.id === state.me?.id)?.alive;
      set({
        ...(meAlive === false ? { possessed: null } : {}),
        phase: m.phase, players: m.players, ownerId: m.ownerId, code: m.code,
        countdownEndsAt: m.countdownEndsAt, possessionSec: m.possessionSec,
        ...(fallen && m.phase === 'HUNT' ? { fallen: { name: fallen.name, left: m.players.filter(p => p.alive).length,
          from: Date.now() + FALLEN_DELAY_MS, until: Date.now() + FALLEN_DELAY_MS + FALLEN_SHOW_MS } } : {}),
      });
      break;
    }
    case 'cfg': set({ cfg: m.cfg }); break;
    case 'map': set({ arena: m.arena, pos: null, deaths: [], ping: null }); break;
    case 'possessed': set({ possessed: { endsAt: m.endsAt } }); break;
    case 'released': set({ possessed: null }); break;
    case 'ping': set({ ping: { snapshot: m.snapshot, until: m.until } }); break;
    case 'event': if (m.kind === 'scream' && m.at) set({ deaths: [...state.deaths, m.at] }); break;
    case 'end': set({ result: m.result, history: m.history, possessed: null }); break;
    case 'sync': {
      const r = Date.now();
      samples.push({ rtt: r - m.c, off: m.s - (m.c + r) / 2 });
      if (samples.length > 5) samples.shift();
      offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off; // lowest-latency sample wins
      break;
    }
  }
}
