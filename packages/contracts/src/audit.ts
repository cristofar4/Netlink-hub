/**
 * Audit contract.
 *
 * Every security-relevant request produces exactly one audit record with its
 * outcome. Audit records deliberately carry *no* content: no file bytes, no
 * message text, no passwords, no browsing history, no precise location.
 */

export const AUDIT_ACTIONS = [
  'auth.register.started',
  'auth.register.completed',
  'auth.email.verification.sent',
  'auth.email.verification.failed',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.login.challenge.issued',
  'auth.device.verification.succeeded',
  'auth.device.verification.failed',
  'auth.token.refreshed',
  'auth.token.reuse_detected',
  'auth.logout',
  'device.registered',
  'device.trusted',
  'device.renamed',
  'device.revoked',
  'device.heartbeat',
  'permission.denied',
  'space.created',
  'space.renamed',
  'resource.enabled',
  'resource.disabled',
  'invitation.created',
  'invitation.claimed',
  'invitation.revoked',
  'data.allocation.created',
  'data.allocation.updated',
  'data.allocation.paused',
  'data.allocation.revoked',
  'power.command.requested',
  'power.command.result',
  'file.listed',
  'file.downloaded',
  'file.uploaded',
  'file.deleted',
  'printer.job.submitted',
  'printer.job.result',
  'remote.session.started',
  'remote.session.ended',
  'remote.session.denied',
  'remote.input.refused',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditOutcome = 'success' | 'failure' | 'denied';

export type AuditRecord = {
  id: string;
  action: AuditAction;
  outcome: AuditOutcome;
  createdAt: string;
  actorUserId: string | null;
  actorDeviceId: string | null;
  targetDeviceId: string | null;
  spaceId: string | null;
  /** Coarse location derived from IP, city-level at best. */
  approximateLocation: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Small, non-sensitive structured detail (e.g. `{ "reason": "not_granted" }`). */
  metadata: Record<string, string | number | boolean | null> | null;
};

export type AuditPage = {
  items: AuditRecord[];
  nextCursor: string | null;
};

/**
 * Human-facing copy for the Activity screen. Keeping it beside the action list
 * means a new action cannot be added without deciding how a user will read it.
 */
export const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  'auth.register.started': 'Started creating an account',
  'auth.register.completed': 'Created a NetLink account',
  'auth.email.verification.sent': 'Sent an email verification code',
  'auth.email.verification.failed': 'Failed an email verification',
  'auth.login.succeeded': 'Signed in',
  'auth.login.failed': 'Failed a sign-in attempt',
  'auth.login.challenge.issued': 'Requested a new-device code',
  'auth.device.verification.succeeded': 'Verified a new device',
  'auth.device.verification.failed': 'Failed a new-device verification',
  'auth.token.refreshed': 'Renewed a session',
  'auth.token.reuse_detected': 'Detected a reused session token',
  'auth.logout': 'Signed out',
  'device.registered': 'Registered a device',
  'device.trusted': 'Trusted a device',
  'device.renamed': 'Renamed a device',
  'device.revoked': 'Revoked a device',
  'device.heartbeat': 'Agent heartbeat',
  'permission.denied': 'Blocked an action without permission',
  'space.created': 'Created a Space',
  'space.renamed': 'Renamed a Space',
  'resource.enabled': 'Started sharing a resource',
  'resource.disabled': 'Stopped sharing a resource',
  'invitation.created': 'Created a NetLink Pass',
  'invitation.claimed': 'Accepted a NetLink Pass',
  'invitation.revoked': 'Revoked a NetLink Pass',
  'data.allocation.created': 'Allocated data',
  'data.allocation.updated': 'Updated a data allocation',
  'data.allocation.paused': 'Paused a data allocation',
  'data.allocation.revoked': 'Revoked a data allocation',
  'power.command.requested': 'Requested a power action',
  'power.command.result': 'Power action result',
  'file.listed': 'Browsed approved files',
  'file.downloaded': 'Downloaded a file',
  'file.uploaded': 'Uploaded a file',
  'file.deleted': 'Deleted a file',
  'printer.job.submitted': 'Sent a print job',
  'printer.job.result': 'Print job result',
  'remote.session.started': 'Started a remote session',
  'remote.session.ended': 'Ended a remote session',
  'remote.session.denied': 'Blocked a remote session',
  'remote.input.refused': 'Refused input on a view-only session',
};
