import { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { amOwner, host, leaveRoom, myPlayer, nameOf, setReady, useStore } from '../store';
import { calibrate } from '../radio';
import { Btn, C, Card, P, Screen, Title } from '../theme';
import { Avatar } from './common';

const TIMERS = [60, 90, 120, 180, 240, 300];

export function Lobby() {
  const s = useStore();
  const owner = amOwner();
  const me = myPlayer();
  const calibrating = s.phase === 'CALIBRATION';
  const n = s.players.length;
  const allReady = n > 0 && s.players.every(p => p.ready);
  const startBlock = n < 3 ? `Need ${3 - n} more player${3 - n > 1 ? 's' : ''}` : !allReady ? 'Waiting for everyone to be ready' : null;

  const confirmLeave = () =>
    Alert.alert('Leave this game?', owner ? 'Host controls will pass to another player.' : undefined, [
      { text: 'Stay', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: leaveRoom },
    ]);

  return (
    <Screen style={{ paddingBottom: 16 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Pressable onPress={confirmLeave}><P dim>‹ Leave</P></Pressable>
        <P dim>{calibrating ? 'Calibrating' : 'Lobby'}</P>
      </View>

      <Pressable onPress={() => Share.share({ message: `Join my Betaal game — code ${s.code}` })} style={{ alignItems: 'center', marginTop: 10 }}>
        <P dim>GAME CODE</P>
        <Text style={{ color: C.gold, fontSize: 64, fontWeight: '900', letterSpacing: 14 }}>{s.code}</Text>
        <P dim>Tap to share · others tap “Join game”</P>
      </Pressable>

      <ScrollView style={{ flex: 1, marginTop: 14 }} contentContainerStyle={{ gap: 8 }}>
        {s.players.map(p => (
          <Card key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
            <Avatar name={p.name} color={p.connected ? C.gold : C.dim} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.text, fontSize: 17, fontWeight: '600' }}>
                {p.name}{p.id === s.me?.id ? '  (you)' : ''}
              </Text>
              <Text style={{ color: C.dim, fontSize: 12 }}>
                {p.id === s.ownerId ? 'Host · ' : ''}{p.uwb ? 'UWB' : 'Bluetooth'}{!p.connected ? ' · reconnecting…' : ''}
              </Text>
            </View>
            {calibrating
              ? p.id === s.ownerId ? <Text style={{ color: C.dim }}>reference</Text>
                : <Text style={{ color: p.calibrated ? C.ok : C.dim, fontWeight: '700' }}>{p.calibrated ? '✓ done' : '…'}</Text>
              : <Text style={{ color: p.ready ? C.ok : C.dim, fontWeight: '700' }}>{p.ready ? '✓ READY' : 'not ready'}</Text>}
          </Card>
        ))}
      </ScrollView>

      {calibrating ? <Calibration owner={owner} hostName={nameOf(s.ownerId ?? undefined)} done={!!me?.calibrated} />
        : (
          <View>
            {owner && (
              <Card style={{ marginBottom: 8 }}>
                <P dim>Possession timer</P>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                  {TIMERS.map(t => (
                    <Pressable key={t} onPress={() => host({ cmd: 'setTimer', sec: t })}
                      style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: s.possessionSec === t ? C.gold : 'transparent', borderWidth: 1, borderColor: C.line }}>
                      <Text style={{ color: s.possessionSec === t ? '#120d06' : C.text, fontWeight: '700' }}>{t < 120 ? `${t}s` : `${t / 60}m`}</Text>
                    </Pressable>
                  ))}
                </View>
              </Card>
            )}
            {!owner && <P dim style={{ textAlign: 'center' }}>Possession timer: {s.possessionSec} s · host starts the game</P>}
            <Btn title={me?.ready ? 'Ready ✓  (tap to undo)' : "I'm ready"} kind={me?.ready ? 'ghost' : 'primary'} onPress={() => setReady(!me?.ready)} />
            {owner && (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Btn title="Calibrate radios" kind="ghost" onPress={() => host({ cmd: 'calibStart' })} style={{ flex: 1 }} />
                <Btn title="Start" kind="danger" disabled={!!startBlock} onPress={() => host({ cmd: 'start' })} style={{ flex: 1 }} />
              </View>
            )}
            {owner && startBlock && <P dim style={{ textAlign: 'center' }}>{startBlock}</P>}
          </View>
        )}
    </Screen>
  );
}

function Calibration({ owner, hostName, done }: { owner: boolean; hostName: string; done: boolean }) {
  const [left, setLeft] = useState(0);
  const [msg, setMsg] = useState('');
  if (owner) {
    return (
      <View>
        <P style={{ textAlign: 'center', marginBottom: 6 }}>Your phone is the reference. Hold it upright and stay still. Each player stands 1 step (1 m) in front of you and taps Measure.</P>
        <Btn title="Finish calibration" onPress={() => host({ cmd: 'calibFinish' })} />
      </View>
    );
  }
  return (
    <View>
      <P style={{ textAlign: 'center', marginBottom: 6 }}>
        Stand one step (1 m) in front of {hostName}. Both phones upright, cameras facing each other.
      </P>
      <Btn
        title={left ? `Hold still… ${left}` : done ? 'Measured ✓  (measure again)' : 'Measure (5 s)'}
        kind={done ? 'ghost' : 'primary'} busy={false} disabled={!!left}
        onPress={async () => { setMsg(''); const ok = await calibrate(setLeft); setMsg(ok ? '' : `Can't hear ${hostName}'s phone — check Bluetooth, move closer, retry.`); }}
      />
      {!!msg && <P dim style={{ textAlign: 'center', color: C.red }}>{msg}</P>}
    </View>
  );
}
