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
  heartbeatIntervalSeconds: number;
  /** Signed commands waiting for this agent. Empty until Phase 4. */
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
