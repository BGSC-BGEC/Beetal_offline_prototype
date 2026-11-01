// Heading-up radar: you at the centre, the way your phone points is up.
// ponytail: plain SVG instead of Google Maps (no API key); swap for react-native-maps if landmarks matter.
import Svg, { Circle, Defs, G, Line, Polygon, RadialGradient, Stop, Text as SvgText } from 'react-native-svg';
import { isIndoor, sameSpace, toRadar, type Position } from '../../shared/math.ts';
import type { State } from './store';
import { Skull, Wisp } from './icons';
import { C } from './theme';

const RANGE_M = 40;

export function Radar({ s, size, now, immune }: { s: State; size: number; now: number; immune: boolean }) {
  const c = size / 2;
  const k = (c - 8) / RANGE_M; // px per metre
  const pt = (p: Position) => {
    const r = toRadar(s.pos!, s.heading, p);
    return { x: c + r.x * k, y: c - r.y * k };
  };
  const ping = s.ping && now < s.ping.until ? s.ping : null;
  const fade = ping ? Math.min(1, (ping.until - now) / 1200) : 0;
  const origin = s.pos && isIndoor(s.pos) ? s.pos : null;
  const floor = s.arena?.floors.find(f => f.id === origin?.floorId);

  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id="bg" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#1d1520" stopOpacity="1" />
          <Stop offset="1" stopColor={C.bg} stopOpacity="1" />
        </RadialGradient>
      </Defs>
      <Circle cx={c} cy={c} r={c - 4} fill="url(#bg)" />
      {[10, 20, 30, 40].map(m => (
        <Circle key={m} cx={c} cy={c} r={m * k} stroke={m === 40 ? C.goldDim : C.line} strokeWidth={m === 40 ? 1.5 : 1} fill="none" />
      ))}
      {[10, 20, 30].map(m => (
        <SvgText key={'l' + m} x={c + 4} y={c - m * k - 4} fill={C.dim} fontSize={10}>{m} m</SvgText>
      ))}
      {/* north marker rides the outer ring */}
      <G rotation={-s.heading - (s.arena?.northDeg ?? 0)} origin={`${c}, ${c}`}>
        <SvgText x={c} y={22} fill={C.red} fontSize={15} fontWeight="bold" textAnchor="middle">N</SvgText>
      </G>
      <Line x1={c} y1={c} x2={c} y2={8} stroke={C.gold} strokeOpacity={0.18} strokeDasharray="3 7" />

      {origin && floor && <>
        <Polygon points={[{ x: 0, y: 0 }, { x: floor.width, y: 0 }, { x: floor.width, y: floor.depth }, { x: 0, y: floor.depth }].map(p => { const q = pt({ ...origin, ...p }); return `${q.x},${q.y}`; }).join(' ')} fill="none" stroke={C.goldDim} strokeWidth={1} />
        {floor.walls.map((w, i) => { const a = pt({ ...origin, ...w.a }), b = pt({ ...origin, ...w.b }); return <Line key={`wall${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={C.dim} strokeWidth={2} />; })}
      </>}
      {s.pos && s.deaths.filter(d => sameSpace(s.pos!, d) && (!origin || (isIndoor(d) && d.floorId === origin.floorId))).map((d, i) => { const p = pt(d); return <Skull key={'d' + i} x={p.x} y={p.y} s={1.1} />; })}

      {s.pos && ping?.snapshot.filter(p => p.pos && sameSpace(s.pos!, p.pos) && p.id !== s.me?.id).map(p => {
        const q = pt(p.pos!);
        const location = p.pos && isIndoor(p.pos) ? p.pos : null;
        const otherFloor = origin && location && location.floorId !== origin.floorId
          ? ` (${location.z > origin.z ? '↑' : '↓'} ${s.arena?.floors.find(f => f.id === location.floorId)?.name ?? 'other floor'})` : '';
        return (
          <G key={p.id} opacity={fade}>
            <Circle cx={q.x} cy={q.y} r={Math.max(6, p.pos!.acc * k)} fill="#ffffff0d" stroke="#ffffff26" />
            {p.immune && <Circle cx={q.x} cy={q.y} r={12} stroke={C.blue} strokeWidth={3} fill="none" />}
            <Circle cx={q.x} cy={q.y} r={6.5} fill={p.exited ? '#e8e3da' : C.gold} />
            {p.exited && <Wisp x={q.x} y={q.y - 20} />}
            <SvgText x={q.x} y={q.y + 24} fill={C.text} fontSize={13} fontWeight="600" textAnchor="middle">{p.name}{otherFloor}</SvgText>
          </G>
        );
      })}

      {s.pos && <Circle cx={c} cy={c} r={Math.max(8, s.pos.acc * k)} fill="#e3b04b14" stroke="#e3b04b40" />}
      {immune && <Circle cx={c} cy={c} r={20} stroke={C.blue} strokeWidth={3} fill="none" />}
      {s.sensors?.heading === false ? <Circle cx={c} cy={c} r={8} fill={C.gold} />
        : <Polygon points={`${c},${c - 13} ${c - 9},${c + 9} ${c},${c + 4} ${c + 9},${c + 9}`} fill={C.gold} />}
    </Svg>
  );
}
