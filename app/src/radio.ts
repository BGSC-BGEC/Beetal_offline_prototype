// Sensing: GPS + heading + stab detection (always on once permitted), and while in a room:
// BLE RSSI + UWB ranging -> neighbour reports, calibration, stab -> kill claim.
import * as Location from 'expo-location';
import Betaal from '../modules/betaal';
import { backAxisHeading, makeSwingDetector, median, quatToMatrix, selectTarget, type PeerReading } from '../../shared/math.ts';
import { DEFAULT_CFG } from '../../shared/config.ts';
import { amAlive, get, myPlayer, onMessage, send, set, toast } from './store';
import { buzz, playPrivate } from './audio';

const rssi = new Map<number, { v: number; t: number }[]>();          // by player idx
const uwb = new Map<string, { d: number; az?: number; t: number }>(); // by player id
const uwbPeers = new Set<string>();
let declination = 0;
let cooldownUntil = 0;
let bleRoom: { room: number; idx: number } | null = null;

// ---------- stab listeners (game + tutorial) ----------
const stabSubs = new Set<() => void>();
export const onStab = (f: () => void) => (stabSubs.add(f), () => { stabSubs.delete(f); });
/** Live forward thrust (m/s², along the camera axis) for the tutorial meter. */
export let forwardAccel = 0;

let sensorsOn = false;
/** Start GPS, heading and stab detection. Call once permissions are granted. */
export async function initSensors() {
  if (sensorsOn) return;
  sensorsOn = true;
  Betaal.keepAwake(true);
  Betaal.startSensors();

  Betaal.addListener('onRotation', q => {
    set({ heading: backAxisHeading(quatToMatrix(q.x, q.y, q.z, q.w), declination), compassOk: q.acc >= 2 });
  });

  const swing = makeSwingDetector(DEFAULT_CFG);
  Betaal.addListener('onAccel', a => {
    forwardAccel = -a.z;
    if (swing(a)) stabSubs.forEach(f => f());
  });

  Betaal.addListener('onRssi', e => {
    const xs = rssi.get(e.idx) ?? [];
    xs.push({ v: e.rssi, t: e.t });
    rssi.set(e.idx, xs);
  });
  Betaal.addListener('onUwb', e => { if (e.d !== undefined) uwb.set(e.peer, { d: e.d, az: e.az, t: e.t }); });
  Betaal.addListener('onUwbEnd', e => { uwbPeers.delete(e.peer); uwb.delete(e.peer); });

  onStab(onGameStab);
  onMessage(m => {
    if (m.t === 'welcome') startBle(m.room, m.idx);
    if (m.t === 'left') stopBle();
    if (m.t === 'killResult') {
      if (m.ok) { playPrivate('hit'); buzz([0, 200]); }
      else { playPrivate('miss'); if (m.reason !== 'range') toast(m.reason === 'crowded' ? 'Too close to call' : `Missed (${m.reason})`); }
    }
    if (m.t === 'uwbOob') onUwbOob(m.from, JSON.parse(m.data));
  });

  setInterval(reportNeighbours, 500);

  try {
    await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      loc => {
        const pos = { lat: loc.coords.latitude, lon: loc.coords.longitude, acc: loc.coords.accuracy ?? 50 };
        if (!get().pos) declination = Betaal.declination(pos.lat, pos.lon);
        set({ pos });
        if (get().me) send({ t: 'pos', ...pos });
      },
    );
  } catch (e) { toast(`GPS unavailable: ${e}`, 6000); }
}

function startBle(room: number, idx: number) {
  if (bleRoom?.room === room && bleRoom.idx === idx) return;
  try { Betaal.startBle(room, idx); bleRoom = { room, idx }; }
  catch (e) { toast('Bluetooth is off — turn it on to play', 8000); }
}
export function retryBle() { const s = get(); if (s.me) { bleRoom = null; startBle(s.room, s.me.idx); } }

function stopBle() {
  Betaal.stopBle(); bleRoom = null;
  for (const id of uwbPeers) Betaal.uwbStop(id);
  uwbPeers.clear(); uwb.clear(); rssi.clear();
}

function rssiMedian(idx: number, now: number): number | undefined {
  const { windowMs, staleMs } = get().cfg.ble;
  const xs = (rssi.get(idx) ?? []).filter(s => now - s.t <= windowMs);
  rssi.set(idx, xs);
  const last = xs[xs.length - 1];
  return last && now - last.t <= staleMs ? median(xs.map(s => s.v)) : undefined;
}

