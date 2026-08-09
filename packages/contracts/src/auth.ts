import { z } from 'zod';

/**
 * Auth contracts shared by the NestJS control plane and the desktop client.
 * The API validates every request against these schemas; the desktop client
 * uses the same schemas so a request is never shaped differently on the wire.
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between two resend requests for the same challenge. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
/** Maximum resends per challenge before the user must start over. */
export const OTP_MAX_RESENDS = 3;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;
/** A device that was not marked "Trust This Device" gets a short-lived session. */
export const UNTRUSTED_REFRESH_TOKEN_TTL_DAYS = 1;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * What makes a password acceptable, as a list the interface can show.
 *
 * The schema below is built from these, so the ticks on the sign-up form and
 * the rules the server enforces cannot drift apart — the failure mode being a
 * form that accepts a password the API then refuses, with no way for the person
 * typing it to tell which rule they broke.
 */
export const PASSWORD_RULES = [
  {
    id: 'length',
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    test: (value: string) => value.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: 'lowercase',
    label: 'A lowercase letter',
    message: 'Password must contain a lowercase letter',
    test: (value: string) => /[a-z]/.test(value),
  },
  {
    id: 'uppercase',
    label: 'An uppercase letter',
    message: 'Password must contain an uppercase letter',
    test: (value: string) => /[A-Z]/.test(value),
  },
  {
    id: 'number',
    label: 'A number',
    message: 'Password must contain a number',
    test: (value: string) => /[0-9]/.test(value),
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  message: string;
  test: (value: string) => boolean;
}>;

const passwordSchema = PASSWORD_RULES.reduce(
  (schema, rule) => schema.refine(rule.test, rule.message),
  z
    .string()
    .max(
      PASSWORD_MAX_LENGTH,
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    ) as z.ZodType<string>,
);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`);

/**
 * Device identity presented at enrollment. The private half never leaves the
 * device; only this public material is sent to the control plane.
 */
export const deviceIdentitySchema = z.object({
  /** Stable, device-generated identifier (UUIDv4 created at first run). */
  installationId: z.string().uuid(),
  /** Base64url-encoded Ed25519 public key (32 bytes). */
  publicKey: z.string().min(32).max(128),
  publicKeyAlgorithm: z.literal('ed25519'),
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['windows', 'macos', 'linux', 'web', 'android', 'ios']),
  osVersion: z.string().trim().max(128).optional(),
  appVersion: z.string().trim().max(64).optional(),
  kind: z.enum(['desktop', 'agent', 'mobile', 'browser']).default('desktop'),
});
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

export const registerRequestSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const verifyEmailRequestSchema = z.object({
  challengeId: z.string().uuid(),
  code: otpCodeSchema,
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const resendCodeRequestSchema = z.object({
  challengeId: z.string().uuid(),
});
export type ResendCodeRequest = z.infer<typeof resendCodeRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(256),
  device: deviceIdentitySchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const verifyDeviceRequestSchema = z.object({
  challengeId: z.string().uuid(),
  code: otpCodeSchema,
  trustDevice: z.boolean().default(false),
});
export type VerifyDeviceRequest = z.infer<typeof verifyDeviceRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const renameDeviceRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
});
export type RenameDeviceRequest = z.infer<typeof renameDeviceRequestSchema>;

/** Why the client is being asked for a six-digit code. */
export const challengePurposes = ['email_verification', 'device_verification', 'step_up'] as const;
export type ChallengePurpose = (typeof challengePurposes)[number];

export type ChallengeResponse = {
  challengeId: string;
  purpose: ChallengePurpose;
  /** Masked for display — the full address is never echoed back. */
  maskedEmail: string;
  expiresAt: string;
  resendAvailableAt: string;
  attemptsRemaining: number;
  resendsRemaining: number;
  /** Present only when the SMTP transport is the console/dev transport. */
  devCode?: string;
};

export type AuthenticatedUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
};

export type AuthenticatedDevice = {
  id: string;
  name: string;
  platform: string;
  kind: string;
  trusted: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Coarse, city-level at best. Never a precise coordinate. */
  approximateLocation: string | null;
  current?: boolean;
};

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
};

export type AuthSuccessResponse = {
  status: 'authenticated';
  user: AuthenticatedUser;
  device: AuthenticatedDevice;
  tokens: SessionTokens;
};

export type ChallengeRequiredResponse = {
  status: 'challenge_required';
  challenge: ChallengeResponse;
};

export type LoginResponse = AuthSuccessResponse | ChallengeRequiredResponse;

/**
 * Masks an address for display on the "check your email" screens:
 * `christopher@example.com` -> `c••••••••r@example.com`.
 *
 * The API is the only place that knows the full address; this runs there and
 * the client renders whatever it is given.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•'.repeat(Math.max(email.length, 3));
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  // The domain stays visible so the owner can recognise which mailbox to open;
  // the local part is what identifies the person, so that is what we hide.
  const maskedLocal =
    local.length <= 2
      ? `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 1))}`
      : `${local[0]}${'•'.repeat(Math.min(local.length - 2, 8))}${local[local.length - 1]}`;

  return `${maskedLocal}@${domain}`;
}
