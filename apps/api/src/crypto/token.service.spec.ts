import { TokenService } from './token.service';

describe('TokenService', () => {
  const tokens = new TokenService();

  describe('generateOtp', () => {
    it('always produces exactly six digits', () => {
      for (let i = 0; i < 500; i += 1) {
        expect(tokens.generateOtp()).toMatch(/^\d{6}$/);
      }
    });

    it('preserves leading zeros rather than shortening the code', () => {
      // Over this many draws a code below 100000 is essentially certain, and it
      // must still render as six characters.
      const codes = Array.from({ length: 2000 }, () => tokens.generateOtp());
      expect(codes.every((c) => c.length === 6)).toBe(true);
      expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    });

    it('spreads across the full range instead of repeating', () => {
      const codes = new Set(Array.from({ length: 500 }, () => tokens.generateOtp()));
      // Birthday-bound: 500 draws from 10^6 should yield well over 400 distinct.
      expect(codes.size).toBeGreaterThan(450);
    });
  });

  describe('hashSecret', () => {
    it('is deterministic', () => {
      expect(tokens.hashSecret('123456')).toEqual(tokens.hashSecret('123456'));
    });

    it('differs for different inputs', () => {
      expect(tokens.hashSecret('123456')).not.toEqual(tokens.hashSecret('123457'));
    });

    it('never contains the plaintext', () => {
      expect(tokens.hashSecret('123456')).not.toContain('123456');
    });
  });

  describe('verifySecret', () => {
    it('accepts the matching secret', () => {
      const hash = tokens.hashSecret('000123');
      expect(tokens.verifySecret('000123', hash)).toBe(true);
    });

    it('rejects a different secret', () => {
      const hash = tokens.hashSecret('000123');
      expect(tokens.verifySecret('000124', hash)).toBe(false);
      expect(tokens.verifySecret('123', hash)).toBe(false);
    });

    it('rejects a malformed or empty stored hash without throwing', () => {
      expect(tokens.verifySecret('000123', '')).toBe(false);
      expect(tokens.verifySecret('000123', 'zz')).toBe(false);
      expect(tokens.verifySecret('000123', 'abc')).toBe(false);
    });
  });

  describe('generateOpaqueToken', () => {
    it('produces url-safe, high-entropy, non-repeating values', () => {
      const values = new Set(Array.from({ length: 200 }, () => tokens.generateOpaqueToken()));
      expect(values.size).toBe(200);
      for (const value of values) {
        expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(value.length).toBeGreaterThanOrEqual(43);
      }
    });
  });

  describe('generateFamilyId', () => {
    it('is unique per call', () => {
      const ids = new Set(Array.from({ length: 200 }, () => tokens.generateFamilyId()));
      expect(ids.size).toBe(200);
    });
  });
});
