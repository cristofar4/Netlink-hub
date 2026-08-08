import { z } from 'zod';

/**
 * Remote desktop.
 *
 * The pixels and the keystrokes travel directly between the two machines over
 * WebRTC. The control plane never sees either — it authorises the session,
 * brokers the connection, and records that it happened.
 *
 * That has one consequence which shapes everything below: **the server cannot
 * be the thing that stops a view-only session from typing.** It never sees the
 * input. So the mode is fixed at authorisation time, sealed inside a signed
 * grant, and enforced by the agent, which is the only party that can refuse to
 * move the mouse.
 */

export const REMOTE_SESSION_MODES = ['view', 'control'] as const;
export type RemoteSessionMode = (typeof REMOTE_SESSION_MODES)[number];

export const REMOTE_SESSION_MODE_LABELS: Readonly<Record<RemoteSessionMode, string>> = {
  view: 'View only',
  control: 'Full control',
};

/**
 * The capabilities each mode needs.
 *
 * `devices.observe` is separate from `devices.control` on purpose. Without it,
 * "view only" could not be granted independently — anyone allowed to watch a
 * screen would also be allowed to type on it, which makes the whole mode
 * meaningless. Control additionally requires observe, because controlling a
 * machine you cannot see is not a coherent thing to grant.
 */
export const REMOTE_MODE_PERMISSIONS: Readonly<Record<RemoteSessionMode, readonly string[]>> = {
  view: ['devices.observe'],
  control: ['devices.observe', 'devices.control'],
};

export const REMOTE_SESSION_STATES = ['pending', 'connecting', 'active', 'ended'] as const;
export type RemoteSessionState = (typeof REMOTE_SESSION_STATES)[number];

export const REMOTE_END_REASONS = [
  'viewer_left',
  'host_ended',
  'host_offline',
  'idle_timeout',
  'max_duration',
  'connect_timeout',
  'permission_revoked',
  'failed',
] as const;
export type RemoteEndReason = (typeof REMOTE_END_REASONS)[number];

export const REMOTE_END_REASON_LABELS: Readonly<Record<RemoteEndReason, string>> = {
  viewer_left: 'You ended the session',
  host_ended: 'Ended at the computer',
  host_offline: 'The computer went offline',
  idle_timeout: 'Ended after a period with no activity',
  max_duration: 'Reached the maximum session length',
  connect_timeout: 'The two machines could not connect in time',
  permission_revoked: 'Your access was changed while connected',
  failed: 'The connection failed',
};

/** A grant is short-lived; connecting has to happen promptly or not at all. */
export const REMOTE_GRANT_TTL_SECONDS = 120;

/** How long the two peers have to actually establish a connection. */
export const REMOTE_CONNECT_TIMEOUT_SECONDS = 45;

/** A session with no input and no viewer heartbeat for this long is closed. */
export const REMOTE_IDLE_TIMEOUT_SECONDS = 300;

/** A hard ceiling, so a forgotten window cannot watch a screen indefinitely. */
export const REMOTE_MAX_DURATION_SECONDS = 4 * 60 * 60;

/** The viewer says "still here" on this cadence; the idle clock resets. */
export const REMOTE_HEARTBEAT_SECONDS = 20;

// ---------------------------------------------------------------------------
// ICE
// ---------------------------------------------------------------------------

/**
 * One ICE server, in the shape RTCPeerConnection expects.
 *
 * TURN credentials are ephemeral: the username carries its own expiry and the
 * password is derived from it, so a leaked pair stops working within minutes
 * and cannot be used to relay anything else.
 */
export type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export const CONNECTION_STRATEGIES = ['direct', 'relayed', 'unknown'] as const;
export type ConnectionStrategy = (typeof CONNECTION_STRATEGIES)[number];

export const CONNECTION_STRATEGY_LABELS: Readonly<Record<ConnectionStrategy, string>> = {
  direct: 'Direct connection',
  relayed: 'Relayed connection',
  unknown: 'Connecting…',
};

/**
 * Derives the strategy from the ICE candidate pair actually in use.
 *
 * A relayed pair is not a failure — it is what happens behind a symmetric NAT,
 * and it still carries end-to-end encrypted media. It is shown because a relay
 * is slower, and because a person deserves to know their pixels are taking a
 * detour through a server.
 */
export function strategyFromCandidateTypes(
  local: string | null | undefined,
  remote: string | null | undefined,
): ConnectionStrategy {
  if (!local || !remote) return 'unknown';
  if (local === 'relay' || remote === 'relay') return 'relayed';
  return 'direct';
}

// ---------------------------------------------------------------------------
// The signed grant
// ---------------------------------------------------------------------------

/**
 * What the control plane signs and the agent verifies.
 *
 * `mode` is inside the signature. A viewer who edits their copy to say
 * "control" produces a grant the agent will not accept, and the agent is the
 * only side that can actually move the mouse.
 */
export type RemoteGrant = {
  sessionId: string;
  spaceId: string;
  /** The computer being viewed. */
  agentId: string;
  mode: RemoteSessionMode;
  /** Recorded for audit, not used for authorisation — that already happened. */
  requestedBy: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};

