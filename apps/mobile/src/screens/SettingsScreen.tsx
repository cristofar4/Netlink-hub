import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AuthenticatedDevice } from '@netlink/contracts';
import { Alert, Badge, Button, Card, Screen, StatusDot } from '../components/primitives';
import { colors, fontSize, space } from '../theme/tokens';
import { API_URL, BUILD_KIND } from '../lib/config';
import { ApiError } from '../lib/api';
import { api, useSession } from '../state/session';

/**
 * Settings.
 *
 * Mostly a device list, because that is the control that matters: revoking a
 * lost phone is the thing somebody needs at speed, from whatever device they
 * still have. Revocation is immediate — the still-valid access token on that
 * device is refused the moment it happens.
 */
export function SettingsScreen() {
  const { session } = useSession();
  const [devices, setDevices] = useState<AuthenticatedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await api.devices());
      setError(null);
    } catch (caught) {
      setDevices([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load your devices.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.list}>
        {error && <Alert tone="danger">{error}</Alert>}

        <Card title={session?.user.name ?? 'Signed in'} subtitle={session?.user.email}>
          <Button
            label="Sign out"
            variant="secondary"
            onPress={() => void api.signOut()}
            accessibilityHint="Signs out on this phone only. Your other devices stay signed in."
          />
        </Card>

        <Card
          title="Your devices"
          subtitle="Revoking one ends its session immediately and leaves the others working."
        >
          {(devices ?? []).map((device) => {
            const isThisPhone = device.id === session?.device.id;
            return (
              <View key={device.id} style={styles.device}>
                <View style={styles.deviceText}>
                  <Text style={styles.deviceName}>
                    {device.name}
                    {isThisPhone ? '  (this phone)' : ''}
                  </Text>
                  <StatusDot
                    tone={device.revokedAt ? 'offline' : device.trusted ? 'online' : 'warning'}
                    label={
                      device.revokedAt
                        ? 'Revoked'
                        : device.trusted
                          ? 'Trusted'
                          : 'Not trusted — asks for a code each time'
                    }
                  />
                </View>

                {!device.revokedAt &&
                  (confirming === device.id ? (
                    <View style={styles.confirm}>
                      <Text style={styles.warn}>
                        {isThisPhone
                          ? 'This will sign this phone out and it will need verifying again.'
                          : 'That device will be signed out immediately.'}
                      </Text>
                      <Button
                        label="Revoke"
                        variant="danger"
                        loading={busy === device.id}
                        onPress={() =>
                          void (async () => {
                            setBusy(device.id);
                            try {
                              await api.revokeDevice(device.id);
                              // Revoking this phone ends this session, so there
                              // is nothing left to reload into.
                              if (isThisPhone) await api.signOutLocally();
                              else await load();
                            } catch (caught) {
                              setError(
                                caught instanceof ApiError
                                  ? caught.message
                                  : 'That device was not revoked.',
                              );
                            } finally {
                              setBusy(null);
                              setConfirming(null);
                            }
                          })()
                        }
                      />
                      <Button label="Keep it" variant="ghost" onPress={() => setConfirming(null)} />
                    </View>
                  ) : (
                    <Button
                      label="Revoke"
                      variant="ghost"
                      onPress={() => setConfirming(device.id)}
                    />
                  ))}
              </View>
            );
          })}
        </Card>

        <Card title="About this build">
          <View style={styles.aboutRow}>
            <Text style={styles.aboutKey}>Build</Text>
            <Badge tone={BUILD_KIND === 'release' ? 'neutral' : 'warning'}>{BUILD_KIND}</Badge>
          </View>
          <Text style={styles.about}>Connects to {API_URL}</Text>
          <Text style={styles.about}>
            NetLink never stores your password, your files, or anything on your screen. Files and
            remote sessions go directly between your own devices.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  device: { gap: space[2], paddingVertical: space[2] },
  deviceText: { gap: space[1] },
  deviceName: { color: colors.text, fontSize: fontSize.base },
  confirm: { gap: space[2] },
  warn: { color: colors.warning, fontSize: fontSize.xs, lineHeight: 18 },
  aboutRow: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  aboutKey: { color: colors.textSecondary, fontSize: fontSize.sm },
  about: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18 },
});
