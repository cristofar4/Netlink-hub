import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_TRUSTED_DEVICE_PERMISSIONS,
  type AuthSuccessResponse,
  type AuthenticatedDevice,
  type AuthenticatedUser,
  type ChallengeResponse,
  type DeviceIdentity,
  type LoginRequest,
  type LoginResponse,
  type RegisterRequest,
  type VerifyDeviceRequest,
  type VerifyEmailRequest,
} from '@netlink/contracts';
import type { AppConfig } from '../config/configuration';
import type { RequestContext } from '../common/request-context';
import { RateLimiterService } from '../common/rate-limiter.service';
import { TooManyRequestsException } from '../common/too-many-requests.exception';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../crypto/password.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChallengeService } from './challenge.service';
import { SessionService } from './session.service';

/**
 * Generic message returned for every failed sign-in, whatever the real reason.
 * Distinguishing "no such account" from "wrong password" would turn the login
 * endpoint into an account-enumeration oracle.
 */
const GENERIC_LOGIN_FAILURE = 'That email and password combination did not match.';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly challenges: ChallengeService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get exposeDevCode(): boolean {
    return this.config.get('EXPOSE_DEV_OTP', { infer: true });
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Creates an unverified account and emails a six-digit code.
   *
   * The account exists immediately but `emailVerified` stays false, and an
   * unverified account cannot sign in. Registering an email that already has an
   * account returns the same shape as a fresh registration so the endpoint does
   * not reveal which addresses are taken.
   */
  async register(input: RegisterRequest, context: RequestContext): Promise<ChallengeResponse> {
    this.enforceLimit(
      `register:${context.ipAddress ?? 'unknown'}`,
      this.config.get('RATE_LIMIT_REGISTER_PER_HOUR', { infer: true }),
      3600,
      'Too many accounts created from this network. Please try again later.',
    );

    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });

    if (existing) {
      await this.audit.record({
        action: 'auth.register.started',
        outcome: 'failure',
        actorUserId: existing.id,
        context,
        metadata: { reason: 'email_already_registered' },
      });

      if (existing.emailVerified) {
        // Do not confirm the address is taken and do not email a code for an
        // account the requester may not own. Return a decoy challenge shaped
        // exactly like a real one; submitting any code against it will fail.
        return this.decoyChallenge(input.email);
      }

      // The account exists but was never confirmed — this is almost always the
      // same person retrying, so re-issue rather than dead-ending them.
      const issued = await this.challenges.issue({
        userId: existing.id,
        userEmail: existing.email,
        userName: existing.name,
        purpose: 'email_verification',
        approximateLocation: context.approximateLocation,
        exposeDevCode: this.exposeDevCode,
      });
      return issued.response;
    }

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: await this.passwords.hash(input.password),
        emailVerified: false,
      },
    });

    await this.audit.record({
      action: 'auth.register.started',
      outcome: 'success',
      actorUserId: user.id,
      context,
    });

    const issued = await this.challenges.issue({
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      purpose: 'email_verification',
      approximateLocation: context.approximateLocation,
      exposeDevCode: this.exposeDevCode,
    });

    await this.audit.record({
      action: 'auth.email.verification.sent',
      outcome: 'success',
      actorUserId: user.id,
      context,
    });

    return issued.response;
  }

  /** Confirms the emailed code and marks the account verified. */
  async verifyEmail(
    input: VerifyEmailRequest,
    context: RequestContext,
  ): Promise<{ verified: true }> {
    this.enforceLimit(
      `otp:${context.ipAddress ?? 'unknown'}`,
      this.config.get('RATE_LIMIT_OTP_VERIFY_PER_MINUTE', { infer: true }),
      60,
      'Too many verification attempts. Please wait a moment.',
    );

    const result = await this.challenges.consume({
      challengeId: input.challengeId,
      code: input.code,
      purpose: 'email_verification',
    });

    if (!result.ok) {
      await this.audit.record({
        action: 'auth.email.verification.failed',
        outcome: 'failure',
        context,
        metadata: { reason: result.reason, attemptsRemaining: result.attemptsRemaining },
      });
      throw new BadRequestException(
        describeChallengeFailure(result.reason, result.attemptsRemaining),
      );
    }

    await this.prisma.user.update({
      where: { id: result.challenge.userId },
      data: { emailVerified: true },
    });

    await this.audit.record({
      action: 'auth.register.completed',
      outcome: 'success',
      actorUserId: result.challenge.userId,
      context,
    });

    return { verified: true };
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  /**
   * Password sign-in bound to a device identity.
   *
   * A device already known and trusted for this account is signed straight in.
   * Anything else — a first-time device, or one the owner chose not to trust —
   * gets a six-digit code before any session is issued.
   */
  async login(input: LoginRequest, context: RequestContext): Promise<LoginResponse> {
    this.enforceLimit(
      `login:${context.ipAddress ?? 'unknown'}`,
      this.config.get('RATE_LIMIT_LOGIN_PER_MINUTE', { infer: true }),
      60,
      'Too many sign-in attempts. Please wait a minute and try again.',
    );

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    // Always spend the cost of a hash comparison, even for an unknown address,
    // so response timing does not reveal whether the account exists.
    const passwordMatches = user
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.verify(DUMMY_ARGON2_HASH, input.password);

    if (!user || !passwordMatches || user.disabledAt) {
      await this.audit.record({
        action: 'auth.login.failed',
        outcome: 'failure',
        actorUserId: user?.id ?? null,
        context,
        metadata: {
          reason: !user ? 'unknown_email' : user.disabledAt ? 'disabled' : 'bad_password',
        },
      });
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    if (!user.emailVerified) {
      // The account is real and the password was right, so re-issuing the
      // confirmation code reveals nothing new and unblocks the user.
      const issued = await this.challenges.issue({
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        purpose: 'email_verification',
        approximateLocation: context.approximateLocation,
        exposeDevCode: this.exposeDevCode,
      });
      return { status: 'challenge_required', challenge: issued.response };
    }

    // Upgrade a hash that predates the current Argon2id parameters, now that we
    // hold a verified plaintext password.
    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await this.passwords.hash(input.password) },
      });
    }

    const device = await this.upsertDevice(user.id, input.device, context);

    if (device.revokedAt) {
      await this.audit.record({
        action: 'auth.login.failed',
        outcome: 'denied',
        actorUserId: user.id,
        actorDeviceId: device.id,
        context,
        metadata: { reason: 'device_revoked' },
      });
      throw new UnauthorizedException(
        'This device was removed from your account. Reinstall NetLink to enroll it again.',
      );
    }

    if (device.trusted) {
      const tokens = await this.sessions.startSession({
        userId: user.id,
        deviceId: device.id,
        trusted: true,
      });
      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });
      await this.audit.record({
        action: 'auth.login.succeeded',
        outcome: 'success',
        actorUserId: user.id,
        actorDeviceId: device.id,
        context,
        metadata: { trustedDevice: true },
      });
      this.rateLimiter.reset(`login:${context.ipAddress ?? 'unknown'}`);

      return {
        status: 'authenticated',
        user: toAuthenticatedUser(user),
        device: toAuthenticatedDevice(device, true),
        tokens,
      };
    }

    const issued = await this.challenges.issue({
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      purpose: 'device_verification',
      deviceId: device.id,
      pendingDeviceName: device.name,
      approximateLocation: context.approximateLocation,
      exposeDevCode: this.exposeDevCode,
    });

    await this.audit.record({
      action: 'auth.login.challenge.issued',
      outcome: 'success',
      actorUserId: user.id,
      actorDeviceId: device.id,
      context,
    });

    return { status: 'challenge_required', challenge: issued.response };
  }

  /**
   * Completes new-device verification.
   *
   * "Trust This Device" is applied here and only here — the client cannot mark
   * a device trusted any other way, and the device being trusted is the one
   * recorded on the challenge, not one named in the request body.
   */
  async verifyDevice(
    input: VerifyDeviceRequest,
    context: RequestContext,
  ): Promise<AuthSuccessResponse> {
    this.enforceLimit(
      `otp:${context.ipAddress ?? 'unknown'}`,
      this.config.get('RATE_LIMIT_OTP_VERIFY_PER_MINUTE', { infer: true }),
      60,
      'Too many verification attempts. Please wait a moment.',
    );

    const result = await this.challenges.consume({
      challengeId: input.challengeId,
      code: input.code,
      purpose: 'device_verification',
    });

    if (!result.ok) {
      await this.audit.record({
        action: 'auth.device.verification.failed',
        outcome: 'failure',
        context,
        metadata: { reason: result.reason, attemptsRemaining: result.attemptsRemaining },
      });
      throw new BadRequestException(
        describeChallengeFailure(result.reason, result.attemptsRemaining),
      );
    }

    if (!result.challenge.deviceId) {
      throw new BadRequestException('This verification request is no longer valid.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: result.challenge.userId } });
    if (!user || user.disabledAt) throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);

    const device = await this.prisma.device.update({
      where: { id: result.challenge.deviceId },
      data: {
        trusted: input.trustDevice,
        trustedAt: input.trustDevice ? new Date() : null,
        lastSeenAt: new Date(),
        approximateLocation: context.approximateLocation,
        lastIpAddress: context.ipAddress,
      },
    });

    const tokens = await this.sessions.startSession({
      userId: user.id,
      deviceId: device.id,
      trusted: device.trusted,
    });

    await this.audit.record({
      action: 'auth.device.verification.succeeded',
      outcome: 'success',
      actorUserId: user.id,
      actorDeviceId: device.id,
      context,
      metadata: { trusted: device.trusted },
    });

    if (device.trusted) {
      await this.audit.record({
        action: 'device.trusted',
        outcome: 'success',
        actorUserId: user.id,
        actorDeviceId: device.id,
        context,
        metadata: { deviceName: device.name },
      });
    }

    await this.audit.record({
      action: 'auth.login.succeeded',
      outcome: 'success',
      actorUserId: user.id,
      actorDeviceId: device.id,
      context,
      metadata: { trustedDevice: device.trusted },
    });

    return {
      status: 'authenticated',
      user: toAuthenticatedUser(user),
      device: toAuthenticatedDevice(device, true),
      tokens,
    };
  }

  async resendCode(challengeId: string, context: RequestContext): Promise<ChallengeResponse> {
    this.enforceLimit(
      `resend:${context.ipAddress ?? 'unknown'}`,
      this.config.get('RATE_LIMIT_OTP_VERIFY_PER_MINUTE', { infer: true }),
      60,
      'Too many code requests. Please wait a moment.',
    );
    return this.challenges.resend({ challengeId, exposeDevCode: this.exposeDevCode });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string, context: RequestContext) {
    const outcome = await this.sessions.rotate(refreshToken);

    if (!outcome.ok) {
      if (outcome.reason === 'reuse_detected') {
        await this.audit.record({
          action: 'auth.token.reuse_detected',
          outcome: 'denied',
          actorUserId: outcome.userId ?? null,
          context,
        });
        throw new UnauthorizedException(
          'This session was ended for your security. Please sign in again.',
        );
      }
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }

    await this.prisma.device.update({
      where: { id: outcome.deviceId },
      data: { lastSeenAt: new Date(), lastIpAddress: context.ipAddress },
    });

    await this.audit.record({
      action: 'auth.token.refreshed',
      outcome: 'success',
      actorUserId: outcome.userId,
      actorDeviceId: outcome.deviceId,
      context,
    });

    return outcome.tokens;
  }

  async logout(refreshToken: string, context: RequestContext): Promise<{ signedOut: true }> {
    await this.sessions.revokeByToken(refreshToken, 'user_signed_out');
    await this.audit.record({ action: 'auth.logout', outcome: 'success', context });
    return { signedOut: true };
  }

  async currentUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Your session is no longer valid.');
    return toAuthenticatedUser(user);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Finds or creates the Device row for this installation.
   *
   * A device is identified by its own generated `installationId` scoped to the
   * account. The public key is stored on first sight and is *not* overwritten
   * afterwards — a changed key means a different device, so it enrolls as one
   * rather than silently taking over an existing trusted record.
   */
  private async upsertDevice(userId: string, identity: DeviceIdentity, context: RequestContext) {
    const existing = await this.prisma.device.findUnique({
      where: { userId_installationId: { userId, installationId: identity.installationId } },
    });

    if (existing) {
      if (existing.publicKey !== identity.publicKey) {
        await this.audit.record({
          action: 'auth.login.failed',
          outcome: 'denied',
          actorUserId: userId,
          actorDeviceId: existing.id,
          context,
          metadata: { reason: 'device_key_mismatch' },
        });
        throw new UnauthorizedException(
          'This installation no longer matches its registered device identity. Reinstall NetLink to enroll it again.',
        );
      }

      return this.prisma.device.update({
        where: { id: existing.id },
        data: {
          osVersion: identity.osVersion ?? existing.osVersion,
          appVersion: identity.appVersion ?? existing.appVersion,
          approximateLocation: context.approximateLocation,
          lastIpAddress: context.ipAddress,
        },
      });
    }

    // A public key already bound to another account is refused outright.
    const keyOwner = await this.prisma.device.findUnique({
      where: { publicKey: identity.publicKey },
    });
    if (keyOwner) {
      throw new BadRequestException(
        'This device identity is already registered. Reinstall NetLink to generate a new one.',
      );
    }

    const device = await this.prisma.device.create({
      data: {
        userId,
        installationId: identity.installationId,
        name: identity.name,
        platform: identity.platform as never,
        kind: identity.kind as never,
        osVersion: identity.osVersion ?? null,
        appVersion: identity.appVersion ?? null,
        publicKey: identity.publicKey,
        trusted: false,
        approximateLocation: context.approximateLocation,
        lastIpAddress: context.ipAddress,
      },
    });

    await this.audit.record({
      action: 'device.registered',
      outcome: 'success',
      actorUserId: userId,
      actorDeviceId: device.id,
      context,
      metadata: {
        deviceName: device.name,
        platform: identity.platform,
        // Recorded so the owner can see what a new device starts with. It is
        // deliberately the minimum: visibility, and nothing else.
        defaultPermissions: DEFAULT_TRUSTED_DEVICE_PERMISSIONS.join(',') || 'none',
      },
    });

    return device;
  }

  private enforceLimit(key: string, limit: number, windowSeconds: number, message: string): void {
    const result = this.rateLimiter.consume(key, limit, windowSeconds);
    if (!result.allowed) {
      throw new TooManyRequestsException(message, result.retryAfterSeconds);
    }
  }

  /**
   * A challenge-shaped response that no code can satisfy, used when we must not
   * confirm whether an email is already registered.
   */
  private decoyChallenge(email: string): ChallengeResponse {
    const now = Date.now();
    return this.challenges.toResponse(
      {
        // Random id: it matches no row, so any submitted code fails as
        // `not_found`, which is the same failure a wrong code produces.
        id: crypto.randomUUID(),
        purpose: 'email_verification',
        expiresAt: new Date(now + 10 * 60_000),
        lastSentAt: new Date(now),
        attempts: 0,
        maxAttempts: 5,
        resendCount: 0,
      },
      email,
    );
  }
}

