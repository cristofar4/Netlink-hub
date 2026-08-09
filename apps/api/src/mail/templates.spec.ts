import { composeVerificationMail } from './templates';
import { DEFAULT_BRANDING, type Branding } from './branding';

/**
 * The verification email is the most phishable message the product sends, and
 * the only one carrying text a stranger chose (their own name). These tests
 * cover both of those, and the plainest failure of all: a code that reaches
 * one part of the message but not the other.
 */

const acme: Branding = {
  name: 'Acme Networks',
  url: 'https://acme.example.com/',
  supportEmail: 'help@acme.example.com',
  footer: 'Acme Networks Ltd, Lagos',
};

const base = {
  name: 'Christopher',
  code: '481920',
  purpose: 'email_verification' as const,
  expiresInMinutes: 10,
};

describe('verification email', () => {
  it('carries the code in both the HTML and the plain text', () => {
    const mail = composeVerificationMail(base, DEFAULT_BRANDING);

    // A client set to plain text, a screen reader and a spam filter all read
    // the text part. A code only in the markup is a code some people cannot
    // reach.
    expect(mail.text).toContain('481920');
    expect(mail.html).toContain('481920');
  });

  it('signs every purpose with the configured brand, not the product name', () => {
    for (const purpose of ['email_verification', 'device_verification', 'step_up'] as const) {
      const mail = composeVerificationMail({ ...base, purpose }, acme);
      expect(mail.subject).toContain('Acme Networks');
      expect(mail.text).toContain('ACME NETWORKS');
      expect(mail.html).toContain('Acme Networks');
      expect(mail.subject).not.toContain('NetLink');
    }
  });

  it('keeps the code out of the subject line', () => {
    // Subjects show on lock screens and in notification previews. The code
    // should require opening the message.
    for (const purpose of ['email_verification', 'device_verification', 'step_up'] as const) {
      const mail = composeVerificationMail({ ...base, purpose }, acme);
      expect(mail.subject).not.toContain(base.code);
    }
  });

  it('escapes a name that contains markup', () => {
    const mail = composeVerificationMail(
      { ...base, name: '<img src=x onerror="alert(1)">Chris' },
      DEFAULT_BRANDING,
    );

    // The payload survives as text — that is the point of escaping, and
    // asserting the string "onerror=" is absent would be asserting the wrong
    // thing. What matters is that no tag can form and no attribute can be
    // closed: every angle bracket and quote is encoded.
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Chris');
    expect(mail.text).toContain('<img src=x onerror="alert(1)">Chris');
  });

  it('escapes a brand configured with markup in it', () => {
    const mail = composeVerificationMail(base, { name: '<b>Evil</b>' });
    expect(mail.html).not.toContain('<b>Evil</b>');
    expect(mail.html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });

  it('tells a new-device email which device and roughly where', () => {
    const mail = composeVerificationMail(
      {
        ...base,
        purpose: 'device_verification',
        deviceName: 'Work Laptop',
        approximateLocation: 'Owerri, Nigeria',
      },
      acme,
    );

    expect(mail.text).toContain('Work Laptop');
    expect(mail.text).toContain('Owerri, Nigeria');
    expect(mail.html).toContain('Work Laptop');
    // The anti-phishing line is the point of this message.
    expect(mail.text).toContain('will never ask you for this code');
  });

  it('leaves out the footer lines that were not configured', () => {
    const mail = composeVerificationMail(base, { name: 'Acme Networks' });

    expect(mail.text).not.toContain('Questions?');
    expect(mail.html).not.toContain('mailto:');
    // The brand name is still there — only the optional lines are absent.
    expect(mail.html).toContain('Acme Networks');
  });

  it('shows the support address and site when they are configured', () => {
    const mail = composeVerificationMail(base, acme);

    expect(mail.text).toContain('help@acme.example.com');
    expect(mail.text).toContain('Acme Networks Ltd, Lagos');
    expect(mail.html).toContain('mailto:help@acme.example.com');
    // The host, rather than the full URL with its scheme and trailing slash.
    expect(mail.html).toContain('acme.example.com');
  });

  it('says how long the code lasts, in both parts', () => {
    const mail = composeVerificationMail({ ...base, expiresInMinutes: 10 }, DEFAULT_BRANDING);
    expect(mail.text).toContain('10 minutes');
    expect(mail.html).toContain('10 minutes');
  });
});
