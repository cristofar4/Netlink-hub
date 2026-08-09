/**
 * Who NetLink's emails say they are from.
 *
 * A verification code is the most phishable message a product sends: it is
 * short, it is urgent, and it asks for an action. The defence is that the real
 * one is recognisable — the sender is the company the person signed up with,
 * the wording is the same every time, and it never asks for anything back.
 *
 * So the brand is configuration rather than a constant. An operator running
 * this for their own company sets four environment variables and every message
 * carries their name instead of the product's.
 */
export type Branding = {
  /** Appears in every subject line and in the body. */
  name: string;
  /** Linked from the footer. Absent means the footer carries no link. */
  url?: string;
  /** "Questions? write to …". Absent means the line is omitted. */
  supportEmail?: string;
  /** The legal line at the very bottom — company name, address, whatever applies. */
  footer?: string;
};

export const DEFAULT_BRANDING: Branding = { name: 'NetLink' };

/**
 * The palette, matching the app's own tokens.
 *
 * Inline, because email clients strip `<style>` blocks and none of them
 * support CSS custom properties. Kept here so the two do not drift silently.
 */
export const MAIL_COLOURS = {
  ground: '#060b18',
  surface: '#0e1a33',
  border: '#1c3159',
  text: '#f2f6ff',
  textSecondary: '#a3b5d4',
  textMuted: '#6f84a8',
  accent: '#38bdf8',
  brand: '#2f6bff',
} as const;
