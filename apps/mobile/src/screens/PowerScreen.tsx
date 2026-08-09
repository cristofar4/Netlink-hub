import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  POWER_ACTION_LABELS,
  POWER_COUNTDOWN_SECONDS,
  isDestructivePowerAction,
  type AgentPowerState,
  type PowerAction,
} from '@netlink/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Screen,
  StatusDot,
} from '../components/primitives';
import { colors, fontSize, radius, space, touchTarget } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api } from '../state/session';
import { useSpace } from '../state/space';
import { useBrandName } from '../state/brand';

/**
 * Device Power and Wake.
 *
 * This is the reason most people will open NetLink on a phone: they are out,
 * and they want the computer at home to be on when they get back — or they
 * left it running and want it off.
 *
 * Every button says why it cannot be pressed. "Turn On is greyed out" is
 * useless; "no Wake Helper is online on that network" is something a person can
 * act on. Destructive actions ask for a six-digit code and then run a
 * ten-second countdown that anyone can stop — and the countdown is real: the
 * control plane withholds the command from the agent until it elapses.
 */
export function PowerScreen() {
  const brand = useBrandName();
  const { active, loading: spaceLoading } = useSpace();
  const [states, setStates] = useState<AgentPowerState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState<{ agentId: string; action: PowerAction } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!active) return;
    try {
      setStates(await api.powerState(active.id));
      setError(null);
    } catch (caught) {
      setStates([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load your computers.');
    }
  }, [active]);

  useEffect(() => {
    void load();
  }, [load]);

  // A command in its countdown changes state every second, so the view keeps up
  // while one is pending and stops polling the moment none is.
  const hasPending = states?.some((state) => state.pending) ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [hasPending, load]);

  if (spaceLoading || states === null) {
    return (
      <Screen>
        <Card>
          <Text style={styles.body}>Loading…</Text>
        </Card>
      </Screen>
    );
  }

  if (!active) {
    return (
      <Screen>
        <Card>
          <EmptyState
            title="No Space yet"
            description="Create a Space on your computer, then it will appear here."
          />
        </Card>
      </Screen>
    );
  }

  const send = async (
    agentId: string,
    action: PowerAction,
    confirmation?: { stepUpChallengeId: string; stepUpCode: string },
  ) => {
    setBusy(`${agentId}:${action}`);
    setError(null);
    setNotice(null);
    try {
      await api.sendPowerCommand(active.id, { action, targetAgentId: agentId, ...confirmation });
      setConfirming(null);
      setNotice(
        isDestructivePowerAction(action)
          ? `${POWER_ACTION_LABELS[action]} starts in ${POWER_COUNTDOWN_SECONDS} seconds. You can still stop it.`
          : `${POWER_ACTION_LABELS[action]} sent.`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That command was not accepted.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.cyan}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && !error && <Alert tone="success">{notice}</Alert>}

        {states.length === 0 && (
          <Card>
            <EmptyState
              title="No computers here yet"
              description={`Install the ${brand} agent on the computer you want to reach, then enrol it from the ${brand} window on that machine.`}
            />
          </Card>
        )}

        {states.map((state) => (
          <Card
            key={state.agentId}
            title={state.agentName}
            actions={
              <View style={styles.badges}>
                {state.isWakeHelper && <Badge tone="cyan">Wake Helper</Badge>}
                <StatusDot
                  tone={state.online ? 'online' : 'offline'}
                  label={state.online ? 'Online' : 'Offline'}
                />
              </View>
            }
          >
            {state.pending && (
              <Alert tone="warning">
                {POWER_ACTION_LABELS[state.pending.action as PowerAction]} is pending.
                {state.pending.cancellable ? ' You can still stop it.' : ''}
              </Alert>
            )}

            {state.actions.map((entry) => {
              const key = `${state.agentId}:${entry.action}`;
              return (
                <View key={entry.action} style={styles.action}>
                  <Button
                    label={POWER_ACTION_LABELS[entry.action]}
                    variant={
                      isDestructivePowerAction(entry.action)
                        ? 'danger'
                        : entry.action === 'power.wake'
                          ? 'primary'
                          : 'secondary'
                    }
                    disabled={!entry.allowed}
                    loading={busy === key}
                    accessibilityHint={entry.reason ?? undefined}
                    onPress={() => {
                      if (entry.requiresStepUp) {
                        setConfirming({ agentId: state.agentId, action: entry.action });
                      } else {
                        void send(state.agentId, entry.action);
                      }
                    }}
                  />
                  {/* The reason a button cannot be pressed is the useful part. */}
                  {entry.reason && <Text style={styles.reason}>{entry.reason}</Text>}
                </View>
              );
            })}

            {!state.online && state.wake.blockers.length > 0 && (
              <View style={styles.blockers}>
                <Text style={styles.blockersTitle}>Before this can be turned on:</Text>
                {state.wake.blockers.map((blocker) => (
                  <Text key={blocker} style={styles.reason}>
                    • {blocker}
                  </Text>
                ))}
              </View>
            )}
          </Card>
        ))}
      </ScrollView>

      {confirming && (
        <ConfirmSheet
          spaceId={active.id}
          action={confirming.action}
          onCancel={() => setConfirming(null)}
          onConfirmed={(confirmation) =>
            void send(confirming.agentId, confirming.action, confirmation)
          }
        />
      )}
    </Screen>
  );
}

/**
 * The six-digit confirmation before a restart or a shutdown.
 *
 * Holding the permission is not enough for something that interrupts whoever
 * is sitting at that machine.
 */
function ConfirmSheet({
  spaceId,
  action,
  onCancel,
  onConfirmed,
}: {
  spaceId: string;
  action: PowerAction;
  onCancel: () => void;
  onConfirmed: (confirmation: { stepUpChallengeId: string; stepUpCode: string }) => void;
}) {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedEmail, setMaskedEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const challenge = await api.requestPowerStepUp(spaceId, action);
        if (!active) return;
        setChallengeId(challenge.challengeId);
        setMaskedEmail(challenge.maskedEmail);
      } catch (caught) {
        if (active) {
          setError(caught instanceof ApiError ? caught.message : 'Could not send a code.');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [spaceId, action]);

  return (
    <View style={styles.sheet}>
      <Card title={POWER_ACTION_LABELS[action]}>
        <Text style={styles.body}>
          This interrupts whoever is using that computer, so we ask every time. Enter the code we
          sent to {maskedEmail || 'your email'}.
        </Text>

        {error && <Alert tone="danger">{error}</Alert>}

        <TextInput
          style={styles.codeInput}
          value={code}
          onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          accessibilityLabel="Six-digit confirmation code"
          placeholder="000000"
          placeholderTextColor={colors.textMuted}
        />

        <Button
          label="Confirm"
          variant="danger"
          disabled={code.length !== 6 || !challengeId}
          onPress={() => {
            if (challengeId) onConfirmed({ stepUpChallengeId: challengeId, stepUpCode: code });
          }}
        />
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  body: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  action: { gap: space[1] },
  reason: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18 },
  blockers: { gap: space[1], paddingTop: space[2] },
  blockersTitle: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  sheet: {
    position: 'absolute',
    left: space[4],
    right: space[4],
    bottom: space[4],
    top: space[10],
    justifyContent: 'flex-end',
  },
  codeInput: {
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.base,
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    textAlign: 'center',
    letterSpacing: 10,
    fontSize: fontSize['2xl'],
  },
});
