// Persisted player preferences (survive app restarts).
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Prefs = {
  name: string;
  serverUrl: string;
  token: string | null;   // reconnect token for the room you're in
  tutorialDone: boolean;
  haptics: boolean;
};

// Render free web service (render.yaml); LAN servers are set in Settings.
export const DEFAULT_SERVER = 'wss://betaal-proto.onrender.com';

const KEY = 'betaal.prefs.v1';
let prefs: Prefs = { name: '', serverUrl: DEFAULT_SERVER, token: null, tutorialDone: false, haptics: true };

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
    if (prefs.serverUrl === 'wss://betaal-proto.fly.dev') prefs.serverUrl = DEFAULT_SERVER; // 0.2.0 default, never deployed
  } catch {}
  return prefs;
}

export const getPrefs = () => prefs;

export function savePrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {});
  return prefs;
}
