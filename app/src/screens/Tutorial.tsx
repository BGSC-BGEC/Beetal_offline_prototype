// GDD §10.8 tutorial: stance, strike, listen, rules. Mandatory on first launch, skippable after.
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Polygon, Text as SvgText } from 'react-native-svg';
import { useStore } from '../store';
import { forwardAccel, onStab } from '../radio';
import { buzz, playDemo, playPrivate } from '../audio';
import { wrap180 } from '../../../shared/math.ts';
import { DEFAULT_CFG } from '../../../shared/config.ts';
import { Btn, C, Card, P, Screen, Title } from '../theme';

const STEPS = ['Stance', 'Strike', 'Listen', 'Rules'] as const;

/** True after `ms` — lets players past a step if their phone's sensor misbehaves. */
function useElapsed(ms: number) {
  const [done, setDone] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDone(true), ms); return () => clearTimeout(t); }, [ms]);
  return done;
}

export function Tutorial({ canSkip, onDone }: { canSkip: boolean; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : onDone());
  return (
    <Screen style={{ paddingBottom: 16 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {STEPS.map((s, i) => <View key={s} style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: i <= step ? C.gold : C.line }} />)}
        </View>
        {canSkip && <Pressable onPress={onDone}><P dim>Skip</P></Pressable>}
      </View>
      <View style={{ flex: 1, marginTop: 18 }}>
        {step === 0 && <Stance onOk={next} />}
        {step === 1 && <Strike onOk={next} />}
        {step === 2 && <Listen onOk={next} />}
        {step === 3 && <Rules onOk={next} />}
      </View>
    </Screen>
  );
}

// ---------- 1. stance: hold upright, turn a full circle (proves the compass works) ----------
function Stance({ onOk }: { onOk: () => void }) {
  const s = useStore();
  const last = useRef<number | null>(null);
  const [turned, setTurned] = useState(0);
  useEffect(() => {
    if (last.current !== null) setTurned(t => Math.min(360, t + Math.abs(wrap180(s.heading - last.current!))));
    last.current = s.heading;
  }, [s.heading]);
  const done = turned >= 330;
  const stuck = useElapsed(20_000);
  const size = 220, c = size / 2;
  return (
    <View style={{ flex: 1 }}>
      <Title size={34}>Stance</Title>
      <P>Hold your phone upright in front of your chest, screen facing you, camera pointing forward — like you're filming. The camera is your eyes and your blade.</P>
      <View style={{ alignItems: 'center', marginVertical: 18 }}>
        <Svg width={size} height={size}>
          <Circle cx={c} cy={c} r={c - 4} stroke={C.line} strokeWidth={2} fill={C.card} />
          <Circle cx={c} cy={c} r={c - 4} stroke={C.gold} strokeWidth={6} fill="none"
            strokeDasharray={`${(turned / 360) * 2 * Math.PI * (c - 4)} 9999`} rotation={-90} origin={`${c}, ${c}`} />
          <G rotation={-s.heading} origin={`${c}, ${c}`}>
            <SvgText x={c} y={30} fill={C.red} fontSize={18} fontWeight="bold" textAnchor="middle">N</SvgText>
          </G>
          <Polygon points={`${c},${c - 40} ${c - 14},${c + 16} ${c},${c + 6} ${c + 14},${c + 16}`} fill={C.gold} />
        </Svg>
        <P dim>{done ? 'Compass works.' : `Now turn slowly on the spot, one full circle (${Math.round(turned)}°)`}</P>
        {!s.compassOk && <P style={{ color: C.gold, textAlign: 'center' }}>Compass needs calibrating — wave the phone in a figure-8.</P>}
      </View>
      <Btn title={done ? 'Next' : 'Turn a full circle first'} disabled={!done} onPress={onOk} />
      {!done && stuck && <Btn title="Compass not responding? Continue anyway" kind="ghost" onPress={onOk} />}
    </View>
  );
}

// ---------- 2. strike: three detected stabs, live thrust meter ----------
function Strike({ onOk }: { onOk: () => void }) {
  const [hits, setHits] = useState(0);
  const [meter, setMeter] = useState(0);
  useEffect(() => {
    const off = onStab(() => { setHits(h => h + 1); playPrivate('hit'); buzz([0, 120]); });
    const t = setInterval(() => setMeter(m => Math.max(forwardAccel, m * 0.85)), 50);
    return () => { off(); clearInterval(t); };
  }, []);
  const peak = DEFAULT_CFG.swing.peak;
  const stuck = useElapsed(30_000);
  const pct = Math.min(1, meter / (peak * 1.5));
  return (
    <View style={{ flex: 1 }}>
      <Title size={34}>Strike</Title>
      <P>To kill, get within arm's reach of someone and thrust your phone sharply forward at them — a short, fast stab. Waving or walking won't trigger it.</P>
      <Card style={{ marginTop: 20 }}>
        <P dim>Thrust</P>
        <View style={{ height: 22, backgroundColor: C.bg, borderRadius: 11, overflow: 'hidden', marginTop: 6 }}>
          <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: meter >= peak ? C.red : C.gold }} />
          <View style={{ position: 'absolute', left: `${(1 / 1.5) * 100}%`, top: 0, bottom: 0, width: 2, backgroundColor: C.text }} />
        </View>
        <P dim style={{ marginTop: 6 }}>Cross the white line, fast.</P>
      </Card>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginVertical: 26 }}>
        {[0, 1, 2].map(i => (
          <View key={i} style={{ width: 54, height: 54, borderRadius: 27, borderWidth: 2, borderColor: i < hits ? C.red : C.line, backgroundColor: i < hits ? '#3a0f0a' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: C.red, fontSize: 22, fontWeight: '900' }}>{i < hits ? '✕' : ''}</Text>
          </View>
        ))}
      </View>
      <P dim style={{ textAlign: 'center' }}>In a game: a 3-second cooldown after every strike. The Ghost must get even closer.</P>
      <View style={{ flex: 1 }} />
      <Btn title={hits >= 3 ? 'Next' : `Land ${3 - hits} more stab${3 - hits === 1 ? '' : 's'}`} disabled={hits < 3} onPress={onOk} />
      {hits < 3 && stuck && <Btn title="Can't trigger it? Continue anyway" kind="ghost" onPress={onOk} />}
    </View>
  );
}

