import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AUDIT_ACTION_LABELS, type AuditRecord } from '@netlink/contracts';
import { Alert, Card, EmptyState, Screen } from '../components/primitives';
import { colors, fontSize, space } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api } from '../state/session';

/**
 * Activity.
 *
 * The record of what happened, never what was in it. Every row here is an
 * event and an outcome — no file names, no message text, no browsing history,
 * because none of that reaches the server to be recorded.
 */
export function ActivityScreen() {
  const [events, setEvents] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api.activity(50);
      setEvents(page.items);
      setError(null);
    } catch (caught) {
      setEvents([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load your activity.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (events === null) {
    return (
      <Screen>
        <Card>
          <Text style={styles.body}>Loading…</Text>
        </Card>
      </Screen>
    );
  }

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

        {events.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing yet"
              description="Sign-ins, device changes and every action taken on your computers appear here."
            />
          </Card>
        ) : (
          <Card
            title="Recent activity"
            subtitle="What happened, never what was in it."
          >
            {events.map((event) => (
              <View key={event.id} style={styles.row}>
                <View
                  style={[
                    styles.marker,
                    {
                      backgroundColor:
                        event.outcome === 'success'
                          ? colors.success
                          : event.outcome === 'denied'
                            ? colors.warning
                            : colors.danger,
                    },
                  ]}
                />
                <View style={styles.rowText}>
                  <Text style={styles.action}>
                    {AUDIT_ACTION_LABELS[event.action] ?? event.action}
                  </Text>
                  <Text style={styles.meta}>
                    {new Date(event.createdAt).toLocaleString()}
                    {event.approximateLocation ? ` · ${event.approximateLocation}` : ''}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  body: { color: colors.textSecondary, fontSize: fontSize.base },
  row: { flexDirection: 'row', gap: space[3], alignItems: 'flex-start', paddingVertical: space[2] },
  marker: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  rowText: { flex: 1, gap: 2 },
  action: { color: colors.text, fontSize: fontSize.sm },
  meta: { color: colors.textMuted, fontSize: fontSize.xs },
});
