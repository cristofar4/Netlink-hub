import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import type { Branding } from './branding';
import { MAIL_BRANDING, MAIL_TRANSPORT, MailService, createMailTransport } from './mail.service';
import { BrandingController } from './branding.controller';

@Global()
@Module({
  controllers: [BrandingController],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        createMailTransport({
          MAIL_TRANSPORT: config.get('MAIL_TRANSPORT', { infer: true }),
          MAIL_FROM: config.get('MAIL_FROM', { infer: true }),
          SMTP_HOST: config.get('SMTP_HOST', { infer: true }),
          SMTP_PORT: config.get('SMTP_PORT', { infer: true }),
          SMTP_SECURE: config.get('SMTP_SECURE', { infer: true }),
          SMTP_USER: config.get('SMTP_USER', { infer: true }),
          SMTP_PASSWORD: config.get('SMTP_PASSWORD', { infer: true }),
        } as AppConfig),
    },
    {
      // Resolved once at startup rather than read per message: the name on a
      // verification email must not change between two codes sent a minute
      // apart because someone edited an environment variable mid-flight.
      provide: MAIL_BRANDING,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Branding => ({
        name: config.get('BRAND_NAME', { infer: true }),
        url: config.get('BRAND_URL', { infer: true }),
        supportEmail: config.get('BRAND_SUPPORT_EMAIL', { infer: true }),
        footer: config.get('BRAND_FOOTER', { infer: true }),
      }),
    },
    MailService,
  ],
  exports: [MailService, MAIL_TRANSPORT, MAIL_BRANDING],
})
export class MailModule {}
