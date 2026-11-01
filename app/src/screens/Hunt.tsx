import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { amAlive, leaveRoom, myPlayer, serverNow, useStore } from '../store';
import { Radar } from '../Radar';
import { SkullIcon as Skull } from '../icons';
import { C, P, Title } from '../theme';

export function Hunt({ now }: { now: number }) {
  const s = useStore();
  const { width } = useWindowDimensions();
  const [peek, setPeek] = useState(false);
  const alive = amAlive();
  const me = myPlayer();
  const living = s.players.filter(p => p.alive).length;
  const gpsBad = !s.pos || s.pos.acc > 15;

  return (
    // Every phone shows the same screen; possession lives only in your ears. Hold to check yourself.
    <Pressable style={st.root} onLongPress={() => setPeek(true)} onPressOut={() => setPeek(false)} delayLongPress={350}>
      <View style={st.top}>
        <Chip text={`${living} alive`} />
        {me?.immune && <Chip text="PROTECTED" color={C.blue} />}
        <Chip text={s.pos ? `GPS ±${s.pos.acc.toFixed(0)} m` : 'No GPS'} color={gpsBad ? C.red : C.dim} />
      </View>
      {!s.compassOk && <P dim style={{ textAlign: 'center', color: C.gold }}>Wave your phone in a figure-8 to fix the compass</P>}

      <View style={{ flex: 1, justifyContent: 'center' }}>
        {s.pos ? <Radar s={s} size={width} now={now} immune={!!me?.immune} />
          : <P style={{ textAlign: 'center' }}>Waiting for GPS — stay outdoors, away from buildings…</P>}
      </View>

      {s.fallen && now >= s.fallen.from && now < s.fallen.until && alive && (
        <View style={st.banner} pointerEvents="none">
          <Skull size={46} />
          <Title size={34} color={C.red} style={{ marginTop: 6 }}>{s.fallen.name}</Title>
          <P style={{ fontSize: 17 }}>has fallen</P>
          <P dim style={{ marginTop: 4 }}>{s.fallen.left} remain</P>
        </View>
      )}

      <View style={st.bottom}>
        <P dim style={{ textAlign: 'center' }}>Hold the screen to check yourself · thrust to strike</P>
        <Pressable onPress={() => Alert.alert('Leave the game?', 'You will die and cannot rejoin this round.', [
          { text: 'Stay', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: leaveRoom }])}>
          <P dim style={{ textAlign: 'center', marginTop: 8, fontSize: 12 }}>leave</P>
        </Pressable>
      </View>

      {peek && alive && (
        <View style={st.peek}>
          {s.possessed ? (
            <>
              <Title size={30} color={C.red}>Betaal is in you</Title>
              <Text style={{ color: C.text, fontSize: 64, fontWeight: '900' }}>
                {Math.max(0, Math.ceil((s.possessed.endsAt - serverNow()) / 1000))}s
              </Text>
              <P style={{ textAlign: 'center' }}>Kill anyone before your breath runs out —{'\n'}or die and set them free.</P>
            </>
          ) : (
            <>
              <Title size={30}>You are yourself</Title>
              <P style={{ textAlign: 'center' }}>{me?.immune ? 'Protected for a few seconds.' : 'For now.'}</P>
            </>
          )}
        </View>
      )}

      {!alive && (
        <View style={st.dead}>
          <Title size={44} color={C.red}>You have fallen</Title>
          <P style={{ textAlign: 'center', marginTop: 8 }}>Leave the ground quietly. No talking, no hints.{'\n'}Results appear when the hunt ends.</P>
        </View>
      )}
    </Pressable>
  );
}

function Chip({ text, color = C.dim }: { text: string; color?: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 }}>{text}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: 48 },
  top: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 6 },
  bottom: { paddingBottom: 22, paddingHorizontal: 20 },
  banner: { position: 'absolute', bottom: 120, alignSelf: 'center', alignItems: 'center', backgroundColor: '#0b0a0ce6', borderColor: '#d4442e66', borderWidth: 1, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 16 },
  peek: { ...StyleSheet.absoluteFill, backgroundColor: '#0b0a0cf2', alignItems: 'center', justifyContent: 'center', padding: 28 },
  dead: { ...StyleSheet.absoluteFill, backgroundColor: '#1a0606f0', alignItems: 'center', justifyContent: 'center', padding: 28 },
});