/**
 * A real Argon2id hash of a random string, compared against when the email is
 * unknown so that path costs the same as a genuine verification.
 */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZXh4$8xN2xW9ZTgOSs0pQqjOa1cO3LmZ0m6zW4cVJ0jVYFbo';

function describeChallengeFailure(reason: string, attemptsRemaining: number): string {
  switch (reason) {
    case 'expired':
      return 'That code has expired. Request a new one.';
    case 'already_used':
      return 'That code has already been used. Request a new one.';
    case 'too_many_attempts':
      return 'Too many incorrect codes. Request a new one.';
    case 'not_found':
      return 'That code is not correct.';
    default:
      return attemptsRemaining > 0
        ? `That code is not correct. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect codes. Request a new one.';
  }
}

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
};

export function toAuthenticatedUser(user: UserRow): AuthenticatedUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  };
}

type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  kind: string;
  trusted: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
  approximateLocation: string | null;
};

export function toAuthenticatedDevice(device: DeviceRow, current = false): AuthenticatedDevice {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    kind: device.kind,
    trusted: device.trusted,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    createdAt: device.createdAt.toISOString(),
    revokedAt: device.revokedAt ? device.revokedAt.toISOString() : null,
    approximateLocation: device.approximateLocation,
    ...(current ? { current: true } : {}),
  };
}
