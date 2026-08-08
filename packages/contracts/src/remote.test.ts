import { describe, expect, it } from 'vitest';
import {
  REMOTE_MODE_PERMISSIONS,
  REMOTE_SESSION_MODES,
  createRemoteSessionSchema,
  isValidKeyCode,
  remoteSessionIsLive,
  remoteSignalSchema,
  strategyFromCandidateTypes,
  FRAME_QUALITY_SETTINGS,
} from './remote';
import { evaluatePermission, type Permission, type PrincipalGrant } from './permissions';

describe('remote session modes', () => {
  it('needs observe to watch and both to control', () => {
    expect(REMOTE_MODE_PERMISSIONS.view).toEqual(['devices.observe']);
    expect(REMOTE_MODE_PERMISSIONS.control).toEqual(['devices.observe', 'devices.control']);
  });

  /**
   * The reason the two capabilities are separate. If control did not need its
   * own grant, "view only" would be a label rather than a boundary.
   */
  it('does not let an observer reach control', () => {
    const observer: PrincipalGrant = {
      role: 'invited_member',
      permissions: ['devices.view', 'devices.observe'],
    };

    const forView = REMOTE_MODE_PERMISSIONS.view.every(
      (permission) => evaluatePermission(observer, permission as Permission).allowed,
    );
    const forControl = REMOTE_MODE_PERMISSIONS.control.every(
      (permission) => evaluatePermission(observer, permission as Permission).allowed,
    );

    expect(forView).toBe(true);
    expect(forControl).toBe(false);
  });

  it('does not let control stand in for observe', () => {
    const partial: PrincipalGrant = {
      role: 'invited_member',
      permissions: ['devices.view', 'devices.control'],
    };

    const forControl = REMOTE_MODE_PERMISSIONS.control.every(
      (permission) => evaluatePermission(partial, permission as Permission).allowed,
    );
    expect(forControl).toBe(false);
  });

  it('has exactly two modes', () => {
    expect([...REMOTE_SESSION_MODES]).toEqual(['view', 'control']);
  });
});

describe('starting a session', () => {
  it('requires a real computer and a known mode', () => {
    const valid = createRemoteSessionSchema.safeParse({
      agentId: '11111111-2222-3333-4444-555555555555',
      mode: 'view',
    });
    expect(valid.success).toBe(true);

    expect(
      createRemoteSessionSchema.safeParse({ agentId: 'not-a-uuid', mode: 'view' }).success,
    ).toBe(false);
    expect(
      createRemoteSessionSchema.safeParse({
        agentId: '11111111-2222-3333-4444-555555555555',
        mode: 'administrator',
      }).success,
    ).toBe(false);
  });

  it('will not accept a confirmation code that is not six digits', () => {
    const base = { agentId: '11111111-2222-3333-4444-555555555555', mode: 'control' as const };
    for (const stepUpCode of ['12345', '1234567', 'abcdef', '']) {
      expect(createRemoteSessionSchema.safeParse({ ...base, stepUpCode }).success).toBe(false);
    }
  });
});

describe('signalling', () => {
  it('accepts only the four message kinds', () => {
    const base = { sessionId: '11111111-2222-3333-4444-555555555555', payload: '{}' };
    for (const kind of ['offer', 'answer', 'candidate', 'bye']) {
      expect(remoteSignalSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
    expect(remoteSignalSchema.safeParse({ ...base, kind: 'frame' }).success).toBe(false);
  });

  /**
   * A field both peers can write to, on a server that is not supposed to carry
   * media, has to be bounded — or it becomes somewhere to park data.
   */
  it('bounds the payload', () => {
    const base = {
      sessionId: '11111111-2222-3333-4444-555555555555',
      kind: 'candidate' as const,
    };
    expect(remoteSignalSchema.safeParse({ ...base, payload: 'x'.repeat(20_000) }).success).toBe(
      true,
    );
    expect(remoteSignalSchema.safeParse({ ...base, payload: 'x'.repeat(20_001) }).success).toBe(
      false,
    );
  });
});

describe('how the connection was made', () => {
  it('calls a pair relayed if either end relays', () => {
    expect(strategyFromCandidateTypes('relay', 'host')).toBe('relayed');
    expect(strategyFromCandidateTypes('host', 'relay')).toBe('relayed');
  });

  it('calls everything else direct', () => {
    expect(strategyFromCandidateTypes('host', 'host')).toBe('direct');
    expect(strategyFromCandidateTypes('srflx', 'prflx')).toBe('direct');
  });

  it('says it does not know rather than guessing', () => {
    expect(strategyFromCandidateTypes(null, 'host')).toBe('unknown');
    expect(strategyFromCandidateTypes('host', undefined)).toBe('unknown');
    expect(strategyFromCandidateTypes('', '')).toBe('unknown');
  });
});

describe('key codes', () => {
  it('accepts the physical key names a browser produces', () => {
    for (const code of ['KeyA', 'Digit4', 'ArrowLeft', 'ShiftLeft', 'F12', 'Numpad0']) {
      expect(isValidKeyCode(code)).toBe(true);
    }
  });

  it('refuses anything that is not one', () => {
    for (const code of ['', 'Key A', 'Key-A', '../etc', '{}', 'A'.repeat(25)]) {
      expect(isValidKeyCode(code)).toBe(false);
    }
  });
});

describe('frame quality', () => {
  /**
   * These must match `qualities` in services/agent/internal/remote/capture.go,
   * so the viewer's "Balanced" and the host's "balanced" mean the same thing.
   */
  it('matches the host', () => {
    expect(FRAME_QUALITY_SETTINGS.low).toEqual({ jpegQuality: 45, maxFps: 20, maxWidth: 1280 });
    expect(FRAME_QUALITY_SETTINGS.balanced).toEqual({
      jpegQuality: 65,
      maxFps: 15,
      maxWidth: 1600,
    });
    expect(FRAME_QUALITY_SETTINGS.sharp).toEqual({ jpegQuality: 82, maxFps: 10, maxWidth: 1920 });
  });
});

describe('session state', () => {
  it('treats everything but ended as live', () => {
    expect(remoteSessionIsLive('pending')).toBe(true);
    expect(remoteSessionIsLive('connecting')).toBe(true);
    expect(remoteSessionIsLive('active')).toBe(true);
    expect(remoteSessionIsLive('ended')).toBe(false);
  });
});
