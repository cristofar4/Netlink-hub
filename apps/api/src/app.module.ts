import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { validateConfig } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DevicesModule } from './devices/devices.module';
import { SpacesModule } from './spaces/spaces.module';
import { AgentsModule } from './agents/agents.module';
import { DataModule } from './data/data.module';
import { PowerModule } from './power/power.module';
import { LiveModule } from './live/live.module';
import { HealthModule } from './health/health.module';
import { AccessTokenGuard } from './auth/access-token.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
      cache: true,
    }),
    PrismaModule,
    MailModule,
    AuditModule,
    AuthModule,
    LiveModule,
    SpacesModule,
    DevicesModule,
    AgentsModule,
    DataModule,
    PowerModule,
    HealthModule,
  ],
  providers: [
    {
      // Authentication is on by default for every route in the application.
      // Public endpoints opt out with @Public(), so forgetting a guard leaves
      // an endpoint locked rather than open.
      provide: APP_GUARD,
      useClass: AccessTokenGuard,
    },
  ],
})
export class AppModule {}
