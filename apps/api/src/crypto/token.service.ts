import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { OTP_LENGTH } from '@netlink/contracts';

/**
 * Generation and hashing of every opaque secret the control plane issues:
 * six-digit email codes, refresh tokens and invitation claim tokens.
 *
 * Nothing here is reversible. The server stores hashes; the plaintext exists
 * only long enough to be emailed or returned to the client that requested it.
 */
@Injectable()
export class TokenService {
  /**
   * A uniformly distributed six-digit code, leading zeros preserved.
   *
   * `randomInt` is used rather than `Math.random` (not cryptographic) and
   * rather than `randomBytes % 1_000_000` (modulo-biased).
   */
  generateOtp(length: number = OTP_LENGTH): string {
    const max = 10 ** length;
    return randomInt(0, max).toString().padStart(length, '0');
  }

  /** 256 bits of entropy, base64url encoded. */
  generateOpaqueToken(byteLength = 32): string {
    return randomBytes(byteLength).toString('base64url');
  }

  /**
   * SHA-256 is correct here — unlike a password, these secrets are
   * high-entropy and short-lived, so a slow KDF buys nothing and would make
   * every token refresh needlessly expensive.
   */
  hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  /** Constant-time comparison of two hex digests. */
  verifySecret(secret: string, storedHash: string): boolean {
    const candidate = Buffer.from(this.hashSecret(secret), 'hex');
    let stored: Buffer;
    try {
      stored = Buffer.from(storedHash, 'hex');
    } catch {
      return false;
    }
    if (candidate.length !== stored.length || stored.length === 0) return false;
    return timingSafeEqual(candidate, stored);
  }

  /** Shared lineage identifier for a rotating refresh-token chain. */
  generateFamilyId(): string {
    return randomBytes(16).toString('hex');
  }
}
