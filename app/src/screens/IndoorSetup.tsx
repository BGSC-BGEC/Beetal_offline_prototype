import { useState } from 'react';
import { Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';
import { validIndoorMap, type IndoorMap, type IndoorPosition, type XY } from '../../../shared/indoor.ts';
import { isIndoor } from '../../../shared/math.ts';
import { amOwner, get, host, useStore } from '../store';
import { confirmSuggestedFloor, enableIndoorSensors, locateAt, refreshIndoorCapabilities, savedIndoorMap, scanIndoorWifi } from '../indoor';
import { getPrefs, savePrefs } from '../prefs';
import { Btn, C, Card, P, Screen, Title } from '../theme';
import { inputStyle } from './common';

export function IndoorSetup({ back }: { back: () => void }) {
  const s = useStore();
  const editable = !s.me || (amOwner() && s.phase === 'LOBBY');
  const [draft, setDraft] = useState<IndoorMap | null>(() => s.arena ?? savedIndoorMap());
  const map = editable ? draft : s.arena;
  const [floorIndex, setFloorIndex] = useState(() => Math.max(0, map?.floors.findIndex(f => s.pos && isIndoor(s.pos) && f.id === s.pos.floorId) ?? 0));
  const floor = map?.floors[Math.min(floorIndex, map.floors.length - 1)];
  const [name, setName] = useState('My building');
  const [width, setWidth] = useState('20'), [depth, setDepth] = useState('20');
  const [floorCount, setFloorCount] = useState('2'), [floorHeight, setFloorHeight] = useState('3');
  const [north, setNorth] = useState('0'), [phoneHeight, setPhoneHeight] = useState('1.2');
  const [stride, setStride] = useState(String(getPrefs().strideM));
  const [mode, setMode] = useState<'me' | 'marker' | 'wall' | 'ap'>('me');
  const [firstWallPoint, setFirstWallPoint] = useState<XY | null>(null);
  const [markerName, setMarkerName] = useState('Marker');
  const [selectedAp, setSelectedAp] = useState<string | null>(null), [apHeight, setApHeight] = useState('2.2');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const run = async (action: () => unknown | Promise<unknown>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  const update = (next: IndoorMap) => { setDraft(next); setMessage('Map changed. Save it, then apply it to the room.'); };
  const create = () => {
    const count = Number(floorCount), h = Number(floorHeight);
    if (!Number.isInteger(count) || count < 1 || count > 30 || !Number.isFinite(h) || h < 2 || h > 10) throw new Error('Use 1–30 floors and a measured floor height from 2–10 m.');
    const next: IndoorMap = {
      id: Date.now().toString(36), name: name.trim(), northDeg: Number(north), phoneHeightM: Number(phoneHeight),
      floors: Array.from({ length: count }, (_, i) => ({ id: `f${i}`, name: `Floor ${i}`, z: i * h,
        width: Number(width), depth: Number(depth), walls: [], markers: [{ id: 'entry', name: 'Entry', x: 1, y: 1 }] })),
      accessPoints: [], fingerprints: [],
    };
    if (!validIndoorMap(next) || next.floors.some(f => f.width < 2 || f.depth < 2)) throw new Error('Check the name, dimensions, north bearing and phone height (0.3–2.5 m).');
    update(next); setFloorIndex(0); setFirstWallPoint(null);
  };
  const tap = (x: number, y: number) => {
    if (!map || !floor) return;
    const point = { x: Math.round(Math.max(0, Math.min(floor.width, x)) * 10) / 10, y: Math.round(Math.max(0, Math.min(floor.depth, y)) * 10) / 10 };
    if (!editable || mode === 'me') {
      if (map.id !== s.arena?.id) { setMessage('Apply this map to the room first, then tap your spot.'); return; }
      run(() => { locateAt(floor.id, point.x, point.y, 'manual'); setMessage(`Location set on ${floor.name} at (${point.x}, ${point.y}).`); });
    } else if (mode === 'ap') {
      const h = Number(apHeight);
      if (!selectedAp || !Number.isFinite(h) || h < 0 || h > 10) { setMessage('Select a router below and enter its measured height above this floor (0–10 m).'); return; }
      update({ ...map, accessPoints: [...map.accessPoints.filter(a => a.bssid !== selectedAp), { ...point, z: floor.z + h, bssid: selectedAp }] });
    } else if (mode === 'marker') {
      if (!markerName.trim()) { setMessage('Name the marker first.'); return; }
      update({ ...map, floors: map.floors.map(f => f.id !== floor.id ? f : { ...f, markers: [...f.markers, { ...point, id: Date.now().toString(36), name: markerName.trim() }] }) });
    } else if (!firstWallPoint) { setFirstWallPoint(point); setMessage('Tap the other end of this wall. Leave gaps for doors.'); }
    else {
      if (Math.hypot(point.x - firstWallPoint.x, point.y - firstWallPoint.y) >= 0.2) update({ ...map, floors: map.floors.map(f => f.id !== floor.id ? f : { ...f, walls: [...f.walls, { a: firstWallPoint, b: point }] }) });
      setFirstWallPoint(null);
    }
  };
  const recordFingerprint = async () => {
    const pos = s.pos;
    if (!map || map.id !== s.arena?.id || !pos || !isIndoor(pos) || (pos.source !== 'marker' && pos.source !== 'manual') || pos.acc > 2) throw new Error('Apply the map, then tap your exact spot (or use a marker) before recording.');
    await scanIndoorWifi();
    const current = get().pos;
    if (!current || !isIndoor(current) || current.mapId !== pos.mapId || current.floorId !== pos.floorId || Math.hypot(current.x - pos.x, current.y - pos.y) > 0.5) throw new Error('Location changed during the scan. Stand at the marker and retry.');
    const readings = get().wifi.filter(r => Date.now() - r.t < 15_000).map(({ bssid, rssi }) => ({ bssid, rssi }));
    if (readings.length < 3) throw new Error('Need at least 3 freshly scanned Wi-Fi signals for a fingerprint. Scan throttling may require waiting 35 seconds.');
    update({ ...map, fingerprints: [...map.fingerprints.filter(p => p.floorId !== pos.floorId || Math.hypot(p.x - pos.x, p.y - pos.y) > 0.5), { floorId: pos.floorId, x: pos.x, y: pos.y, readings }] });
  };
  const caps = s.indoorCapabilities;

  return (
    <Screen style={{ paddingBottom: 12 }}>
      <Pressable onPress={back}><P dim>‹ Back</P></Pressable>
      <Title size={30}>Indoor maps</Title>
      {!!message && <View accessible accessibilityLiveRegion="polite"><P style={{ color: C.gold }}>{message}</P></View>}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
        <Card>
          <P>Available on this phone</P>
          <P dim>Motion: {s.sensors?.acceleration ?? 'checking'} · heading: {s.sensors?.heading ? 'yes' : 'no'}</P>
          <P dim>Wi-Fi: {caps?.wifiEnabled ? 'on' : 'off/unavailable'} · location: {caps?.locationEnabled ? 'on' : 'off'} · Wi-Fi permission: {caps?.wifiPermission ? 'granted' : 'missing'}</P>
          <P dim>Wi-Fi RTT hardware: {caps?.rtt ? 'yes' : 'no'} · currently usable: {caps?.rttAvailable ? 'yes' : 'no'}</P>
          <P dim>Step sensor: {caps?.steps ? 'yes' : 'no'} · permission: {caps?.stepPermission ? 'granted' : 'missing'} · barometer: {caps?.barometer ? 'yes' : 'no'}</P>
          <Btn title="Enable available indoor sensors" kind="ghost" busy={busy} onPress={() => run(enableIndoorSensors)} />
          <Btn title="Check phone and scan routers" kind="ghost" busy={busy} onPress={() => run(async () => { refreshIndoorCapabilities(); await scanIndoorWifi(); })} />
          <P dim>{s.indoorNote}</P>
          <P dim>Jio/Airtel and other router brands use the same checks. Ordinary Wi-Fi does not guarantee ranging. Signal fingerprints are rough; they cannot confirm an attack cone.</P>
        </Card>

        {editable && <Card>
          <P>Create a map</P>
          <Field label="Building name" value={name} change={setName} />
          <Field label="Width, metres (map X)" value={width} change={setWidth} numeric />
          <Field label="Depth, metres (map Y)" value={depth} change={setDepth} numeric />
          <Field label="Number of floors" value={floorCount} change={setFloorCount} numeric />
          <Field label="Measured floor-to-floor height, metres" value={floorHeight} change={setFloorHeight} numeric />
          <Field label="Compass bearing of map UP, degrees (0 = north)" value={north} change={setNorth} numeric />
          <Field label="Phone height above the floor during play, metres" value={phoneHeight} change={setPhoneHeight} numeric />
          <Btn title="Create new map" onPress={() => run(create)} />
        </Card>}

        {map && floor && <Card>
          <P>{map.name} · {map.floors.length} floors · up = {map.northDeg}°</P>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {map.floors.map((f, i) => <Btn key={f.id} title={`${f.name} (${f.z} m)`} kind={f.id === floor.id ? 'primary' : 'ghost'} onPress={() => { setFloorIndex(i); setFirstWallPoint(null); }} />)}
          </View>
          <P dim>{floor.width} × {floor.depth} m. Bottom-left is (0, 0). {editable && mode !== 'me' ? `Tap to add ${mode === 'ap' ? 'the selected router' : mode === 'wall' ? 'wall endpoints' : 'a marker'}.` : 'Tap where you are standing to set your position (gold dot).'}</P>
          <MapPlan map={map} floorIndex={floorIndex} first={firstWallPoint} tap={tap} me={s.pos && isIndoor(s.pos) && s.pos.mapId === map.id ? s.pos : null} />
          {editable && <>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <Btn title="My spot" kind={mode === 'me' ? 'primary' : 'ghost'} onPress={() => { setMode('me'); setFirstWallPoint(null); }} style={{ flex: 1 }} />
              <Btn title="Markers" kind={mode === 'marker' ? 'primary' : 'ghost'} onPress={() => { setMode('marker'); setFirstWallPoint(null); }} style={{ flex: 1 }} />
              <Btn title="Walls" kind={mode === 'wall' ? 'primary' : 'ghost'} onPress={() => { setMode('wall'); setFirstWallPoint(null); }} style={{ flex: 1 }} />
            </View>
            <Field label="New marker name" value={markerName} change={setMarkerName} />
            <Btn title="Remove last wall" kind="ghost" disabled={!floor.walls.length} onPress={() => update({ ...map, floors: map.floors.map(f => f.id === floor.id ? { ...f, walls: f.walls.slice(0, -1) } : f) })} />
            <Btn title="Remove last marker" kind="ghost" disabled={!floor.markers.length} onPress={() => update({ ...map, floors: map.floors.map(f => f.id === floor.id ? { ...f, markers: f.markers.slice(0, -1) } : f) })} />
          </>}
          {floor.markers.map(marker => <View key={marker.id} style={{ marginTop: 8 }}>
            <P dim>{marker.name}: ({marker.x}, {marker.y})</P>
            <Btn title={`I'm at ${marker.name}`} kind="ghost" onPress={() => run(() => locateAt(floor.id, marker.x, marker.y, 'marker'))} />
          </View>)}
          {editable && <>
            <Btn title="Record Wi-Fi fingerprint at my marker" kind="ghost" busy={busy} onPress={() => run(recordFingerprint)} />
            <P dim>{map.fingerprints.length} fingerprint locations · {map.accessPoints.length} mapped access points</P>
            <Btn title="Save map on this phone" onPress={() => run(() => { if (!validIndoorMap(map)) throw new Error('Invalid map or too many items.'); savePrefs({ indoorMap: map }); setMessage('Map saved on this phone.'); })} />
            {s.me && <Btn title="Apply this map to the room" disabled={s.phase !== 'LOBBY'} onPress={() => run(() => { if (!validIndoorMap(map)) throw new Error('Invalid map.'); savePrefs({ indoorMap: map }); host({ cmd: 'setMap', map }); setMessage('Map submitted. Each player now taps their spot on the map.'); })} />}
            <Btn title="Share/export map" kind="ghost" onPress={() => Share.share({ message: JSON.stringify(map) })} />
          </>}
          {s.arena && amOwner() && s.phase === 'LOBBY' && <Btn title="Use outdoor GPS instead" kind="ghost" onPress={() => host({ cmd: 'setMap', map: null })} />}
        </Card>}

        {editable && map && <Card>
          <P>Map nearby routers</P>
          <P dim>For RTT, measure each router's actual position and height. At least three well-spaced responders are needed on the chosen floor. Tap a router, then tap its location on the map.</P>
          <Field label="Selected router height above selected floor, metres" value={apHeight} change={setApHeight} numeric />
          {s.wifi.map(ap => <Btn key={ap.bssid} title={`${ap.ssid || ap.bssid} · ${ap.rssi} dBm · ${ap.rtt ? 'RTT' : 'signal only'}${selectedAp === ap.bssid ? ' ✓' : ''}`} kind="ghost" onPress={() => { setSelectedAp(ap.bssid); setMode('ap'); setMessage('Now tap this router’s measured location on the floor plan.'); }} />)}
          <Btn title="Remove last mapped router" kind="ghost" disabled={!map.accessPoints.length} onPress={() => update({ ...map, accessPoints: map.accessPoints.slice(0, -1) })} />
        </Card>}

        <Card>
          <P>Set or reset your position</P>
          <P dim>Tap your spot on the floor plan above, or use a named marker. Wi-Fi RTT, fingerprints and step tracking update it where this phone supports them; otherwise tap again whenever you move far.</P>
          {s.suggestedFloor && <>
            <P>Sensors suggest you moved to {s.arena?.floors.find(f => f.id === s.suggestedFloor)?.name}.</P>
            <Btn title="Confirm floor change" onPress={() => run(confirmSuggestedFloor)} />
          </>}
          <Field label="Measured stride length, metres (walk 10 steps; divide distance by 10)" value={stride} change={setStride} numeric />
          <Btn title="Save my stride" kind="ghost" onPress={() => run(() => { const n = Number(stride); if (!Number.isFinite(n) || n < 0.3 || n > 1.2) throw new Error('Stride must be 0.3–1.2 m.'); savePrefs({ strideM: n }); setMessage('Stride saved.'); })} />
          <P dim>Without a step sensor/heading, tap your spot more often. Without a barometer, switch floors on the plan and tap your spot after taking stairs.</P>
        </Card>

        {editable && <Card>
          <P>Import a shared map</P>
          <TextInput style={[inputStyle, { height: 100 }]} multiline value={importText} onChangeText={setImportText} accessibilityLabel="Shared map data" />
          <Btn title="Import map" kind="ghost" onPress={() => run(() => { if (importText.length > 300_000) throw new Error('Map is too large.'); const imported = JSON.parse(importText); if (!validIndoorMap(imported)) throw new Error('Invalid map data.'); update(imported); setFloorIndex(0); })} />
        </Card>}
      </ScrollView>
    </Screen>
  );
}

function Field({ label, value, change, numeric }: { label: string; value: string; change: (s: string) => void; numeric?: boolean }) {
  return <View style={{ marginTop: 8 }}><P dim>{label}</P><TextInput style={inputStyle} value={value} onChangeText={change} keyboardType={numeric ? 'decimal-pad' : 'default'} accessibilityLabel={label} /></View>;
}

function MapPlan({ map, floorIndex, first, tap, me }: { map: IndoorMap; floorIndex: number; first: XY | null; tap: (x: number, y: number) => void; me: IndoorPosition | null }) {
  const [pixels, setPixels] = useState(280);
  const floor = map.floors[Math.min(floorIndex, map.floors.length - 1)];
  const height = Math.min(360, pixels * floor.depth / floor.width);
  return <View onLayout={e => setPixels(e.nativeEvent.layout.width)} onStartShouldSetResponder={() => true} onResponderRelease={e => tap(e.nativeEvent.locationX / pixels * floor.width, (1 - e.nativeEvent.locationY / height) * floor.depth)} accessibilityLabel={`Floor plan ${floor.name}`}>
    <Svg width="100%" height={height} viewBox={`0 0 ${floor.width} ${floor.depth}`} preserveAspectRatio="none">
      <Rect x={0} y={0} width={floor.width} height={floor.depth} fill={C.bg} stroke={C.gold} strokeWidth={0.15} />
      {floor.walls.map((w, i) => <Line key={i} x1={w.a.x} y1={floor.depth - w.a.y} x2={w.b.x} y2={floor.depth - w.b.y} stroke={C.text} strokeWidth={0.15} />)}
      {floor.markers.map(m => <Circle key={m.id} cx={m.x} cy={floor.depth - m.y} r={0.3} fill={C.blue} />)}
      {map.accessPoints.filter(a => Math.abs(a.z - floor.z) < 10).map(a => <Circle key={a.bssid} cx={a.x} cy={floor.depth - a.y} r={0.25} fill={C.ok} />)}
      {me && me.floorId === floor.id && <><Circle cx={me.x} cy={floor.depth - me.y} r={Math.min(me.acc, Math.max(floor.width, floor.depth))} fill={C.gold} opacity={0.15} /><Circle cx={me.x} cy={floor.depth - me.y} r={0.35} fill={C.gold} /></>}
      {first && <Circle cx={first.x} cy={floor.depth - first.y} r={0.3} fill={C.red} />}
      <SvgText x={0.5} y={floor.depth - 0.3} fill={C.dim} fontSize={0.6}>0,0</SvgText>
    </Svg>
  </View>;
}
