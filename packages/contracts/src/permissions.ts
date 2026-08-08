/**
 * NetLink capability model.
 *
 * Everything is deny-by-default. A principal (a trusted personal device, or an
 * invited member holding a NetLink Pass) has *only* the capabilities explicitly
 * granted to it. There is no implicit inheritance: holding `data.use` never
 * implies `files.read`, and holding `devices.view` never implies `power.*`.
 *
 * `devices.observe` — watching a screen — is deliberately separate from
 * `devices.control`. Folding the two together would make "view only" a label
 * rather than a boundary: everyone allowed to watch would also be allowed to
 * type. Keeping them apart is what lets an owner hand out one without the
 * other, and is what the agent's view-only gate actually enforces.
 */

export const PERMISSIONS = [
  'data.use',
  'data.manage',
  'devices.view',
  'devices.observe',
  'devices.control',
  'files.read',
  'files.upload',
  'files.delete',
  'printers.use',
  'power.wake',
  'power.restart',
  'power.shutdown',
  'power.lock',
  'power.sleep',
  'invitations.create',
  'members.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/**
 * Human-facing copy. Used by the desktop UI so permission lists never render a
 * raw identifier to an owner deciding what to hand out.
 */
export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  'data.use': 'Use shared data',
  'data.manage': 'Manage the Data Pool',
  'devices.view': 'See computers in this Space',
  'devices.observe': "Watch a computer's screen, without control",
  'devices.control': 'Remotely control computers',
  'files.read': 'Browse and download approved files',
  'files.upload': 'Upload files',
  'files.delete': 'Delete files',
  'printers.use': 'Print to approved printers',
  'power.wake': 'Turn on a computer',
  'power.restart': 'Restart a computer',
  'power.shutdown': 'Shut down a computer',
  'power.lock': 'Lock a computer',
  'power.sleep': 'Put a computer to sleep',
  'invitations.create': 'Invite people',
  'members.manage': 'Manage members and their access',
};

/**
 * Sensitive capabilities require a fresh step-up verification before the action
 * is accepted, even when the principal already holds the permission.
 */
export const STEP_UP_PERMISSIONS: readonly Permission[] = [
  'devices.control',
  'files.delete',
  'power.restart',
  'power.shutdown',
  'members.manage',
];

export function requiresStepUp(permission: Permission): boolean {
  return STEP_UP_PERMISSIONS.includes(permission);
}

/** Principal roles recognised by the control plane. */
export const PRINCIPAL_ROLES = ['owner', 'trusted_device', 'invited_member'] as const;
export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number];

/**
 * The complete capability set an owner holds over their own Space. Owners are
 * still evaluated through the same check path — the role is not a bypass, it
 * simply resolves to this grant set.
 */
export const OWNER_PERMISSIONS: readonly Permission[] = [...PERMISSIONS];

/**
 * A Data-Only pass. This is deliberately a single capability: a Data-Only
 * member can consume their data allocation and nothing else. It must never be
 * widened by defaulting logic elsewhere in the system.
 */
export const DATA_ONLY_PERMISSIONS: readonly Permission[] = ['data.use'];

/**
 * Capabilities an invited member receives when the owner grants nothing
 * explicitly. Deliberately empty: an invitation with no grants can do nothing.
 */
export const DEFAULT_INVITED_MEMBER_PERMISSIONS: readonly Permission[] = [];

/**
 * Capabilities a newly trusted personal device receives. A device that has just
 * completed new-device verification can see the Space and its computers, but is
 * granted no power, file-mutation or remote-control capability until the owner
 * assigns it.
 */
export const DEFAULT_TRUSTED_DEVICE_PERMISSIONS: readonly Permission[] = ['devices.view'];

export type PermissionDecision = {
  readonly allowed: boolean;
  readonly permission: Permission;
  /** Machine-readable reason, surfaced in audit records. */
  readonly reason: 'granted' | 'not_granted' | 'principal_suspended' | 'principal_expired';
};

export type PrincipalGrant = {
  readonly role: PrincipalRole;
  readonly permissions: readonly Permission[];
  readonly suspended?: boolean;
  /** ISO-8601 timestamp. A pass past its expiry grants nothing. */
  readonly expiresAt?: string | null;
};

/**
 * The single authority for "may this principal do this?".
 *
 * Both the API guards and the desktop UI call this, so a button is never shown
 * for something the server would reject, and the server never trusts the UI.
 */
export function evaluatePermission(
  grant: PrincipalGrant,
  permission: Permission,
  now: Date = new Date(),
): PermissionDecision {
  if (grant.suspended) {
    return { allowed: false, permission, reason: 'principal_suspended' };
  }
  if (grant.expiresAt) {
    const expiry = new Date(grant.expiresAt);
    if (!Number.isNaN(expiry.getTime()) && expiry.getTime() <= now.getTime()) {
      return { allowed: false, permission, reason: 'principal_expired' };
    }
  }
  if (!grant.permissions.includes(permission)) {
    return { allowed: false, permission, reason: 'not_granted' };
  }
  return { allowed: true, permission, reason: 'granted' };
}

export function hasPermission(
  grant: PrincipalGrant,
  permission: Permission,
  now: Date = new Date(),
): boolean {
  return evaluatePermission(grant, permission, now).allowed;
}

/**
 * Surfaces the Data-Only isolation rule as a predicate the UI and API share:
 * a principal whose only capability is `data.use` must never be shown, or be
 * able to reach, computers, files, printers, members or power controls.
 */
export function isDataOnlyPrincipal(grant: PrincipalGrant): boolean {
  return (
    grant.role === 'invited_member' &&
    grant.permissions.length === 1 &&
    grant.permissions[0] === 'data.use'
  );
}
