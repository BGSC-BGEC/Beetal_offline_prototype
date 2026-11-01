// Indoor coordinates are metres in one shared map: x right/east, y up/north, z height.
export type XY = { x: number; y: number };
export type Wall = { a: XY; b: XY };
export type WifiReading = { bssid: string; ssid?: string; rssi: number; rtt: boolean; t: number };
export type WifiRange = { bssid: string; d: number; error: number };
export type Floor = {
  id: string; name: string; z: number; width: number; depth: number;
  walls: Wall[];
  markers: (XY & { id: string; name: string })[];
};
export type IndoorMap = {
  id: string; name: string; northDeg: number; phoneHeightM: number; floors: Floor[];
  accessPoints: (XY & { bssid: string; z: number })[];
  fingerprints: (XY & { floorId: string; readings: { bssid: string; rssi: number }[] })[];
};
export type IndoorPosition = XY & {
  mapId: string; floorId: string; z: number; acc: number;
  source: 'marker' | 'manual' | 'rtt' | 'fingerprint' | 'steps';
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 80;
const id = (s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s);
const point = (p: any) => p && finite(p.x) && finite(p.y) && Math.abs(p.x) <= 10000 && Math.abs(p.y) <= 10000;
const mac = (s: unknown) => typeof s === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s);

/** Validate imported maps and host messages before storing or using their geometry. */
export function validIndoorMap(m: any): m is IndoorMap {
  if (!m || !id(m.id) || !text(m.name) || !finite(m.northDeg) || Math.abs(m.northDeg) > 360 ||
    !finite(m.phoneHeightM) || m.phoneHeightM < 0.3 || m.phoneHeightM > 2.5 ||
    !Array.isArray(m.floors) || m.floors.length < 1 || m.floors.length > 30 ||
    !Array.isArray(m.accessPoints) || m.accessPoints.length > 100 ||
    !Array.isArray(m.fingerprints) || m.fingerprints.length > 300) return false;
  const ids = new Set<string>();
  for (const f of m.floors) {
    if (!f || !id(f.id) || ids.has(f.id) || !text(f.name) || !finite(f.z) || Math.abs(f.z) > 1000 ||
      !finite(f.width) || f.width <= 0 || f.width > 1000 || !finite(f.depth) || f.depth <= 0 || f.depth > 1000 ||
      !Array.isArray(f.walls) || f.walls.length > 300 || !f.walls.every((w: any) => w && point(w.a) && point(w.b)) ||
      !Array.isArray(f.markers) || f.markers.length > 100 || !f.markers.every((p: any) => point(p) && id(p.id) && text(p.name)) ||
      new Set(f.markers.map((p: any) => p.id)).size !== f.markers.length) return false;
    const inside = (p: XY) => p.x >= 0 && p.x <= f.width && p.y >= 0 && p.y <= f.depth;
    if (!f.markers.every(inside) || !f.walls.every((w: Wall) => inside(w.a) && inside(w.b))) return false;
    ids.add(f.id);
  }
  return m.accessPoints.every((p: any) => point(p) && mac(p.bssid) && finite(p.z) && Math.abs(p.z) <= 1000) &&
    new Set(m.accessPoints.map((p: any) => p.bssid.toLowerCase())).size === m.accessPoints.length &&
    m.fingerprints.every((p: any) => point(p) && ids.has(p.floorId) && p.x >= 0 && p.y >= 0 &&
      p.x <= m.floors.find((f: Floor) => f.id === p.floorId).width && p.y <= m.floors.find((f: Floor) => f.id === p.floorId).depth && Array.isArray(p.readings) &&
      p.readings.length >= 1 && p.readings.length <= 100 && p.readings.every((r: any) => r && mac(r.bssid) && finite(r.rssi) && r.rssi >= -127 && r.rssi <= 0));
}

export function validIndoorPosition(p: any, map: IndoorMap): p is IndoorPosition {
  const floor = map.floors.find(f => f.id === p?.floorId);
  return !!floor && p.mapId === map.id && point(p) && p.x >= 0 && p.y >= 0 && p.x <= floor.width && p.y <= floor.depth &&
    finite(p.z) && Math.abs(p.z - floor.z) <= 2 && finite(p.acc) && p.acc >= 0.5 && p.acc <= 1000 &&
    ['marker', 'manual', 'rtt', 'fingerprint', 'steps'].includes(p.source);
}

