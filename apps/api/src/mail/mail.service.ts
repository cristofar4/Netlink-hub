import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/configuration';
import { DEFAULT_BRANDING, type Branding } from './branding';
import { composeVerificationMail, type VerificationPurpose } from './templates';

export type NetLinkMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * The SMTP abstraction. Every outbound message goes through a transport, so
 * swapping the console transport for a real provider is a configuration
 * change, not a code change.
 */
export interface MailTransport {
  readonly name: string;
  send(mail: NetLinkMail): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** Development transport: prints the message so the code is visible in the API log. */
export class ConsoleMailTransport implements MailTransport {
  readonly name = 'console';
  private readonly logger = new Logger('Mail:console');

  async send(mail: NetLinkMail): Promise<void> {
    this.logger.log(`To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
  }
}

/** Test transport: keeps messages in memory so tests can assert on them. */
export class MemoryMailTransport implements MailTransport {
  readonly name = 'memory';
  readonly outbox: NetLinkMail[] = [];

  async send(mail: NetLinkMail): Promise<void> {
    this.outbox.push(mail);
  }

  lastFor(email: string): NetLinkMail | undefined {
    return [...this.outbox].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(
    private readonly from: string,
    options: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
    },
  ) {
    this.transporter = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user ? { user: options.user, pass: options.password ?? '' } : undefined,
      // Certificate validation stays on. A misconfigured SMTP server should
      // fail loudly rather than deliver verification codes over a connection
      // that anyone can intercept.
      tls: { rejectUnauthorized: true },
    });
  }

  async send(mail: NetLinkMail): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }
}

export const MAIL_BRANDING = Symbol('MAIL_BRANDING');

@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(MAIL_BRANDING) private readonly brand: Branding = DEFAULT_BRANDING,
  ) {}

  get transportName(): string {
    return this.transport.name;
  }

  /** The name these emails are signed with, so callers can report it. */
  get brandName(): string {
    return this.brand.name;
  }

  async sendVerificationCode(input: {
    to: string;
    name: string;
    code: string;
    purpose: VerificationPurpose;
    deviceName?: string;
    approximateLocation?: string | null;
    expiresInMinutes: number;
  }): Promise<void> {
    const { subject, text, html } = composeVerificationMail(input, this.brand);
    await this.transport.send({ to: input.to, subject, text, html });
  }
}

export function createMailTransport(config: AppConfig): MailTransport {
  switch (config.MAIL_TRANSPORT) {
    case 'smtp':
      return new SmtpMailTransport(config.MAIL_FROM, {
        host: config.SMTP_HOST as string,
        port: config.SMTP_PORT ?? 587,
        secure: config.SMTP_SECURE,
        user: config.SMTP_USER,
        password: config.SMTP_PASSWORD,
      });
    case 'memory':
      return new MemoryMailTransport();
    case 'console':
    default:
      return new ConsoleMailTransport();
  }
}
