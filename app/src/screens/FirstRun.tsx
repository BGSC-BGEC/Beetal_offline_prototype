import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Btn, C, P, Screen, Title } from '../theme';
import { inputStyle } from './common';

/** First launch: who are you? Then permissions + tutorial. */
export function FirstRun({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Screen style={{ justifyContent: 'space-between' }}>
      <View style={{ marginTop: 40, alignItems: 'center' }}>
        <Title size={76}>बेताल</Title>
        <Title size={22} color={C.text} style={{ letterSpacing: 8, marginTop: -6 }}>BETAAL</Title>
        <P dim style={{ marginTop: 18, textAlign: 'center' }}>One of you carries the Ghost.{'\n'}Kill, or be killed.</P>
      </View>
      <View>
        <P style={{ marginBottom: 8 }}>What should the others call you?</P>
        <TextInput
          style={inputStyle} value={name} onChangeText={setName} maxLength={16} placeholder="Your name"
          placeholderTextColor={C.dim} returnKeyType="done" onSubmitEditing={() => name.trim() && onDone(name.trim())}
        />
        <Btn title="Continue" disabled={!name.trim()} onPress={() => onDone(name.trim())} style={{ marginTop: 12 }} />
      </View>
    </Screen>
  );
}
