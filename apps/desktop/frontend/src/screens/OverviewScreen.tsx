import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Card, StatTile, StatusDot, usePrefersReducedMotion } from '@netlink/ui';
import {
  AUDIT_ACTION_LABELS,
  formatBytes,
  percentUsed,
  type AgentSummary,
  type AuditRecord,
  type LiveEvent,
  type ResourceSummary,
  type SpaceOverview,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useLiveEvents } from '../state/live';
import { useSpaces } from '../state/space';
import { EnrollAgentCard } from '../components/EnrollAgentCard';
import { SpaceMap, type MapNode } from '../components/SpaceMap';
import type { SectionId } from './sections';
import './overview.css';

/**
 * The dashboard.
 *
 * One picture of a Space — what is in it, whether it is reachable, and what
 * needs attention — followed by the four things people actually came to do.
 *
 * The counts come from a single overview request rather than five parallel
 * ones, so the tiles cannot disagree with each other while a slower response is
 * still in flight. The latency figure is the exception: it is measured here,
 * because what matters is the distance from *this* machine to the control
 * plane, which the server cannot report.
 */
export function OverviewScreen({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const { activeSpace, loading: spacesLoading, error: spacesError } = useSpaces();
  const spaceId = activeSpace?.id ?? null;

  const [overview, setOverview] = useState<SpaceOverview | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [activity, setActivity] = useState<AuditRecord[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const load = useCallback(async () => {
    if (!spaceId) return;
    try {
      const [summary, agentList, resourceList] = await Promise.all([
        api.spaceOverview(spaceId),
        api.listAgents(spaceId),
        api.listResources(spaceId),
      ]);
      setOverview(summary);
      setAgents(agentList);
      setResources(resourceList);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this Space.');
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The activity feed is account-wide, so it survives a change of Space.
  useEffect(() => {
    let cancelled = false;
    void api
      .activity(6)
      .then((page) => {
        if (!cancelled) setActivity(page.items);
      })
      .catch(() => {
        /* The dashboard is still useful without the feed. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const measure = async () => {
      const value = await api.pingLatencyMs();
      if (!cancelled) setLatencyMs(value);
    };
    void measure();
    const timer = window.setInterval(() => void measure(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Live updates: only the events that change something on this screen.
  const liveStatus = useLiveEvents(
    useCallback(
      (event: LiveEvent) => {
        if (!spaceId || !('spaceId' in event) || event.spaceId !== spaceId) return;
        if (
          event.type === 'agent.status' ||
          event.type === 'resources.updated' ||
          event.type === 'data.usage' ||
          event.type === 'remote.session'
        ) {
          void load();
        }
      },
      [spaceId, load],
    ),
  );

  const sharedFolders = resources.filter((item) => item.kind === 'folder' && item.enabled);
  const sharedPrinters = resources.filter((item) => item.kind === 'printer' && item.enabled);

  const nodes = useMemo<MapNode[]>(() => {
    // Derived inside the memo rather than passed in: `onlineAgents` is a fresh
    // array on every render, so depending on it would rebuild the map each time
    // and defeat the point of memoising it.
    const onlineAgents = agents.filter((agent) => agent.status === 'online');
    const first = onlineAgents[0] ?? agents[0] ?? null;
    const dataPercent = overview?.data
      ? 100 - percentUsed(overview.data.balanceBytes, overview.data.usedBytes)
      : 0;

    return [
      {
        id: 'computer',
        icon: 'monitor',
        label: first?.name ?? 'Computers',
        detail: first ? (first.status === 'online' ? 'Online' : 'Offline') : 'None set up yet',
        tone: onlineAgents.length > 0 ? 'online' : agents.length > 0 ? 'warning' : 'offline',
        angle: 315,
        live: onlineAgents.length > 0,
        onOpen: () => onNavigate('network'),
      },
      {
        id: 'data',
        icon: 'data',
        label: overview?.data ? formatBytes(overview.data.remainingBytes) : 'Data Pool',
        detail: overview?.data ? 'Remaining' : 'Not connected',
        tone: overview?.data ? 'online' : 'offline',
        angle: 45,
        live: Boolean(overview?.data),
        ring: overview?.data ? dataPercent : undefined,
        onOpen: () => onNavigate('data'),
      },
      {
        id: 'files',
        icon: 'folder',
        label: 'Approved files',
        detail:
          sharedFolders.length > 0
            ? `${sharedFolders.length} folder${sharedFolders.length === 1 ? '' : 's'}`
            : 'None approved',
        tone: sharedFolders.length > 0 ? 'online' : 'offline',
        angle: 225,
        live: sharedFolders.length > 0,
        onOpen: () => onNavigate('files'),
      },
      {
        id: 'printers',
        icon: 'printer',
        label: 'Printers',
        detail: sharedPrinters.length > 0 ? `${sharedPrinters.length} shared` : 'None shared',
        tone: sharedPrinters.length > 0 ? 'online' : 'offline',
        angle: 135,
        live: sharedPrinters.length > 0,
        onOpen: () => onNavigate('printers'),
      },
      {
        id: 'people',
        icon: 'people',
        label:
          overview && overview.memberCount > 1
            ? `${overview.memberCount - 1} ${overview.memberCount === 2 ? 'person' : 'people'}`
            : 'People',
        detail: overview && overview.memberCount > 1 ? 'Shared access' : 'Only you',
        tone: overview && overview.memberCount > 1 ? 'online' : 'offline',
        angle: 180,
        live: Boolean(overview && overview.memberCount > 1),
        onOpen: () => onNavigate('members'),
      },
    ];
  }, [agents, overview, sharedFolders.length, sharedPrinters.length, onNavigate]);

  if (spacesLoading && !activeSpace) return <Card>Loading your Spaces…</Card>;
  if (!activeSpace) {
    return (
      <Card title="No Space yet">
        <p className="nl-muted">
          {spacesError ?? 'A Space is created for you the first time you sign in.'}
        </p>
      </Card>
    );
  }

  const failing = overview?.health.signals.filter((signal) => !signal.ok) ?? [];

  return (
    <div className="overview">
      {error && <Alert tone="error">{error}</Alert>}

      <div className="overview__tiles">
        <StatTile
          icon={<PulseIcon />}
          label="Network health"
          value={overview ? overview.health.score : '—'}
          unit={overview ? '/100' : undefined}
          detail={
            overview
              ? failing.length === 0
                ? 'Every check passed'
                : `${failing.length} check${failing.length === 1 ? '' : 's'} to look at`
              : undefined
          }
          tone={healthTone(overview?.health.score)}
        />
        <StatTile
          icon={<DevicesIcon />}
          label="Devices online"
          value={overview ? overview.onlineAgentCount : '—'}
          detail={overview ? `of ${overview.agentCount} in this Space` : undefined}
          tone="cyan"
        />
        <StatTile
          icon={<GaugeIcon />}
          label="Latency"
          // Null means the ping failed. Showing the last good number would be
          // a claim about a connection that is not answering.
          value={latencyMs === null ? 'No answer' : latencyMs}
          unit={latencyMs === null ? undefined : 'ms'}
          detail="To the control plane"
          tone={latencyMs === null ? 'warning' : 'primary'}
        />
        <StatTile
          icon={<DataIcon />}
          label="Data remaining"
          value={overview?.data ? formatBytes(overview.data.remainingBytes) : 'Not connected'}
          detail={
            overview?.data
              ? `of ${formatBytes(overview.data.balanceBytes)}`
              : 'Connect an account on the Data Pool screen'
          }
          tone="success"
          onOpen={() => onNavigate('data')}
        />
      </div>

      <div className="overview__body">
        <section className="overview__map-card nl-card">
          <header className="overview__map-head">
            <div>
              <h2 className="overview__space-name">{activeSpace.name}</h2>
              <p className="overview__space-detail">
                {activeSpace.isOwner ? 'You own this Space' : 'Shared with you'}
              </p>
            </div>
            <div className="nl-spacer" />
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
          </header>

          <SpaceMap
            nodes={nodes}
            centreLabel={activeSpace.name}
            centreDetail={failing.length === 0 ? 'Protected' : 'Needs attention'}
            centreTone={failing.length === 0 ? 'secure' : 'warning'}
            animated={!reducedMotion}
          />
        </section>

        <div className="overview__side">
          <Card title="Quick actions">
            <div className="overview__actions">
              <QuickAction
                label="Connect to a computer"
                icon={<MonitorIcon />}
                onClick={() => onNavigate('network')}
              />
              <QuickAction
                label="Send a file"
                icon={<SendIcon />}
                onClick={() => onNavigate('files')}
              />
              <QuickAction
                label="Print a document"
                icon={<PrinterIcon />}
                onClick={() => onNavigate('printers')}
              />
              <QuickAction
                label="Create a NetLink Pass"
                icon={<KeyIcon />}
                onClick={() => onNavigate('data')}
              />
            </div>
          </Card>

          <Card title="NetLink Assist">
            <Assist overview={overview} onNavigate={onNavigate} />
          </Card>

          {activeSpace.isOwner && agents.length === 0 && (
            <EnrollAgentCard spaceId={activeSpace.id} onEnrolled={() => void load()} />
          )}
        </div>
      </div>

      <Card
        title="Recent activity"
        actions={
          <button type="button" className="overview__link" onClick={() => onNavigate('activity')}>
            View all
          </button>
        }
      >
        {activity.length === 0 ? (
          <p className="nl-muted overview__empty">Nothing has happened on this account yet.</p>
        ) : (
          <ul className="overview__activity">
            {activity.map((event) => (
              <li key={event.id} className="overview__activity-row">
                <StatusDot
                  tone={
                    event.outcome === 'success'
                      ? 'online'
                      : event.outcome === 'failure'
                        ? 'danger'
                        : 'warning'
                  }
                  label=""
                />
                <span className="overview__activity-label">
                  {AUDIT_ACTION_LABELS[event.action] ?? event.action}
                </span>
                <span className="nl-spacer" />
                <time className="overview__activity-time" dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * The assistant panel.
 *
 * It reports the checks the server actually ran. When something failed it says
 * which one and what it means, rather than a cheerful summary — a panel that
 * says "everything looks good" over a failing check is worse than no panel.
 */
function Assist({
  overview,
  onNavigate,
}: {
  overview: SpaceOverview | null;
  onNavigate: (section: SectionId) => void;
}) {
  if (!overview) return <p className="nl-muted overview__empty">Checking this Space…</p>;

  const failing = overview.health.signals.filter((signal) => !signal.ok);
  const days = overview.data?.projectedDaysRemaining ?? null;

  return (
    <div className="overview__assist">
      <div
        className={`overview__assist-mark overview__assist-mark--${failing.length ? 'warn' : 'ok'}`}
      >
        <PulseIcon />
      </div>
      <div className="overview__assist-text">
        <strong>{failing.length === 0 ? 'Everything looks good' : failing[0].label}</strong>
        <span>{failing.length === 0 ? allGoodLine(days) : failing[0].detail}</span>

        {failing.length > 1 && (
          <span className="overview__assist-more">
            {failing.length - 1} other check{failing.length - 1 === 1 ? '' : 's'} did not pass.
          </span>
        )}

        {days !== null && failing.length > 0 && (
          <button type="button" className="overview__link" onClick={() => onNavigate('data')}>
            Your data may last {days} {days === 1 ? 'day' : 'days'}
          </button>
        )}
      </div>
    </div>
  );
}

function allGoodLine(days: number | null): string {
  if (days === null) {
    // No usage history means no projection. Saying "plenty left" would be
    // inventing a measurement nobody made.
    return 'Every check passed on this Space.';
  }
  return `Your data may last ${days} ${days === 1 ? 'day' : 'days'} at the recent rate.`;
}

function healthTone(score: number | undefined): 'success' | 'warning' | 'danger' | 'primary' {
  if (score === undefined) return 'primary';
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

function QuickAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="overview__action" onClick={onClick}>
      <span className="overview__action-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="overview__action-label">{label}</span>
      <span className="overview__action-chevron" aria-hidden="true">
        <ChevronIcon />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const stroke = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function PulseIcon() {
  return (
    <svg {...stroke}>
      <path d="M3 12h3.5L9 6l4 12 2.5-6H21" />
    </svg>
  );
}

function DevicesIcon() {
  return (
    <svg {...stroke}>
      <rect x="2.5" y="5" width="13" height="10" rx="2" />
      <path d="M6 19h6" />
      <rect x="17" y="9" width="4.5" height="10" rx="1.5" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg {...stroke}>
      <path d="M4 16a8 8 0 1 1 16 0" />
      <path d="m12 15 3.5-4" />
    </svg>
  );
}

function DataIcon() {
  return (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v8h8" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...stroke} width={18} height={18}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...stroke} width={18} height={18}>
      <path d="M21 4 3 11l7 2.5L12.5 21 21 4Z" />
    </svg>
  );
}

function PrinterIcon() {
  return (
    <svg {...stroke} width={18} height={18}>
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="7" rx="2" />
      <path d="M7 14h10v6H7z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg {...stroke} width={18} height={18}>
      <circle cx="8" cy="14" r="4" />
      <path d="m11 11 8-8M17 5l2 2M14.5 7.5l2 2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...stroke} width={16} height={16}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
