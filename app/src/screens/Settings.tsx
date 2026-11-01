import { useState } from 'react';
import { Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { connect, useStore } from '../store';
import { DEFAULT_SERVER, getPrefs, savePrefs } from '../prefs';
import { playDemo, realSounds } from '../audio';
import { retryBle } from '../radio';
import { Btn, C, Card, P, Screen, Title } from '../theme';
import { OnlineBadge, inputStyle } from './common';

export function Settings({ back }: { back: () => void }) {
  const s = useStore();
  const [name, setName] = useState(getPrefs().name);
  const [server, setServer] = useState(getPrefs().serverUrl);
  const [haptics, setHaptics] = useState(getPrefs().haptics);
  const saveName = () => name.trim() && savePrefs({ name: name.trim() });
  const applyServer = (url: string) => {
    let u = url.trim();
    if (u && !/^wss?:\/\//.test(u)) u = `ws://${u}${/:\d+$/.test(u) ? '' : ':8787'}`; // "192.168.1.5" -> ws://192.168.1.5:8787
    setServer(u); savePrefs({ serverUrl: u, token: null }); connect();
  };
  return (
    <Screen style={{ paddingBottom: 12 }}>
      <Pressable onPress={() => { saveName(); back(); }}><P dim>‹ Back</P></Pressable>
      <Title size={34} style={{ marginTop: 12 }}>Settings</Title>
      <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 20 }}>
        <Card>
          <P dim>Your name</P>
          <TextInput style={[inputStyle, { marginTop: 6 }]} value={name} onChangeText={setName} onBlur={saveName} maxLength={16} />
        </Card>

        <Card>
          <P dim>Server</P>
          <TextInput style={[inputStyle, { marginTop: 6, fontSize: 15 }]} value={server} onChangeText={setServer}
            autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => applyServer(server)} />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
            <Btn title="Connect" onPress={() => applyServer(server)} style={{ flex: 1 }} />
            <Btn title="Default" kind="ghost" onPress={() => applyServer(DEFAULT_SERVER)} style={{ flex: 1 }} />
          </View>
          <OnlineBadge online={s.online} />
          <P dim style={{ marginTop: 6 }}>For a laptop on the same Wi-Fi, type its IP (e.g. 192.168.1.5).</P>
        </Card>

        <Card>
          <P dim>Earphone check</P>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
            <Btn title="Left" kind="ghost" onPress={() => playDemo('bell', -1)} style={{ flex: 1 }} />
            <Btn title="Right" kind="ghost" onPress={() => playDemo('bell', 1)} style={{ flex: 1 }} />
          </View>
        </Card>

        <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <P>Vibration</P>
          <Switch value={haptics} onValueChange={v => { setHaptics(v); savePrefs({ haptics: v }); }} thumbColor={haptics ? C.gold : C.dim} />
        </Card>

        <Card>
          <P dim>Bluetooth</P>
          <Btn title="Restart Bluetooth radio" kind="ghost" onPress={retryBle} />
        </Card>

        <P dim style={{ textAlign: 'center' }}>
          Betaal physical prototype v{Constants.expoConfig?.version ?? '?'} · sounds from files: {realSounds.length ? realSounds.join(', ') : 'none (placeholders)'}
        </P>
      </ScrollView>
    </Screen>
  );
}
