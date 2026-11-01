import { ScrollView, Text, View } from 'react-native';
import type { HistoryEntry } from '../../../shared/protocol.ts';
import { amOwner, host, leaveRoom, nameOf, useStore } from '../store';
import { Btn, C, Card, P, Screen, Title } from '../theme';
import { fmtTime } from './common';

function line(h: HistoryEntry): { text: string; color: string } {
  switch (h.kind) {
    case 'possessed': return { text: `Betaal took ${nameOf(h.id)}`, color: C.gold };
    case 'task': return { text: 'A task set was completed', color: C.blue };
    case 'kill':
      if (h.cause === 'timer') return { text: `${nameOf(h.victim)}'s breath ran out`, color: C.red };
      if (h.cause === 'left') return { text: `${nameOf(h.victim)} left the ground`, color: C.dim };
      return { text: `${nameOf(h.by)} struck down ${nameOf(h.victim)}`, color: C.text };
  }
}

export function Results() {
  const s = useStore();
  const r = s.result!;
  const won = !!s.me && r.winners.includes(s.me.id);
  const headline = r.kind === 'players' ? 'The Ghost is destroyed' : r.kind === 'divya' ? 'दिव्य विजय' : 'Betaal wins';
  const sub = r.kind === 'players' ? `${nameOf(r.ghostHost)} carried Betaal to the end.`
    : r.kind === 'divya' ? 'Divya Vijaya — the Ghost found no one to take. All are saved.'
      : `${nameOf(r.ghostHost)} carried Betaal and takes everything.`;
  return (
    <Screen style={{ paddingBottom: 16 }}>
      <View style={{ alignItems: 'center' }}>
        <Title size={r.kind === 'divya' ? 44 : 36} color={r.kind === 'ghost' ? C.red : C.gold} style={{ textAlign: 'center', alignSelf: 'stretch' }}>{headline}</Title>
        <P style={{ textAlign: 'center' }}>{sub}</P>
        <Text style={{ color: won ? C.ok : C.dim, fontSize: 22, fontWeight: '800', marginTop: 12 }}>{won ? 'YOU WON' : 'YOU LOST'}</Text>
        <P dim style={{ textAlign: 'center', marginTop: 4 }}>Winners: {r.winners.map(nameOf).join(', ') || 'none'}</P>
      </View>

      <P dim style={{ marginTop: 20, marginBottom: 6 }}>WHAT REALLY HAPPENED</P>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6 }}>
        {s.history.map((h, i) => {
          const l = line(h);
          return (
            <Card key={i} style={{ flexDirection: 'row', gap: 12, paddingVertical: 10 }}>
              <Text style={{ color: C.dim, width: 42, fontVariant: ['tabular-nums'] }}>{fmtTime(h.at)}</Text>
              <Text style={{ color: l.color, flex: 1, fontSize: 15 }}>{l.text}</Text>
            </Card>
          );
        })}
      </ScrollView>

      {amOwner() ? <Btn title="Play again" onPress={() => host({ cmd: 'reset' })} /> : <P dim style={{ textAlign: 'center' }}>Waiting for the host to start another round…</P>}
      <Btn title="Leave" kind="ghost" onPress={leaveRoom} />
    </Screen>
  );
}
