import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ComponentHealth, HealthResponse } from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { Public } from '../auth/public.decorator';

const START_TIME = Date.now();
const VERSION = process.env.npm_package_version ?? '0.1.0';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
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