export type RemoteGrantEnvelope = {
  grant: RemoteGrant;
  signature: string;
  keyId: string;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const createRemoteSessionSchema = z.object({
  agentId: z.string().uuid(),
  mode: z.enum(REMOTE_SESSION_MODES),
  /** Control is a step-up action, same as restarting the machine. */
  stepUpChallengeId: z.string().uuid().optional(),
  stepUpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type CreateRemoteSessionRequest = z.infer<typeof createRemoteSessionSchema>;

export type RemoteSessionSummary = {
  id: string;
  spaceId: string;
  agentId: string;
  agentName: string;
  mode: RemoteSessionMode;
  state: RemoteSessionState;
  viewerName: string;
  /** True when this session belongs to the caller. */
  isMine: boolean;
  strategy: ConnectionStrategy;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  endReason: RemoteEndReason | null;
  expiresAt: string;
};

/** What the viewer receives when a session is granted. */
export type RemoteSessionTicket = {
  session: RemoteSessionSummary;
  iceServers: IceServer[];
  /**
   * True when a TURN server is configured. Without one, two peers that are both
   * behind symmetric NAT will not connect, and the UI says so rather than
   * spinning.
   */
  relayAvailable: boolean;
};

// ---------------------------------------------------------------------------
// Signalling
// ---------------------------------------------------------------------------

export const SIGNAL_KINDS = ['offer', 'answer', 'candidate', 'bye'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_ROLES = ['viewer', 'host'] as const;
export type SignalRole = (typeof SIGNAL_ROLES)[number];

/**
 * One signalling message.
 *
 * Bounded in size: SDP and ICE candidates are small, and an unbounded field
 * that both ends can write to is a place to park data the server should not be
 * carrying.
 */
export const remoteSignalSchema = z.object({
  sessionId: z.string().uuid(),
  kind: z.enum(SIGNAL_KINDS),
  payload: z.string().max(20_000),
});
export type RemoteSignalRequest = z.infer<typeof remoteSignalSchema>;

export type RemoteSignal = {
  seq: number;
  sessionId: string;
  from: SignalRole;
  kind: SignalKind;
  payload: string;
  createdAt: string;
};

/** What the agent posts when the peer connection settles. */
export const remoteConnectedSchema = z.object({
  deviceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  localCandidateType: z.string().max(20).optional(),
  remoteCandidateType: z.string().max(20).optional(),
});

export const remoteEndSchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.enum(REMOTE_END_REASONS),
  detail: z.string().max(300).optional(),
});

/**
 * The agent reporting that a view-only session tried to send input.
 *
 * This should never happen with the stock client, which is exactly why it is
 * worth recording when it does: it means someone modified their side.
 */
export const remoteViolationSchema = z.object({
  deviceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  kind: z.literal('input_on_view_only'),
  count: z.number().int().min(1).max(10_000),
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const INPUT_KINDS = [
  'mouse.move',
  'mouse.down',
  'mouse.up',
  'mouse.wheel',
  'key.down',
  'key.up',
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

/**
 * A single input event, as it crosses the data channel.
 *
 * Coordinates are normalised 0..1 rather than pixels, so a viewer on a laptop
 * and a host on a 4K monitor agree without either side knowing the other's
 * resolution. The host clamps anyway — a value outside the range is a bug or an
 * attack, and neither should be able to steer the pointer off-screen.
 */
export type InputEvent =
  | { kind: 'mouse.move'; x: number; y: number }
  | { kind: 'mouse.down' | 'mouse.up'; x: number; y: number; button: MouseButton }
  | { kind: 'mouse.wheel'; x: number; y: number; deltaY: number }
  | { kind: 'key.down' | 'key.up'; code: string };

/**
 * Key codes are passed through as W3C `KeyboardEvent.code` values, which are
 * physical positions rather than characters. They are bounded in length and
 * validated against a character class so nothing arbitrary reaches the host's
 * key mapping.
 */
export const KEY_CODE_PATTERN = /^[A-Za-z0-9]{1,24}$/;

export function isValidKeyCode(code: string): boolean {
  return KEY_CODE_PATTERN.test(code);
}

/** Rate ceiling per session, so a data channel cannot be used to flood a host. */
export const INPUT_EVENTS_PER_SECOND = 200;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const FRAME_QUALITIES = ['low', 'balanced', 'sharp'] as const;
export type FrameQuality = (typeof FRAME_QUALITIES)[number];

export const FRAME_QUALITY_LABELS: Readonly<Record<FrameQuality, string>> = {
  low: 'Smoothest',
  balanced: 'Balanced',
  sharp: 'Sharpest',
};

/**
 * JPEG quality and frame budget per setting.
 *
 * Kept here rather than in the agent so the viewer can show honestly what it is
 * asking for, and so the two ends cannot drift apart.
 */
export const FRAME_QUALITY_SETTINGS: Readonly<
  Record<FrameQuality, { jpegQuality: number; maxFps: number; maxWidth: number }>
> = {
  low: { jpegQuality: 45, maxFps: 20, maxWidth: 1280 },
  balanced: { jpegQuality: 65, maxFps: 15, maxWidth: 1600 },
  sharp: { jpegQuality: 82, maxFps: 10, maxWidth: 1920 },
};

/** The header the host prepends to each frame on the data channel. */
export type FrameHeader = {
  seq: number;
  width: number;
  height: number;
  /** Milliseconds since the session started, for a latency read-out. */
  at: number;
};

export function remoteSessionIsLive(state: RemoteSessionState): boolean {
  return state === 'pending' || state === 'connecting' || state === 'active';
}
