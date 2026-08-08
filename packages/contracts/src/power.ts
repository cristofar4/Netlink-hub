import { z } from 'zod';

/**
 * Device Power and Wake.
 *
 * Turning someone's computer off is the most disruptive thing NetLink can do,
 * so every command is signed, addressed to one machine, time-bounded, single-use
 * and audited — and the destructive ones give the person sitting at the machine
 * ten seconds to stop it.
 *
 * The action list is fixed and closed. There is no verb here that runs a
 * program, and there never will be.
 */

export const POWER_ACTIONS = [
  'power.wake',
  'power.restart',
  'power.shutdown',
  'power.lock',
  'power.sleep',
  'power.cancel',
] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

/** How long a person at the machine has to cancel a restart or shutdown. */
export const POWER_COUNTDOWN_SECONDS = 10;

/** A command that has not been collected within this window is dead. */
export const POWER_COMMAND_TTL_SECONDS = 120;

export const POWER_ACTION_LABELS: Readonly<Record<PowerAction, string>> = {
  'power.wake': 'Turn on',
  'power.restart': 'Restart',
  'power.shutdown': 'Shut down',
  'power.lock': 'Lock',
  'power.sleep': 'Sleep',
  'power.cancel': 'Cancel pending shutdown',
};

/** The capability each action needs. Wake and cancel share `power.wake`. */
export const POWER_ACTION_PERMISSIONS: Readonly<Record<PowerAction, string>> = {
  'power.wake': 'power.wake',
  'power.restart': 'power.restart',
  'power.shutdown': 'power.shutdown',
  'power.lock': 'power.lock',
  'power.sleep': 'power.sleep',
  'power.cancel': 'power.wake',
};

/** Actions that interrupt whatever the person at the machine is doing. */
export function isDestructivePowerAction(action: PowerAction): boolean {
  return action === 'power.restart' || action === 'power.shutdown';
}

/**
 * Actions that need the target agent already running.
 *
 * Wake is the exception, and the reason a Wake Helper exists at all: a machine
 * that is switched off cannot receive anything from the cloud.
 */
export function requiresTargetOnline(action: PowerAction): boolean {
  return action !== 'power.wake';
}

export const POWER_COMMAND_STATES = [
  'pending',
  'countdown',
  'sent',
  'acknowledged',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;
export type PowerCommandState = (typeof POWER_COMMAND_STATES)[number];

export const powerCommandRequestSchema = z.object({
  action: z.enum(POWER_ACTIONS),
  targetAgentId: z.string().uuid(),
  /**
   * A fresh six-digit code, required for restart and shutdown. Requested from
   * `/power/step-up` immediately before the command.
   */
  stepUpChallengeId: z.string().uuid().optional(),
  stepUpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type PowerCommandRequest = z.infer<typeof powerCommandRequestSchema>;

export type PowerCommandSummary = {
  id: string;
  spaceId: string;
  action: PowerAction;
  state: PowerCommandState;
  targetAgentId: string;
  targetAgentName: string;
  helperAgentId: string | null;
  helperAgentName: string | null;
  requestedAt: string;
  /** When the countdown ends and the command is actually sent. Null if none. */
  executeAt: string | null;
  expiresAt: string;
  detail: string | null;
  /** True while the person who asked can still call it off. */
  cancellable: boolean;
};

/**
 * Every precondition for waking a machine, checked and shown before the button
 * is offered. Nothing here is inferred — each field is separately observed.
 */
export type WakeReadiness = {
  wakeOnLanEnabled: boolean;
  networkAdapterFound: boolean;
  /** Undetectable on many desktops, so it is displayed but never blocks. */
  powerConnected: boolean | null;
  wakeHelperOnline: boolean;
  wakeCapableLink: boolean;
  targetMacRegistered: boolean;
  ready: boolean;
  blockers: string[];
  helperAgentId: string | null;
  helperAgentName: string | null;
};

export type AgentPowerState = {
  agentId: string;
  agentName: string;
  online: boolean;
  isWakeHelper: boolean;
  /** Which actions this caller may attempt right now, and why not otherwise. */
  actions: Array<{
    action: PowerAction;
    allowed: boolean;
    requiresStepUp: boolean;
    reason: string | null;
  }>;
  wake: WakeReadiness;
  pending: PowerCommandSummary | null;
};

export const setWakeHelperRequestSchema = z.object({
  isWakeHelper: z.boolean(),
});

export const registerMacRequestSchema = z.object({
  macAddress: z
    .string()
    .trim()
    .regex(
      /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{12}$/,
      'Enter a MAC address like 00:1A:2B:3C:4D:5E',
    ),
});

/** What the agent posts back after acting on a command. */
export const powerResultSchema = z.object({
  deviceId: z.string().uuid(),
  commandId: z.string().uuid(),
  succeeded: z.boolean(),
  detail: z.string().max(500).optional(),
});
export type PowerResult = z.infer<typeof powerResultSchema>;
