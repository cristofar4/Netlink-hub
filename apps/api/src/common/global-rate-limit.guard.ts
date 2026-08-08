import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { extractRequestContext } from './request-context';
import { RateLimiterService } from './rate-limiter.service';
import { TooManyRequestsException } from './too-many-requests.exception';
import type { AppConfig } from '../config/configuration';

/**
 * A ceiling on requests from one address, across every endpoint.
 *
 * The endpoint-specific limits — sign-in, registration, code verification — are
 * much tighter and live where they belong. This one exists for everything else:
 * the endpoints nobody thought to protect individually, and the case where the
 * cost is not any single request but the volume.
 *
 * It runs *ahead* of authentication, so an unauthenticated flood is stopped
 * before it costs a token verification, and so an attacker cannot get more
 * throughput by simply not signing in.
 *
 * Health and metrics are exempt. A monitoring system polls them steadily and by
 * design, and rate-limiting the thing that tells you the system is up is how a
 * small problem is first observed as a total outage.
 */
@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private static readonly EXEMPT = ['/health', '/metrics'];

  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path ?? '';
    if (GlobalRateLimitGuard.EXEMPT.some((exempt) => path.includes(exempt))) return true;

    const { ipAddress } = extractRequestContext(request);
    const limit = this.config.get('RATE_LIMIT_GLOBAL_PER_MINUTE', { infer: true });

    const result = await this.rateLimiter.consume(`global:${ipAddress ?? 'unknown'}`, limit, 60);
    if (!result.allowed) {
      throw new TooManyRequestsException(
        'Too many requests from this connection. Please wait a moment.',
        result.retryAfterSeconds,
      );
    }
    return true;
  }
}
