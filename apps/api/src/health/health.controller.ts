import { Controller, Get, Header, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ComponentHealth, HealthResponse } from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { Public } from '../auth/public.decorator';
import { MetricsService } from '../common/metrics.service';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppConfig } from '../config/configuration';

const START_TIME = Date.now();
const VERSION = process.env.npm_package_version ?? '0.1.0';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /** Liveness. Answers as long as the process is running; touches nothing. */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness. Actually queries PostgreSQL, because an API that reports healthy
   * while its database is unreachable is worse than one that reports nothing.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Readiness probe with component detail' })
  async ready(): Promise<HealthResponse> {
    const components: Record<string, ComponentHealth> = {};

    try {
      const latencyMs = await this.prisma.ping();
      components.database = { status: 'up', latencyMs };
    } catch (error) {
      components.database = { status: 'down', detail: (error as Error).message };
    }

    // The console and memory transports are legitimate in development but are
    // not real delivery, so readiness reports them as degraded rather than up.
    const transport = this.mail.transportName;
    components.mail =
      transport === 'smtp'
        ? { status: 'up', detail: 'smtp' }
        : { status: 'degraded', detail: `${transport} transport — no real email is being sent` };

    /*
    Whether rate-limit counters are shared.

    Reported because the failure mode is invisible otherwise: two instances on
    in-memory counters enforce twice the configured limit and nothing looks
    wrong. Saying so here means a misconfigured deployment shows up on the
    dashboard rather than in an incident.
    */
    const limiter = this.rateLimiter.describe();
    components.rateLimiter = limiter.shared
      ? { status: 'up', detail: limiter.kind }
      : {
          status: 'degraded',
          detail: `${limiter.kind} — counters are per-instance, so limits do not hold across replicas`,
        };

    const status = components.database?.status === 'down' ? 'error' : 'ok';

    return {
      status,
      service: 'netlink-api',
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      timestamp: new Date().toISOString(),
      components,
    };
  }
}

/**
 * Metrics, in Prometheus text format.
 *
 * Off unless `ENABLE_METRICS` is set, and a 404 when it is off rather than a
 * 403 — an endpoint that exists but refuses is still an endpoint worth probing.
 *
 * It carries no user ids, no emails, no addresses and no Space ids; routes
 * appear as templates only. See `MetricsService` for why that restraint is
 * deliberate rather than incidental.
 */
@ApiTags('health')
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Prometheus metrics' })
  render(): string {
    if (!this.config.get('ENABLE_METRICS', { infer: true })) {
      throw new NotFoundException();
    }
    return this.metrics.render();
  }
}
