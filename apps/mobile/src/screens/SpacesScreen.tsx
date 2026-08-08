import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { statusFromHeartbeat, type AgentSummary } from '@netlink/contracts';
import { Alert, Badge, Button, Card, EmptyState, Screen, StatusDot } from '../components/primitives';
import { colors, fontSize, space } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api } from '../state/session';
import { useSpace } from '../state/space';
import { SHOW_DATA_POOL } from '../lib/config';

/**
 * My Spaces on a phone.
 *
 * The desktop shows an animated map of everything connected to a Space. That
 * does not translate: a map is a thing you scan on a large screen, and on a
 * phone it becomes a small picture you cannot read. The same information is
 * here as a list, ordered by what a person on the move actually wants — which
 * computers are reachable right now.
 */
export function SpacesScreen({ onOpenPower }: { onOpenPower: () => void }) {
  const { spaces, active, select, loading, error: spaceError, reload } = useSpace();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!active) {
      setAgents([]);
      return;
    }
    try {
      setAgents(await api.listAgents(active.id));
      setError(null);
    } catch (caught) {
      setAgents([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load this Space.');
    }
  }, [active]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || agents === null) {
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
              <Card title="Your Spaces">
                {spaces.map((entry) => (
                  <Button
                    key={entry.id}
                    label={entry.name}
                    variant={entry.id === active?.id ? 'primary' : 'secondary'}
                    onPress={() => select(entry.id)}
                  />
                ))}
              </Card>
            )}

            <Card
              title={active?.name ?? 'Space'}
              subtitle={
                agents.length === 0
                  ? 'No computers yet'
                  : `${online} of ${agents.length} ${agents.length === 1 ? 'computer' : 'computers'} online`
              }
              actions={
                <StatusDot
                  tone={online > 0 ? 'online' : 'offline'}
                  label={online > 0 ? 'Reachable' : 'Nothing online'}
                />
              }
            >
              {agents.length === 0 ? (
                <EmptyState
                  title="No computers here"
                  description="Install the NetLink agent on the computer you want to reach, then enrol it from the NetLink window on that machine."
                />
              ) : (
                <Button label="Power and Wake" onPress={onOpenPower} />
              )}
            </Card>

            {agents.map((agent) => {
              const isOnline = statusFromHeartbeat(agent.lastHeartbeatAt) === 'online';
              return (
                <Card
                  key={agent.id}
                  title={agent.name}
                  subtitle={isOnline ? 'Online and reachable' : 'Not reachable right now'}
                  actions={
                    <View style={styles.badges}>
                      {agent.isWakeHelper && <Badge tone="cyan">Wake Helper</Badge>}
                      <StatusDot
                        tone={isOnline ? 'online' : 'offline'}
                        label={isOnline ? 'Online' : 'Offline'}
                      />
                    </View>
                  }
                />
              );
            })}

            {/*
              Files, printers and remote desktop are reachable from the desktop
              app. They are named here rather than hidden, because a section
              that simply does not exist reads as a missing feature, and one
              that says where it lives reads as a decision.
            */}
            <Card
              title="Also in this Space"
              subtitle="Available in the NetLink window on your computer."
            >
              <Text style={styles.body}>
                Approved files, printers and remote desktop are on the desktop app, where there is
                room for them.
                {SHOW_DATA_POOL ? ' The Data Pool is in this build for development.' : ''}
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  body: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
});
