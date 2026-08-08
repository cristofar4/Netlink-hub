import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ChallengeResponse } from '@netlink/contracts';
import { Alert, Button, Card, Screen } from '../components/primitives';
import { colors, fontSize, radius, space, touchTarget } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api } from '../state/session';

/**
 * Creating an account, confirming it, and signing in from this phone.
 *
 * The flow is the same as the desktop's, because it has to be: the same
 * six-digit codes, the same masked email, the same explicit "trust this
 * device". What differs is only the shape — a phone keyboard covers half the
 * screen, so every step is one field and one button rather than a form.
 */

type Stage =
  | { name: 'welcome' }
  | { name: 'register' }
  | { name: 'verify-email'; challenge: ChallengeResponse }
  | { name: 'sign-in' }
  | { name: 'verify-device'; challenge: ChallengeResponse };

export function AuthFlow() {
  const [stage, setStage] = useState<Stage>({ name: 'welcome' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.wordmark}>NetLink</Text>
            <Text style={styles.tagline}>
              Reach your own computers, the files you choose, and the printer at home.
            </Text>
          </View>

          {error && <Alert tone="danger">{error}</Alert>}

          {stage.name === 'welcome' && (
            <Card>
              <Text style={styles.body}>
                You will need your own NetLink account. If somebody invited you, sign in with your
                own account — nobody ever shares a password.
              </Text>
              <Button label="Create an account" onPress={() => setStage({ name: 'register' })} />
              <Button
                label="I already have one"
                variant="secondary"
                onPress={() => setStage({ name: 'sign-in' })}
              />
            </Card>
          )}

          {stage.name === 'register' && (
            <Card title="Create your account">
              <Field label="Your name" value={name} onChange={setName} autoComplete="name" />
              <Field
                label="Email"
                value={email}
                onChange={setEmail}
                keyboardType="email-address"
                autoComplete="email"
              />
              <Field
                label="Password"
                value={password}
                onChange={setPassword}
                secure
                autoComplete="new-password"
                hint="At least 12 characters, with upper case, lower case and a digit."
              />
              <Button
                label="Create account"
                loading={busy}
                onPress={() =>
                  void run(async () => {
                    const challenge = await api.register({ name, email, password });
                    setCode('');
                    setStage({ name: 'verify-email', challenge });
                  })
                }
              />
              <Button label="Back" variant="ghost" onPress={() => setStage({ name: 'welcome' })} />
            </Card>
          )}

          {stage.name === 'verify-email' && (
            <Card
              title="Confirm your email"
              subtitle={`We sent a six-digit code to ${stage.challenge.maskedEmail}.`}
            >
              <CodeField value={code} onChange={setCode} />
              <Button
                label="Confirm"
                loading={busy}
                disabled={code.length !== 6}
                onPress={() =>
                  void run(async () => {
                    await api.verifyEmail(stage.challenge.challengeId, code);
                    setCode('');
                    setStage({ name: 'sign-in' });
                  })
                }
              />
              <Button
                label="Send it again"
                variant="ghost"
                onPress={() =>
                  void run(async () => {
                    const challenge = await api.resendCode(stage.challenge.challengeId);
                    setStage({ name: 'verify-email', challenge });
                  })
                }
              />
            </Card>
          )}

          {stage.name === 'sign-in' && (
            <Card title="Sign in">
              <Field
                label="Email"
                value={email}
                onChange={setEmail}
                keyboardType="email-address"
                autoComplete="email"
              />
              <Field
                label="Password"
                value={password}
                onChange={setPassword}
                secure
                autoComplete="current-password"
              />
              <Button
                label="Sign in"
                loading={busy}
                onPress={() =>
                  void run(async () => {
                    const result = await api.login(email, password);
                    if (result.status === 'challenge_required') {
                      setCode('');
                      setStage({ name: 'verify-device', challenge: result.challenge });
                    }
                    // On success the session provider picks it up and this
                    // screen is replaced — nothing to do here.
                  })
                }
              />
              <Button label="Back" variant="ghost" onPress={() => setStage({ name: 'welcome' })} />
            </Card>
          )}

          {stage.name === 'verify-device' && (
            <Card
              title="Is this you?"
              subtitle={`This phone has not been used with your account before, so we sent a code to ${stage.challenge.maskedEmail}.`}
            >
              <CodeField value={code} onChange={setCode} />

              <Button
                label={trustDevice ? '✓  Trust this phone' : 'Trust this phone'}
                variant="secondary"
                onPress={() => setTrustDevice((value) => !value)}
                accessibilityHint="Trusted devices are not asked for a code every time. You can revoke this phone later from any of your devices."
              />
              <Text style={styles.hint}>
                {trustDevice
                  ? 'You will not be asked for a code on this phone again. You can revoke it at any time.'
                  : 'You will be asked for a code every time you sign in on this phone.'}
              </Text>

              <Button
                label="Confirm"
                loading={busy}
                disabled={code.length !== 6}
                onPress={() =>
                  void run(async () => {
                    await api.verifyDevice(stage.challenge.challengeId, code, trustDevice);
                  })
                }
              />
            </Card>
          )}
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  hint,
  keyboardType,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  hint?: string;
  keyboardType?: 'default' | 'email-address';
  autoComplete?: 'name' | 'email' | 'new-password' | 'current-password';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'sentences'}
        autoCorrect={false}
        placeholderTextColor={colors.textMuted}
        accessibilityLabel={label}
      />
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

/**
 * The six-digit code.
 *
 * One field rather than six boxes. Six separate inputs look neat and are
 * miserable on a phone: they fight the keyboard, they break paste, and they
 * defeat the SMS/email autofill that Android offers for exactly this.
 */
function CodeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <View style={styles.field}>
      <TextInput
        style={[styles.input, styles.codeInput]}
        value={value}
        onChangeText={(next) => onChange(next.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus
        accessibilityLabel="Six-digit code"
        placeholder="000000"
        placeholderTextColor={colors.textMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { gap: space[4], paddingBottom: space[10] },
  brand: { gap: space[2], paddingTop: space[10], paddingBottom: space[4] },
  wordmark: { color: colors.text, fontSize: fontSize['3xl'], fontWeight: '700' },
  tagline: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  body: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  field: { gap: space[2] },
  fieldLabel: { color: colors.textSecondary, fontSize: fontSize.sm },
  input: {
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.base,
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    paddingHorizontal: space[4],
    fontSize: fontSize.base,
  },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 10,
    fontSize: fontSize['2xl'],
  },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18 },
});
