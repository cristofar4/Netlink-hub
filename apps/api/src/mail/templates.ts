import { MAIL_COLOURS, type Branding } from './branding';

/**
 * The email templates.
 *
 * Two rules shape everything here:
 *
 *   * **Both parts say the same thing.** Every message is sent as HTML and as
 *     plain text, and the text part is written rather than stripped — a mail
 *     client set to plain text, a screen reader and a spam filter all read that
 *     one, and a code that only exists in a `<div>` is a code some people
 *     cannot reach.
 *   * **Every value is escaped.** A person's name arrives from a registration
 *     form. It is the one piece of attacker-controlled text in the message, and
 *     an email is a document that renders HTML.
 *
 * The layout is tables and inline styles on purpose. It is not 2010 nostalgia:
 * Outlook still renders with Word's engine, which ignores flexbox, grid and
 * most of `<style>`.
 */

export type VerificationPurpose = 'email_verification' | 'device_verification' | 'step_up';

export type VerificationInput = {
  name: string;
  code: string;
  purpose: VerificationPurpose;
  deviceName?: string;
  approximateLocation?: string | null;
  expiresInMinutes: number;
};

export type ComposedMail = {
  subject: string;
  text: string;
  html: string;
};

export function composeVerificationMail(input: VerificationInput, brand: Branding): ComposedMail {
  const copy = verificationCopy(input, brand);

  return {
    subject: copy.subject,
    text: renderText(copy, input.code, brand),
    html: renderHtml(copy, input.code, brand),
  };
}

type Copy = {
  subject: string;
  /** The one-line summary, above the code. */
  headline: string;
  /** Optional facts about the request — which device, from roughly where. */
  facts: Array<{ label: string; value: string }>;
  /** What to do if this was not you. */
  warning: string;
};

function verificationCopy(input: VerificationInput, brand: Branding): Copy {
  const expiry = `This code expires in ${input.expiresInMinutes} minutes and can only be used once.`;

  switch (input.purpose) {
    case 'email_verification':
      return {
        subject: `Confirm your ${brand.name} account`,
        headline: `Hi ${input.name}, use this code to confirm your email address.`,
        facts: [{ label: 'Valid for', value: `${input.expiresInMinutes} minutes` }],
        warning: `${expiry} If you did not create an account, you can ignore this email — nothing has been set up.`,
      };

    case 'device_verification': {
      const facts: Array<{ label: string; value: string }> = [];
      if (input.deviceName) facts.push({ label: 'Device', value: input.deviceName });
      if (input.approximateLocation) {
        facts.push({ label: 'Approximate location', value: input.approximateLocation });
      }
      facts.push({ label: 'Valid for', value: `${input.expiresInMinutes} minutes` });

      return {
        subject: `Approve a new device on ${brand.name}`,
        headline: `A new device is trying to sign in to your ${brand.name} account.`,
        facts,
        // The instruction is deliberately blunt: this is the message an
        // attacker most wants forwarded to them.
        warning: `${expiry} ${brand.name} will never ask you for this code — not by email, not by phone, not in a chat. If you were not signing in, do not share it. Change your password and remove any device you do not recognise.`,
      };
    }

    case 'step_up':
      return {
        subject: `Confirm a sensitive action on ${brand.name}`,
        headline: 'Use this code to confirm an action that affects one of your computers.',
        facts: [
          ...(input.deviceName ? [{ label: 'Computer', value: input.deviceName }] : []),
          { label: 'Valid for', value: `${input.expiresInMinutes} minutes` },
        ],
        warning: `${expiry} If you did not start this, do not share the code — someone else may have your password.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function renderText(copy: Copy, code: string, brand: Branding): string {
  const lines = [brand.name.toUpperCase(), '', copy.headline, '', code, ''];

  for (const fact of copy.facts) lines.push(`${fact.label}: ${fact.value}`);

  lines.push('', copy.warning);

  const footer = textFooter(brand);
  if (footer.length > 0) lines.push('', '—', ...footer);

  return lines.join('\n');
}

function textFooter(brand: Branding): string[] {
  const lines: string[] = [];
  if (brand.supportEmail) lines.push(`Questions? Write to ${brand.supportEmail}`);
  if (brand.url) lines.push(brand.url);
  if (brand.footer) lines.push(brand.footer);
  return lines;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderHtml(copy: Copy, code: string, brand: Branding): string {
  const c = MAIL_COLOURS;

  const facts = copy.facts
    .map(
      (fact) => `
            <tr>
              <td style="padding:4px 0;font-size:13px;color:${c.textMuted}">${escapeHtml(fact.label)}</td>
              <td style="padding:4px 0;font-size:13px;color:${c.text};text-align:right">${escapeHtml(fact.value)}</td>
            </tr>`,
    )
    .join('');

  const footerParts: string[] = [];
  if (brand.supportEmail) {
    footerParts.push(
      `Questions? Write to <a href="mailto:${escapeAttribute(brand.supportEmail)}" style="color:${c.accent};text-decoration:none">${escapeHtml(brand.supportEmail)}</a>`,
    );
  }
  if (brand.url) {
    footerParts.push(
      `<a href="${escapeAttribute(brand.url)}" style="color:${c.textMuted};text-decoration:none">${escapeHtml(displayUrl(brand.url))}</a>`,
    );
  }
  if (brand.footer) footerParts.push(escapeHtml(brand.footer));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(copy.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${c.ground};">
    <!-- Shown in the inbox list under the subject, so the code is not the preview. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(copy.headline)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.ground};padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:${c.surface};border:1px solid ${c.border};border-radius:16px;overflow:hidden">
            <tr>
              <td style="padding:24px 28px 0">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:32px;height:32px;background:${c.brand};border-radius:9px" align="center" valign="middle">
                      <span style="font-family:Segoe UI,system-ui,-apple-system,sans-serif;font-size:16px;font-weight:700;color:#ffffff;line-height:32px">${escapeHtml(
                        brand.name.slice(0, 1).toUpperCase(),
                      )}</span>
                    </td>
                    <td style="padding-left:10px;font-family:Segoe UI,system-ui,-apple-system,sans-serif;font-size:16px;font-weight:600;color:${c.text}">${escapeHtml(
                      brand.name,
                    )}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px 0;font-family:Segoe UI,system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.55;color:${c.text}">
                ${escapeHtml(copy.headline)}
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.ground};border:1px solid ${c.border};border-radius:12px">
                  <tr>
                    <td align="center" style="padding:18px 12px;font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:.28em;color:${c.accent}">${escapeHtml(
                      code,
                    )}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Segoe UI,system-ui,-apple-system,sans-serif">${facts}
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px 24px;font-family:Segoe UI,system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.6;color:${c.textSecondary}">
                ${escapeHtml(copy.warning)}
              </td>
            </tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
            <tr>
              <td style="padding:16px 8px;font-family:Segoe UI,system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.7;color:${c.textMuted};text-align:center">
                ${footerParts.join('<br />')}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** `https://netlink.example.com/` reads better as `netlink.example.com`. */
function displayUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escaping for a value that lands inside an attribute.
 *
 * Same as the above plus the characters that end an unquoted attribute — a
 * `mailto:` built from configuration should not be able to introduce one.
 */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;').replace(/=/g, '&#61;');
}
