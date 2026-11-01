// Wire messages (JSON over one WebSocket). `t` is the discriminator.
import type { Cfg } from './config.ts';
import type { LatLon } from './math.ts';

export type Measurement = { method: 'uwb'; d: number; az?: number } | { method: 'ble'; rssiC: number };

/** Commands the room owner's phone (or the GM debug page) may send. */
export type HostCmd =
  | { cmd: 'start' | 'calibStart' | 'calibFinish' | 'reset' | 'task' }
  | { cmd: 'setTimer'; sec: number }
  | { cmd: 'setRef'; id: string }
  | { cmd: 'cfg'; patch: Partial<Cfg> };

/** Phone -> server */
export type ClientMsg =
  | { t: 'create'; name: string; uwb: boolean }
  | { t: 'join'; code?: string; name: string; uwb: boolean; token?: string } // token alone = reconnect
  | { t: 'leave' }
  | { t: 'ready'; on: boolean }
  | ({ t: 'host' } & HostCmd)
  | { t: 'pos'; lat: number; lon: number; acc: number }
  | { t: 'nbr'; peers: Record<string, { rssiC?: number; uwbD?: number }> } // 2 Hz
  | { t: 'kill'; targetId: string; m: Measurement }
  | { t: 'calib'; peerId: string; rssi: number } // my raw median RSSI of the reference phone at 1 m
  | { t: 'sync'; c: number }
  | { t: 'uwbOob'; to: string; data: string } // opaque UWB session params, relayed
  | ({ t: 'gm'; code?: string } & (HostCmd | { cmd: 'watch' }));

export type PublicPlayer = {
  id: string; name: string; idx: number; alive: boolean; immune: boolean; uwb: boolean; bleOffset: number;
  ready: boolean; connected: boolean; calibrated: boolean;
};
export type Snapshot = { id: string; name: string; pos?: LatLon; immune: boolean; exited: boolean }[];

/** Match log for the results reveal. `at` = ms since possession started. */
export type HistoryEntry =
  | { at: number; kind: 'possessed'; id: string }
  | { at: number; kind: 'kill'; victim: string; by?: string; cause: 'ghost' | 'player' | 'timer' | 'left' }
  | { at: number; kind: 'task' };

export type Result = { kind: 'players' | 'ghost' | 'divya'; winners: string[]; ghostHost?: string };

/** Server -> phone. Never contains who the host is (except `possessed` to the host itself, and `end`). */
export type ServerMsg =
  | { t: 'welcome'; id: string; idx: number; token: string; code: string; cfg: Cfg; room: number }
  | {
      t: 'state'; code: string; phase: string; players: PublicPlayer[]; ownerId: string | null;
      countdownEndsAt: number | null; possessionSec: number;
    }
  | { t: 'error'; msg: string }
  | { t: 'left' }
  | { t: 'possessed'; endsAt: number; storyId: number }
  | { t: 'released' }
  | { t: 'event'; kind: 'bell' | 'scream'; at?: LatLon; self: boolean }
  | { t: 'ping'; snapshot: Snapshot; until: number }
  | { t: 'killResult'; ok: boolean; targetId: string; reason?: string }
  | { t: 'end'; result: Result; history: HistoryEntry[] }
  | { t: 'sync'; c: number; s: number }
  | { t: 'uwbOob'; from: string; data: string }
  | { t: 'cfg'; cfg: Cfg };
