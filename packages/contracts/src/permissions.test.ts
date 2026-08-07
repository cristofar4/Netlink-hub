import { describe, expect, it } from 'vitest';
import {
  DATA_ONLY_PERMISSIONS,
  DEFAULT_INVITED_MEMBER_PERMISSIONS,
  DEFAULT_TRUSTED_DEVICE_PERMISSIONS,
  OWNER_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  type PrincipalGrant,
  evaluatePermission,
  hasPermission,
  isDataOnlyPrincipal,
  isPermission,
  requiresStepUp,
} from './permissions';

const dataOnly: PrincipalGrant = {
  role: 'invited_member',
  permissions: ['data.use'],
};

describe('permission catalogue', () => {
  it('contains every capability the product defines', () => {
    expect([...PERMISSIONS]).toEqual([
      'data.use',
      'data.manage',
      'devices.view',
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
    ]);
  });

  it('rejects unknown permission strings', () => {
    expect(isPermission('data.use')).toBe(true);
    expect(isPermission('files.everything')).toBe(false);
    expect(isPermission('')).toBe(false);
    expect(isPermission(null)).toBe(false);
  });
});

describe('deny by default', () => {
  it('grants nothing to an invited member with no explicit permissions', () => {
    const grant: PrincipalGrant = {
      role: 'invited_member',
      permissions: DEFAULT_INVITED_MEMBER_PERMISSIONS,
    };
    for (const permission of PERMISSIONS) {
      expect(hasPermission(grant, permission)).toBe(false);
    }
  });

  it('gives a newly trusted device visibility but no control', () => {
    const grant: PrincipalGrant = {
      role: 'trusted_device',
      permissions: DEFAULT_TRUSTED_DEVICE_PERMISSIONS,
    };
    expect(hasPermission(grant, 'devices.view')).toBe(true);
    for (const permission of [
      'devices.control',
      'power.wake',
      'power.restart',
      'power.shutdown',
      'power.lock',
      'power.sleep',
      'files.read',
      'files.upload',
      'files.delete',
      'printers.use',
      'members.manage',
      'invitations.create',
      'data.manage',
    ] satisfies Permission[]) {
      expect(hasPermission(grant, permission)).toBe(false);
    }
  });

  it('reports why a capability was refused', () => {
    const decision = evaluatePermission(dataOnly, 'files.read');
    expect(decision).toEqual({ allowed: false, permission: 'files.read', reason: 'not_granted' });
  });
});

describe('data-only isolation', () => {
  it('allows only data.use', () => {
    expect(hasPermission(dataOnly, 'data.use')).toBe(true);
    const forbidden = PERMISSIONS.filter((p) => p !== 'data.use');
    for (const permission of forbidden) {
      expect(hasPermission(dataOnly, permission)).toBe(false);
    }
  });

  it('never implies file, printer, device or power access from data access', () => {
    expect(DATA_ONLY_PERMISSIONS).toEqual(['data.use']);
    expect(isDataOnlyPrincipal(dataOnly)).toBe(true);
  });

  it('does not treat an owner as a data-only principal', () => {
    expect(isDataOnlyPrincipal({ role: 'owner', permissions: OWNER_PERMISSIONS })).toBe(false);
  });

  it('does not treat a widened pass as data-only', () => {
    expect(
      isDataOnlyPrincipal({ role: 'invited_member', permissions: ['data.use', 'printers.use'] }),
    ).toBe(false);
  });
});

describe('pass lifecycle', () => {
  const now = new Date('2026-01-10T12:00:00.000Z');

  it('refuses a suspended principal even when the capability is granted', () => {
    const grant: PrincipalGrant = { ...dataOnly, suspended: true };
    expect(evaluatePermission(grant, 'data.use', now)).toEqual({
      allowed: false,
      permission: 'data.use',
      reason: 'principal_suspended',
    });
  });

  it('refuses an expired pass', () => {
    const grant: PrincipalGrant = { ...dataOnly, expiresAt: '2026-01-09T12:00:00.000Z' };
    expect(evaluatePermission(grant, 'data.use', now).reason).toBe('principal_expired');
  });

  it('honours a pass that has not yet expired', () => {
    const grant: PrincipalGrant = { ...dataOnly, expiresAt: '2026-02-09T12:00:00.000Z' };
    expect(hasPermission(grant, 'data.use', now)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    const grant: PrincipalGrant = { ...dataOnly, expiresAt: now.toISOString() };
    expect(hasPermission(grant, 'data.use', now)).toBe(false);
  });

  it('ignores a null expiry', () => {
    expect(hasPermission({ ...dataOnly, expiresAt: null }, 'data.use', now)).toBe(true);
  });
});

describe('owner grants', () => {
  it('covers every capability', () => {
    const grant: PrincipalGrant = { role: 'owner', permissions: OWNER_PERMISSIONS };
    for (const permission of PERMISSIONS) {
      expect(hasPermission(grant, permission)).toBe(true);
    }
  });
});

describe('step-up requirements', () => {
  it('requires step-up for destructive and control capabilities', () => {
    expect(requiresStepUp('power.shutdown')).toBe(true);
    expect(requiresStepUp('power.restart')).toBe(true);
    expect(requiresStepUp('files.delete')).toBe(true);
    expect(requiresStepUp('devices.control')).toBe(true);
    expect(requiresStepUp('members.manage')).toBe(true);
  });

  it('does not require step-up for routine capabilities', () => {
    expect(requiresStepUp('data.use')).toBe(false);
    expect(requiresStepUp('devices.view')).toBe(false);
    expect(requiresStepUp('files.read')).toBe(false);
  });
});
