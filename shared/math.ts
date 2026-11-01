// Pure math shared by the app (audio, swing, targeting) and the server (validation).
import type { Cfg, Role } from './config.ts';
import type { IndoorPosition } from './indoor.ts';
import type { Measurement } from './protocol.ts';

export type LatLon = { lat: number; lon: number; acc: number };
export type Position = LatLon | IndoorPosition;
export const isIndoor = (p: Position): p is IndoorPosition => 'mapId' in p;
export function sameSpace(a: Position, b: Position) {
  return isIndoor(a) ? isIndoor(b) && a.mapId === b.mapId : !isIndoor(b);
}

const M_PER_DEG = 111_320;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Wrap any angle into (-180, 180]. */
export function wrap180(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/** Local east/north offset of `to` from `from` (equirectangular; fine under ~1 km). */
export function enu(from: Position, to: Position) {
  if (!sameSpace(from, to)) return { dE: Infinity, dN: Infinity, dZ: Infinity, d: Infinity, bearing: 0 };
  let dE: number, dN: number, dZ = 0;
  if (isIndoor(from) && isIndoor(to)) { dE = to.x - from.x; dN = to.y - from.y; dZ = to.z - from.z; }
  else if (!isIndoor(from) && !isIndoor(to)) {
    dN = (to.lat - from.lat) * M_PER_DEG;
    dE = (to.lon - from.lon) * M_PER_DEG * Math.cos(rad(from.lat));
  } else return { dE: Infinity, dN: Infinity, dZ: Infinity, d: Infinity, bearing: 0 };
  return { dE, dN, dZ, d: Math.hypot(dE, dN, dZ), bearing: (deg(Math.atan2(dE, dN)) + 360) % 360 };
}

/**
 * Heading of the phone's BACK (camera) axis, degrees clockwise from north.
 * R = Android rotation matrix (device -> world East,North,Up), row-major 3x3.
 * Back vector in device coords is (0,0,-1), so world = -(R[0][2], R[1][2], R[2][2]).
 * Add magnetic declination to get true north.
 */
export function backAxisHeading(R: number[][], declinationDeg = 0): number {
  // Back axis (camera) when upright + top axis when flat: the two horizontal projections point the
  // same way the player faces, and each fades out exactly as the other takes over, so any tilt works.
  const e = -R[0][2] + R[0][1], n = -R[1][2] + R[1][1];
  return (deg(Math.atan2(e, n)) + declinationDeg + 360) % 360;
}

/** Rotation matrix from a unit quaternion (x,y,z,w), as Android's TYPE_ROTATION_VECTOR gives. */
export function quatToMatrix(x: number, y: number, z: number, w: number): number[][] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export type SpatialParams = { gain: number; pan: number; cutoffHz: number };

/**
 * Spatial parameters for an event sound heard by `listener` facing `headingDeg`.
 * kind picks the hearing radii. Recompute every frame while the sound plays.
 */
export function spatialize(
  listener: Position, headingDeg: number, src: Position,
  kind: 'bell' | 'scream', cfg: Cfg,
): SpatialParams {
  const { refM, hearM, maxM } = cfg.audio[kind];
  const { d, bearing } = enu(listener, src);
  const theta = rad(wrap180(bearing - headingDeg));

  // Direction confidence: 0 inside the blind radius (or GPS noise, if worse), 1 from dirFullM out.
  const d0 = Math.max(cfg.audio.blindM, Math.hypot(listener.acc, src.acc));
  const w = clamp((d - d0) / Math.max(1, cfg.audio.dirFullM - d0), 0, 1);

  const pan = w * Math.sin(theta);
  const behind = w * Math.max(0, -Math.cos(theta));
  const cutoffHz = 20_000 * Math.pow(cfg.audio.behindHz / 20_000, behind);

  let gain = refM / (refM + (Math.max(d, refM) - refM));        // inverse, full within refM
  gain *= clamp((maxM - d) / (maxM - hearM), 0, 1);             // fade out past hearM
  return { gain, pan, cutoffHz };
}

/** Move a point a random distance (uniform over a disc of radius m). */
export function blur(p: Position, m: number, rng: () => number): Position {
  const r = m * Math.sqrt(rng()), a = 2 * Math.PI * rng();
  if (isIndoor(p)) return { ...p, x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) };
  return {
    ...p,
    lat: p.lat + (r * Math.cos(a)) / M_PER_DEG,
    lon: p.lon + (r * Math.sin(a)) / (M_PER_DEG * Math.cos(rad(p.lat))),
  };
}

/** Full-volume centred params for the player the event is about (new host / victim). */
export const SELF_SOUND: SpatialParams = { gain: 1, pan: 0, cutoffHz: 20_000 };

// ---------- BLE ----------

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Log-distance model inverted: corrected RSSI -> metres. */
export function bleDistance(rssiCorrected: number, cfg: Cfg): number {
  return Math.pow(10, (cfg.ble.A1 - rssiCorrected) / (10 * cfg.ble.n));
}

/** Corrected-RSSI threshold equivalent to radius R. */
export function bleThresholdDb(R: number, cfg: Cfg): number {
  return cfg.ble.A1 - 10 * cfg.ble.n * Math.log10(R);
}

/** Calibration: C_i per player (mean of both directions at 1 m from reference). offset_i = C_i - median(C). */
export function bleOffsets(C: Record<string, number>): Record<string, number> {
  const med = median(Object.values(C));
  return Object.fromEntries(Object.entries(C).map(([id, c]) => [id, c - med]));
}

