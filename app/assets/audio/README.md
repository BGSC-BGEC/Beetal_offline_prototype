# Game audio

Drop sound files here, named exactly by kind (any of .wav .mp3 .ogg .m4a). Rebuild the APK after adding.
Missing files fall back to built-in placeholder sounds. Leading/trailing silence is trimmed automatically.

| file name (no extension) | plays when | notes |
|---|---|---|
| possessed_breathing | whole possession, only the possessed player hears it | seamless loop, 10-30 s |
| bell | Ghost moves to a new host (spatial, everyone) | 3-4 s |
| scream | someone dies (spatial, everyone) | 2-8 s |
| afterKillDrama | 2.5 s after a scream, with the "X has fallen" reveal (everyone except the victim) | 4-9 s |
| whisper | once, as the last 15 s of possession begin (possessed only); breathing swells under it | 2-4 s |
| win_players | Ghost destroyed | 2-4 s |
| win_ghost | Ghost wins | 3-6 s |
| win_divya | Divya Vijaya | 3-5 s |
| hit | your stab landed | < 0.5 s |
| miss | your stab missed | < 0.5 s |
| deny | stab on cooldown | < 0.5 s |
| ambient | optional low drone under the hunt, everyone | 30-60 s seamless loop |

Mono preferred (stereo is mixed down; sounds are positioned in space by the game).
