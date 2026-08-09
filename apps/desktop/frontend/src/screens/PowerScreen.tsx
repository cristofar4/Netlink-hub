import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, OtpInput, StatusDot } from '@netlink/ui';
import {
  POWER_ACTION_LABELS,
  POWER_COUNTDOWN_SECONDS,
  isDestructivePowerAction,
  type AgentPowerState,
  type PowerAction,
  type PowerCommandSummary,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import './power.css';

/**
 * Device Power and Wake.
 *
 * Every button here says why it cannot be pressed rather than silently doing
 * nothing, because "Turn On is greyed out" is useless and "no Wake Helper is
 * online on the same network" is actionable.
 *
 * Restart and shutdown ask for a six-digit code and then show a countdown the
 * owner can stop. The countdown is not cosmetic: the control plane withholds
 * the command from the agent until it elapses.
 */
export function PowerScreen({ space }: { space: SpaceSummary | null }) {
  const [states, setStates] = useState<AgentPowerState[] | null>(null);
  const [history, setHistory] = useState<PowerCommandSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ agentId: string; action: PowerAction } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!space) return;
    try {
      const [state, recent] = await Promise.all([
        api.powerState(space.id),
        api.powerHistory(space.id, 10),
      ]);
      setStates(state);
      setHistory(recent);
      setError(null);
    } catch (caught) {
      setStates([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the power state.');
    }
  }, [space]);

  useEffect(() => {
    void load();
  }, [load]);

  // A pending command has a countdown, so the view has to keep up with it.
  const hasPending = states?.some((state) => state.pending) ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [hasPending, load]);

  if (!space) return <Card>Select a Space first.</Card>;
  if (states === null) return <Card>Loading…</Card>;

  const run = async (
    agentId: string,
    action: PowerAction,
    confirmation?: Record<string, string>,
  ) => {
    setBusy(`${agentId}:${action}`);
    setError(null);
    try {
      await api.requestPowerCommand(space.id, { action, targetAgentId: agentId, ...confirmation });
      setNotice(
        isDestructivePowerAction(action)
          ? `${POWER_ACTION_LABELS[action]} will happen in ${POWER_COUNTDOWN_SECONDS} seconds. You can still stop it.`
          : `${POWER_ACTION_LABELS[action]} sent.`,
      );
      setConfirming(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That action did not go through.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="info">{notice}</Alert>}

      {states.length === 0 && (
        <Card>
          <EmptyState
            title="No computers yet"
            description="Connect the NetLink agent on a computer to control its power from here."
          />
        </Card>
      )}

      {states.map((state) => (
        <Card key={state.agentId}>
          <div className="nl-row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 'var(--nl-text-lg)' }}>{state.agentName}</strong>
                {state.isWakeHelper && <Badge tone="cyan">Wake Helper</Badge>}
              </div>
            </div>
            <StatusDot
              tone={state.online ? 'online' : 'offline'}
              label={state.online ? 'Online' : 'Off or unreachable'}
            />
          </div>

          {/*
           * Waking a computer that is switched off takes a second machine on
           * the same network to send the packet. When that is the situation,
           * the pair is drawn — the relationship is the whole explanation for
           * why "Turn on" is available here and greyed out somewhere else.
           */}
          {!state.online && (
            <WakePair
              target={state}
              helper={
                states.find(
                  (candidate) =>
                    candidate.agentId !== state.agentId &&
                    candidate.isWakeHelper &&
                    candidate.online,
                ) ?? null
              }
            />
          )}

          {state.pending ? (
            <PendingCommand
              command={state.pending}
              busy={busy === `${state.agentId}:power.cancel`}
              onCancel={() => void run(state.agentId, 'power.cancel')}
            />
          ) : (
            <div className="power__actions">
              {state.actions
                .filter((entry) => entry.action !== 'power.cancel')
                .map((entry) => (
                  <div key={entry.action} className="power__action">
                    <Button
                      variant={
                        entry.action === 'power.shutdown' || entry.action === 'power.restart'
                          ? 'danger'
                          : entry.action === 'power.wake'
                            ? 'primary'
                            : 'secondary'
                      }
                      size="sm"
                      disabled={!entry.allowed}
                      loading={busy === `${state.agentId}:${entry.action}`}
                      onClick={() => {
                        if (entry.requiresStepUp) {
                          setConfirming({ agentId: state.agentId, action: entry.action });
                        } else {
                          void run(state.agentId, entry.action);
                        }
                      }}
                    >
                      {POWER_ACTION_LABELS[entry.action]}
                    </Button>
                    {/* A disabled button with no explanation is just a dead end. */}
                    {entry.reason && <span className="power__reason">{entry.reason}</span>}
                  </div>
                ))}
            </div>
          )}

          {!state.online && (
            <WakeReadinessPanel
              readiness={state.wake}
              spaceId={space.id}
              agentId={state.agentId}
              isOwner={space.isOwner}
              onChanged={() => void load()}
            />
          )}

          {space.isOwner && (
            <div className="power__helper">
              <label className="power__check">
                <input
                  type="checkbox"
                  checked={state.isWakeHelper}
                  onChange={async (event) => {
                    await api.setWakeHelper(space.id, state.agentId, event.target.checked);
                    await load();
                  }}
                />
                <span>
                  Use this computer as a Wake Helper
                  <span className="power__hint">
                    It stays online and sends the magic packet that wakes another computer on the
                    same local network. Waking is impossible without one.
                  </span>
                </span>
              </label>
            </div>
          )}

          {confirming?.agentId === state.agentId && (
            <StepUpConfirm
              spaceId={space.id}
              action={confirming.action}
              agentName={state.agentName}
              onCancel={() => setConfirming(null)}
              onConfirmed={(fields) => void run(state.agentId, confirming.action, fields)}
            />
          )}
        </Card>
      ))}

      {history.length > 0 && (
        <Card title="Power activity" subtitle="Every request and its result, most recent first.">
          <ul className="power__timeline">
            {history.map((command) => (
              <li key={command.id} className={`power__event power__event--${command.state}`}>
                <span className="power__event-mark" aria-hidden="true" />
                <span className="power__event-body">
                  <span className="power__event-title">
                    {POWER_ACTION_LABELS[command.action]} · {command.targetAgentName}
                  </span>
                  <span className="power__event-detail">
                    <Badge
                      tone={
                        command.state === 'succeeded'
                          ? 'success'
                          : command.state === 'failed'
                            ? 'danger'
                            : command.state === 'cancelled'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {command.state}
                    </Badge>
                    {command.detail && <span>{command.detail}</span>}
                  </span>
                </span>
                <time className="power__event-time" dateTime={command.requestedAt}>
                  {new Date(command.requestedAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="power__footnote">
        Every power action is recorded, and the destructive ones ask for a six-digit code first.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The wake pair
// ---------------------------------------------------------------------------

/**
 * The helper and the machine it can wake.
 *
 * Drawn only when the target is offline, because that is the only time it
 * matters. With no helper online the path is dashed and the caption says
 * plainly that nothing here can turn this computer on — which is the truth, and
 * is more useful than a diagram implying otherwise.
 */
function WakePair({ target, helper }: { target: AgentPowerState; helper: AgentPowerState | null }) {
  return (
    <div className="power__pair">
      <div className="power__pair-node power__pair-node--online">
        <span className="power__pair-disc" aria-hidden="true">
          <MonitorGlyph />
        </span>
        <span className="power__pair-name">{helper?.agentName ?? 'No helper online'}</span>
        <span className="power__pair-state">{helper ? 'Wake Helper · online' : 'Cannot wake'}</span>
      </div>

      <div className={`power__pair-link${helper ? ' power__pair-link--live' : ''}`}>
        <span className="power__pair-link-label">
          {helper ? 'Same local network' : 'No path to wake'}
        </span>
      </div>

      <div className="power__pair-node">
        <span className="power__pair-disc" aria-hidden="true">
          <MonitorGlyph />
        </span>
        <span className="power__pair-name">{target.agentName}</span>
        <span className="power__pair-state">Powered off or unreachable</span>
      </div>
    </div>
  );
}

function MonitorGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The countdown
// ---------------------------------------------------------------------------

function PendingCommand({
  command,
  busy,
  onCancel,
}: {
  command: PowerCommandSummary;
  busy: boolean;
  onCancel: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(command.executeAt));

  useEffect(() => {
    setSecondsLeft(secondsUntil(command.executeAt));
    const timer = window.setInterval(() => setSecondsLeft(secondsUntil(command.executeAt)), 250);
    return () => window.clearInterval(timer);
  }, [command.executeAt]);

  const counting = command.cancellable && secondsLeft > 0;

  return (
    <div className={`power__pending${counting ? ' power__pending--counting' : ''}`}>
      <div className="nl-row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <strong>{POWER_ACTION_LABELS[command.action]}</strong>
        {counting ? (
          <span className="power__countdown" aria-live="polite">
            in {secondsLeft}s
          </span>
        ) : (
          <Badge tone="warning">Sent to the computer</Badge>
        )}
        <div className="nl-spacer" />
        {command.cancellable ? (
          <Button variant="secondary" size="sm" loading={busy} onClick={onCancel}>
            Stop it
          </Button>
        ) : (
          <span className="power__reason">
            The computer already has this command and it cannot be called back.
          </span>
        )}
      </div>
      {counting && (
        <div className="power__countdown-track" aria-hidden="true">
          <div
            className="power__countdown-fill"
            style={{ width: `${(secondsLeft / POWER_COUNTDOWN_SECONDS) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(Math.ceil((new Date(iso).getTime() - Date.now()) / 1000), 0);
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

function StepUpConfirm({
  spaceId,
  action,
  agentName,
  onCancel,
  onConfirmed,
}: {
  spaceId: string;
  action: PowerAction;
  agentName: string;
  onCancel: () => void;
  onConfirmed: (fields: { stepUpChallengeId: string; stepUpCode: string }) => void;
}) {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedEmail, setMaskedEmail] = useState<string>('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(true);
  const requested = useRef(false);

  useEffect(() => {
    // Guarded so React's development double-invoke does not send two codes,
    // which would invalidate the first one the moment it arrived.
    if (requested.current) return;
    requested.current = true;

    void api
      .requestPowerStepUp(spaceId, action)
      .then((challenge) => {
        setChallengeId(challenge.challengeId);
        setMaskedEmail(challenge.maskedEmail);
      })
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setSending(false));
  }, [spaceId, action]);

  return (
    <div className="power__stepup">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Confirm {POWER_ACTION_LABELS[action].toLowerCase()} on {agentName}
      </div>
      <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
        {sending
          ? 'Sending a confirmation code…'
          : `Enter the six-digit code we sent to ${maskedEmail}. This interrupts whoever is using that computer, so we ask every time.`}
      </p>

      <div style={{ marginTop: 16 }}>
        <OtpInput
          value={code}
          onChange={setCode}
          onComplete={(value) => {
            if (challengeId) onConfirmed({ stepUpChallengeId: challengeId, stepUpCode: value });
          }}
          disabled={!challengeId}
          invalid={Boolean(error)}
          autoFocus
        />
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <div className="nl-row" style={{ gap: 8, marginTop: 14 }}>
        <Button
          variant="primary"
          size="sm"
          disabled={code.length < 6 || !challengeId}
          onClick={() => {
            if (challengeId) onConfirmed({ stepUpChallengeId: challengeId, stepUpCode: code });
          }}
        >
          Confirm
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wake readiness
// ---------------------------------------------------------------------------

function WakeReadinessPanel({
  readiness,
  spaceId,
  agentId,
  isOwner,
  onChanged,
}: {
  readiness: AgentPowerState['wake'];
  spaceId: string;
  agentId: string;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const [mac, setMac] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checks: Array<[string, boolean | null]> = [
    ['Wake-on-LAN enabled', readiness.wakeOnLanEnabled],
    ['Network adapter available', readiness.networkAdapterFound],
    ['Power connected', readiness.powerConnected],
    ['Wake Helper online', readiness.wakeHelperOnline],
    ['Ethernet or wake-capable connection', readiness.wakeCapableLink],
    ['Target address registered', readiness.targetMacRegistered],
  ];

  return (
    <div className="power__readiness">
      <div className="nl-row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--nl-text-sm)' }}>Before this computer can be woken</strong>
        {readiness.ready ? (
          <Badge tone="success">Ready</Badge>
        ) : (
          <Badge tone="warning">Not ready</Badge>
        )}
        {readiness.helperAgentName && (
          <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
            via {readiness.helperAgentName}
          </span>
        )}
      </div>

      <ul className="power__checks">
        {checks.map(([label, value]) => (
          <li key={label} className={`power__check-item power__check-item--${describe(value)}`}>
            {label}
            {value === null && (
              <span className="power__hint"> — cannot be detected on this hardware</span>
            )}
          </li>
        ))}
      </ul>

      {isOwner && !readiness.targetMacRegistered && (
        <form
          className="nl-row"
          style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setBusy(true);
            try {
              await api.registerMac(spaceId, agentId, mac.trim());
              setMac('');
              onChanged();
            } catch (caught) {
              setError(
                caught instanceof ApiError ? caught.message : 'Could not register that address.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <div style={{ flex: '1 1 240px' }}>
            <Input
              label="Network address (MAC)"
              value={mac}
              onChange={(event) => setMac(event.target.value)}
              placeholder="00:1A:2B:3C:4D:5E"
              hint="Run `ipconfig /all` on that computer and copy its Physical Address."
              error={error ?? undefined}
              disabled={busy}
            />
          </div>
          <Button type="submit" variant="secondary" size="sm" loading={busy}>
            Register
          </Button>
        </form>
      )}
    </div>
  );
}

function describe(value: boolean | null): 'ok' | 'missing' | 'unknown' {
  if (value === null) return 'unknown';
  return value ? 'ok' : 'missing';
}