// ---------- swing ----------

export type Accel = { x: number; y: number; z: number; t: number }; // linear accel, gravity removed

/** Estimate gravity from raw accelerometer samples; allow one second to settle before strikes. */
export function makeGravityFilter() {
  let gravity: Accel | null = null;
  let startedAt = 0;
  return (a: Accel): Accel | null => {
    if (!gravity || a.t <= gravity.t || a.t - gravity.t > 1000) {
      gravity = { ...a };
      startedAt = a.t;
      return null;
    }
    // shortcut: slow gravity estimate assumes a steady grip; use sensor fusion if rotation causes false strikes on real phones.
    const alpha = Math.exp(-(a.t - gravity.t) / 800);
    gravity = {
      x: alpha * gravity.x + (1 - alpha) * a.x,
      y: alpha * gravity.y + (1 - alpha) * a.y,
      z: alpha * gravity.z + (1 - alpha) * a.z,
      t: a.t,
    };
    return a.t - startedAt < 1000 ? null : { x: a.x - gravity.x, y: a.y - gravity.y, z: a.z - gravity.z, t: a.t };
  };
}

/**
 * Stateful stab detector. Feed every sample; returns true once per stab.
 * Stab = forward thrust along the phone's back axis (-z) peaking >= peak
 * within windowMs of rising from rest, and dominating sideways motion.
 */
export function makeSwingDetector(cfg: Cfg) {
  let riseT = -Infinity;
  let armed = true;
  return (a: Accel, settings = cfg.swing): boolean => {
    const f = -a.z;
    const s = Math.hypot(a.x, a.y);
    if (f < 3) { riseT = -Infinity; armed = true; return false; }
    if (riseT === -Infinity) riseT = a.t;
    if (armed && f >= settings.peak && f >= settings.dominance * s && a.t - riseT <= settings.windowMs) {
      armed = false; // one trigger per thrust; re-arms when f drops back below 3
      return true;
    }
    return false;
  };
}

// ---------- target selection (client side, at swing time) ----------

export type PeerReading = {
  id: string;
  rssi?: number;       // median raw RSSI over the window, undefined if stale
  offset: number;      // calibration offset of that peer
  uwb?: { d: number; az?: number; t: number };
};

export type Strike = { targetId: string; m: Measurement };
export type Miss = { miss: 'none' };

/**
 * UWB with angle: nearest peer inside range and cone. Otherwise every peer whose BLE (or angle-less UWB)
 * reading puts it inside range goes in `near`; the server resolves the target with positions + heading.
 */
export function selectTarget(
  peers: PeerReading[], role: Role, myOffset: number, myUwb: boolean, now: number, cfg: Cfg, heading?: number,
): Strike | Miss {
  const uwb: { id: string; d: number; az: number }[] = [];
  const near: Record<string, number> = {};
  for (const p of peers) {
    const u = myUwb && p.uwb && now - p.uwb.t <= cfg.uwb.freshMs && Number.isFinite(p.uwb.d) && p.uwb.d >= 0 ? p.uwb : null;
    if (u && u.az !== undefined && Number.isFinite(u.az)) {
      if (u.d <= cfg.uwb.killR[role] && Math.abs(u.az) <= cfg.uwb.coneDeg) uwb.push({ id: p.id, d: u.d, az: u.az });
      continue;
    }
    if (p.rssi === undefined) continue;
    const rssiC = p.rssi - myOffset - p.offset;
    if (bleDistance(rssiC, cfg) <= cfg.ble.killR[role]) near[p.id] = rssiC;
  }
  if (uwb.length) {
    const t = uwb.sort((a, b) => a.d - b.d)[0];
    return { targetId: t.id, m: { method: 'uwb', d: t.d, az: t.az } };
  }
  const ids = Object.keys(near).sort((a, b) => near[b] - near[a]);
  if (!ids.length) return { miss: 'none' };
  return { targetId: ids[0], m: { method: 'ble', near, ...(heading !== undefined && Number.isFinite(heading) ? { heading } : {}) } };
}

/**
 * Is `to` inside the cone the attacker at `from` faces? Uses shared positions, so it only answers when
 * their combined error is smaller than their separation; otherwise 'unknown'. Other indoor floors are 'out'.
 */
export function coneCheck(from: Position, to: Position, headingDeg: number, coneDeg: number): 'in' | 'out' | 'unknown' {
  if (isIndoor(from) && isIndoor(to) && from.mapId === to.mapId && from.floorId !== to.floorId) return 'out';
  const { dE, dN, bearing } = enu(from, to);
  const sep = Math.hypot(dE, dN), err = from.acc + to.acc;
  if (!Number.isFinite(sep) || err >= sep) return 'unknown';
  const off = Math.abs(wrap180(bearing - headingDeg)), slack = deg(Math.asin(err / sep));
  return off + slack <= coneDeg ? 'in' : off - slack > coneDeg ? 'out' : 'unknown';
}

// ---------- radar (heading-up map) ----------

/** Point `p` relative to `me`, rotated so the direction the phone faces is +y (up). Metres. */
export function toRadar(me: Position, headingDeg: number, p: Position): { x: number; y: number } {
  const { dE, dN } = enu(me, p);
  const h = rad(headingDeg);
  return { x: dE * Math.cos(h) - dN * Math.sin(h), y: dE * Math.sin(h) + dN * Math.cos(h) };
}
