import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { joinRoom, useStore } from '../store';
import { Btn, C, P, Screen, Title } from '../theme';
import { OnlineBadge } from './common';

export function Join({ back }: { back: () => void }) {
  const s = useStore();
  const [code, setCode] = useState('');
  const clean = (t: string) => t.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return (
    <Screen>
      <Pressable onPress={back}><P dim>‹ Back</P></Pressable>
      <Title size={34} style={{ marginTop: 16 }}>Join a game</Title>
      <P dim>Ask the host for the 4-letter code.</P>
      <View style={{ marginTop: 28 }}>
        {/* one hidden input drives four big letter boxes */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {[0, 1, 2, 3].map(i => (
            <View key={i} style={{ width: '22%', aspectRatio: 0.85, borderRadius: 14, borderWidth: 2, borderColor: code.length === i ? C.gold : C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.gold, fontSize: 40, fontWeight: '800' }}>{code[i] ?? ''}</Text>
            </View>
          ))}
        </View>
        <TextInput
          value={code} onChangeText={t => setCode(clean(t))} autoFocus autoCapitalize="characters" autoCorrect={false}
          maxLength={4} caretHidden style={{ position: 'absolute', inset: 0, opacity: 0.01, fontSize: 1 }}
          onSubmitEditing={() => code.length === 4 && joinRoom(code)}
        />
      </View>
      <Btn title="Join" disabled={code.length !== 4 || !s.online} busy={s.busy} onPress={() => joinRoom(code)} style={{ marginTop: 28 }} />
      <View style={{ alignItems: 'center', marginTop: 8 }}><OnlineBadge online={s.online} /></View>
    </Screen>
  );
}
