// Boot: prefs -> (first run: name) -> permissions -> sensors/audio/server -> (first run: tutorial) -> menu.
// In a room the server's phase picks the screen. ponytail: plain state switch, no router (10 screens, no deep links).
import { useEffect, useState } from 'react';
import { BackHandler, PermissionsAndroid, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Betaal from './modules/betaal';
import { connect, setUwbCapable, useStore } from './src/store';
import { getPrefs, loadPrefs, savePrefs } from './src/prefs';
import { initSensors } from './src/radio';
import { initAudio } from './src/audio';
import { Btn, C, P, Screen, Title } from './src/theme';
import { FirstRun } from './src/screens/FirstRun';
import { Menu } from './src/screens/Menu';
import { Join } from './src/screens/Join';
import { Lobby } from './src/screens/Lobby';
import { Countdown } from './src/screens/Countdown';
import { Hunt } from './src/screens/Hunt';
import { Results } from './src/screens/Results';
import { Settings } from './src/screens/Settings';
import { Tutorial } from './src/screens/Tutorial';

type Route = 'boot' | 'firstRun' | 'perms' | 'tutorial' | 'menu' | 'join' | 'settings';

const P_ = PermissionsAndroid.PERMISSIONS;
const REQUIRED = [P_.ACCESS_FINE_LOCATION, P_.BLUETOOTH_SCAN, P_.BLUETOOTH_ADVERTISE, P_.BLUETOOTH_CONNECT];

async function askPermissions(): Promise<boolean> {
  const res = await PermissionsAndroid.requestMultiple([...REQUIRED, 'android.permission.UWB_RANGING' as any]);
  return REQUIRED.every(p => res[p] === 'granted');
}

let started = false;
async function startServices() {
  if (started) return;
  started = true;
  setUwbCapable(Betaal.hasUwb());
  await initAudio();
  initSensors(); // GPS keeps running in the background of this promise
  connect();
}

export default function App() {
  const s = useStore();
  const now = useNow(200);
  const [route, setRoute] = useState<Route>('boot');

  const afterPerms = async () => {
    await startServices();
    setRoute(getPrefs().tutorialDone ? 'menu' : 'tutorial');
  };
  const requestPerms = async () => ((await askPermissions()) ? afterPerms() : setRoute('perms'));

  useEffect(() => {
    loadPrefs().then(p => (p.name ? requestPerms() : setRoute('firstRun')));
  }, []);

  // Android back: sub-pages return to the menu; inside a game it does nothing (use Leave).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const sub = route === 'join' || route === 'settings' || (route === 'tutorial' && getPrefs().tutorialDone);
      if (!s.me && sub) { setRoute('menu'); return true; }
      return !!s.me;
    });
    return () => sub.remove();
  }, [route, s.me]);

  // Leaving a room lands on the menu, not back on the Join page.
  useEffect(() => { if (s.me && route === 'join') setRoute('menu'); }, [s.me]);

  let screen;
  if (route === 'boot') screen = <Screen style={{ justifyContent: 'center', alignItems: 'center' }}><Title size={72}>बेताल</Title></Screen>;
  else if (route === 'firstRun') screen = <FirstRun onDone={name => { savePrefs({ name }); requestPerms(); }} />;
  else if (route === 'perms') screen = <PermsGate onRetry={requestPerms} />;
  else if (route === 'tutorial') screen = <Tutorial canSkip={getPrefs().tutorialDone} onDone={() => { savePrefs({ tutorialDone: true }); setRoute('menu'); }} />;
  else if (s.me && s.result) screen = <Results />;
  else if (s.me && s.phase === 'COUNTDOWN') screen = <Countdown now={now} />;
  else if (s.me && s.phase === 'HUNT') screen = <Hunt now={now} />;
  else if (s.me) screen = <Lobby />;
  else if (route === 'join') screen = <Join back={() => setRoute('menu')} />;
  else if (route === 'settings') screen = <Settings back={() => setRoute('menu')} />;
  else screen = <Menu go={setRoute} />;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      {screen}
      {s.toast && now < s.toast.until && (
        <View style={{ position: 'absolute', bottom: 36, left: 20, right: 20, alignItems: 'center' }} pointerEvents="none">
          <Text style={{ color: C.text, backgroundColor: '#2a2430', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, overflow: 'hidden', fontSize: 15 }}>{s.toast.text}</Text>
        </View>
      )}
      {s.me && !s.online && (
        <View style={{ position: 'absolute', top: 28, alignSelf: 'center', backgroundColor: '#3a2a08', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10 }}>
          <Text style={{ color: C.gold, fontWeight: '700' }}>Reconnecting…</Text>
        </View>
      )}
    </View>
  );
}

function PermsGate({ onRetry }: { onRetry: () => void }) {
  return (
    <Screen style={{ justifyContent: 'center' }}>
      <Title size={34}>Permissions needed</Title>
      <P style={{ marginTop: 8 }}>Betaal uses your location to place sounds and show players on the map, and “Nearby devices” (Bluetooth) to know who is within striking distance.</P>
      <P dim style={{ marginTop: 8 }}>If you denied them permanently, enable them in Android Settings → Apps → Betaal → Permissions.</P>
      <Btn title="Grant permissions" onPress={onRetry} style={{ marginTop: 20 }} />
    </Screen>
  );
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
