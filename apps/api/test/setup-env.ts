/**
 * Runs before any module is imported.
 *
 * `ConfigModule.forRoot({ validate })` evaluates when `app.module.ts` is first
 * imported, which happens at the top of a test file — before any `beforeAll`
 * could set these. So the test environment is established here.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://netlink:netlink@localhost:5432/netlink_test?schema=public';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'test-secret-that-is-definitely-long-enough-32';
process.env.JWT_ACCESS_TTL_SECONDS = process.env.JWT_ACCESS_TTL_SECONDS ?? '900';
process.env.MAIL_TRANSPORT = 'memory';
process.env.EXPOSE_DEV_OTP = 'false';
process.env.ENABLE_OPENAPI = 'false';

// Generous by default so ordinary flows are never throttled. The rate-limit
// test overrides these before importing the app.
process.env.RATE_LIMIT_LOGIN_PER_MINUTE = process.env.RATE_LIMIT_LOGIN_PER_MINUTE ?? '1000';
process.env.RATE_LIMIT_REGISTER_PER_HOUR = process.env.RATE_LIMIT_REGISTER_PER_HOUR ?? '1000';
process.env.RATE_LIMIT_OTP_VERIFY_PER_MINUTE =
  process.env.RATE_LIMIT_OTP_VERIFY_PER_MINUTE ?? '1000';
