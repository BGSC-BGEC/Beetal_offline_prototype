// All game sound: spatial events (bell/scream), the possessed player's breathing + whisper,
// ambient bed during the hunt, feedback and end stings. Native side mixes; JS aims the spatial ones.
import Betaal, { type SoundKind } from '../modules/betaal';
import { SELF_SOUND, spatialize, type LatLon } from '../../shared/math.ts';
import { FALLEN_DELAY_MS, get, onMessage, serverNow } from './store';
import { getPrefs } from './prefs';

let nextId = 1;
const live = new Map<number, { kind: 'bell' | 'scream'; at: LatLon }>();
let breathingId: number | null = null;
let ambientId: number | null = null;
let whisperTimer: ReturnType<typeof setTimeout> | null = null;
let rampTimer: ReturnType<typeof setInterval> | null = null;
let dramaTimer: ReturnType<typeof setTimeout> | null = null;
let dramaId: number | null = null;
/** Sound kinds loaded from real files (the rest are placeholders). */
export let realSounds: SoundKind[] = [];

export function buzz(pattern: number[]) { if (getPrefs().haptics) Betaal.vibrate(pattern); }

export function playPrivate(kind: SoundKind, gain = 1) {
  const id = nextId++;
  Betaal.play(id, kind, gain, SELF_SOUND.pan, SELF_SOUND.cutoffHz, false);
  return id;
}

/** Tutorial/settings demo: play a sound at a fixed pan / muffle. */
export function playDemo(kind: SoundKind, pan: number, cutoffHz = 20_000) {
  Betaal.play(nextId++, kind, 1, pan, cutoffHz, false);
}

function playSpatial(kind: 'bell' | 'scream', at: LatLon | undefined, self: boolean) {
  const { pos, heading, cfg } = get();
  if (self) return playPrivate(kind);
  if (!at || !pos) return Betaal.play(nextId++, kind, 0.4, 0, 20_000, false); // no GPS fix: quiet, centred
  const p = spatialize(pos, heading, at, kind, cfg);
  if (p.gain <= 0) return; // out of earshot
  const id = nextId++;
  live.set(id, { kind, at });
  Betaal.play(id, kind, p.gain, p.pan, p.cutoffHz, false);
}

/** After someone else's scream: the drama sting, timed with the "X has fallen" reveal. */
function scheduleDrama() {
  stopDrama();
  dramaTimer = setTimeout(() => { dramaTimer = null; if (get().phase === 'HUNT') dramaId = playPrivate('afterKillDrama', 0.9); }, FALLEN_DELAY_MS);
}
function stopDrama() {
  if (dramaTimer) clearTimeout(dramaTimer);
  if (dramaId !== null) Betaal.stopSound(dramaId);
  dramaTimer = dramaId = null;
}

function stopPossession() {
  if (breathingId !== null) Betaal.stopSound(breathingId);
  breathingId = null;
  if (whisperTimer) clearTimeout(whisperTimer);
  if (rampTimer) clearInterval(rampTimer);
  whisperTimer = rampTimer = null;
}

function startPossession(endsAt: number) {
  stopPossession();
  const { whisperLastMs } = get().cfg;
  // Buildup: the whisper plays once, at its natural length, as the last 15 s begin; breathing swells under it.
  // Breathing starts after your own bell, loops, and swells in the last 15 s.
  setTimeout(() => {
    if (!get().possessed) return;
    breathingId = nextId++;
    Betaal.play(breathingId, 'possessed_breathing', 0.6, 0, 20_000, true);
    rampTimer = setInterval(() => {
      const left = endsAt - serverNow();
      if (breathingId !== null && left < whisperLastMs) {
        Betaal.setParams(breathingId, 0.6 + 0.4 * (1 - Math.max(0, left) / whisperLastMs), 0, 20_000);
      }
    }, 250);
  }, 2500);
  whisperTimer = setTimeout(() => playPrivate('whisper'), Math.max(0, endsAt - whisperLastMs - serverNow()));
  buzz([0, 80, 120, 80, 120, 500]); // distinct "you are possessed" pattern
}

export async function initAudio() {
  try { realSounds = await Betaal.warmup(); } catch {}
  Betaal.addListener('onSoundEnd', e => live.delete(e.id));

  // Re-aim playing sounds as the listener turns / walks (30 Hz).
  setInterval(() => {
    const { pos, heading, cfg } = get();
    if (!pos) return;
    for (const [id, s] of live) {
      const p = spatialize(pos, heading, s.at, s.kind, cfg);
      Betaal.setParams(id, p.gain, p.pan, p.cutoffHz);
    }
  }, 33);

  onMessage(m => {
    switch (m.t) {
      case 'event':
        playSpatial(m.kind, m.at, m.self);
        if (m.kind === 'scream' && !m.self) scheduleDrama();
        break;
      case 'possessed': startPossession(m.endsAt); break;
      case 'released': stopPossession(); break;
      case 'state':
        // ambient bed only while hunting
        if (m.phase === 'HUNT' && ambientId === null) { ambientId = nextId++; Betaal.play(ambientId, 'ambient', 0.25, 0, 20_000, true); }
        if (m.phase !== 'HUNT' && ambientId !== null) { Betaal.stopSound(ambientId); ambientId = null; }
        // the host's own death never sends 'released' (they're dead), so stop on death too
        if (m.phase !== 'HUNT' || !m.players.find(p => p.id === get().me?.id)?.alive) stopPossession();
        break;
      case 'end':
        stopPossession(); stopDrama(); // the win sting replaces the drama when a kill ends the game
        playPrivate(m.result.kind === 'players' ? 'win_players' : m.result.kind === 'divya' ? 'win_divya' : 'win_ghost');
        buzz([0, 300]);
        break;
      case 'left': stopPossession(); stopDrama(); break;
    }
  });
}
