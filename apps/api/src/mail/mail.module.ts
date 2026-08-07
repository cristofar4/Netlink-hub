import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { MAIL_TRANSPORT, MailService, createMailTransport } from './mail.service';

@Global()
@Module({
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
    MailService,
  ],
  exports: [MailService, MAIL_TRANSPORT],
})
export class MailModule {}
