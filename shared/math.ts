// Pure math shared by the app (audio, swing, targeting) and the server (validation).
import type { Cfg, Role } from './config.ts';

export type LatLon = { lat: number; lon: number; acc: number };

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
export function enu(from: LatLon, to: LatLon) {
  const dN = (to.lat - from.lat) * M_PER_DEG;
  const dE = (to.lon - from.lon) * M_PER_DEG * Math.cos(rad(from.lat));
  return { dE, dN, d: Math.hypot(dE, dN), bearing: (deg(Math.atan2(dE, dN)) + 360) % 360 };
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
  listener: LatLon, headingDeg: number, src: LatLon,
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
export function blur(p: LatLon, m: number, rng: () => number): LatLon {
  const r = m * Math.sqrt(rng()), a = 2 * Math.PI * rng();
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

/**
 * Stateful stab detector. Feed every sample; returns true once per stab.
 * Stab = forward thrust along the phone's back axis (-z) peaking >= peak
 * within windowMs of rising from rest, and dominating sideways motion.
 */
export function makeSwingDetector(cfg: Cfg) {
  let riseT = -Infinity;
  let armed = true;
  return (a: Accel): boolean => {
    const f = -a.z;
    const s = Math.hypot(a.x, a.y);
    if (f < 3) { riseT = -Infinity; armed = true; return false; }
    if (riseT === -Infinity) riseT = a.t;
    if (armed && f >= cfg.swing.peak && f >= cfg.swing.dominance * s && a.t - riseT <= cfg.swing.windowMs) {
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

export type Target = { id: string; method: 'uwb' | 'ble'; d: number; az?: number; rssiC?: number };
export type Miss = { miss: 'none' | 'crowded' };

export function selectTarget(
  peers: PeerReading[], role: Role, myOffset: number, myUwb: boolean, now: number, cfg: Cfg,
): Target | Miss {
  const uwb: Target[] = [];
  const ble: Target[] = [];
  for (const p of peers) {
    if (myUwb && p.uwb && now - p.uwb.t <= cfg.uwb.freshMs) {
      const okAngle = p.uwb.az === undefined || Math.abs(p.uwb.az) <= cfg.uwb.coneDeg;
      if (p.uwb.d <= cfg.uwb.killR[role] && okAngle) uwb.push({ id: p.id, method: 'uwb', d: p.uwb.d, az: p.uwb.az });
    } else if (p.rssi !== undefined) {
      const rssiC = p.rssi - myOffset - p.offset;
      ble.push({ id: p.id, method: 'ble', d: bleDistance(rssiC, cfg), rssiC });
    }
  }
  if (uwb.length) return uwb.sort((a, b) => a.d - b.d)[0];

  ble.sort((a, b) => b.rssiC! - a.rssiC!);
  const best = ble[0];
  if (!best || best.d > cfg.ble.killR[role]) return { miss: 'none' };
  if (ble[1] && best.rssiC! - ble[1].rssiC! < cfg.ble.ambiguityDb) return { miss: 'crowded' };
  return best;
}

// ---------- radar (heading-up map) ----------

/** Point `p` relative to `me`, rotated so the direction the phone faces is +y (up). Metres. */
export function toRadar(me: LatLon, headingDeg: number, p: LatLon): { x: number; y: number } {
  const { dE, dN } = enu(me, p);
  const h = rad(headingDeg);
  return { x: dE * Math.cos(h) - dN * Math.sin(h), y: dE * Math.sin(h) + dN * Math.cos(h) };
}