// ---------- 3. listen: earphone check + every sound and what it means ----------
function Listen({ onOk }: { onOk: () => void }) {
  const rows: { label: string; hint: string; play: () => void }[] = [
    { label: 'Bell — on your LEFT', hint: 'Should be in your left ear only.', play: () => playDemo('bell', -1) },
    { label: 'Bell — on your RIGHT', hint: 'Right ear only. If swapped, flip your earphones.', play: () => playDemo('bell', 1) },
    { label: 'Bell — BEHIND you', hint: 'Behind sounds muffled. Turn your phone to find where a sound came from.', play: () => playDemo('bell', 0, 3000) },
    { label: 'Scream', hint: 'Someone just died — where it came from is where they fell.', play: () => playDemo('scream', 0.5) },
    { label: 'After a death', hint: 'Plays as the fallen player’s name appears on everyone’s screen.', play: () => playPrivate('afterKillDrama') },
    { label: 'Breathing', hint: 'Only YOU hear this: Betaal is inside you. Kill before it stops.', play: () => playPrivate('possessed_breathing') },
    { label: 'Whisper', hint: 'Only you: your last 15 seconds as the host have begun.', play: () => playPrivate('whisper') },
    { label: 'Ghost destroyed', hint: 'The players won.', play: () => playPrivate('win_players') },
    { label: 'Betaal wins', hint: 'The Ghost reached the final two.', play: () => playPrivate('win_ghost') },
  ];
  return (
    <View style={{ flex: 1 }}>
      <Title size={34}>Listen</Title>
      <P>Put your earphones in. Sound is everything in this game — there is no other sign of the Ghost.</P>
      <ScrollView style={{ flex: 1, marginTop: 12 }} contentContainerStyle={{ gap: 8 }}>
        {rows.map(r => (
          <Pressable key={r.label} onPress={r.play}>
            {({ pressed }) => (
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.7 : 1 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#120d06', fontSize: 18, fontWeight: '900' }}>▶</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.text, fontSize: 16, fontWeight: '700' }}>{r.label}</Text>
                  <Text style={{ color: C.dim, fontSize: 13 }}>{r.hint}</Text>
                </View>
              </Card>
            )}
          </Pressable>
        ))}
      </ScrollView>
      <Btn title="Next" onPress={onOk} />
    </View>
  );
}

// ---------- 4. rules ----------
const CARDS: { title: string; body: string }[] = [
  { title: 'One of you carries Betaal', body: 'The Ghost possesses one player at a time. Nobody can see who — not on the map, not on the screen. Every phone looks the same.' },
  { title: 'Listen for it', body: 'A bell rings where the Ghost enters someone. A scream rings where someone dies. Both come from that direction in your earphones — turn to find them.' },
  { title: 'Kill, or be killed', body: 'If you hear breathing, Betaal is in you. Kill anyone before your time runs out and it moves on. Do nothing, and it kills you instead.' },
  { title: 'Every death moves the Ghost', body: 'After any death the Ghost jumps to a random living player. Kill the one carrying it and the Ghost is destroyed — every survivor wins.' },
  { title: 'Or the Ghost wins', body: 'If it comes down to two players, whoever carries Betaal at that moment takes everything. Choose your trust carefully.' },
  { title: 'The map flashes', body: 'Each time the Ghost moves, everyone’s position appears for 5 seconds. A pale wisp marks the one it just left. A blue ring means protected for 10 seconds.' },
  { title: 'Play fair', body: 'Stay inside the agreed ground. Keep the phone in your hand, upright. If you die, leave quietly and give no hints.' },
];

function Rules({ onOk }: { onOk: () => void }) {
  const [i, setI] = useState(0);
  const last = i === CARDS.length - 1;
  return (
    <View style={{ flex: 1 }}>
      <Title size={34}>The rules</Title>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Card style={{ padding: 26, minHeight: 280, justifyContent: 'center' }}>
          <P dim>{i + 1} / {CARDS.length}</P>
          <Title size={28} style={{ marginTop: 6 }}>{CARDS[i].title}</Title>
          <P style={{ fontSize: 18, lineHeight: 27, marginTop: 8 }}>{CARDS[i].body}</P>
        </Card>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn title="Back" kind="ghost" disabled={i === 0} onPress={() => setI(i - 1)} style={{ flex: 1 }} />
        <Btn title={last ? "I'm ready" : 'Next'} onPress={() => (last ? onOk() : setI(i + 1))} style={{ flex: 2 }} />
      </View>
    </View>
  );
}
