import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { SessionTokens } from '@netlink/contracts';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../crypto/token.service';

export type AccessTokenClaims = {
  /** User id. */
  sub: string;
  /** Device id — every access token is bound to the device that obtained it. */
  did: string;
  /** True only for devices the owner explicitly chose to trust. */
  trusted: boolean;
  iss: string;
  aud: string;
};

export type RotationOutcome =
  | { ok: true; tokens: SessionTokens; userId: string; deviceId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reuse_detected'; userId?: string };

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Issues a fresh access/refresh pair and starts a new refresh-token family.
   *
   * A device the owner did not choose to trust gets a much shorter refresh
   * lifetime, so signing in on a borrowed computer expires on its own.
   */
  async startSession(input: {
    userId: string;
    deviceId: string;
    trusted: boolean;
  }): Promise<SessionTokens> {
    return this.issue({ ...input, familyId: this.tokens.generateFamilyId() });
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * The presented token is marked rotated in the same conditional update that
   * accepts it. Presenting a token that is already rotated or revoked means the
   * token leaked, so the whole family is revoked and every session on that
   * lineage dies.
   */
  async rotate(presentedToken: string): Promise<RotationOutcome> {
    const tokenHash = this.tokens.hashSecret(presentedToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { device: true },
    });

    if (!existing) return { ok: false, reason: 'invalid' };

    if (existing.rotatedAt || existing.revokedAt) {
      // Refresh-token reuse. Kill the lineage rather than the token, because we
      // cannot tell whether the legitimate client or the thief is holding it.
      await this.revokeFamily(existing.familyId, 'refresh_token_reuse_detected');
      this.logger.warn(
        `Refresh token reuse detected for user ${existing.userId}; family ${existing.familyId} revoked`,
      );
      return { ok: false, reason: 'reuse_detected', userId: existing.userId };
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired', userId: existing.userId };
    }

    if (existing.device.revokedAt) {
      // A revoked device cannot renew, no matter how fresh its token is.
      await this.revokeFamily(existing.familyId, 'device_revoked');
      return { ok: false, reason: 'revoked', userId: existing.userId };
    }

    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeFamily(existing.familyId, 'refresh_token_reuse_detected');
      return { ok: false, reason: 'reuse_detected', userId: existing.userId };
    }

    const tokens = await this.issue({
      userId: existing.userId,
      deviceId: existing.deviceId,
      trusted: existing.device.trusted,
      familyId: existing.familyId,
      replacesId: existing.id,
    });

    return { ok: true, tokens, userId: existing.userId, deviceId: existing.deviceId };
  }

  /** Ends one session. Other devices are untouched. */
  async revokeByToken(presentedToken: string, reason: string): Promise<boolean> {
    const tokenHash = this.tokens.hashSecret(presentedToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) return false;
    await this.revokeFamily(existing.familyId, reason);
    return true;
  }

  /**
   * Revokes every refresh token belonging to one device.
   *
   * Scoped by `deviceId` on purpose: revoking a device must not sign the owner
   * out anywhere else.
   */
  async revokeDeviceSessions(deviceId: string, reason: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: this.config.get('JWT_AUDIENCE', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
  }

  private async issue(input: {
    userId: string;
    deviceId: string;
    trusted: boolean;
    familyId: string;
    replacesId?: string;
  }): Promise<SessionTokens> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    const refreshDays = input.trusted
      ? this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true })
      : this.config.get('UNTRUSTED_REFRESH_TOKEN_TTL_DAYS', { infer: true });

    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + accessTtl * 1000);
    const refreshTokenExpiresAt = new Date(now + refreshDays * 24 * 60 * 60 * 1000);

    const accessToken = await this.jwt.signAsync(
      { sub: input.userId, did: input.deviceId, trusted: input.trusted },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: accessTtl,
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: this.config.get('JWT_AUDIENCE', { infer: true }),
      },
    );

    const refreshToken = this.tokens.generateOpaqueToken();
    const created = await this.prisma.refreshToken.create({
      data: {
        userId: input.userId,
        deviceId: input.deviceId,
        tokenHash: this.tokens.hashSecret(refreshToken),
        familyId: input.familyId,
        expiresAt: refreshTokenExpiresAt,
      },
    });

    if (input.replacesId) {
      await this.prisma.refreshToken.update({
        where: { id: input.replacesId },
        data: { replacedById: created.id },
      });
    }

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    };
  }
}