/** 2D multilateration on a known floor; AP installation heights are accounted for. */
export function locateRtt(map: IndoorMap, floor: Floor, ranges: WifiRange[]): IndoorPosition | null {
  const points = rttPoints(map, ranges);
  if (points.length < 3) return null;
  const first = points[0];
  const height = floor.z + map.phoneHeightM;
  let aa = 0, ab = 0, bb = 0, ac = 0, bc = 0;
  for (const p of points.slice(1)) {
    const a = 2 * (p.x - first.x), b = 2 * (p.y - first.y);
    const c = first.d ** 2 - p.d ** 2 + p.x ** 2 - first.x ** 2 + p.y ** 2 - first.y ** 2 +
      (p.z - height) ** 2 - (first.z - height) ** 2;
    aa += a * a; ab += a * b; bb += b * b; ac += a * c; bc += b * c;
  }
  const det = aa * bb - ab * ab;
  if (det <= 1e-6 * aa * bb) return null; // nearly collinear APs cannot determine a useful position
  const x = (ac * bb - bc * ab) / det, y = (bc * aa - ac * ab) / det;
  const residual = Math.sqrt(points.reduce((sum, p) => sum + (Math.hypot(x - p.x, y - p.y, height - p.z) - p.d) ** 2, 0) / points.length);
  const acc = Math.max(1, residual * 2, ...points.map(p => p.error * 2));
  const pos: IndoorPosition = { mapId: map.id, floorId: floor.id, x, y, z: floor.z, acc, source: 'rtt' };
  return acc <= 5 && validIndoorPosition(pos, map) ? pos : null;
}

function rttPoints(map: IndoorMap, ranges: WifiRange[]) {
  return ranges.flatMap(r => {
    const p = map.accessPoints.find(a => a.bssid === r.bssid);
    return p && finite(r.d) && r.d > 0 && finite(r.error) && r.error >= 0 ? [{ ...p, ...r }] : [];
  });
}

/** Full XYZ requires at least four responders with useful horizontal and vertical separation. */
export function locateRtt3D(map: IndoorMap, ranges: WifiRange[]): IndoorPosition | null {
  const points = rttPoints(map, ranges);
  if (points.length < 4) return null;
  const first = points[0], matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const p of points.slice(1)) {
    const row = [2 * (p.x - first.x), 2 * (p.y - first.y), 2 * (p.z - first.z)];
    const rhs = first.d ** 2 - p.d ** 2 + p.x ** 2 - first.x ** 2 + p.y ** 2 - first.y ** 2 + p.z ** 2 - first.z ** 2;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) matrix[i][j] += row[i] * row[j];
      matrix[i][3] += row[i] * rhs;
    }
  }
  const scale = Math.max(...matrix.flatMap(r => r.slice(0, 3).map(Math.abs)));
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    if (Math.abs(matrix[pivot][col]) < Math.max(1e-6, scale * 1e-6)) return null;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    for (let j = col; j < 4; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < 3; row++) if (row !== col) {
      const multiplier = matrix[row][col];
      for (let j = col; j < 4; j++) matrix[row][j] -= multiplier * matrix[col][j];
    }
  }
  const [x, y, phoneZ] = matrix.map(r => r[3]), z = phoneZ - map.phoneHeightM;
  const floor = [...map.floors].sort((a, b) => Math.abs(a.z - z) - Math.abs(b.z - z))[0];
  if (Math.abs(floor.z - z) > 1) return null;
  const residual = Math.sqrt(points.reduce((sum, p) => sum + (Math.hypot(x - p.x, y - p.y, phoneZ - p.z) - p.d) ** 2, 0) / points.length);
  const acc = Math.max(1, residual * 2, ...points.map(p => p.error * 2));
  const pos: IndoorPosition = { mapId: map.id, floorId: floor.id, x, y, z, acc, source: 'rtt' };
  return acc <= 5 && validIndoorPosition(pos, map) ? pos : null;
}

/** Wi-Fi fingerprints are coarse location hints, never precision melee measurements. */
export function locateFingerprint(map: IndoorMap, floor: Floor, readings: WifiReading[]): IndoorPosition | null {
  const matches = map.fingerprints.filter(p => p.floorId === floor.id).flatMap(p => {
    const diffs = p.readings.flatMap(r => {
      const live = readings.find(s => s.bssid === r.bssid);
      return live ? [live.rssi - r.rssi] : [];
    });
    return diffs.length >= 3 ? [{ p, error: Math.sqrt(diffs.reduce((n, d) => n + d * d, 0) / diffs.length) }] : [];
  }).sort((a, b) => a.error - b.error);
  const best = matches[0];
  if (!best || best.error > 12 || (matches[1] && matches[1].error - best.error < 3 && Math.hypot(matches[1].p.x - best.p.x, matches[1].p.y - best.p.y) > 3)) return null;
  return { mapId: map.id, floorId: floor.id, x: best.p.x, y: best.p.y, z: floor.z, acc: Math.max(4, best.error), source: 'fingerprint' };
}

/** A pressure baseline at a known marker estimates relative height, not absolute floor identity. */
export function relativeHeight(referenceHpa: number, pressureHpa: number): number {
  return 44330 * (1 - Math.pow(pressureHpa / referenceHpa, 0.1903));
}

export function wallBetween(a: XY, b: XY, walls: Wall[]): boolean {
  const cross = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return walls.some(w => {
    if (Math.max(a.x, b.x) < Math.min(w.a.x, w.b.x) || Math.min(a.x, b.x) > Math.max(w.a.x, w.b.x) ||
      Math.max(a.y, b.y) < Math.min(w.a.y, w.b.y) || Math.min(a.y, b.y) > Math.max(w.a.y, w.b.y)) return false;
    return cross(a, b, w.a) * cross(a, b, w.b) <= 0 && cross(w.a, w.b, a) * cross(w.a, w.b, b) <= 0;
  });
}
