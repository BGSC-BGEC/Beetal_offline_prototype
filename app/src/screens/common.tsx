import { Text, View, type TextStyle } from 'react-native';
import { C, Dot } from '../theme';

export const inputStyle: TextStyle = {
  backgroundColor: C.card, borderWidth: 1, borderColor: C.line, color: C.text, fontSize: 18,
  paddingHorizontal: 16, height: 56, borderRadius: 14,
};

export function OnlineBadge({ online }: { online: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Dot color={online ? C.ok : C.red} />
      <Text style={{ color: C.dim, fontSize: 13 }}>{online ? 'Connected' : 'Connecting… (a sleeping server takes up to a minute to wake)'}</Text>
    </View>
  );
}

export function Avatar({ name, size = 38, color = C.gold }: { name: string; size?: number; color?: string }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#2a2018', borderWidth: 1.5, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color, fontWeight: '800', fontSize: size * 0.42 }}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
