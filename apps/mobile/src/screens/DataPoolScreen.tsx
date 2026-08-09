import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatBytes,
  percentUsed,
  projectDaysRemaining,
  remainingBytes,
  type DataPoolSummary,
  type DataUsageSeries,
  type MemberAccessRow,
  type MyAllocation,
} from '@netlink/contracts';
import { Alert, Card, EmptyState, Screen, StatusDot } from '../components/primitives';
import { Gauge, type GaugeTone } from '../components/Gauge';
import { colors, fontSize, radius, space } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api } from '../state/session';
import { useSpace } from '../state/space';
import { useBrandName } from '../state/brand';
import { splitAmount } from './HomeScreen';

/**
 * The Data Pool on a phone.
 *
 * Read-only by design. Handing out an allocation means choosing an amount, a
 * daily cap, an expiry and a set of permissions — a form that belongs on the
 * screen where somebody is sitting down to think about it. What a phone is
 * good for is the question people actually ask on the move: how much is left,
 * and who is spending it.
 */
export function DataPoolScreen() {
  const brand = useBrandName();
  const { active } = useSpace();
  const [pool, setPool] = useState<DataPoolSummary | null>(null);
  const [mine, setMine] = useState<MyAllocation | null>(null);
  const [members, setMembers] = useState<MemberAccessRow[]>([]);
  const [usage, setUsage] = useState<DataUsageSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!active) return;
    try {
      const summary = await api.dataPool(active.id);
      setPool(summary);
      setMine(null);
      setMembers(await api.members(active.id).catch(() => []));
    } catch (poolError) {
      setPool(null);
      try {
        setMine(await api.myAllocation(active.id));
        setError(null);
      } catch {
        setMine(null);
        // A Space with no pool is not an error worth shouting about; only a
        // genuine failure to reach the server is.
        if (poolError instanceof ApiError && poolError.status >= 500) {
          setError(poolError.message);
        }
      }
    } finally {
      setUsage(await api.dataUsage(active.id).catch(() => null));
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!active) {
    return (
      <Screen>
        <Card>
          <EmptyState title="No Space selected" description="Choose a Space on the Home tab." />
        </Card>
      </Screen>
    );
  }

  if (loading) {
    return (
      <Screen>
        <Card>
          <Text style={styles.body}>Loading the Data Pool…</Text>
        </Card>
      </Screen>
    );
  }

  const owner = pool !== null;
  const total = owner ? pool.balanceBytes : (mine?.allocatedBytes ?? '0');
  const used = owner ? pool.usedBytes : (mine?.usedBytes ?? '0');
  const left = owner
    ? remainingBytes(pool.balanceBytes, pool.usedBytes)
    : (mine?.remainingBytes ?? '0');
  const leftPercent = 100 - percentUsed(total, used);
  const days = usage ? projectDaysRemaining(left, usage.dailyAverageBytes) : null;

  const refresh = (
    <RefreshControl
      refreshing={refreshing}
      tintColor={colors.cyan}
      onRefresh={() => {
        setRefreshing(true);
        void load().finally(() => setRefreshing(false));
      }}
    />
  );

  if (!owner && !mine) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.list} refreshControl={refresh}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Card>
            <EmptyState
              title="No data shared with you"
              description={`Nobody has given you an allowance in this Space, and you do not manage its pool. Connect an account from the ${brand} window on your computer.`}
            />
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.list} refreshControl={refresh}>
        {error && <Alert tone="danger">{error}</Alert>}

        {pool?.isDemo && (
          <Alert tone="warning">
            This is the Demo Provider. No real internet data is being shared and no real usage is
            being measured.
          </Alert>
        )}

        <View style={styles.gaugeCard}>
          <Gauge
            percent={leftPercent}
            value={splitAmount(left).value}
            unit={splitAmount(left).unit}
            caption="remaining"
            footnote={`of ${formatBytes(total)} total`}
            tone={gaugeTone(leftPercent)}
            accessibilityLabel={`${formatBytes(left)} remaining of ${formatBytes(total)}`}
          />
          <Text style={styles.projection}>
            {days === null
              ? 'No usage recorded yet, so there is nothing to project from.'
              : `May last ${days} ${days === 1 ? 'day' : 'days'} at the recent rate.`}
          </Text>
        </View>

        {owner ? (
          <Card
            title="Members"
            subtitle="Everyone sharing this allowance, and what is left of theirs."
          >
            {members.filter((member) => member.allocation).length === 0 ? (
              <Text style={styles.body}>
                Nobody has an allocation yet. Share data from the {brand} window on your computer.
              </Text>
            ) : (
              members
                .filter((member) => member.allocation)
                .map((member) => {
                  const allocation = member.allocation!;
                  return (
                    <View key={member.memberId} style={styles.member}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {member.name.slice(0, 1).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.memberBody}>
                        <Text style={styles.memberName} numberOfLines={1}>
                          {member.name}
                          {member.role === 'owner' ? ' (you)' : ''}
                        </Text>
                        <View style={styles.track}>
                          <View
                            style={[
                              styles.fill,
                              {
                                width: `${percentUsed(allocation.allocatedBytes, allocation.usedBytes)}%`,
                              },
                            ]}
                          />
                        </View>
                      </View>
                      <View style={styles.memberFigures}>
                        <Text style={styles.memberRemaining}>
                          {formatBytes(allocation.remainingBytes)}
                        </Text>
                        <StatusDot
                          tone={allocation.status === 'active' ? 'online' : 'warning'}
                          label={allocation.status === 'active' ? 'Active' : allocation.status}
                        />
                      </View>
                    </View>
                  );
                })
            )}
          </Card>
        ) : (
          mine && (
            <Card title={`Your data in ${mine.spaceName}`} subtitle="Shared with you by the owner.">
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>Used</Text>
                <Text style={styles.factValue}>{formatBytes(mine.usedBytes)}</Text>
              </View>
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>Expires</Text>
                <Text style={styles.factValue}>
                  {new Date(mine.expiresAt).toLocaleDateString()}
                </Text>
              </View>
              {mine.dailyLimitBytes && (
                <View style={styles.factRow}>
                  <Text style={styles.factLabel}>Today</Text>
                  <Text style={styles.factValue}>
                    {formatBytes(mine.usedTodayBytes)} of {formatBytes(mine.dailyLimitBytes)}
                  </Text>
                </View>
              )}
            </Card>
          )
        )}

        <Card title="Sharing more data">
          <Text style={styles.body}>
            Creating a {brand} Pass — choosing an amount, a daily cap and an expiry — is done in the{' '}
            {brand} window on your computer, where there is room to decide it properly.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function gaugeTone(remainingPercent: number): GaugeTone {
  if (remainingPercent <= 5) return 'danger';
  if (remainingPercent <= 20) return 'warning';
  return 'primary';
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  gaugeCard: {
    alignItems: 'center',
    gap: space[4],
    padding: space[6],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  projection: { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center' },
  body: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  member: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingVertical: space[3] },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
  memberBody: { flex: 1, gap: space[2] },
  memberName: { color: colors.text, fontSize: fontSize.base },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(94, 132, 199, 0.18)',
    overflow: 'hidden',
  },
  fill: { height: 6, borderRadius: radius.pill, backgroundColor: colors.primary },
  memberFigures: { alignItems: 'flex-end', gap: space[1] },
  memberRemaining: { color: colors.text, fontSize: fontSize.sm },
  factRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space[2],
  },
  factLabel: { color: colors.textMuted, fontSize: fontSize.sm },
  factValue: { color: colors.text, fontSize: fontSize.base },
});
