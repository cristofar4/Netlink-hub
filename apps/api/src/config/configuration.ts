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

    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    UNTRUSTED_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(1),

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

    RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_OTP_VERIFY_PER_MINUTE: z.coerce.number().int().positive().default(10),

    ENABLE_OPENAPI: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((cfg, ctx) => {
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
      if (cfg.MAIL_TRANSPORT !== 'smtp') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_TRANSPORT'],
          message: 'MAIL_TRANSPORT must be smtp in production',
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
