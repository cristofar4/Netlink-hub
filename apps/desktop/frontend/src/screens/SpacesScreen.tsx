import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, StatusDot, usePrefersReducedMotion } from '@netlink/ui';
import type { AgentSummary, LiveEvent, ResourceSummary, SpaceSummary } from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useSession } from '../state/session';
import { useLiveEvents } from '../state/live';
import type { SectionId } from './sections';
import { EnrollAgentCard } from '../components/EnrollAgentCard';
import './spaces.css';

/**
 * The My Spaces dashboard.
 *
 * The map is the product's centrepiece: one picture of a Space showing the home
 * PC, the Data Pool, approved files, the printer, invited people, network
 * health and connection status, joined by cyan paths.
 *
 * Agent status here is live — it comes from the control plane and updates over
 * the WebSocket when a computer comes online or drops off. Nodes for features a
 * later phase builds show their real "not set up yet" state and say which phase
 * makes them real, so the map never implies something that does not exist.
 */
export function SpacesScreen({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const { user } = useSession();
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const activeSpace = useMemo(
    () => spaces?.find((space) => space.id === activeSpaceId) ?? null,
    [spaces, activeSpaceId],
  );

  const loadSpaces = useCallback(async () => {
    try {
      const list = await api.listSpaces();
      setSpaces(list);
      setActiveSpaceId((current) => current ?? list[0]?.id ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your Spaces.');
      setSpaces([]);
    }
  }, []);

  const loadSpaceDetail = useCallback(async (spaceId: string) => {
    try {
      const [agentList, resourceList] = await Promise.all([
        api.listAgents(spaceId),
        api.listResources(spaceId),
      ]);
      setAgents(agentList);
      setResources(resourceList);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this Space.');
    }
  }, []);

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  useEffect(() => {
    if (activeSpaceId) void loadSpaceDetail(activeSpaceId);
  }, [activeSpaceId, loadSpaceDetail]);

  // Live updates: refresh only the Space the event concerns, and only when it
  // is the one on screen.
  const liveStatus = useLiveEvents(
    useCallback(
      (event: LiveEvent) => {
        if (!activeSpaceId) return;
        if (
          (event.type === 'agent.status' || event.type === 'resources.updated') &&
          event.spaceId === activeSpaceId
        ) {
          void loadSpaceDetail(activeSpaceId);
        }
      },
      [activeSpaceId, loadSpaceDetail],
    ),
  );

  const onlineAgents = agents.filter((agent) => agent.status === 'online');
  const printers = resources.filter((resource) => resource.kind === 'printer');
  const folders = resources.filter((resource) => resource.kind === 'folder');
  const sharedPrinters = printers.filter((printer) => printer.enabled);
  const sharedFolders = folders.filter((folder) => folder.enabled);

  const nodes: MapNode[] = [
    {
      id: 'devices',
      label: 'Computers',
      detail: describeAgents(agents.length, onlineAgents.length),
      tone: onlineAgents.length > 0 ? 'online' : agents.length > 0 ? 'warning' : 'offline',
      angle: 0,
      live: agents.length > 0,
      onOpen: () => onNavigate('devices'),
    },
    {
      id: 'data',
      label: 'Data Pool',
      detail: 'Not set up yet',
      tone: 'offline',
      angle: 60,
      phase: 3,
      onOpen: () => onNavigate('data'),
    },
    {
      id: 'files',
      label: 'Approved files',
      detail:
        sharedFolders.length > 0
          ? `${sharedFolders.length} folder${sharedFolders.length === 1 ? '' : 's'} shared`
          : 'No folders approved',
      tone: sharedFolders.length > 0 ? 'online' : 'offline',
      angle: 120,
      live: sharedFolders.length > 0,
      phase: sharedFolders.length > 0 ? undefined : 5,
      onOpen: () => onNavigate('files'),
    },
    {
      id: 'printers',
      label: 'Printers',
      detail:
        sharedPrinters.length > 0
          ? `${sharedPrinters.length} shared`
          : printers.length > 0
            ? `${printers.length} found, none shared`
            : 'None shared',
      tone: sharedPrinters.length > 0 ? 'online' : 'offline',
      angle: 180,
      live: sharedPrinters.length > 0,
      phase: sharedPrinters.length > 0 ? undefined : 5,
      onOpen: () => onNavigate('printers'),
    },
    {
      id: 'members',
      label: 'People',
      detail:
        activeSpace && activeSpace.memberCount > 1
          ? `${activeSpace.memberCount} people`
          : 'Only you',
      tone: 'offline',
      angle: 240,
      phase: 3,
      onOpen: () => onNavigate('members'),
    },
    {
      id: 'power',
      label: 'Power and Wake',
      detail: onlineAgents.length > 0 ? `${onlineAgents.length} reachable` : 'No agent online',
      tone: onlineAgents.length > 0 ? 'online' : 'offline',
      angle: 300,
      live: onlineAgents.length > 0,
      phase: 4,
      onOpen: () => onNavigate('power'),
    },
  ];

  return (
    <div className="spaces">
      <section className="spaces__hero nl-card">
        <div className="spaces__hero-head">
          <div>
            <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <h2 className="spaces__space-name">{activeSpace?.name ?? 'My Home'}</h2>
              {activeSpace?.isOwner && <Badge tone="primary">Owner</Badge>}
              {spaces && spaces.length > 1 && (
                <select
                  className="spaces__switcher"
                  value={activeSpaceId ?? ''}
                  onChange={(event) => setActiveSpaceId(event.target.value)}
                  aria-label="Switch Space"
                >
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <p className="nl-muted" style={{ marginTop: 4, fontSize: 'var(--nl-text-sm)' }}>
              Signed in as {user?.email}
            </p>
          </div>
          <div className="nl-spacer" />
          <div className="nl-row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <StatusDot
              tone={
                liveStatus === 'connected'
                  ? 'secure'
                  : liveStatus === 'connecting'
                    ? 'connecting'
                    : 'warning'
              }
              label={
                liveStatus === 'connected'
                  ? 'Live'
                  : liveStatus === 'connecting'
                    ? 'Connecting…'
                    : 'Reconnecting…'
              }
            />
            <StatusDot
              tone={onlineAgents.length > 0 ? 'online' : 'offline'}
              label={
                agents.length === 0
                  ? 'No computers yet'
                  : `${onlineAgents.length} of ${agents.length} online`
              }
            />
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 16 }}>
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        <SpaceMap nodes={nodes} animated={!reducedMotion} loading={spaces === null} />
      </section>

      <div className="spaces__grid">
        <Card
          title="Computers in this Space"
          subtitle="A computer appears here once its NetLink agent has joined."
        >
          {agents.length === 0 ? (
            <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
              No computer has joined yet. Use the card beside this one to connect the NetLink agent
              on this machine.
            </p>
          ) : (
            <ul className="nl-stack" style={{ gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
              {agents.map((agent) => (
                <li key={agent.id} className="nl-row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <StatusDot
                    tone={agent.status === 'online' ? 'online' : 'offline'}
                    label={agent.name}
                  />
                  <div className="nl-spacer" />
                  <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                    {agent.status === 'online'
                      ? agent.localIpAddress
                        ? `on ${agent.localIpAddress}`
                        : 'online'
                      : agent.lastHeartbeatAt
                        ? `last seen ${formatRelative(agent.lastHeartbeatAt)}`
                        : 'never seen'}
                  </span>
                  {agent.isWakeHelper && <Badge tone="cyan">Wake Helper</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {activeSpace?.isOwner && activeSpaceId && (
          <EnrollAgentCard
            spaceId={activeSpaceId}
            onEnrolled={() => void loadSpaceDetail(activeSpaceId)}
          />
        )}

        {printers.length > 0 && activeSpace?.isOwner && activeSpaceId && (
          <Card
            title="Printers found on your computers"
            subtitle="Discovering a printer is not the same as sharing it. Turn one on to make it reachable."
          >
            <ul className="nl-stack" style={{ gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
              {printers.map((printer) => (
                <li key={printer.id} className="nl-row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <StatusDot
                    tone={printer.metadata?.status === 'ready' ? 'online' : 'offline'}
                    label={printer.name}
                  />
                  <div className="nl-spacer" />
                  <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                    on {printer.agentName}
                  </span>
                  <Button
                    size="sm"
                    variant={printer.enabled ? 'danger' : 'secondary'}
                    onClick={async () => {
                      await api.setResourceEnabled(activeSpaceId, printer.id, !printer.enabled);
                      await loadSpaceDetail(activeSpaceId);
                    }}
                  >
                    {printer.enabled ? 'Stop sharing' : 'Share'}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card
          title="What is live today"
          subtitle="Phases 0 to 2 are complete: accounts, devices, Spaces and agents."
        >
          <ul className="spaces__checklist">
            {[
              ['Accounts with Argon2id password hashing', true],
              ['Six-digit email verification, single use, ten minutes', true],
              ['New-device verification with Trust This Device', true],
              ['Per-device key pairs, revocable one at a time', true],
              ['Spaces, agent enrollment and live online state', true],
              ['Printer discovery, shared only when you say so', true],
            ].map(([label, done]) => (
              <li
                key={String(label)}
                className={`spaces__checklist-item${done ? ' spaces__checklist-item--done' : ''}`}
              >
                {label}
              </li>
            ))}
            <li className="spaces__checklist-item">
              Data Pool and NetLink Passes <Badge tone="later">Phase 3</Badge>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function describeAgents(total: number, online: number): string {
  if (total === 0) return 'No computers yet';
  if (online === total) return total === 1 ? '1 online' : `${total} online`;
  return `${online} of ${total} online`;
}

function formatRelative(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

type MapNode = {
  id: string;
  label: string;
  detail: string;
  tone: 'online' | 'offline' | 'warning';
  /** Degrees clockwise from twelve o'clock. Kept 60 apart so no two nodes
   * can overlap on the ellipse. */
  angle: number;
  phase?: number;
  live?: boolean;
  onOpen: () => void;
};

const MAP_WIDTH = 880;
const MAP_HEIGHT = 400;
const CENTRE_X = MAP_WIDTH / 2;
const CENTRE_Y = MAP_HEIGHT / 2;
const RADIUS_X = 330;
const RADIUS_Y = 148;

function SpaceMap({
  nodes,
  animated,
  loading,
}: {
  nodes: MapNode[];
  animated: boolean;
  loading: boolean;
}) {
  const positioned = nodes.map((node) => {
    const radians = ((node.angle - 90) * Math.PI) / 180;
    return {
      ...node,
      x: CENTRE_X + Math.cos(radians) * RADIUS_X,
      y: CENTRE_Y + Math.sin(radians) * RADIUS_Y,
    };
  });

  return (
    <div className="spaces__map">
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        className="spaces__map-svg"
        role="img"
        aria-label={`Map of this Space. ${positioned
          .map((node) => `${node.label}: ${node.detail}`)
          .join('. ')}`}
      >
        <defs>
          <radialGradient id="spaces-core">
            <stop offset="0%" stopColor="#5b8cff" />
            <stop offset="100%" stopColor="#16307e" />
          </radialGradient>
        </defs>

        {positioned.map((node) => (
          <line
            key={`edge-${node.id}`}
            x1={CENTRE_X}
            y1={CENTRE_Y}
            x2={node.x}
            y2={node.y}
            stroke="var(--nl-cyan)"
            strokeWidth={node.live ? 1.8 : 1.2}
            // A dimmer path for a resource that is not connected yet, so the
            // eye can tell live from planned without reading a word.
            strokeOpacity={node.live ? 0.75 : 0.22}
            strokeLinecap="round"
            strokeDasharray={node.live && animated ? '6 10' : node.live ? undefined : '3 7'}
            className={node.live && animated ? 'spaces__edge--flow' : undefined}
          />
        ))}

        <circle cx={CENTRE_X} cy={CENTRE_Y} r="52" fill="url(#spaces-core)" />
        <circle cx={CENTRE_X} cy={CENTRE_Y} r="52" fill="none" stroke="rgba(255,255,255,0.25)" />
        {animated && !loading && (
          <circle
            cx={CENTRE_X}
            cy={CENTRE_Y}
            r="52"
            fill="none"
            stroke="var(--nl-cyan)"
            className="spaces__core-pulse"
          />
        )}
        <text x={CENTRE_X} y={CENTRE_Y - 4} textAnchor="middle" className="spaces__core-label">
          NetLink
        </text>
        <text x={CENTRE_X} y={CENTRE_Y + 14} textAnchor="middle" className="spaces__core-sub">
          Space
        </text>
      </svg>

      {positioned.map((node) => (
        <button
          key={node.id}
          type="button"
          className={`spaces__node spaces__node--${node.tone}`}
          style={{
            left: `${(node.x / MAP_WIDTH) * 100}%`,
            top: `${(node.y / MAP_HEIGHT) * 100}%`,
          }}
          onClick={node.onOpen}
        >
          <span className="spaces__node-head">
            <span className="spaces__node-dot" aria-hidden="true" />
            <span className="spaces__node-label">{node.label}</span>
          </span>
          <span className="spaces__node-detail">{node.detail}</span>
          {node.phase && <span className="spaces__node-phase">Phase {node.phase}</span>}
        </button>
      ))}
    </div>
  );
}
