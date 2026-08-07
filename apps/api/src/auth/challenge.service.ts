import { BadRequestException, Injectable } from '@nestjs/common';
import { TooManyRequestsException } from '../common/too-many-requests.exception';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_RESENDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  type ChallengePurpose,
  type ChallengeResponse,
  maskEmail,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../crypto/token.service';
import { MailService } from '../mail/mail.service';

export type IssuedChallenge = {
  response: ChallengeResponse;
  /** Plaintext code — only ever handed to the mail transport, never persisted. */
  code: string;
};

type ChallengeRow = {
  id: string;
  userId: string;
  deviceId: string | null;
  purpose: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  maxAttempts: number;
  resendCount: number;
  lastSentAt: Date;
  pendingDeviceName: string | null;
};

export type ConsumeResult =
  | { ok: true; challenge: ChallengeRow }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'already_used' | 'too_many_attempts' | 'invalid_code';
      attemptsRemaining: number;
    };

/**
 * Six-digit email codes.
 *
 * Rules enforced here, and tested directly:
 *   * the code is stored only as a SHA-256 hash;
 *   * it expires after ten minutes;
 *   * it works exactly once (`consumedAt` is set inside the same transaction
 *     that accepts it, so two concurrent requests cannot both succeed);
 *   * attempts are capped, and a burned-out challenge stays burned out;
 *   * resends are rate-limited by cooldown and by total count.
 */
