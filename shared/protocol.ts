// Wire messages (JSON over one WebSocket). `t` is the discriminator.
import type { Cfg } from './config.ts';
import type { Position } from './math.ts';
import type { IndoorMap } from './indoor.ts';

/** BLE claims list every peer the attacker hears inside kill range; the server picks the one the cone allows. */
export type Measurement =
  | { method: 'uwb'; d: number; az: number }
  | { method: 'ble'; near: Record<string, number>; heading?: number };

/** Commands the room owner's phone (or the GM debug page) may send. */
export type HostCmd =
  | { cmd: 'start' | 'calibStart' | 'calibFinish' | 'reset' | 'task' }
  | { cmd: 'setTimer'; sec: number }
  | { cmd: 'setRef'; id: string }
  | { cmd: 'cfg'; patch: Partial<Cfg> };
// Map editing is limited to the room owner in the lobby.
export type MapCmd = { cmd: 'setMap'; map: IndoorMap | null };

/** Phone -> server */
export type ClientMsg =
  | { t: 'create'; name: string; uwb: boolean }
  | { t: 'join'; code?: string; name: string; uwb: boolean; token?: string } // token alone = reconnect
  | { t: 'leave' }
  | { t: 'ready'; on: boolean }
  | ({ t: 'host' } & (HostCmd | MapCmd))
  | ({ t: 'pos' } & Position)
  | { t: 'nbr'; peers: Record<string, { rssiC?: number; uwbD?: number }> } // 2 Hz
  | { t: 'kill'; targetId: string; m: Measurement }
  | { t: 'calib'; peerId: string; rssi: number } // my raw median RSSI of the reference phone at 1 m
  | { t: 'sync'; c: number }
  | { t: 'uwbOob'; to: string; data: string } // opaque UWB session params, relayed
  | ({ t: 'gm'; code?: string } & (HostCmd | { cmd: 'watch' }));

export type PublicPlayer = {
  id: string; name: string; idx: number; alive: boolean; immune: boolean; uwb: boolean; bleOffset: number;
  ready: boolean; connected: boolean; calibrated: boolean;
  positionReady: boolean;
};
export type Snapshot = { id: string; name: string; pos?: Position; immune: boolean; exited: boolean }[];

/** Match log for the results reveal. `at` = ms since possession started. */
export type HistoryEntry =
  | { at: number; kind: 'possessed'; id: string }
  | { at: number; kind: 'kill'; victim: string; by?: string; cause: 'ghost' | 'player' | 'timer' | 'left' }
  | { at: number; kind: 'task' };

export type Result = { kind: 'players' | 'ghost' | 'divya'; winners: string[]; ghostHost?: string };

/** Server -> phone. Never contains who the host is (except `possessed` to the host itself, and `end`). */
export type ServerMsg =
  | { t: 'welcome'; protocolVersion: 2; id: string; idx: number; token: string; code: string; cfg: Cfg; room: number; arena: IndoorMap | null }
  | { t: 'map'; arena: IndoorMap | null }
  | {
      t: 'state'; code: string; phase: string; players: PublicPlayer[]; ownerId: string | null;
      countdownEndsAt: number | null; possessionSec: number;
    }
  | { t: 'error'; msg: string }
  | { t: 'left' }
  | { t: 'possessed'; endsAt: number; storyId: number }
  | { t: 'released' }
  | { t: 'event'; kind: 'bell' | 'scream'; at?: Position; self: boolean }
  | { t: 'ping'; snapshot: Snapshot; until: number }
  | { t: 'killResult'; ok: boolean; targetId: string; reason?: string }
  | { t: 'end'; result: Result; history: HistoryEntry[] }
  | { t: 'sync'; c: number; s: number }
  | { t: 'uwbOob'; from: string; data: string }
  | { t: 'cfg'; cfg: Cfg };