function readings(now: number): PeerReading[] {
  const s = get();
  return s.players
    .filter(p => p.alive && p.id !== s.me?.id)
    .map(p => ({ id: p.id, offset: p.bleOffset, rssi: rssiMedian(p.idx, now), uwb: p.uwb ? uwb.get(p.id) : undefined }));
}

function onGameStab() {
  const st = get();
  if (st.phase !== 'HUNT' || !amAlive()) return;
  const now = Date.now();
  if (now < cooldownUntil) { buzz([0, 40, 60, 40]); playPrivate('deny'); return; }
  cooldownUntil = now + st.cfg.cooldownMs;
  const t = selectTarget(readings(now), st.possessed ? 'ghost' : 'vikram', myPlayer()?.bleOffset ?? 0, Betaal.hasUwb(), now, st.cfg);
  if ('miss' in t) {
    playPrivate('miss');
    if (t.miss === 'crowded') toast('Too close to call — get closer to one person');
    return;
  }
  send({ t: 'kill', targetId: t.id, m: t.method === 'uwb' ? { method: 'uwb', d: t.d, az: t.az } : { method: 'ble', rssiC: t.rssiC! } });
}

// Neighbour report 2 Hz (top 5 nearest) + UWB peer choice every 5 s
let tickN = 0;
function reportNeighbours() {
  const s = get();
  if (!s.me) return;
  const now = Date.now();
  const myOff = myPlayer()?.bleOffset ?? 0;
  const peers = readings(now)
    .map(r => ({
      id: r.id,
      rssiC: r.rssi === undefined ? undefined : r.rssi - myOff - r.offset,
      uwbD: r.uwb && now - r.uwb.t <= s.cfg.uwb.freshMs ? r.uwb.d : undefined,
    }))
    .filter(r => r.rssiC !== undefined || r.uwbD !== undefined)
    .sort((a, b) => (b.rssiC ?? -999) - (a.rssiC ?? -999))
    .slice(0, 5);
  send({ t: 'nbr', peers: Object.fromEntries(peers.map(p => [p.id, { rssiC: p.rssiC, uwbD: p.uwbD }])) });
  if (Betaal.hasUwb() && ++tickN % 10 === 0) pickUwbPeers(peers.map(p => p.id));
}

// ---------- UWB pairing over the server: lower idx = controller ----------
// controller --hello--> controlee --addr--> controller --params--> controlee ; either side --stop-->
type Oob = { k: 'hello' } | { k: 'addr'; addr: string } | { k: 'params'; p: any } | { k: 'stop' };
const oob = (to: string, data: Oob) => send({ t: 'uwbOob', to, data: JSON.stringify(data) });

function pickUwbPeers(nearestIds: string[]) {
  const s = get();
  const myIdx = s.me!.idx;
  const idxOf = (id: string) => s.players.find(p => p.id === id)?.idx ?? -1;
  const want = new Set(nearestIds.filter(id => s.players.find(p => p.id === id)?.uwb && idxOf(id) > myIdx).slice(0, 3));
  for (const id of uwbPeers) if (!want.has(id) && idxOf(id) > myIdx) {
    Betaal.uwbStop(id); oob(id, { k: 'stop' }); uwbPeers.delete(id);
  }
  for (const id of want) if (!uwbPeers.has(id)) { uwbPeers.add(id); oob(id, { k: 'hello' }); }
}

async function onUwbOob(from: string, m: Oob) {
  try {
    if (m.k === 'hello') { uwbPeers.add(from); oob(from, { k: 'addr', addr: await Betaal.uwbControleeAddress(from) }); }
    if (m.k === 'addr') oob(from, { k: 'params', p: await Betaal.uwbControllerStart(from, m.addr) });
    if (m.k === 'params') Betaal.uwbControleeStart(from, m.p);
    if (m.k === 'stop') { Betaal.uwbStop(from); uwbPeers.delete(from); }
  } catch (e) {
    uwbPeers.delete(from); // ponytail: give up on this pair until the next 5 s pick; BLE covers it
    console.warn('uwb', from, e);
  }
}

// ---------- calibration: stand 1 m from the host's phone for 5 s ----------
export async function calibrate(onTick: (secLeft: number) => void): Promise<boolean> {
  const s = get();
  const ref = s.players.find(p => p.id === s.ownerId);
  if (!ref) return false;
  const vals: number[] = [];
  for (let i = 5; i > 0; i--) {
    onTick(i);
    await new Promise(r => setTimeout(r, 1000));
    const v = rssiMedian(ref.idx, Date.now());
    if (v !== undefined) vals.push(v);
  }
  onTick(0);
  if (vals.length < 3) return false;
  send({ t: 'calib', peerId: ref.id, rssi: median(vals) });
  return true;
}
