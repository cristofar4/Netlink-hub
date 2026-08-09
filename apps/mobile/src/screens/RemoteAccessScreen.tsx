import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatBytes,
  statusFromHeartbeat,
  type AgentSummary,
  type ApprovedFolder,
  type FileEntry,
  type SharedPrinter,
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
import { colors, fontSize, radius, space } from '../theme/tokens';
import { ApiError } from '../lib/api';
import { api } from '../state/session';
import { useSpace } from '../state/space';
import { useBrandName } from '../state/brand';

/**
 * Remote access from a phone.
 *
 * Every action here is one this app can actually carry out. Watching or driving
 * a screen is not among them — that needs a WebRTC viewer and a keyboard, and
 * it lives in the desktop app. Rather than showing a Connect button that opens
 * an apology, each resource offers what a phone can genuinely do: turn a
 * computer on, look through an approved folder, see whether a printer is ready.
 */
export function RemoteAccessScreen({ onOpenPower }: { onOpenPower: () => void }) {
  const brand = useBrandName();
  const { active } = useSpace();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [folders, setFolders] = useState<ApprovedFolder[]>([]);
  const [printers, setPrinters] = useState<SharedPrinter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!active) {
      setLoading(false);
      return;
    }
    try {
      const [agentList, folderList, printerList] = await Promise.all([
        api.listAgents(active.id),
        // A member without files or printers permission simply gets an empty
        // section rather than an error across the whole screen.
        api.listFolders(active.id).catch(() => []),
        api.listPrinters(active.id).catch(() => []),
      ]);
      setAgents(agentList);
      setFolders(folderList);
      setPrinters(printerList);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this Space.');
    } finally {
      setLoading(false);
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

  const nothing = agents.length === 0 && folders.length === 0 && printers.length === 0;

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

        <Text style={styles.lede}>
          Your devices and resources in {active?.name ?? 'this Space'}, wherever you are.
        </Text>

        {nothing && (
          <Card>
            <EmptyState
              title="Nothing shared yet"
              description={`Install the ${brand} agent on a computer and approve a folder or printer from the ${brand} window there.`}
            />
          </Card>
        )}

        {agents.map((agent) => {
          const online = statusFromHeartbeat(agent.lastHeartbeatAt) === 'online';
          return (
            <Card
              key={agent.id}
              title={agent.name}
              subtitle={online ? 'Online and reachable' : 'Powered off or unreachable'}
              actions={
                <View style={styles.badges}>
                  {agent.isWakeHelper && <Badge tone="cyan">Wake Helper</Badge>}
                  <StatusDot
                    tone={online ? 'online' : 'offline'}
                    label={online ? 'Online' : 'Offline'}
                  />
                </View>
              }
            >
              <Button
                label={online ? 'Power and lock' : 'Turn it on'}
                variant={online ? 'secondary' : 'primary'}
                onPress={onOpenPower}
              />
            </Card>
          );
        })}

        {folders.map((folder) => (
          <FolderCard key={folder.resourceId} spaceId={active!.id} folder={folder} />
        ))}

        {printers.map((printer) => (
          <Card
            key={printer.resourceId}
            title={printer.name}
            subtitle={`Printer on ${printer.agentName}`}
            actions={
              <StatusDot
                tone={printer.agentOnline && printer.status === 'ready' ? 'online' : 'offline'}
                label={printer.agentOnline ? printer.status : 'Offline'}
              />
            }
          >
            <Text style={styles.body}>
              Sending a document to this printer needs the file, so it is done from the {brand}
              window on your computer.
            </Text>
          </Card>
        ))}

        {agents.length > 0 && (
          <Card title="Watching a screen">
            <Text style={styles.body}>
              Remote desktop is in the {brand} window on your computer. It needs a keyboard and a
              screen with room for one, so it is not built into the phone app.
            </Text>
          </Card>
        )}

        <View style={styles.assurance}>
          <Text style={styles.assuranceTitle}>All connections are secure</Text>
          <Text style={styles.assuranceBody}>
            Transfers and sessions travel directly between your devices, encrypted end to end.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * One approved folder, with its contents on demand.
 *
 * Browsing is a request to the computer at the other end, so it only happens
 * when somebody asks — opening this screen must not wake up every agent in a
 * Space to list directories nobody looked at.
 */
function FolderCard({ spaceId, folder }: { spaceId: string; folder: ApprovedFolder }) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card
      title={folder.name}
      subtitle={`Folder on ${folder.agentName}${folder.readOnly ? ' · read only' : ''}`}
      actions={
        <StatusDot
          tone={folder.agentOnline ? 'online' : 'offline'}
          label={folder.agentOnline ? 'Available' : 'Offline'}
        />
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {entries === null ? (
        <Button
          label="Browse"
          disabled={!folder.agentOnline}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            setError(null);
            try {
              setEntries(await api.browse(spaceId, folder.resourceId));
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not open that folder.');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : entries.length === 0 ? (
        <Text style={styles.body}>This folder is empty.</Text>
      ) : (
        <View>
          {entries.slice(0, 12).map((entry) => (
            <View key={entry.path} style={styles.entry}>
              <Text style={styles.entryName} numberOfLines={1}>
                {entry.isDir ? '▸ ' : ''}
                {entry.name}
              </Text>
              <Text style={styles.entryMeta}>
                {entry.isDir ? 'Folder' : formatBytes(entry.sizeBytes)}
              </Text>
            </View>
          ))}
          {entries.length > 12 && (
            <Text style={styles.entryMeta}>
              and {entries.length - 12} more — open this folder on your computer to see everything.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[4], paddingBottom: space[10] },
  lede: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  body: { color: colors.textSecondary, fontSize: fontSize.base, lineHeight: 24 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingVertical: space[2],
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  entryName: { color: colors.text, fontSize: fontSize.sm, flex: 1 },
  entryMeta: { color: colors.textMuted, fontSize: fontSize.xs },
  assurance: {
    gap: space[1],
    padding: space[4],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.cyanDim,
    backgroundColor: colors.cyanFaint,
  },
  assuranceTitle: { color: colors.text, fontSize: fontSize.base, fontWeight: '600' },
  assuranceBody: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
});
