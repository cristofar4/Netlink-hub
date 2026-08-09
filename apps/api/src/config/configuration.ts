import { z } from 'zod';

/**
 * Every configuration value the control plane reads, validated at boot.
 *
 * The process refuses to start on invalid configuration rather than falling
 * back to a weak default — an API that silently boots with a placeholder JWT
 * secret is worse than one that does not boot at all.
 */
const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),
    API_PREFIX: z.string().default('api'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /** Signing key for short-lived access tokens. */
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_ISSUER: z.string().default('netlink'),
    JWT_AUDIENCE: z.string().default('netlink-client'),

    /**
     * Ed25519 seed (32 bytes, base64url) used to sign power commands.
     * Without it a fresh key is generated at boot, which is fine locally and
     * refused in production.
     */
    POWER_SIGNING_KEY: z.string().optional(),

    /**
     * ICE configuration for remote desktop.
     *
     * STUN only tells a peer its own public address; it carries no media and
     * sees no traffic. TURN does relay media, so its credentials are minted
     * per session and expire in minutes — `TURN_SECRET` is the shared secret a
     * coturn server is started with (`static-auth-secret`), never a password
     * handed to a client.
     *
     * Both are comma-separated so a deployment can list several.
     */
    STUN_URLS: z.string().default(''),
    TURN_URLS: z.string().default(''),
    TURN_SECRET: z.string().optional(),
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),

    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    UNTRUSTED_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(1),

    /**
     * Who the emails come from.
     *
     * These are configuration rather than constants because the people
     * receiving a six-digit code need to recognise the sender — an email
     * signed by a product name they have never heard of reads as phishing,
     * which is exactly the instinct you want people to keep.
     *
     * BRAND_NAME appears in every subject line, in the message body and in the
     * footer. MAIL_FROM must be an address on a domain your SMTP provider has
     * verified you may send from; the two should agree, or spam filters will
     * notice that they do not.
     */
    BRAND_NAME: z.string().trim().min(1).max(60).default('NetLink'),
    /** Linked from the email footer. Omit and the footer simply has no link. */
    BRAND_URL: z.string().url().optional(),
    /** Shown as "questions? write to …". Omit to leave it out. */
    BRAND_SUPPORT_EMAIL: z.string().email().optional(),
    /** The legal line at the very bottom, e.g. a company name and address. */
    BRAND_FOOTER: z.string().trim().max(200).optional(),

    /**
     * `console` prints the message (and the code) to the server log for local
     * development. `smtp` performs real delivery. `memory` is used by tests.
     */
    MAIL_TRANSPORT: z.enum(['console', 'smtp', 'memory']).default('console'),
    MAIL_FROM: z.string().default('NetLink <no-reply@netlink.local>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    /**
     * Returns the OTP in the API response so a developer without a mailbox can
     * complete the flow. Refused outright in production.
     */
    EXPOSE_DEV_OTP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    CORS_ORIGINS: z.string().default('http://localhost:5173,http://wails.localhost'),

    /**
     * Where rate-limit counters live.
     *
     * `memory` is correct for exactly one instance. With two, counters that do
     * not agree mean the effective limit is `limit × replicas`, which is not a
     * limit — so production must say which it wants rather than inheriting a
     * default that is silently wrong at scale.
     */
    RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
    /** Ceiling on requests from one address, across every endpoint. */
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_OTP_VERIFY_PER_MINUTE: z.coerce.number().int().positive().default(10),

    ENABLE_OPENAPI: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /**
     * Serves `/api/metrics` in Prometheus format.
     *
     * Off unless asked for, and bound behind whatever the deployment uses to
     * reach it — the endpoint carries no personal data by design, but it is
     * still an unauthenticated description of how the system is behaving.
     */
    ENABLE_METRICS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    /** Version reported on the health endpoint and in the update manifest. */
    APP_VERSION: z.string().default('0.1.0-dev'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.TURN_URLS.trim() && !cfg.TURN_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TURN_SECRET'],
        message:
          'TURN_SECRET is required when TURN_URLS is set — without it no usable credential can be minted',
      });
    }
    if (cfg.MAIL_TRANSPORT === 'smtp' && !cfg.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when MAIL_TRANSPORT=smtp',
      });
    }
    if (cfg.NODE_ENV === 'production') {
      if (cfg.EXPOSE_DEV_OTP) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EXPOSE_DEV_OTP'],
          message: 'EXPOSE_DEV_OTP must be false in production',
        });
      }
      if (!cfg.POWER_SIGNING_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['POWER_SIGNING_KEY'],
          message:
            'POWER_SIGNING_KEY is required in production — an ephemeral key would invalidate every power command on restart',
        });
      }
      if (cfg.RATE_LIMIT_STORE !== 'postgres') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RATE_LIMIT_STORE'],
          message:
            'RATE_LIMIT_STORE must be postgres in production — in-memory counters do not hold across instances, so the effective limit becomes limit × replicas',
        });
      }
      if (cfg.MAIL_TRANSPORT !== 'smtp') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_TRANSPORT'],
          message: 'MAIL_TRANSPORT must be smtp in production',
        });
      }
      if (cfg.MAIL_FROM.includes('netlink.local')) {
        // The development default is an address on a domain that does not
        // exist. Sending from it in production means every verification code
        // is either rejected outright or filed as spam — and the first anyone
        // hears of it is a user who cannot sign in.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_FROM'],
          message:
            'MAIL_FROM is still the development default. Set it to an address on a domain your SMTP provider has verified.',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid NetLink API configuration:\n${details}`);
  }
  return result.data;
}

export function corsOrigins(config: AppConfig): string[] {
  return config.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
