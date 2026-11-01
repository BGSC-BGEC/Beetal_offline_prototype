// Look & feel: dark folk-horror. Black, temple gold, sindoor vermilion; Yatra One for display type.
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

export const C = {
  bg: '#0b0a0c',
  card: '#17141a',
  line: '#2a2430',
  gold: '#e3b04b',
  goldDim: '#8a6a2c',
  red: '#d4442e',
  blue: '#5fc2f5',
  text: '#efe9e1',
  dim: '#8f8790',
  ok: '#6cc28a',
};
export const DISPLAY = 'YatraOne-Regular';

export function Screen({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.screen, style]}>{children}</View>;
}

export function Title({ children, size = 40, color = C.gold, style }: { children: ReactNode; size?: number; color?: string; style?: TextStyle }) {
  return <Text style={[{ fontFamily: DISPLAY, fontSize: size, color, lineHeight: size * 1.35 }, style]}>{children}</Text>;
}

export function P({ children, dim, style }: { children: ReactNode; dim?: boolean; style?: TextStyle }) {
  return <Text style={[s.p, dim && { color: C.dim, fontSize: 14 }, style]}>{children}</Text>;
}

export function Btn({ title, onPress, kind = 'primary', disabled, busy, style }: {
  title: string; onPress: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; busy?: boolean; style?: ViewStyle;
}) {
  const bg = kind === 'primary' ? C.gold : kind === 'danger' ? C.red : 'transparent';
  const fg = kind === 'ghost' ? C.text : '#120d06';
  return (
    <Pressable
      onPress={onPress} disabled={disabled || busy}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.35 : pressed ? 0.75 : 1 },
        kind === 'ghost' && { borderWidth: 1, borderColor: C.line }, style]}
      accessibilityRole="button" accessibilityLabel={title}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 22, paddingTop: 56, paddingBottom: 28 },
  p: { color: C.text, fontSize: 16, lineHeight: 23 },
  btn: { height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginVertical: 6 },
  btnText: { fontSize: 17, fontWeight: '700', letterSpacing: 0.5 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.line },
});
