import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatBytes,
  percentUsed,
  statusFromHeartbeat,
  type AgentSummary,
  type SpaceOverview,
} from '@netlink/contracts';
import { Alert, Card, EmptyState, Screen, StatusDot } from '../components/primitives';
import { Gauge } from '../components/Gauge';
import { colors, fontSize, radius, space } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api, useSession } from '../state/session';
import { useSpace } from '../state/space';
import { SHOW_DATA_POOL } from '../lib/config';

/**
 * Home.
 *
 * The desktop dashboard is a map you scan; a phone is something people pull out
 * to check one thing and act on it. So this is a short column of answers —
 * how much data is left, what is reachable, whether anything needs attention —
 * each one a way into the tab that handles it.
 *
 * The summary comes from the overview endpoint, which computes it in one read.
 * Assembling it here from four requests would let the cards disagree with each
 * other while the slowest was still arriving.
 */
export function HomeScreen({
  onOpenTab,
}: {
  onOpenTab: (tab: 'data' | 'remote' | 'settings') => void;
}) {
  const { session } = useSession();
  const { spaces, active, select, loading, error: spaceError, reload } = useSpace();
  const [overview, setOverview] = useState<SpaceOverview | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!active) {
      setOverview(null);
      setAgents([]);
      return;
    }
    try {
      const [summary, agentList] = await Promise.all([
        api.overview(active.id),
        api.listAgents(active.id),
      ]);
      setOverview(summary);
      setAgents(agentList);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this Space.');
    }
  }, [active]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Screen>
        <Card>
          <Text style={styles.body}>Loading…</Text>
        </Card>
      </Screen>
    );
  }

  const online = agents.filter(
    (agent) => statusFromHeartbeat(agent.lastHeartbeatAt) === 'online',
  ).length;
  const failing = overview?.health.signals.filter((signal) => !signal.ok) ?? [];
  const data = overview?.data ?? null;
  const remaining = data ? BigInt(data.remainingBytes) : null;

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
              void Promise.all([reload(), load()]).finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <View style={styles.greeting}>
          <Text style={styles.greetingLine}>{timeOfDay()},</Text>
          <Text style={styles.greetingName}>{session?.user.name.split(' ')[0] ?? 'there'}</Text>
        </View>

        {(error || spaceError) && <Alert tone="danger">{error ?? spaceError}</Alert>}

        {spaces.length === 0 ? (
          <Card>
            <EmptyState
              title="No Spaces yet"
              description="A Space is created on your computer, from the NetLink window there. It will appear here as soon as it exists."
            />
          </Card>
        ) : (
          <>
            {spaces.length > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.chips}>
                  {spaces.map((entry) => (
                    <Pressable
                      key={entry.id}
                      onPress={() => select(entry.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: entry.id === active?.id }}
                      style={[styles.chip, entry.id === active?.id && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, entry.id === active?.id && styles.chipTextOn]}>
                        {entry.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            )}

            <View style={styles.pair}>
              {SHOW_DATA_POOL && (
                <Pressable
                  style={styles.tile}
                  accessibilityRole="button"
                  accessibilityLabel={
                    remaining === null
                      ? 'Data Pool, no account connected'
                      : `Data Pool, ${formatBytes(data!.remainingBytes)} remaining`
                  }
                  onPress={() => onOpenTab('data')}
                >
                  <Text style={styles.tileTitle}>Data Pool</Text>
                  {data ? (
                    <Gauge
                      percent={100 - percentUsed(data.balanceBytes, data.usedBytes)}
                      value={splitAmount(data.remainingBytes).value}
                      unit={splitAmount(data.remainingBytes).unit}
                      caption="remaining"
                      size={120}
                      thickness={8}
                      accessibilityLabel={`${formatBytes(data.remainingBytes)} remaining of ${formatBytes(data.balanceBytes)}`}
                    />
                  ) : (
                    <Text style={styles.tileBody}>No account connected yet.</Text>
                  )}
                </Pressable>
              )}

              <Pressable
                style={styles.tile}
                accessibilityRole="button"
                accessibilityLabel={`Remote access, ${(overview?.folderCount ?? 0) + (overview?.printerCount ?? 0) + agents.length} resources`}
                onPress={() => onOpenTab('remote')}
              >
                <Text style={styles.tileTitle}>Remote access</Text>
                <Text style={styles.tileFigure}>
                  {agents.length + (overview?.folderCount ?? 0) + (overview?.printerCount ?? 0)}
                </Text>
                <Text style={styles.tileBody}>
                  resource
                  {agents.length + (overview?.folderCount ?? 0) + (overview?.printerCount ?? 0) ===
                  1
                    ? ''
                    : 's'}{' '}
                  in {active?.name ?? 'this Space'}
                </Text>
              </Pressable>
            </View>

            <Card
              title="Security status"
              subtitle={
                failing.length === 0 ? 'Every check on this Space passed.' : failing[0].detail
              }
              actions={
                <StatusDot
                  tone={failing.length === 0 ? 'online' : 'warning'}
                  label={failing.length === 0 ? 'Protected' : 'Needs attention'}
                />
              }
            >
              <Text style={styles.body}>
                Network health {overview ? `${overview.health.score} out of 100` : 'unknown'}.
                {failing.length > 1
                  ? ` ${failing.length} checks did not pass.`
                  : failing.length === 1
                    ? ' One check did not pass.'
                    : ''}
              </Text>
            </Card>

            <Card
              title="Computers"
              subtitle={
                agents.length === 0
                  ? 'No computers in this Space yet'
                  : `${online} of ${agents.length} online`
              }
              actions={
                <StatusDot
                  tone={online > 0 ? 'online' : 'offline'}
                  label={online > 0 ? 'Reachable' : 'Nothing online'}
                />
              }
            >
              {agents.map((agent) => {
                const isOnline = statusFromHeartbeat(agent.lastHeartbeatAt) === 'online';
                return (
                  <View key={agent.id} style={styles.row}>
                    <StatusDot
                      tone={isOnline ? 'online' : 'offline'}
                      label={isOnline ? 'Online' : 'Offline'}
                    />
                    <Text style={styles.rowName} numberOfLines={1}>
                      {agent.name}
                    </Text>
                  </View>
                );
              })}
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function timeOfDay(now: Date = new Date()): string {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Splits `64.8 GB` into figure and unit, as the desktop gauge does. */
export function splitAmount(bytes: string | number): { value: string; unit: string } {
  const formatted = formatBytes(bytes);
  const index = formatted.lastIndexOf(' ');
  return index === -1
    ? { value: formatted, unit: '' }
    : { value: formatted.slice(0, index), unit: formatted.slice(index + 1) };
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  greeting: { gap: 2 },
  greetingLine: { color: colors.textSecondary, fontSize: fontSize.lg },
  greetingName: { color: colors.text, fontSize: 28, fontWeight: '700' },
  chips: { flexDirection: 'row', gap: space[2] },
  chip: {
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { color: colors.textSecondary, fontSize: fontSize.sm },
  chipTextOn: { color: colors.text, fontWeight: '600' },
  pair: { flexDirection: 'row', gap: space[3] },
  tile: {
    flex: 1,
    gap: space[2],
    padding: space[4],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  tileTitle: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: '600',
    alignSelf: 'stretch',
  },
  tileFigure: { color: colors.text, fontSize: 34, fontWeight: '700' },
  tileBody: { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center' },
  body: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingVertical: space[2] },
  rowName: { color: colors.text, fontSize: fontSize.base, flex: 1 },
});
