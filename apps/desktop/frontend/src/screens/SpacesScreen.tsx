import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, StatusDot, usePrefersReducedMotion } from '@netlink/ui';
import type { AuthenticatedDevice } from '@netlink/contracts';
import { api } from '../lib/api';
import { useSession } from '../state/session';
import type { SectionId } from './sections';
import './spaces.css';

/**
 * The My Spaces dashboard.
 *
 * The map is the product's centrepiece: one picture of a Space showing the home
 * PC, the Data Pool, approved files, the printer, invited people, network
 * health and connection status, joined by cyan paths.
 *
 * What is real in Phase 1 is the device data — the enrolled devices come from
 * the control plane and their trust state is live. The other nodes are shown in
 * their "not set up yet" state and each says which phase makes it real, so the
 * map is honest about what exists rather than decorative.
 */
export function SpacesScreen({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const { user } = useSession();
  const [devices, setDevices] = useState<AuthenticatedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    let cancelled = false;
    void api
      .listDevices()
      .then((list) => !cancelled && setDevices(list))
      .catch((caught: Error) => !cancelled && setError(caught.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const activeDevices = useMemo(
    () => (devices ?? []).filter((device) => !device.revokedAt),
    [devices],
  );
  const trustedCount = activeDevices.filter((device) => device.trusted).length;

  const nodes: MapNode[] = [
    {
      id: 'devices',
      label: 'Computers',
      detail:
        activeDevices.length === 1
          ? '1 device enrolled'
          : `${activeDevices.length} devices enrolled`,
      tone: activeDevices.length > 0 ? 'online' : 'offline',
      angle: 0,
      live: true,
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
      detail: 'No folders approved',
      tone: 'offline',
      angle: 120,
      phase: 5,
      onOpen: () => onNavigate('files'),
    },
    {
      id: 'printers',
      label: 'Printers',
      detail: 'None shared',
      tone: 'offline',
      angle: 180,
      phase: 5,
      onOpen: () => onNavigate('printers'),
    },
    {
      id: 'members',
      label: 'People',
      detail: 'Only you',
      tone: 'offline',
      angle: 240,
      phase: 3,
      onOpen: () => onNavigate('members'),
    },
    {
      id: 'power',
      label: 'Power and Wake',
      detail: 'Needs an agent',
      tone: 'offline',
      angle: 300,
      phase: 4,
      onOpen: () => onNavigate('power'),
    },
  ];

  return (
    <div className="spaces">
      <section className="spaces__hero nl-card">
        <div className="spaces__hero-head">
          <div>
            <div className="nl-row" style={{ gap: 10 }}>
              <h2 className="spaces__space-name">My Home</h2>
              <Badge tone="primary">Owner</Badge>
            </div>
            <p className="nl-muted" style={{ marginTop: 4, fontSize: 'var(--nl-text-sm)' }}>
              Signed in as {user?.email}
            </p>
          </div>
          <div className="nl-spacer" />
          <StatusDot
            tone={activeDevices.length > 0 ? 'secure' : 'offline'}
            label={
              activeDevices.length > 0
                ? `${trustedCount} trusted of ${activeDevices.length}`
                : 'No devices yet'
            }
          />
        </div>

        {error && (
          <div style={{ marginTop: 16 }}>
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        <SpaceMap nodes={nodes} animated={!reducedMotion} loading={devices === null} />
      </section>

      <div className="spaces__grid">
        <Card
          title="This Space"
          subtitle="A Space is one location — your home, your office, your shop."
        >
          <dl className="spaces__facts">
            <div>
              <dt>Devices enrolled</dt>
              <dd>{devices === null ? '—' : activeDevices.length}</dd>
            </div>
            <div>
              <dt>Trusted devices</dt>
              <dd>{devices === null ? '—' : trustedCount}</dd>
            </div>
            <div>
              <dt>People invited</dt>
              <dd>0</dd>
            </div>
            <div>
              <dt>Network health</dt>
              <dd className="spaces__fact-ok">Control plane reachable</dd>
            </div>
          </dl>
          <div style={{ marginTop: 20 }}>
            <Button variant="secondary" onClick={() => onNavigate('devices')}>
              Manage devices
            </Button>
          </div>
        </Card>

        <Card
          title="What is live today"
          subtitle="Phase 1 is complete: accounts, verification and trusted devices."
        >
          <ul className="spaces__checklist">
            <li className="spaces__checklist-item spaces__checklist-item--done">
              Accounts with Argon2id password hashing
            </li>
            <li className="spaces__checklist-item spaces__checklist-item--done">
              Six-digit email verification, single use, ten minutes
            </li>
            <li className="spaces__checklist-item spaces__checklist-item--done">
              New-device verification with Trust This Device
            </li>
            <li className="spaces__checklist-item spaces__checklist-item--done">
              Per-device key pairs, revocable one at a time
            </li>
            <li className="spaces__checklist-item spaces__checklist-item--done">
              An audit trail of every security event
            </li>
            <li className="spaces__checklist-item">
              Agent heartbeats and live online state <Badge tone="later">Phase 2</Badge>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
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
        aria-label={`Map of My Home. ${positioned
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
          My Home
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