@Injectable()
export class ChallengeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
  ) {}

  async issue(input: {
    userId: string;
    userEmail: string;
    userName: string;
    purpose: ChallengePurpose;
    deviceId?: string | null;
    pendingDeviceName?: string | null;
    approximateLocation?: string | null;
    exposeDevCode: boolean;
  }): Promise<IssuedChallenge> {
    // Only one live challenge per (user, purpose). Issuing a new one supersedes
    // any pending code so an old email cannot be replayed after a restart.
    await this.prisma.challenge.updateMany({
      where: { userId: input.userId, purpose: input.purpose as never, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = this.tokens.generateOtp();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000);

    const challenge = await this.prisma.challenge.create({
      data: {
        userId: input.userId,
        deviceId: input.deviceId ?? null,
        purpose: input.purpose as never,
        codeHash: this.tokens.hashSecret(code),
        expiresAt,
        maxAttempts: OTP_MAX_ATTEMPTS,
        lastSentAt: now,
        pendingDeviceName: input.pendingDeviceName ?? null,
      },
    });

    await this.mail.sendVerificationCode({
      to: input.userEmail,
      name: input.userName,
      code,
      purpose: input.purpose,
      deviceName: input.pendingDeviceName ?? undefined,
      approximateLocation: input.approximateLocation ?? null,
      expiresInMinutes: OTP_TTL_MINUTES,
    });

    return {
      code,
      response: this.toResponse(
        {
          id: challenge.id,
          purpose: input.purpose,
          expiresAt,
          lastSentAt: now,
          attempts: 0,
          maxAttempts: OTP_MAX_ATTEMPTS,
          resendCount: 0,
        },
        input.userEmail,
        input.exposeDevCode ? code : undefined,
      ),
    };
  }

  /**
   * Re-sends the code for an existing challenge.
   *
   * A resend issues a *new* code and invalidates the previous one, so an
   * attacker who saw an earlier email gains nothing by forcing a resend.
   */
  async resend(input: { challengeId: string; exposeDevCode: boolean }): Promise<ChallengeResponse> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: input.challengeId },
      include: { user: true },
    });

    if (!challenge || challenge.consumedAt) {
      throw new BadRequestException('This verification request is no longer valid.');
    }

    const now = new Date();
    const cooldownEndsAt = new Date(
      challenge.lastSentAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000,
    );
    if (now < cooldownEndsAt) {
      throw new TooManyRequestsException(
        `Please wait ${Math.ceil((cooldownEndsAt.getTime() - now.getTime()) / 1000)} seconds before requesting another code.`,
      );
    }
    if (challenge.resendCount >= OTP_MAX_RESENDS) {
      throw new TooManyRequestsException(
        'Too many codes requested. Please start again in a few minutes.',
      );
    }

    const code = this.tokens.generateOtp();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000);

    const updated = await this.prisma.challenge.update({
      where: { id: challenge.id },
      data: {
        codeHash: this.tokens.hashSecret(code),
        expiresAt,
        lastSentAt: now,
        resendCount: { increment: 1 },
        // A resend restores the attempt budget for the new code, but the
        // resend budget itself is what stops this being an unlimited retry loop.
        attempts: 0,
      },
    });

    await this.mail.sendVerificationCode({
      to: challenge.user.email,
      name: challenge.user.name,
      code,
      purpose: challenge.purpose as ChallengePurpose,
      deviceName: challenge.pendingDeviceName ?? undefined,
      expiresInMinutes: OTP_TTL_MINUTES,
    });

    return this.toResponse(
      {
        id: updated.id,
        purpose: updated.purpose as ChallengePurpose,
        expiresAt: updated.expiresAt,
        lastSentAt: updated.lastSentAt,
        attempts: updated.attempts,
        maxAttempts: updated.maxAttempts,
        resendCount: updated.resendCount,
      },
      challenge.user.email,
      input.exposeDevCode ? code : undefined,
    );
  }

  /**
   * Validates a submitted code and, on success, marks the challenge consumed.
   *
   * The consume step is a conditional update on `consumedAt: null`, so if two
   * requests race with the same correct code, exactly one of them wins.
   */
  async consume(input: {
    challengeId: string;
    code: string;
    purpose: ChallengePurpose;
  }): Promise<ConsumeResult> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: input.challengeId },
    });

    if (!challenge || challenge.purpose !== input.purpose) {
      return { ok: false, reason: 'not_found', attemptsRemaining: 0 };
    }
    if (challenge.consumedAt) {
      return { ok: false, reason: 'already_used', attemptsRemaining: 0 };
    }
    if (challenge.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired', attemptsRemaining: 0 };
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      return { ok: false, reason: 'too_many_attempts', attemptsRemaining: 0 };
    }

    if (!this.tokens.verifySecret(input.code, challenge.codeHash)) {
      const updated = await this.prisma.challenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      const attemptsRemaining = Math.max(updated.maxAttempts - updated.attempts, 0);
      // Burning the last attempt kills the challenge outright rather than
      // leaving a code that is still technically valid but unusable.
      if (attemptsRemaining === 0) {
        await this.prisma.challenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        });
      }
      return { ok: false, reason: 'invalid_code', attemptsRemaining };
    }

    const claimed = await this.prisma.challenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Lost the race to a concurrent request holding the same code.
      return { ok: false, reason: 'already_used', attemptsRemaining: 0 };
    }

    return {
      ok: true,
      challenge: {
        ...challenge,
        purpose: challenge.purpose as string,
      } as ChallengeRow,
    };
  }

  toResponse(
    challenge: {
      id: string;
      purpose: ChallengePurpose;
      expiresAt: Date;
      lastSentAt: Date;
      attempts: number;
      maxAttempts: number;
      resendCount: number;
    },
    email: string,
    devCode?: string,
  ): ChallengeResponse {
    return {
      challengeId: challenge.id,
      purpose: challenge.purpose,
      maskedEmail: maskEmail(email),
      expiresAt: challenge.expiresAt.toISOString(),
      resendAvailableAt: new Date(
        challenge.lastSentAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000,
      ).toISOString(),
      attemptsRemaining: Math.max(challenge.maxAttempts - challenge.attempts, 0),
      resendsRemaining: Math.max(OTP_MAX_RESENDS - challenge.resendCount, 0),
      ...(devCode ? { devCode } : {}),
    };
  }
}
