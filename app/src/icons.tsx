// Small hand-drawn SVG marks used on the radar and in lists (no emoji: consistent across phones).
import Svg, { Circle, G, Path } from 'react-native-svg';

export function Skull({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`}>
      <Path d="M-8 -2 a8 8 0 1 1 16 0 v4 l-2 2 v3 h-12 v-3 l-2 -2 z" fill="#d9d2c5" />
      <Circle cx={-3.2} cy={-1} r={2.3} fill="#0b0a0c" />
      <Circle cx={3.2} cy={-1} r={2.3} fill="#0b0a0c" />
      <Path d="M-1 3 h2 l-1 -2 z" fill="#0b0a0c" />
    </G>
  );
}

export function Wisp({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`} opacity={0.9}>
      <Path d="M-7 8 v-9 a7 7 0 0 1 14 0 v9 l-2.3 -2.5 l-2.4 2.5 l-2.3 -2.5 l-2.3 2.5 l-2.4 -2.5 z" fill="#f2efe8" />
      <Circle cx={-2.6} cy={-1.5} r={1.5} fill="#0b0a0c" />
      <Circle cx={2.6} cy={-1.5} r={1.5} fill="#0b0a0c" />
    </G>
  );
}

/** Standalone skull for UI (outside the radar). */
export function SkullIcon({ size = 40 }: { size?: number }) {
  return <Svg width={size} height={size} viewBox="-10 -11 20 20"><Skull x={0} y={0} /></Svg>;
}
