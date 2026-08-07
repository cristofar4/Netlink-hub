import { ARGON2_OPTIONS, PasswordService, parsePhc } from './password.service';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('produces an Argon2id PHC string, never the raw password', async () => {
    const hash = await passwords.hash('CorrectHorse1Battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('CorrectHorse1Battery');
  });

  it('records the configured cost parameters in the hash', async () => {
    const parsed = parsePhc(await passwords.hash('CorrectHorse1Battery'));
    expect(parsed).toEqual({
      algorithm: 'argon2id',
      memoryCost: ARGON2_OPTIONS.memoryCost,
      timeCost: ARGON2_OPTIONS.timeCost,
      parallelism: ARGON2_OPTIONS.parallelism,
    });
  });

  it('salts every hash, so the same password never hashes twice the same way', async () => {
    const [a, b] = await Promise.all([
      passwords.hash('CorrectHorse1Battery'),
      passwords.hash('CorrectHorse1Battery'),
    ]);
    expect(a).not.toEqual(b);
  });

  it('verifies the correct password', async () => {
    const hash = await passwords.hash('CorrectHorse1Battery');
    await expect(passwords.verify(hash, 'CorrectHorse1Battery')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await passwords.hash('CorrectHorse1Battery');
    await expect(passwords.verify(hash, 'correcthorse1battery')).resolves.toBe(false);
    await expect(passwords.verify(hash, 'CorrectHorse1Batter')).resolves.toBe(false);
    await expect(passwords.verify(hash, '')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a corrupted stored hash', async () => {
    await expect(passwords.verify('not-a-hash', 'CorrectHorse1Battery')).resolves.toBe(false);
    await expect(passwords.verify('', 'CorrectHorse1Battery')).resolves.toBe(false);
    await expect(passwords.verify('$argon2id$v=19$m=1', 'x')).resolves.toBe(false);
  });

  it('handles long and unicode passwords', async () => {
    const long = `${'ü'.repeat(100)}A1`;
    const hash = await passwords.hash(long);
    await expect(passwords.verify(hash, long)).resolves.toBe(true);
  });

  describe('needsRehash', () => {
    it('is false for a hash at current policy', async () => {
      expect(passwords.needsRehash(await passwords.hash('CorrectHorse1Battery'))).toBe(false);
    });

    it('is true for a weaker hash', () => {
      expect(passwords.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('is true for a non-argon2id algorithm', () => {
      expect(passwords.needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('is true for anything unparseable', () => {
      expect(passwords.needsRehash('garbage')).toBe(true);
      expect(passwords.needsRehash('')).toBe(true);
    });
  });
});

describe('parsePhc', () => {
  it('returns null for malformed input', () => {
    expect(parsePhc('')).toBeNull();
    expect(parsePhc('$argon2id$')).toBeNull();
    expect(parsePhc('$argon2id$v=19$m=notanumber,t=2,p=1$c2FsdA$aGFzaA')).toBeNull();
    expect(parsePhc('$argon2id$v=19$t=2,p=1$c2FsdA$aGFzaA')).toBeNull();
  });
});
