// Every tunable number for the physical prototype. Server owns the live copy;
// the GM page can patch it at runtime and the server pushes it to phones on join.
// Distances in metres, times in ms, RSSI in dBm.

export const DEFAULT_CFG = {
  possessionMs: 120_000,   // GDD 4.2, host-configurable 60k..300k
  whisperLastMs: 15_000,   // rising whisper starts this long before expiry
  immunityMs: 10_000,      // GDD 4.4
  cooldownMs: 3_000,       // GDD 6.4
  killWindowMs: 150,       // concurrent-kill window (GDD said 50-100, widened for mobile jitter)
  pingMs: 5_000,           // how long the transfer snapshot stays on the map
  stories: 25,             // Appendix A tale count, storyId = 0..stories-1

  uwb: {
    killR: { vikram: 1.5, ghost: 1.0 },
    coneDeg: 45,           // |azimuth| limit; AoA only valid within ~±60° of the phone back
    freshMs: 300,          // reading older than this = fall back to BLE for that pair
    reverseSlackM: 0.5,    // victim's own reading of attacker may be this much further
  },

  ble: {
    A1: -58,               // corrected RSSI at 1 m — TUNE ONCE at studio with real phones
    n: 2.0,                // path-loss exponent, open outdoor ground
    killR: { vikram: 1.5, ghost: 0.75 },
    ambiguityDb: 3,        // strongest peer must beat 2nd by this, else "too crowded"
    windowMs: 1000,        // median window
    staleMs: 1500,         // no packet for this long = peer unknown
    reverseSlackDb: 6,     // victim's reading of attacker may be this much weaker than threshold
  },

  gpsSanitySlackM: 5,      // reject kill if GPS distance > R + accA + accB + this

  swing: { peak: 12, dominance: 2, windowMs: 250 },

  audio: {
    // Huddling hides the Ghost: inside blindM a sound is centred, unmuffled and at full volume for
    // everyone, so a group can't tell which of them it came from. Direction fades in from blindM to
    // dirFullM. To find the source you must be away from it when it rings.
    bell:   { refM: 12, hearM: 40, maxM: 55 },
    scream: { refM: 12, hearM: 45, maxM: 60 },
    blindM: 12,            // centred below max(this, combined GPS acc); keep = refM so volume gives nothing away
    dirFullM: 30,          // full left/right/behind precision from here out
    bellBlurM: 6,          // bell source moved up to this far at random: points at a cluster, not a person
    behindHz: 3000,        // low-pass cutoff when source is fully behind
  },
};

export type Cfg = typeof DEFAULT_CFG;
export type Role = 'vikram' | 'ghost';
