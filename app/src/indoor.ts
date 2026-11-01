import { PermissionsAndroid, Platform } from 'react-native';
import Betaal from '../modules/betaal';
import { isIndoor } from '../../shared/math.ts';
import { locateFingerprint, locateRtt, locateRtt3D, relativeHeight, validIndoorMap, wallBetween, type IndoorPosition } from '../../shared/indoor.ts';
import { get, onMessage, send, set } from './store';
import { getPrefs } from './prefs';

let initialized = false;
let scanning = false;
let ranging = false;
let mapId: string | null = null;
let pressure: number | null = null;
let baseline: { hpa: number; z: number } | null = null;
let lastFixAt = 0;
let lastStepAt = 0;

export function refreshIndoorCapabilities() { set({ indoorCapabilities: Betaal.indoorCapabilities() }); }

export async function enableIndoorSensors() {
  const permissions = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  if (Number(Platform.Version) >= 33) permissions.push('android.permission.NEARBY_WIFI_DEVICES' as any);
  if (Number(Platform.Version) >= 29) permissions.push('android.permission.ACTIVITY_RECOGNITION' as any);
  await PermissionsAndroid.requestMultiple(permissions);
  const active = Betaal.startIndoorSensors();
  refreshIndoorCapabilities();
  set({ indoorNote: `Step tracking ${active.steps ? 'available' : 'unavailable'}; barometer ${active.barometer ? 'available' : 'unavailable'}. Scan Wi-Fi to check nearby routers.` });
}

function fix(pos: IndoorPosition) {
  lastFixAt = Date.now();
  set({ pos, indoorNote: `${pos.source}: estimated accuracy ±${pos.acc.toFixed(1)} m.`, suggestedFloor: null });
}

/** Player says where they stand: a named marker spot, or any tapped point on the floor plan. */
export function locateAt(floorId: string, x: number, y: number, source: 'marker' | 'manual') {
  const map = get().arena, floor = map?.floors.find(f => f.id === floorId);
  if (!map || !floor) throw new Error('Apply this map to the room before setting your location.');
  if (x < 0 || y < 0 || x > floor.width || y > floor.depth) throw new Error('That spot is outside the floor plan.');
  baseline = pressure === null ? null : { hpa: pressure, z: floor.z };
  fix({ mapId: map.id, floorId, x, y, z: floor.z, acc: source === 'marker' ? 0.75 : 1.5, source });
}

/** Accept the barometer's floor change: same x/y, new floor, wider error until the next fix. */
export function confirmSuggestedFloor() {
  const s = get(), p = s.pos, floor = s.arena?.floors.find(f => f.id === s.suggestedFloor);
  if (!p || !isIndoor(p) || !floor) return;
  baseline = pressure === null ? null : { hpa: pressure, z: floor.z };
  set({ pos: { ...p, floorId: floor.id, z: floor.z, x: Math.min(p.x, floor.width), y: Math.min(p.y, floor.depth), acc: Math.min(1000, p.acc + 1) }, suggestedFloor: null });
}

export async function scanIndoorWifi() {
  if (scanning) return;
  scanning = true;
  try {
    refreshIndoorCapabilities();
    const caps = get().indoorCapabilities!;
    if (!caps.wifiPermission || !caps.wifiEnabled || !caps.locationEnabled) throw new Error('Enable Wi-Fi and location, and grant nearby Wi-Fi/location permissions.');
    const requestedAt = Date.now();
    const accepted = Betaal.requestWifiScan();
    let readings = Betaal.wifiReadings();
    if (accepted) for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      readings = Betaal.wifiReadings();
      if (readings.some(r => r.t >= requestedAt)) break;
    }
    set({ wifi: readings, indoorNote: `${readings.length} routers visible; ${readings.filter(r => r.rtt).length} advertise Wi-Fi RTT.${accepted ? '' : ' Scan request refused/throttled; showing cached results.'}` });
    const map = get().arena, pos = get().pos;
    const floor = map && pos && isIndoor(pos) ? map.floors.find(f => f.id === pos.floorId) : null;
    const fresh = readings.filter(r => Date.now() - r.t <= 15_000);
    if (map && floor && Date.now() - lastFixAt > 10_000) {
      const estimate = locateFingerprint(map, floor, fresh);
      if (estimate) fix(estimate);
    }
  } catch (e) { set({ indoorNote: String(e) }); }
  finally { scanning = false; }
}

