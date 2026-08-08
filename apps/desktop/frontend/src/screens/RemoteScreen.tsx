import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, OtpInput, StatusDot } from '@netlink/ui';
import {
  CONNECTION_STRATEGY_LABELS,
  REMOTE_END_REASON_LABELS,
  REMOTE_MAX_DURATION_SECONDS,
  type AgentSummary,
  type ConnectionStrategy,
  type RemoteSessionMode,
  type RemoteSessionSummary,
  type RemoteSessionTicket,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { RemoteViewer, buttonName, normalisePointer } from '../lib/remote';
import './remote.css';

/**
 * Network Access — remote desktop.
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
export function RemoteScreen({ space }: { space: SpaceSummary | null }) {
  const [computers, setComputers] = useState<AgentSummary[] | null>(null);
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([]);
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
      const [agents, recent] = await Promise.all([
        api.listAgents(space.id),
        api.listRemoteSessions(space.id, 10),
      ]);
      setComputers(agents);
      setSessions(recent);
      setError(null);
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

  if (!space) return <Card>Select a Space first.</Card>;
  if (computers === null) return <Card>Loading…</Card>;

  const begin = async (
    agent: AgentSummary,
    mode: RemoteSessionMode,
    confirmation?: { stepUpChallengeId: string; stepUpCode: string },
  ) => {
    setError(null);
    setNotice(null);
    try {
      const ticket = await api.createRemoteSession(space.id, {
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

  if (live) {
    return (
      <RemoteStage
        key={live.session.id}
        spaceId={space.id}
        ticket={live}
        onLeave={async () => {
          setLive(null);
          setNotice('The session has ended.');
          await load();
        }}
      />
    );
  }

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="success">{notice}</Alert>}

      {computers.length === 0 ? (
        <Card>
          <EmptyState
            title="No computers in this Space"
            description="Install the NetLink agent on the computer you want to reach, then enrol it from My Spaces."
          />
        </Card>
      ) : (
        computers.map((agent) => (
          <Card
            key={agent.id}
            title={agent.name}
            subtitle={
              agent.status === 'online' ? 'Online and reachable' : 'Not reachable right now'
            }
            actions={
              <StatusDot
                tone={agent.status === 'online' ? 'online' : 'offline'}
                label={agent.status === 'online' ? 'Online' : 'Offline'}
              />
            }
          >
            <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                disabled={agent.status !== 'online'}
                onClick={async () => {
                  const ticket = await begin(agent, 'view');
                  if (ticket) setLive(ticket);
                }}
              >
                Watch the screen
              </Button>
              <Button
                variant="primary"
                disabled={agent.status !== 'online'}
                onClick={() => setConnecting({ agent, mode: 'control' })}
              >
                Take control
              </Button>
              {agent.status !== 'online' && (
                <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                  Turn it on from Device Power and Wake first.
                </span>
              )}
            </div>
          </Card>
        ))
      )}

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

      {sessions.length > 0 && (
        <Card
          title="Recent sessions"
          subtitle="NetLink records who connected, to which computer, and for how long — never what was on the screen."
        >
          <ul className="nl-stack" style={{ gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
            {sessions.map((session) => (
              <li key={session.id} className="remote__row">
                <Badge tone={session.mode === 'control' ? 'warning' : 'neutral'}>
                  {session.mode === 'control' ? 'Full control' : 'View only'}
                </Badge>
                <span style={{ fontSize: 'var(--nl-text-sm)', flex: '1 1 160px', minWidth: 0 }}>
                  {session.agentName}
                </span>
                <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                  {session.viewerName} ·{' '}
                  {session.endReason
                    ? REMOTE_END_REASON_LABELS[session.endReason]
                    : CONNECTION_STRATEGY_LABELS[session.strategy]}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live session
// ---------------------------------------------------------------------------

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
}: {
  spaceId: string;
  ticket: RemoteSessionTicket;
  onLeave: () => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<RemoteViewer | null>(null);
  const [state, setState] = useState<RTCPeerConnectionState>('new');
  const [strategy, setStrategy] = useState<ConnectionStrategy>('unknown');
  const [latency, setLatency] = useState<number | null>(null);
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
        }
        context.drawImage(bitmap, 0, 0);
        // The bitmap holds decoded pixels; releasing it explicitly keeps a
        // 15fps stream from leaning on the garbage collector.
        bitmap.close();
        setLatency(latencyMs);
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

  return (
    <div className="nl-stack" style={{ gap: 16 }}>
      <Card
        title={session.agentName}
        subtitle={
          control
            ? 'You are controlling this computer. Anyone sitting at it can see everything you do.'
            : 'You are watching this screen. Nothing you type or click is sent.'
        }
        actions={
          <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Badge tone={control ? 'warning' : 'cyan'}>
              {control ? 'Full control' : 'View only'}
            </Badge>
            <StatusDot
              tone={state === 'connected' ? 'online' : state === 'failed' ? 'offline' : 'warning'}
              label={
                state === 'connected'
                  ? CONNECTION_STRATEGY_LABELS[strategy]
                  : state === 'failed'
                    ? 'Connection failed'
                    : 'Connecting…'
              }
            />
          </div>
        }
      >
        {error && <Alert tone="error">{error}</Alert>}

        {state !== 'connected' && !error && (
          <Alert tone="info">
            Finding a path between the two computers.
            {!ticket.relayAvailable &&
              ' No relay is configured, so this only works if a direct connection is possible.'}
          </Alert>
        )}

        <div className={`remote__stage${control ? '' : ' remote__stage--view'}`}>
          <canvas ref={canvasRef} className="remote__canvas" {...pointerHandlers} />
          {!control && <div className="remote__watermark">View only</div>}
        </div>

        <div className="remote__meta">
          <span>{formatDuration(elapsed)}</span>
          <span>{latency === null ? 'Measuring…' : `${latency} ms`}</span>
          <span>{CONNECTION_STRATEGY_LABELS[strategy]}</span>
          <span className="nl-dim">Ends automatically in {formatDuration(remaining)}</span>
        </div>

        <div className="nl-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => void onLeave()}>
            End session
          </Button>
        </div>
      </Card>

      <Card subtitle="Nothing on this screen passes through NetLink's servers. The picture and your keystrokes travel directly between the two computers.">
        <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
          Session {session.id.slice(0, 8)} in {spaceId.slice(0, 8)}
        </span>
      </Card>
    </div>
  );
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
