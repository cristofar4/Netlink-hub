import { describe, expect, it } from 'vitest';
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MINUTES,
  deviceIdentitySchema,
  loginRequestSchema,
  maskEmail,
  otpCodeSchema,
  registerRequestSchema,
  verifyDeviceRequestSchema,
} from './auth';

describe('maskEmail', () => {
  it('keeps the domain readable and hides the local part', () => {
    expect(maskEmail('christopher@example.com')).toBe('c••••••••r@example.com');
  });

  it('handles short local parts', () => {
    expect(maskEmail('ab@example.com')).toBe('a•@example.com');
    expect(maskEmail('a@example.com')).toBe('a•@example.com');
  });

  it('handles a three-character local part', () => {
    expect(maskEmail('abc@example.com')).toBe('a•c@example.com');
  });

  it('never leaks the full local part', () => {
    const masked = maskEmail('verylongaddress@netlink.app');
    expect(masked).not.toContain('verylongaddress');
    expect(masked.endsWith('@netlink.app')).toBe(true);
  });

  it('degrades safely on malformed input', () => {
    expect(maskEmail('not-an-email')).not.toContain('not-an-email');
  });
});

describe('OTP policy constants', () => {
  it('matches the documented policy', () => {
    expect(OTP_LENGTH).toBe(6);
    expect(OTP_TTL_MINUTES).toBe(10);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });
});

describe('otpCodeSchema', () => {
  it('accepts exactly six digits', () => {
    expect(otpCodeSchema.parse('012345')).toBe('012345');
  });

  it('rejects wrong lengths and non-digits', () => {
    expect(otpCodeSchema.safeParse('12345').success).toBe(false);
    expect(otpCodeSchema.safeParse('1234567').success).toBe(false);
    expect(otpCodeSchema.safeParse('12a456').success).toBe(false);
  });
});

describe('registerRequestSchema', () => {
  it('normalises the email', () => {
    const parsed = registerRequestSchema.parse({
      name: '  Christopher ',
      email: '  Chris@Example.COM ',
      password: 'CorrectHorse1Battery',
    });
    expect(parsed.email).toBe('chris@example.com');
    expect(parsed.name).toBe('Christopher');
  });

  it('rejects weak passwords', () => {
    const base = { name: 'A', email: 'a@example.com' };
    expect(registerRequestSchema.safeParse({ ...base, password: 'short1A' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...base, password: 'alllowercase1234' }).success).toBe(
      false,
    );
    expect(
      registerRequestSchema.safeParse({ ...base, password: 'NoDigitsInHereAtAll' }).success,
    ).toBe(false);
  });

  it('accepts a strong password', () => {
    expect(
      registerRequestSchema.safeParse({
        name: 'A',
        email: 'a@example.com',
        password: 'CorrectHorse1Battery',
      }).success,
    ).toBe(true);
  });
});

describe('deviceIdentitySchema', () => {
  const valid = {
    installationId: '3f1a1a3e-3b0f-4f2c-9a1a-1e2b3c4d5e6f',
    publicKey: 'k'.repeat(43),
    publicKeyAlgorithm: 'ed25519' as const,
    name: 'Christopher PC',
    platform: 'windows' as const,
  };

  it('defaults the device kind to desktop', () => {
    expect(deviceIdentitySchema.parse(valid).kind).toBe('desktop');
  });

  it('rejects a non-UUID installation id', () => {
    expect(deviceIdentitySchema.safeParse({ ...valid, installationId: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects an unsupported key algorithm', () => {
    expect(deviceIdentitySchema.safeParse({ ...valid, publicKeyAlgorithm: 'rsa' }).success).toBe(
      false,
    );
  });

  it('is required on login so every session is bound to a device identity', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'a@example.com', password: 'whatever' }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({
        email: 'a@example.com',
        password: 'whatever',
        device: valid,
      }).success,
    ).toBe(true);
  });
});

describe('verifyDeviceRequestSchema', () => {
  it('defaults trustDevice to false so trust is always an explicit choice', () => {
    const parsed = verifyDeviceRequestSchema.parse({
      challengeId: '3f1a1a3e-3b0f-4f2c-9a1a-1e2b3c4d5e6f',
      code: '123456',
    });
    expect(parsed.trustDevice).toBe(false);
  });
});
