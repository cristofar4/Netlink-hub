import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's Argon2id baseline
 * (19 MiB memory, 2 iterations, 1 degree of parallelism). They are recorded
 * inside the PHC string that is stored, so raising them later still lets
 * existing hashes verify — `needsRehash` reports which stored hashes are below
 * the current policy so they can be upgraded on the user's next sign-in.
 */
export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

@Injectable()
export class PasswordService {
  /** Returns a PHC-format Argon2id string. The raw password is never retained. */
  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Constant-time verification. Returns false on a malformed stored hash rather
   * than throwing, so a corrupted row cannot be distinguished from a wrong
   * password by an attacker watching responses.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /** True when a stored hash was produced with weaker parameters than current policy. */
  needsRehash(storedHash: string): boolean {
    const params = parsePhc(storedHash);
    if (!params) return true;
    if (params.algorithm !== 'argon2id') return true;
    return (
      params.memoryCost < ARGON2_OPTIONS.memoryCost ||
      params.timeCost < ARGON2_OPTIONS.timeCost ||
      params.parallelism < ARGON2_OPTIONS.parallelism
    );
  }
}

type PhcParams = {
  algorithm: string;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
};

/** Parses `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. */
export function parsePhc(phc: string): PhcParams | null {
  const parts = phc.split('$');
  // ['', 'argon2id', 'v=19', 'm=19456,t=2,p=1', salt, hash]
  if (parts.length < 5) return null;
  const algorithm = parts[1];
  const paramSection = parts[3];
  if (!algorithm || !paramSection) return null;

  const params: Record<string, number> = {};
  for (const pair of paramSection.split(',')) {
    const [key, value] = pair.split('=');
    if (!key || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    params[key] = parsed;
  }

  if (params.m === undefined || params.t === undefined || params.p === undefined) return null;
  return {
    algorithm,
    memoryCost: params.m,
    timeCost: params.t,
    parallelism: params.p,
  };
}
