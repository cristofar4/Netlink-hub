import { z } from 'zod';

/**
 * Spaces, agents and the resources an agent offers.
 *
 * A Space is a location — My Home, My Office, My Shop. An Agent is the
 * background service on one computer in that Space. A Resource is something
 * the owner has explicitly approved that agent to expose.
 */

export const AGENT_STATUSES = ['offline', 'online', 'unreachable'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * How long after its last heartbeat an agent is treated as offline.
 *
 * Three missed beats at the default 30-second interval. Two would make a
 * single dropped packet look like an outage; four takes too long to notice a
 * machine that genuinely went away.
 */
export const AGENT_HEARTBEAT_INTERVAL_SECONDS = 30;
export const AGENT_OFFLINE_AFTER_SECONDS = AGENT_HEARTBEAT_INTERVAL_SECONDS * 3;

/** Enrollment tokens are handed straight to a local process, so they are short. */
export const ENROLLMENT_TOKEN_TTL_SECONDS = 300;

export const createSpaceRequestSchema = z.object({
  name: z.string().trim().min(1, 'Give this Space a name').max(60),
});
export type CreateSpaceRequest = z.infer<typeof createSpaceRequestSchema>;

export const renameSpaceRequestSchema = createSpaceRequestSchema;

export type SpaceSummary = {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  /** True when the caller owns this Space rather than being an invited member. */
  isOwner: boolean;
  agentCount: number;
  onlineAgentCount: number;
  memberCount: number;
  resourceCount: number;
};

export type AgentSummary = {
  id: string;
  spaceId: string;
  deviceId: string;
  name: string;
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  isWakeHelper: boolean;
  wakeOnLanReady: boolean;
  /** Present only for the owner; a member never needs the local address. */
  localIpAddress: string | null;
  macAddress: string | null;
  appVersion: string | null;
  createdAt: string;
};

export const RESOURCE_KINDS = ['folder', 'printer'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type ResourceSummary = {
  id: string;
  spaceId: string;
  agentId: string;
  agentName: string;
  kind: ResourceKind;
  name: string;
  /** The approved folder root, or the printer's Windows name. */
  target: string;
  enabled: boolean;
  metadata: Record<string, string | number | boolean | null> | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Agent-facing contracts
// ---------------------------------------------------------------------------

export const agentEnrollRequestSchema = z.object({
  installationId: z.string().uuid(),
  publicKey: z.string().min(32).max(128),
  publicKeyAlgorithm: z.literal('ed25519'),
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['windows', 'macos', 'linux']),
  kind: z.literal('agent'),
  osVersion: z.string().trim().max(128).optional(),
  appVersion: z.string().trim().max(64).optional(),
  enrollmentToken: z.string().min(20).max(512),
});
export type AgentEnrollRequest = z.infer<typeof agentEnrollRequestSchema>;

export type AgentEnrollResponse = {
  deviceId: string;
  /**
   * The agent's own id, distinct from the device's.
   *
   * One identifies the installation, the other identifies its membership of a
   * Space. Remote session grants are addressed to this one, and an agent that
   * does not know it cannot recognise a grant meant for it.
   */
  agentId: string;
  spaceId: string;
  /** Echoed so the agent can confirm it enrolled where it expected to. */
  spaceName: string;
  heartbeatIntervalSeconds: number;
};

/**
 * What an agent reports on each beat.
 *
 * State, never content: whether the machine is up, its local address, whether
 * it can act as a Wake Helper. No file names, no window titles, no activity.
 */
export const agentHeartbeatRequestSchema = z.object({
  deviceId: z.string().uuid(),
  status: z.enum(['online', 'unreachable']),
  localIpAddress: z.string().max(64).optional(),
  macAddress: z.string().max(32).optional(),
  wakeOnLanReady: z.boolean().default(false),
  isWakeHelper: z.boolean().default(false),
  appVersion: z.string().max(64).optional(),
  sentAt: z.string(),
});
export type AgentHeartbeatRequest = z.infer<typeof agentHeartbeatRequestSchema>;

export type AgentHeartbeatResponse = {
  acknowledged: boolean;
  /** True once the owner has revoked this device; the agent then forgets its identity. */
  revoked: boolean;
  message?: string;
  /**
   * Repeated on every beat, not only at enrollment, so an installation that
   * enrolled before this field existed learns its agent id without anyone
   * having to re-enrol it.
   */
  agentId?: string;
  heartbeatIntervalSeconds: number;
  /** Signed commands waiting for this agent. */
  pendingCommands: unknown[];
};

export const agentResourceReportSchema = z.object({
  deviceId: z.string().uuid(),
  resources: z
    .array(
      z.object({
        kind: z.enum(RESOURCE_KINDS),
        name: z.string().trim().min(1).max(200),
        target: z.string().trim().min(1).max(400),
        metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      }),
    )
    .max(200),
});
export type AgentResourceReport = z.infer<typeof agentResourceReportSchema>;

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * Messages pushed over the WebSocket so the dashboard reflects reality without
 * polling. Every payload is state the caller is already allowed to see.
 */
export type LiveEvent =
  | { type: 'agent.status'; spaceId: string; agentId: string; status: AgentStatus; at: string }
  | { type: 'space.updated'; spaceId: string }
  | { type: 'resources.updated'; spaceId: string; agentId: string }
  | { type: 'data.usage'; spaceId: string; memberId: string; usedBytes: string }
  | {
      type: 'power.result';
      spaceId: string;
      agentId: string;
      commandId: string;
      succeeded: boolean;
    }
  | {
      type: 'remote.signal';
      spaceId: string;
      sessionId: string;
      /** Which side wrote it, so a peer ignores the echo of its own message. */
      from: 'viewer' | 'host';
      seq: number;
    }
  | {
      type: 'remote.session';
      spaceId: string;
      sessionId: string;
      agentId: string;
      state: 'pending' | 'connecting' | 'active' | 'ended';
    }
  | { type: 'ping'; at: string };

/** Computes agent status from its last heartbeat, so the rule lives in one place. */
export function statusFromHeartbeat(
  lastHeartbeatAt: Date | string | null,
  now: Date = new Date(),
): AgentStatus {
  if (!lastHeartbeatAt) return 'offline';
  const last = typeof lastHeartbeatAt === 'string' ? new Date(lastHeartbeatAt) : lastHeartbeatAt;
  if (Number.isNaN(last.getTime())) return 'offline';
  const age = (now.getTime() - last.getTime()) / 1000;
  return age <= AGENT_OFFLINE_AFTER_SECONDS ? 'online' : 'offline';
}

// ---------------------------------------------------------------------------
// Space overview
// ---------------------------------------------------------------------------

/**
 * One checked fact behind the network health score.
 *
 * Health is not a mood. Every point in the score comes from a signal that was
 * actually evaluated against the database, and each one carries the sentence
 * the UI shows when it fails, so a low score can always be explained rather
 * than merely displayed.
 */
export type HealthSignal = {
  id: HealthSignalId;
  label: string;
  ok: boolean;
  /** Why this signal passed or failed, in the words the owner reads. */
  detail: string;
  /** Points this signal contributes when it passes. The weights total 100. */
  weight: number;
};

export const HEALTH_SIGNAL_IDS = [
  'computers.online',
  'wake.helper',
  'data.connected',
  'data.remaining',
  'resources.shared',
  'security.clean',
] as const;
export type HealthSignalId = (typeof HEALTH_SIGNAL_IDS)[number];

/**
 * The weights, in one place so the score and its explanation cannot drift.
 *
 * A computer you can reach is most of what a Space is for, so it carries the
 * largest share. Security events come next: a run of denials matters more than
 * a printer nobody shared.
 */
export const HEALTH_SIGNAL_WEIGHTS: Readonly<Record<HealthSignalId, number>> = {
  'computers.online': 30,
  'security.clean': 20,
  'data.connected': 15,
  'data.remaining': 15,
  'wake.helper': 10,
  'resources.shared': 10,
};

/** How far back `security.clean` looks for denied or failed events. */
export const HEALTH_SECURITY_WINDOW_HOURS = 24;
/** Below this share of the balance, `data.remaining` fails. */
export const HEALTH_DATA_REMAINING_FLOOR = 0.1;

export type SpaceOverview = {
  spaceId: string;
  spaceName: string;
  isOwner: boolean;
  agentCount: number;
  onlineAgentCount: number;
  folderCount: number;
  printerCount: number;
  memberCount: number;
  /** Remote desktop sessions that are connecting or live right now. */
  activeSessionCount: number;
  /** Null when this Space has no Data Pool, or the caller may not manage it. */
  data: {
    isDemo: boolean;
    balanceBytes: string;
    usedBytes: string;
    remainingBytes: string;
    /** Null when there is no usage history to project from. */
    projectedDaysRemaining: number | null;
  } | null;
  health: {
    /** 0–100: the summed weights of every signal that passed. */
    score: number;
    signals: HealthSignal[];
  };
};

/** Sums the passing signals. Kept here so both sides score a Space alike. */
export function healthScore(signals: readonly HealthSignal[]): number {
  return signals.reduce((total, signal) => (signal.ok ? total + signal.weight : total), 0);
}
