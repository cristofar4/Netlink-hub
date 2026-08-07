import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/configuration';

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

@Injectable()
export class MailService {
  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  get transportName(): string {
    return this.transport.name;
  }

  async sendVerificationCode(input: {
    to: string;
    name: string;
    code: string;
    purpose: 'email_verification' | 'device_verification' | 'step_up';
    deviceName?: string;
    approximateLocation?: string | null;
    expiresInMinutes: number;
  }): Promise<void> {
    const { subject, headline, body } = this.composeVerification(input);
    await this.transport.send({
      to: input.to,
      subject,
      text: `${headline}\n\n${input.code}\n\n${body}`,
      html: renderHtml({ headline, code: input.code, body }),
    });
  }

  private composeVerification(input: {
    name: string;
    purpose: 'email_verification' | 'device_verification' | 'step_up';
    deviceName?: string;
    approximateLocation?: string | null;
    expiresInMinutes: number;
  }): { subject: string; headline: string; body: string } {
    const expiry = `This code expires in ${input.expiresInMinutes} minutes and can be used once.`;
    const ignore = 'If you did not request this, you can ignore this email. Nothing has changed.';

    switch (input.purpose) {
      case 'email_verification':
        return {
          subject: 'Confirm your NetLink account',
          headline: `Hi ${input.name}, here is your NetLink confirmation code:`,
          body: `${expiry}\n\n${ignore}`,
        };
      case 'device_verification': {
        const where = input.approximateLocation ? ` near ${input.approximateLocation}` : '';
        const which = input.deviceName ? ` from "${input.deviceName}"` : '';
        return {
          subject: 'Verify a new device on NetLink',
          headline: `Someone is signing in to your NetLink account${which}${where}. Your code is:`,
          body: `${expiry}\n\nIf this was not you, do not share this code. Sign in and revoke any device you do not recognise.`,
        };
      }
      case 'step_up':
        return {
          subject: 'Confirm a sensitive NetLink action',
          headline: 'Confirm this action with the code below:',
          body: `${expiry}\n\n${ignore}`,
        };
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(input: { headline: string; code: string; body: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#080f1f;font-family:Segoe UI,system-ui,sans-serif;color:#e8eefc">
  <div style="max-width:480px;margin:0 auto;background:#0e1a33;border:1px solid #1c3159;border-radius:16px;padding:28px">
    <p style="margin:0 0 8px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#6f8bbd">NetLink</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.5">${escapeHtml(input.headline)}</p>
    <p style="margin:0 0 20px;font-size:34px;letter-spacing:.34em;font-weight:700;color:#38bdf8">${escapeHtml(
      input.code,
    )}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#93a7cc;white-space:pre-line">${escapeHtml(
      input.body,
    )}</p>
  </div>
</body></html>`;
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
