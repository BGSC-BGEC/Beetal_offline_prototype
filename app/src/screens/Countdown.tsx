import { Text, View } from 'react-native';
import { serverNow, useStore } from '../store';
import { C, P, Screen, Title } from '../theme';

/** 10 s "spread out" countdown before the first possession. */
export function Countdown({ now }: { now: number }) {
  const s = useStore();
  void now; // re-render tick
  const left = s.countdownEndsAt ? Math.max(0, Math.ceil((s.countdownEndsAt - serverNow()) / 1000)) : 0;
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <Title size={30} color={C.text}>Spread out</Title>
      <Text style={{ color: C.gold, fontSize: 160, fontWeight: '900', lineHeight: 180 }}>{left || ''}</Text>
      <Title size={26} style={{ alignSelf: 'stretch', textAlign: 'center' }}>{left > 0 ? 'बेताल जाग रहा है' : 'बेताल जाग गया'}</Title>
      <P dim style={{ marginTop: 18, textAlign: 'center' }}>
        Earphones in. Phone upright, camera forward.{'\n'}{s.sensors?.acceleration === 'none' ? 'Tap Strike when within range.' : 'Thrust forward to strike.'}{'\n'}Hold the screen during the hunt to check yourself.
      </P>
      <View style={{ height: 40 }} />
    </Screen>
  );
}
