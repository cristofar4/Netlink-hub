import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Protects one account from repeated failed sign-ins, wherever they come from.
 *
 * This exists because per-IP rate limiting cannot see the attack that matters.
 * A single machine trying a thousand passwords is stopped by an IP limit. A
 * thousand machines each trying one password against the same account is not —
 * every request looks like a first attempt from a new address, and that is what
 * credential stuffing actually looks like.
 *
 * Two design choices worth stating, because both are the kind of thing that
 * looks like an oversight:
 *
 *   * **The lockout is temporary and it decays.** A permanent one would hand
 *     anybody who knows an email address the ability to lock its owner out of
 *     their own account. Denial of service by helpful security control is still
 *     denial of service.
 *   * **A locked account still returns the ordinary "wrong password" message.**
 *     Saying "this account is locked" tells an attacker they found a real
 *     address and that their guesses are landing.
 */
@Injectable()
export class AccountGuardService {
  /** Failures tolerated before the first cooling-off period. */
  static readonly THRESHOLD = 5;

  /** The first delay. Each further failure doubles it, to the ceiling. */
  static readonly BASE_LOCK_SECONDS = 30;

  /** No delay is ever longer than this. */
  static readonly MAX_LOCK_SECONDS = 15 * 60;

  /**
   * A quiet spell this long clears the count.
   *
   * Someone who mistypes twice today and twice next week is not an attack, and
   * treating them as one is how a security control becomes something people
   * work around.
   */
  static readonly DECAY_SECONDS = 60 * 60;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reports how long this account must wait, or zero.
   *
   * Called before the password is checked, so a locked account does not spend
   * an Argon2id verification on every attempt — which is itself the thing that
   * makes a lockout worth having under load.
   */
  async lockedForSeconds(userId: string, now = new Date()): Promise<number> {
    const guard = await this.prisma.accountGuard.findUnique({ where: { userId } });
    if (!guard?.lockedUntil) return 0;

    const remaining = Math.ceil((guard.lockedUntil.getTime() - now.getTime()) / 1000);
    return remaining > 0 ? remaining : 0;
  }

  /** Records a failed attempt and returns the resulting delay, in seconds. */
  async recordFailure(userId: string, now = new Date()): Promise<number> {
    const existing = await this.prisma.accountGuard.findUnique({ where: { userId } });

    // A long quiet spell means the previous failures were not part of this.
    const decayed =
      existing !== null &&
      now.getTime() - existing.lastFailure.getTime() > AccountGuardService.DECAY_SECONDS * 1000;

    const failures = !existing || decayed ? 1 : existing.failures + 1;

    let lockedUntil: Date | null = null;
    if (failures >= AccountGuardService.THRESHOLD) {
      const over = failures - AccountGuardService.THRESHOLD;
      const seconds = Math.min(
        AccountGuardService.BASE_LOCK_SECONDS * 2 ** over,
        AccountGuardService.MAX_LOCK_SECONDS,
      );
      lockedUntil = new Date(now.getTime() + seconds * 1000);
    }

    await this.prisma.accountGuard.upsert({
      where: { userId },
      create: { userId, failures, firstFailure: now, lastFailure: now, lockedUntil },
      update: {
        failures,
        lastFailure: now,
        ...(decayed ? { firstFailure: now } : {}),
        lockedUntil,
      },
    });

    return lockedUntil ? Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) : 0;
  }

  /**
   * Clears the record after a successful sign-in.
   *
   * A correct password is proof the account is not under successful attack, and
   * leaving a count behind would mean a person who got it right on the fifth
   * try starts tomorrow one mistake from a lockout.
   */
  async recordSuccess(userId: string): Promise<void> {
    await this.prisma.accountGuard.deleteMany({ where: { userId } });
  }
}
