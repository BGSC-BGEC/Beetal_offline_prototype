import { NativeModule, requireNativeModule } from 'expo';
import type { WifiRange, WifiReading } from '../../../shared/indoor.ts';

type Events = {
  onRotation(e: { w: number; x: number; y: number; z: number; acc: number }): void;
  onAccel(e: { x: number; y: number; z: number; t: number; includesGravity: boolean }): void;
  onRssi(e: { idx: number; rssi: number; t: number }): void;
  onUwb(e: { peer: string; d?: number; az?: number; t: number }): void;
  onUwbEnd(e: { peer: string; reason: string }): void;
  onSoundEnd(e: { id: number }): void;
  onPressure(e: { hpa: number }): void;
  onStep(e: { t: number }): void;
};

export type UwbParams = { addr: string; sessionId: number; key: string; channel: number; preamble: number };
export type SensorStatus = { acceleration: 'linear' | 'accelerometer' | 'none'; heading: boolean };
export type IndoorCapabilities = {
  wifi: boolean; wifiEnabled: boolean; wifiPermission: boolean; locationEnabled: boolean;
  rtt: boolean; rttAvailable: boolean; steps: boolean; stepPermission: boolean; barometer: boolean;
};
export type SoundKind =
  | 'bell' | 'scream' | 'whisper' | 'possessed_breathing' | 'win_players' | 'win_ghost' | 'win_divya'
  | 'hit' | 'miss' | 'deny' | 'ambient' | 'afterKillDrama';

declare class BetaalModule extends NativeModule<Events> {
  hasUwb(): boolean;
  indoorCapabilities(): IndoorCapabilities;
  startIndoorSensors(): { steps: boolean; barometer: boolean };
  stopIndoorSensors(): void;
  requestWifiScan(): boolean;
  wifiReadings(): WifiReading[];
  rangeWifi(bssids: string[]): Promise<WifiRange[]>;
  declination(lat: number, lon: number): number;
  vibrate(patternMs: number[]): void;
  keepAwake(on: boolean): void;
  startSensors(): SensorStatus;
  stopSensors(): void;
  startBle(roomHash: number, idx: number): void;
  stopBle(): void;
  uwbControleeAddress(peer: string): Promise<string>;
  uwbControllerStart(peer: string, controleeAddr: string): Promise<UwbParams>;
  uwbControleeStart(peer: string, params: UwbParams): boolean;
  uwbStop(peer: string): void;
  play(id: number, kind: SoundKind, gain: number, pan: number, cutoffHz: number, loop: boolean): void;
  setParams(id: number, gain: number, pan: number, cutoffHz: number): void;
  stopSound(id: number): void;
  /** Resolves with the sound kinds that were loaded from real files (rest are placeholders). */
  warmup(): Promise<SoundKind[]>;
}

export default requireNativeModule<BetaalModule>('Betaal');