async function rangeIndoorWifi() {
  const s = get(), map = s.arena, pos = s.pos;
  if (ranging || !map || !pos || !isIndoor(pos) || !s.indoorCapabilities?.rttAvailable || map.accessPoints.length < 3) return;
  const floor = map.floors.find(f => f.id === pos.floorId);
  if (!floor) return;
  ranging = true;
  try {
    const ranges = await Betaal.rangeWifi(map.accessPoints.map(p => p.bssid));
    const current = get().pos;
    if (get().arena?.id !== map.id || !current || !isIndoor(current) || current.floorId !== floor.id) return;
    const estimate = locateRtt3D(map, ranges) ?? locateRtt(map, floor, ranges);
    if (estimate && estimate.floorId !== current.floorId) {
      set({ suggestedFloor: estimate.floorId, indoorNote: 'Wi-Fi RTT suggests a different floor. Confirm the floor change.' }); return;
    }
    if (estimate) fix(estimate);
    else set({ indoorNote: 'Wi-Fi RTT needs at least 3 well-spaced mapped responders with consistent ranges. Using the last fix/motion estimate.' });
  } catch (e) { set({ indoorNote: `${e}. Using available marker/motion/fingerprint positioning.` }); }
  finally { ranging = false; }
}

export function initIndoorTracking() {
  if (initialized) return;
  initialized = true;
  refreshIndoorCapabilities();
  Betaal.addListener('onPressure', e => {
    if (!Number.isFinite(e.hpa) || e.hpa <= 0) return;
    pressure = pressure === null ? e.hpa : pressure * 0.8 + e.hpa * 0.2;
    const s = get();
    if (!s.arena || !s.pos || !isIndoor(s.pos)) return;
    if (!baseline) { baseline = { hpa: pressure, z: s.pos.z }; return; }
    const height = baseline.z + relativeHeight(baseline.hpa, pressure);
    const nearest = [...s.arena.floors].sort((a, b) => Math.abs(a.z - height) - Math.abs(b.z - height))[0];
    set({ suggestedFloor: nearest && nearest.id !== s.pos.floorId && Math.abs(nearest.z - height) < 1 ? nearest.id : null });
  });
  Betaal.addListener('onStep', () => {
    const s = get(), p = s.pos;
    if (!s.arena || !p || !isIndoor(p)) return;
    const floor = s.arena.floors.find(f => f.id === p.floorId);
    const stride = getPrefs().strideM;
    if (!s.compassOk || !s.sensors?.heading || !floor || !Number.isFinite(stride) || stride < 0.3 || stride > 1.2) {
      set({ pos: { ...p, acc: Math.min(1000, p.acc + 1) }, indoorNote: 'Step detected but heading/stride is unavailable. Tap your spot on the map when you stop.' }); return;
    }
    const radians = s.heading * Math.PI / 180;
    const next = { ...p, x: p.x + stride * Math.sin(radians), y: p.y + stride * Math.cos(radians), acc: Math.min(1000, p.acc + 0.25), source: 'steps' as const };
    if (next.x < 0 || next.y < 0 || next.x > floor.width || next.y > floor.depth || wallBetween(p, next, floor.walls)) {
      set({ pos: { ...p, acc: Math.min(1000, p.acc + stride) }, indoorNote: 'Estimated movement crosses a mapped wall/boundary. Tap your spot on the map.' }); return;
    }
    lastStepAt = Date.now();
    set({ pos: next });
  });
  onMessage(m => {
    if (m.t !== 'welcome' && m.t !== 'map' && m.t !== 'left') return;
    const nextMap = get().arena?.id ?? null;
    if (nextMap === mapId && m.t !== 'map') return;
    mapId = nextMap; baseline = null; lastFixAt = 0;
    set({ pos: null, suggestedFloor: null, indoorNote: nextMap ? 'Indoor map active. Tap where you are standing on the map.' : 'Outdoor GPS mode.' });
    if (nextMap) Betaal.startIndoorSensors(); else Betaal.stopIndoorSensors();
  });
  setInterval(() => {
    const s = get(), p = s.pos;
    if (!s.arena || !p || !isIndoor(p)) return;
    // shortcut: dead reckoning accumulates error; periodic mapped fixes are required for useful tracking.
    const pos = { ...p, acc: Math.min(1000, p.acc + (Date.now() - lastStepAt > 2000 ? 0.2 : 0.05)) };
    set({ pos });
    // Keep reporting even when old: the growing error radius tells the server how far to trust it.
    if (s.me) send({ t: 'pos', ...pos });
    if (Date.now() - lastFixAt >= 60_000 && pos.source !== 'rtt') set({ indoorNote: `No fresh fix for a minute (±${pos.acc.toFixed(0)} m). Tap your spot on the map to sharpen it.` });
  }, 1000);
  setInterval(() => { if (get().arena) { refreshIndoorCapabilities(); rangeIndoorWifi(); } }, 2000);
  setInterval(() => { if (get().arena) scanIndoorWifi(); }, 35_000);
}

export function savedIndoorMap() {
  const map = getPrefs().indoorMap;
  return validIndoorMap(map) ? map : null;
}
