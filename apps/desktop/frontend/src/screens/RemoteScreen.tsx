import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  OtpInput,
  Sparkline,
  StatTile,
  StatusDot,
} from '@netlink/ui';
import {
  CONNECTION_STRATEGY_LABELS,
  PERMISSION_LABELS,
  REMOTE_END_REASON_LABELS,
  REMOTE_MAX_DURATION_SECONDS,
  type AgentSummary,
  type ConnectionStrategy,
  type MemberAccessRow,
  type RemoteSessionMode,
  type RemoteSessionSummary,
  type RemoteSessionTicket,
  type ResourceSummary,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { RemoteViewer, buttonName, normalisePointer } from '../lib/remote';
import type { SectionId } from './sections';
import './remote.css';

/**
 * Network Access — the computers, folders and printers this Space can reach,
 * and the remote desktop sessions that reach them.
 *
 * Two modes, and the difference between them is real rather than cosmetic.
 * A view-only session sends nothing: the pointer handlers are not attached, and
 * even if they were, the computer at the other end refuses input it was not
 * granted, checked against a signature this app cannot forge.
 *
 * Taking control asks for a six-digit code first, for the same reason
 * restarting someone's machine does — holding the permission is necessary but
 * not sufficient for something the person sitting there will notice.
 */
export function RemoteScreen({
  space,
  onNavigate,
}: {
  space: SpaceSummary | null;
  onNavigate: (section: SectionId) => void;
}) {
  const [computers, setComputers] = useState<AgentSummary[] | null>(null);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [members, setMembers] = useState<MemberAccessRow[]>([]);
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{
    agent: AgentSummary;
    mode: RemoteSessionMode;
  } | null>(null);
  const [live, setLive] = useState<RemoteSessionTicket | null>(null);

  const load = useCallback(async () => {
    if (!space) return;
    try {
      const [agents, recent, resourceList] = await Promise.all([
        api.listAgents(space.id),
        api.listRemoteSessions(space.id, 10),
        api.listResources(space.id),
      ]);
      setComputers(agents);
      setSessions(recent);
      setResources(resourceList);
      setError(null);
      // Only an owner may enumerate members; for everyone else this panel is
      // simply absent rather than empty.
      setMembers(await api.memberAccess(space.id).catch(() => []));
    } catch (caught) {
      setComputers([]);
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load remote desktop access.',
      );
    }
  }, [space]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void api.pingLatencyMs().then((value) => {
      if (!cancelled) setLatencyMs(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const begin = async (
    agent: AgentSummary,
    mode: RemoteSessionMode,
    confirmation?: { stepUpChallengeId: string; stepUpCode: string },
  ) => {
    setError(null);
    setNotice(null);
    try {
      const ticket = await api.createRemoteSession(space!.id, {
        agentId: agent.id,
        mode,
        ...confirmation,
      });
      setConnecting(null);
      return ticket;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That session was not started.');
      return null;
    }
  };

  if (!space) return <Card>Select a Space first.</Card>;
  if (computers === null) return <Card>Loading…</Card>;

  if (live) {
    return (
      <RemoteStage
        key={live.session.id}
        spaceId={space.id}
        ticket={live}
        onNavigate={onNavigate}
        onLeave={async () => {
          setLive(null);
          setNotice('The session has ended.');
          await load();
        }}
      />
    );
  }

  const online = computers.filter((agent) => agent.status === 'online');
  const folders = resources.filter((item) => item.kind === 'folder' && item.enabled);
  const printers = resources.filter((item) => item.kind === 'printer' && item.enabled);
  const liveSessions = sessions.filter(
    (session) => session.state === 'active' || session.state === 'connecting',
  );

  return (
    <div className="remote">
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="success">{notice}</Alert>}

      {/*
       * A statement about how the product works, not a live reading. The
       * picture and the keystrokes go directly between the two devices; the
       * control plane only introduces them.
       */}
      <section className="remote__assurance nl-card">
        <span className="remote__assurance-mark" aria-hidden="true">
          <ShieldIcon />
        </span>
        <div>
          <strong>Sessions are end-to-end encrypted</strong>
          <p>
            Screens, keystrokes and files travel directly between your devices. NetLink records that
            a session happened — never what was on the screen.
          </p>
        </div>
      </section>

      <div className="remote__tiles">
        <StatTile
          icon={<GlobeIcon />}
          label="Computers"
          value={online.length}
          detail={`of ${computers.length} online`}
          tone={online.length > 0 ? 'success' : 'warning'}
        />
        <StatTile
          icon={<FolderIcon />}
          label="Shared resources"
          value={folders.length + printers.length}
          detail={`${folders.length} folder${folders.length === 1 ? '' : 's'}, ${printers.length} printer${printers.length === 1 ? '' : 's'}`}
          tone="cyan"
        />
        <StatTile
          icon={<PeopleIcon />}
          label="Active sessions"
          value={liveSessions.length}
          detail={liveSessions.length === 0 ? 'Nobody is connected' : 'Connected now'}
        />
        <StatTile
          icon={<GaugeIcon />}
          label="Latency"
          value={latencyMs === null ? 'No answer' : latencyMs}
          unit={latencyMs === null ? undefined : 'ms'}
          detail="To the control plane"
          tone={latencyMs === null ? 'warning' : 'primary'}
        />
      </div>

      <div className="remote__body">
        <div className="remote__main">
          <Card
            title="Remote resources"
            subtitle="Everything this Space has approved. A resource you have not shared does not appear."
          >
            {computers.length === 0 && folders.length === 0 && printers.length === 0 ? (
              <EmptyState
                title="Nothing to reach yet"
                description="Install the NetLink agent on the computer you want to reach, then enrol it from the Overview screen."
              />
            ) : (
              <div className="remote__resources">
                {computers.map((agent) => (
                  <article key={agent.id} className="remote__resource">
                    <div className="remote__resource-art remote__resource-art--screen">
                      <MonitorGlyph />
                    </div>
                    <h3 className="remote__resource-name">{agent.name}</h3>
                    <p className="remote__resource-detail">
                      {agent.appVersion ? `NetLink agent ${agent.appVersion}` : 'NetLink agent'}
                    </p>
                    <StatusDot
                      tone={agent.status === 'online' ? 'online' : 'offline'}
                      label={agent.status === 'online' ? 'Online' : 'Offline'}
                    />
                    <div className="remote__resource-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={agent.status !== 'online'}
                        onClick={() => setConnecting({ agent, mode: 'control' })}
                      >
                        Connect
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={agent.status !== 'online'}
                        onClick={async () => {
                          const ticket = await begin(agent, 'view');
                          if (ticket) setLive(ticket);
                        }}
                      >
                        Watch
                      </Button>
                    </div>
                    {agent.status !== 'online' && (
                      <button
                        type="button"
                        className="remote__resource-hint"
                        onClick={() => onNavigate('power')}
                      >
                        Turn it on from Device Power and Wake
                      </button>
                    )}
                  </article>
                ))}

                {folders.length > 0 && (
                  <article className="remote__resource">
                    <div className="remote__resource-art remote__resource-art--folder">
                      <FolderGlyph />
                    </div>
                    <h3 className="remote__resource-name">Approved files</h3>
                    <p className="remote__resource-detail">
                      {folders.length} folder{folders.length === 1 ? '' : 's'}
                    </p>
                    <StatusDot tone="online" label="Available" />
                    <div className="remote__resource-actions">
                      <Button variant="primary" size="sm" onClick={() => onNavigate('files')}>
                        Browse
                      </Button>
                    </div>
                  </article>
                )}

                {printers.length > 0 && (
                  <article className="remote__resource">
                    <div className="remote__resource-art remote__resource-art--printer">
                      <PrinterGlyph />
                    </div>
                    <h3 className="remote__resource-name">Printers</h3>
                    <p className="remote__resource-detail">
                      {printers.length} shared · {printers[0].agentName}
                    </p>
                    <StatusDot tone="online" label="Ready" />
                    <div className="remote__resource-actions">
                      <Button variant="primary" size="sm" onClick={() => onNavigate('printers')}>
                        Print
                      </Button>
                    </div>
                  </article>
                )}
              </div>
            )}
          </Card>

          <Card
            title="Recent connections"
            subtitle="Who connected, to which computer, and how it went — never what was on the screen."
          >
            {sessions.length === 0 ? (
              <p className="remote__lede">No remote session has been started in this Space yet.</p>
            ) : (
              <div className="remote__table-wrap">
                <table className="remote__table">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Computer</th>
                      <th scope="col">Mode</th>
                      <th scope="col">Started</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session) => (
                      <tr key={session.id}>
                        <td>{session.viewerName}</td>
                        <td>{session.agentName}</td>
                        <td>
                          <Badge tone={session.mode === 'control' ? 'warning' : 'neutral'}>
                            {session.mode === 'control' ? 'Full control' : 'View only'}
                          </Badge>
                        </td>
                        <td className="remote__table-dim">
                          {new Date(session.startedAt).toLocaleString()}
                        </td>
                        <td>
                          <StatusDot
                            tone={
                              session.state === 'active'
                                ? 'online'
                                : session.state === 'ended'
                                  ? 'offline'
                                  : 'connecting'
                            }
                            label={
                              session.endReason
                                ? REMOTE_END_REASON_LABELS[session.endReason]
                                : CONNECTION_STRATEGY_LABELS[session.strategy]
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="remote__side">
          <Card title="Access permissions" subtitle="What each person here is allowed to reach.">
            {members.filter((member) => member.role !== 'owner').length === 0 ? (
              <p className="remote__lede">
                Nobody else has access to this Space. Share data or access from the Data Pool
                screen.
              </p>
            ) : (
              <ul className="remote__members">
                {members
                  .filter((member) => member.role !== 'owner')
                  .map((member) => (
                    <li key={member.memberId} className="remote__member">
                      <div className="remote__member-head">
                        <span className="remote__member-avatar" aria-hidden="true">
                          {member.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="remote__member-name">{member.name}</span>
                        {member.suspended && <Badge tone="warning">Suspended</Badge>}
                      </div>
                      <ul className="remote__grants">
                        {member.permissions.length === 0 ? (
                          <li className="remote__grant remote__grant--none">Nothing granted</li>
                        ) : (
                          member.permissions.map((permission) => (
                            <li key={permission} className="remote__grant">
                              {PERMISSION_LABELS[permission]}
                            </li>
                          ))
                        )}
                      </ul>
                    </li>
                  ))}
              </ul>
            )}

            <div className="remote__side-actions">
              <Button variant="primary" onClick={() => onNavigate('members')}>
                Manage access
              </Button>
              <Button variant="secondary" onClick={() => onNavigate('data')}>
                Create a Pass
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {connecting && (
        <ConfirmControlDialog
          spaceId={space.id}
          agentName={connecting.agent.name}
          onCancel={() => setConnecting(null)}
          onConfirmed={async (confirmation) => {
            const ticket = await begin(connecting.agent, 'control', confirmation);
            if (ticket) setLive(ticket);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live session
// ---------------------------------------------------------------------------

/** How many latency samples the performance line keeps. */
const LATENCY_SAMPLES = 40;

/**
 * The connected view.
 *
 * The canvas is the only place a frame ever lands — nothing is written to disk,
 * and no frame is kept once the next one replaces it.
 */
function RemoteStage({
  spaceId,
  ticket,
  onLeave,
  onNavigate,
}: {
  spaceId: string;
  ticket: RemoteSessionTicket;
  onLeave: () => Promise<void>;
  onNavigate: (section: SectionId) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<RemoteViewer | null>(null);
  const [state, setState] = useState<RTCPeerConnectionState>('new');
  const [strategy, setStrategy] = useState<ConnectionStrategy>('unknown');
  const [latency, setLatency] = useState<number | null>(null);
  const [samples, setSamples] = useState<number[]>([]);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const session = ticket.session;
  const control = session.mode === 'control';

  /*
  The viewer is created here rather than by the caller, because it needs the
  canvas to exist before it can paint into it — and because unmounting has to
  end the session. A screen still being streamed to a window nobody is looking
  at is the one outcome this feature must never produce.
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;

    const viewer = new RemoteViewer(spaceId, ticket, {
      onFrame: (bitmap, _seq, latencyMs) => {
        if (!canvas || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          setResolution({ width: bitmap.width, height: bitmap.height });
        }
        context.drawImage(bitmap, 0, 0);
        // The bitmap holds decoded pixels; releasing it explicitly keeps a
        // 15fps stream from leaning on the garbage collector.
        bitmap.close();
        setLatency(latencyMs);
        setSamples((current) => [...current, latencyMs].slice(-LATENCY_SAMPLES));
      },
      onStrategy: setStrategy,
      onState: setState,
      onError: setError,
      onClosed: () => setState('closed'),
    });

    viewerRef.current = viewer;
    void viewer.start().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'The session could not be started.');
    });

    return () => {
      viewerRef.current = null;
      void viewer.close('viewer_left');
    };
  }, [spaceId, ticket]);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Keyboard is captured at the window while a control session is live, so
  // typing works without having to click the canvas first.
  useEffect(() => {
    if (!control) return;

    const down = (event: KeyboardEvent) => {
      event.preventDefault();
      viewerRef.current?.sendInput({ kind: 'key.down', code: event.code });
    };
    const up = (event: KeyboardEvent) => {
      event.preventDefault();
      viewerRef.current?.sendInput({ kind: 'key.up', code: event.code });
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [control]);

  const pointerHandlers = control
    ? {
        onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const { x, y } = normalisePointer(canvas, event.clientX, event.clientY);
          viewerRef.current?.sendInput({ kind: 'mouse.move', x, y });
        },
        onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => {
          const canvas = canvasRef.current;
          const button = buttonName(event.button);
          if (!canvas || !button) return;
          const { x, y } = normalisePointer(canvas, event.clientX, event.clientY);
          viewerRef.current?.sendInput({ kind: 'mouse.down', x, y, button });
        },
        onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => {
          const canvas = canvasRef.current;
          const button = buttonName(event.button);
          if (!canvas || !button) return;
          const { x, y } = normalisePointer(canvas, event.clientX, event.clientY);
          viewerRef.current?.sendInput({ kind: 'mouse.up', x, y, button });
        },
        onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const { x, y } = normalisePointer(canvas, event.clientX, event.clientY);
          viewerRef.current?.sendInput({ kind: 'mouse.wheel', x, y, deltaY: event.deltaY / 100 });
        },
        onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
      }
    : {};

  const remaining = REMOTE_MAX_DURATION_SECONDS - elapsed;
  const quality = describeQuality(latency);
  // A fixed ceiling for the line: the scale must not shrink to flatter a
  // connection that is getting worse.
  const latencyCeiling = Math.max(200, ...samples);

  return (
    <div className="stage">
      <header className="stage__bar">
        <span className="stage__bar-title">
          <MonitorGlyph />
          {session.agentName}
        </span>
        <StatusDot
          tone={state === 'connected' ? 'online' : state === 'failed' ? 'offline' : 'warning'}
          label={
            state === 'connected'
              ? 'Connected'
              : state === 'failed'
                ? 'Connection failed'
                : 'Connecting…'
          }
        />
        <span className="stage__bar-metric">{latency === null ? '—' : `${latency} ms`}</span>
        <Badge tone={control ? 'warning' : 'cyan'}>{control ? 'Full control' : 'View only'}</Badge>

        <div className="nl-spacer" />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const element = stageRef.current;
            if (!element) return;
            if (document.fullscreenElement) void document.exitFullscreen();
            else void element.requestFullscreen().catch(() => setError('Full screen was refused.'));
          }}
        >
          Full screen
        </Button>
        <Button variant="danger" size="sm" onClick={() => void onLeave()}>
          Disconnect
        </Button>
      </header>

      {error && <Alert tone="error">{error}</Alert>}

      {state !== 'connected' && !error && (
        <Alert tone="info">
          Finding a path between the two computers.
          {!ticket.relayAvailable &&
            ' No relay is configured, so this only works if a direct connection is possible.'}
        </Alert>
      )}

      <div className="stage__body">
        <div ref={stageRef} className={`remote__stage${control ? '' : ' remote__stage--view'}`}>
          <canvas ref={canvasRef} className="remote__canvas" {...pointerHandlers} />
          {!control && <div className="remote__watermark">View only</div>}
        </div>

        <aside className="stage__panel">
          <Card title="Session details">
            <dl className="stage__facts">
              <div>
                <dt>Computer</dt>
                <dd>{session.agentName}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{control ? 'Full control' : 'View only'}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>{CONNECTION_STRATEGY_LABELS[strategy]}</dd>
              </div>
              <div>
                <dt>Quality</dt>
                <dd className={`stage__quality stage__quality--${quality.tone}`}>
                  {quality.label}
                </dd>
              </div>
              <div>
                <dt>Resolution</dt>
                <dd>
                  {resolution
                    ? `${resolution.width} × ${resolution.height}`
                    : 'Waiting for a frame'}
                </dd>
              </div>
              <div>
                <dt>Elapsed</dt>
                <dd>{formatDuration(elapsed)}</dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Connection performance"
            subtitle="Round trip of each frame, most recent last."
          >
            {samples.length < 2 ? (
              <p className="remote__lede">Measuring…</p>
            ) : (
              <Sparkline
                points={samples}
                max={latencyCeiling}
                label={`Frame latency over the last ${samples.length} frames, currently ${latency} milliseconds.`}
                trailingLabel="Now"
              />
            )}
          </Card>

          <Card title="Quick actions">
            <div className="stage__actions">
              <Button variant="secondary" onClick={() => onNavigate('files')}>
                Transfer files
              </Button>
              <Button variant="secondary" onClick={() => onNavigate('printers')}>
                Send to printer
              </Button>
              {/*
               * Power actions live on their own screen because each one asks
               * for a fresh six-digit code. Reproducing that flow inside a live
               * session would mean two step-up dialogs with different rules.
               */}
              <Button variant="secondary" onClick={() => onNavigate('power')}>
                Power and wake
              </Button>
            </div>
          </Card>

          <p className="stage__note">
            Ends automatically in {formatDuration(remaining)}. Nothing on this screen passes through
            NetLink&rsquo;s servers.
          </p>
        </aside>
      </div>
    </div>
  );
}

/**
 * Puts a word to the round-trip figure.
 *
 * The thresholds are about what a person feels when they move a pointer: under
 * 60 ms the far cursor keeps up, past 150 ms it visibly lags. The number is
 * always shown beside the word, so nobody has to take the label's word for it.
 */
function describeQuality(latency: number | null): {
  label: string;
  tone: 'good' | 'fair' | 'poor';
} {
  if (latency === null) return { label: 'Measuring…', tone: 'fair' };
  if (latency <= 60) return { label: 'Excellent', tone: 'good' };
  if (latency <= 150) return { label: 'Good', tone: 'fair' };
  return { label: 'Laggy', tone: 'poor' };
}

// ---------------------------------------------------------------------------

function ConfirmControlDialog({
  spaceId,
  agentName,
  onCancel,
  onConfirmed,
}: {
  spaceId: string;
  agentName: string;
  onCancel: () => void;
  onConfirmed: (confirmation: { stepUpChallengeId: string; stepUpCode: string }) => Promise<void>;
}) {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedEmail, setMaskedEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const challenge = await api.requestRemoteStepUp(spaceId);
        if (cancelled) return;
        setChallengeId(challenge.challengeId);
        setMaskedEmail(challenge.maskedEmail);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : 'Could not send a code.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="dialog__scrim" role="presentation" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="control-title" className="dialog__title">
          Take control of {agentName}
        </h2>
        <p className="dialog__body">
          Taking control lets you move the pointer and type on that computer. Anyone sitting at it
          will see everything you do. Enter the six-digit code we sent to {maskedEmail || 'you'}.
        </p>

        {error && <Alert tone="error">{error}</Alert>}

        <OtpInput
          value={code}
          onChange={setCode}
          disabled={busy || !challengeId}
          invalid={Boolean(error)}
          autoFocus
          onComplete={async (value) => {
            if (!challengeId) return;
            setBusy(true);
            setError(null);
            try {
              await onConfirmed({ stepUpChallengeId: challengeId, stepUpCode: value });
            } finally {
              setBusy(false);
            }
          }}
        />

        <div className="nl-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const safe = Math.max(seconds, 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
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

function ShieldIcon() {
  return (
    <svg {...stroke} width={22} height={22}>
      <path d="M12 3.5 5 6v6c0 4.2 2.9 7.4 7 8.5 4.1-1.1 7-4.3 7-8.5V6Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg {...stroke}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...stroke}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg {...stroke}>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 7.5a3 3 0 0 1 0 5.5M17 19a5.5 5.5 0 0 0-2-4.3" />
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

function MonitorGlyph() {
  return (
    <svg {...stroke} width={18} height={18}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg {...stroke} width={34} height={34}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function PrinterGlyph() {
  return (
    <svg {...stroke} width={34} height={34}>
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="7" rx="2" />
      <path d="M7 14h10v6H7z" />
    </svg>
  );
}
