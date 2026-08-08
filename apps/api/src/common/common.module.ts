import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { AppConfig } from '../config/configuration';
import { MemoryRateLimitStore, PostgresRateLimitStore, RateLimitStore } from './rate-limit.store';
import { RateLimiterService } from './rate-limiter.service';
import { AccountGuardService } from './account-guard.service';
import { MetricsService } from './metrics.service';

/**
 * The cross-cutting services: rate limiting, account protection, metrics.
 *
 * Global because every feature module needs them and threading the same three
 * providers through a dozen module definitions is how one of them ends up with
 * a second instance and its own private counters.
 */
@Global()
@Module({
  providers: [
    {
      /*
      Which store depends on the deployment, so it is resolved once, here.

      A single instance can count in its own memory. The moment there are two,
      counters that do not agree mean the effective limit is `limit × replicas`
      — which is not a limit. The readiness endpoint reports which one is in
      use, so a misconfiguration is visible rather than silently generous.
      */
      provide: RateLimitStore,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService<AppConfig, true>, prisma: PrismaService) =>
        config.get('RATE_LIMIT_STORE', { infer: true }) === 'postgres'
          ? new PostgresRateLimitStore(prisma)
          : new MemoryRateLimitStore(),
    },
    RateLimiterService,
    AccountGuardService,
    MetricsService,
  ],
  exports: [RateLimitStore, RateLimiterService, AccountGuardService, MetricsService],
})
export class CommonModule {}
