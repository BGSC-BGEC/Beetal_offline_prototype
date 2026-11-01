import { View } from 'react-native';
import { createRoom, useStore } from '../store';
import { getPrefs } from '../prefs';
import { Btn, C, P, Screen, Title } from '../theme';
import { OnlineBadge } from './common';

export function Menu({ go }: { go: (r: 'join' | 'settings' | 'tutorial') => void }) {
  const s = useStore();
  return (
    <Screen style={{ justifyContent: 'space-between' }}>
      <View style={{ alignItems: 'center', marginTop: 24 }}>
        <Title size={72}>बेताल</Title>
        <Title size={20} color={C.text} style={{ letterSpacing: 8, marginTop: -6 }}>BETAAL</Title>
        <P dim style={{ marginTop: 10 }}>Playing as {getPrefs().name}</P>
      </View>
      <View>
        <Btn title="Create game" disabled={!s.online} busy={s.busy} onPress={createRoom} />
        <Btn title="Join game" kind="ghost" disabled={!s.online} onPress={() => go('join')} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn title="How to play" kind="ghost" onPress={() => go('tutorial')} style={{ flex: 1 }} />
          <Btn title="Settings" kind="ghost" onPress={() => go('settings')} style={{ flex: 1 }} />
        </View>
        <View style={{ alignItems: 'center', marginTop: 14 }}><OnlineBadge online={s.online} /></View>
        {!s.online && <P dim style={{ textAlign: 'center', marginTop: 6 }}>Can't reach the server? Check Settings → Server.</P>}
      </View>
    </Screen>
  );
}
