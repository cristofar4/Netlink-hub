import request from 'supertest';
import type { Server } from 'node:http';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';
import { AccountGuardService } from '../../src/common/account-guard.service';
import { MetricsService } from '../../src/common/metrics.service';
import {
  MemoryRateLimitStore,
  PostgresRateLimitStore,
  type RateLimitStore,
} from '../../src/common/rate-limit.store';
import { RateLimiterService } from '../../src/common/rate-limiter.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Production hardening (integration)', () => {
  let harness: TestHarness;
  let http: Server;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  async function registerAndVerify(address: string) {
    const registration = await request(http)
      .post('/api/auth/register')
      .send({ name: address.split('@')[0], email: address, password: strongPassword })
      .expect(202);
    await request(http)
      .post('/api/auth/verify-email')
      .send({ challengeId: registration.body.challengeId, code: readCode(harness.mail, address) })
      .expect(200);
  }

  function attemptLogin(address: string, password: string) {
    return request(http)
      .post('/api/auth/login')
      .send({ email: address, password, device: makeDevice() });
  }

  // -------------------------------------------------------------------------
  // Rate-limit storage
  // -------------------------------------------------------------------------

  describe('shared rate-limit counters', () => {
    /**
     * The property that makes a shared store worth having: two instances see
     * one budget. With per-process counters the effective limit is
     * `limit × replicas`, which is not a limit at all.
     */
    it('counts across instances', async () => {
      const prisma = harness.app.get(PrismaService);
      const first = new PostgresRateLimitStore(prisma);
      const second = new PostgresRateLimitStore(prisma);

      const key = `shared-test-${Date.now()}`;

      expect((await first.consume(key, 3, 60)).allowed).toBe(true);
      expect((await second.consume(key, 3, 60)).allowed).toBe(true);
      expect((await first.consume(key, 3, 60)).allowed).toBe(true);

      // Fourth hit, from either instance, is over.
      const refused = await second.consume(key, 3, 60);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('does not count across instances when the store is in memory', async () => {
      const first = new MemoryRateLimitStore();
      const second = new MemoryRateLimitStore();
      const key = 'per-process';

      await first.consume(key, 1, 60);
      // The second instance has never heard of it — which is exactly the
      // failure the shared store exists to fix, stated as a test so the
      // difference is not theoretical.
      expect((await second.consume(key, 1, 60)).allowed).toBe(true);
    });

    it('starts a fresh window once the old one passes', async () => {
      const prisma = harness.app.get(PrismaService);
      const store = new PostgresRateLimitStore(prisma);
      const key = `window-test-${Date.now()}`;
      const start = Date.now();

      expect((await store.consume(key, 1, 60, start)).allowed).toBe(true);
      expect((await store.consume(key, 1, 60, start + 1000)).allowed).toBe(false);

      // A minute later the budget is back, and the row was reused rather than
      // accumulating forever.
      expect((await store.consume(key, 1, 60, start + 61_000)).allowed).toBe(true);
    });

    it('handles concurrent hits without losing any', async () => {
      const prisma = harness.app.get(PrismaService);
      const store = new PostgresRateLimitStore(prisma);
      const key = `concurrent-${Date.now()}`;

      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.consume(key, 5, 60)),
      );

      // Exactly five allowed. A read-then-write would let several through.
      expect(results.filter((result) => result.allowed)).toHaveLength(5);
    });

    it('reports on the health endpoint whether counters are shared', async () => {
      const health = await request(http).get('/api/health').expect(200);
      const limiter = health.body.components.rateLimiter;

      expect(limiter).toBeDefined();
      const store = harness.app.get<RateLimitStore>(RateLimiterService).describe();
      expect(limiter.status).toBe(store.shared ? 'up' : 'degraded');
    });
  });

  // -------------------------------------------------------------------------
  // Account protection
  // -------------------------------------------------------------------------

  describe('protecting one account from many machines', () => {
    it('starts refusing after repeated wrong passwords', async () => {
      await registerAndVerify('target@example.com');

      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD; attempt += 1) {
        await attemptLogin('target@example.com', 'Wrong-Password-1').expect(401);
      }

      const guard = await harness.prisma.accountGuard.findUniqueOrThrow({
        where: { userId: (await harness.prisma.user.findFirstOrThrow()).id },
      });
      expect(guard.lockedUntil).not.toBeNull();
      expect(guard.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    /**
     * The refusal must be indistinguishable from a wrong password. Saying "this
     * account is locked" confirms the address is real and that the guesses are
     * landing.
     */
    it('says nothing different when an account is cooling off', async () => {
      await registerAndVerify('quiet@example.com');

      const first = await attemptLogin('quiet@example.com', 'Wrong-Password-1').expect(401);
      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD; attempt += 1) {
        await attemptLogin('quiet@example.com', 'Wrong-Password-1');
      }
      const locked = await attemptLogin('quiet@example.com', 'Wrong-Password-1').expect(401);

      expect(locked.body.message).toBe(first.body.message);
    });

    it('refuses even the correct password while cooling off', async () => {
      await registerAndVerify('correct@example.com');

      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD; attempt += 1) {
        await attemptLogin('correct@example.com', 'Wrong-Password-1');
      }

      await attemptLogin('correct@example.com', strongPassword).expect(401);
    });

    it('records the cooling-off refusal separately in the audit trail', async () => {
      await registerAndVerify('audited@example.com');

      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD + 1; attempt += 1) {
        await attemptLogin('audited@example.com', 'Wrong-Password-1');
      }

      const denied = await harness.prisma.auditEvent.findMany({
        where: { action: 'auth.login.failed', outcome: 'denied' },
      });
      expect(
        denied.some(
          (event) => (event.metadata as { reason?: string })?.reason === 'account_cooling_off',
        ),
      ).toBe(true);
    });

    it('clears the count after a successful sign-in', async () => {
      await registerAndVerify('recovers@example.com');
      const guard = harness.app.get(AccountGuardService);
      const user = await harness.prisma.user.findFirstOrThrow();

      // Just under the threshold, so nothing is locked yet.
      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD - 1; attempt += 1) {
        await attemptLogin('recovers@example.com', 'Wrong-Password-1').expect(401);
      }

      await attemptLogin('recovers@example.com', strongPassword).expect(200);

      expect(
        await harness.prisma.accountGuard.findUnique({ where: { userId: user.id } }),
      ).toBeNull();
      expect(await guard.lockedForSeconds(user.id)).toBe(0);
    });

    /**
     * A lockout that never lifts would hand anybody who knows an email address
     * the ability to lock its owner out of their own account. Denial of service
     * by helpful security control is still denial of service.
     */
    it('lifts on its own rather than locking someone out permanently', async () => {
      await registerAndVerify('temporary@example.com');
      const guard = harness.app.get(AccountGuardService);
      const user = await harness.prisma.user.findFirstOrThrow();

      const now = new Date();
      let delay = 0;
      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD; attempt += 1) {
        delay = await guard.recordFailure(user.id, now);
      }

      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(AccountGuardService.MAX_LOCK_SECONDS);

      // Once the delay has passed, the account is usable again.
      const after = new Date(now.getTime() + (delay + 1) * 1000);
      expect(await guard.lockedForSeconds(user.id, after)).toBe(0);
    });

    it('never delays longer than the ceiling, however many failures there are', async () => {
      await registerAndVerify('persistent@example.com');
      const guard = harness.app.get(AccountGuardService);
      const user = await harness.prisma.user.findFirstOrThrow();

      const now = new Date();
      let delay = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        delay = await guard.recordFailure(user.id, now);
      }

      expect(delay).toBe(AccountGuardService.MAX_LOCK_SECONDS);
    });

    it('forgets old failures after a long quiet spell', async () => {
      await registerAndVerify('occasional@example.com');
      const guard = harness.app.get(AccountGuardService);
      const user = await harness.prisma.user.findFirstOrThrow();

      const first = new Date();
      for (let attempt = 0; attempt < AccountGuardService.THRESHOLD - 1; attempt += 1) {
        await guard.recordFailure(user.id, first);
      }

      // Someone who mistypes twice today and twice next month is not an attack.
      const later = new Date(first.getTime() + (AccountGuardService.DECAY_SECONDS + 60) * 1000);
      const delay = await guard.recordFailure(user.id, later);
      expect(delay).toBe(0);

      const row = await harness.prisma.accountGuard.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(row.failures).toBe(1);
    });

    it('does not create a record for an address that has no account', async () => {
      await attemptLogin('nobody@example.com', 'Wrong-Password-1').expect(401);
      expect(await harness.prisma.accountGuard.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  describe('metrics', () => {
    it('serves Prometheus text', async () => {
      await request(http).get('/api/health/live').expect(200);

      const metrics = await request(http).get('/api/metrics').expect(200);
      expect(metrics.headers['content-type']).toContain('text/plain');
      expect(metrics.text).toContain('# TYPE netlink_http_requests_total counter');
      expect(metrics.text).toContain('netlink_uptime_seconds');
    });

    /**
     * A metrics endpoint is scraped by monitoring, often without
     * authentication, and it is a description of who used the system and when
     * if the labels are careless. Route templates only.
     */
    it('labels routes by template, never by the ids that were in them', async () => {
      const address = 'metrics@example.com';
      await registerAndVerify(address);

      const login = await request(http)
        .post('/api/auth/login')
        .send({ email: address, password: strongPassword, device: makeDevice() })
        .expect(200);
      const verified = await request(http)
        .post('/api/auth/verify-device')
        .send({
          challengeId: login.body.challenge.challengeId,
          code: readCode(harness.mail, address),
          trustDevice: true,
        })
        .expect(200);

      const spaces = await request(http)
        .get('/api/spaces')
        .set('Authorization', `Bearer ${verified.body.tokens.accessToken}`)
        .expect(200);
      const spaceId = spaces.body[0].id as string;

      await request(http)
        .get(`/api/spaces/${spaceId}/agents`)
        .set('Authorization', `Bearer ${verified.body.tokens.accessToken}`)
        .expect(200);

      const metrics = await request(http).get('/api/metrics').expect(200);

      expect(metrics.text).toContain(':spaceId');
      expect(metrics.text).not.toContain(spaceId);
      expect(metrics.text).not.toContain(address);
      expect(metrics.text).not.toContain(verified.body.user.id);
    });

    it('does not create a metric series per unmatched path', async () => {
      const metricsService = harness.app.get(MetricsService);
      metricsService.reset();

      for (const path of ['/api/nope-1', '/api/nope-2', '/api/nope-3']) {
        await request(http).get(path);
      }

      const metrics = await request(http).get('/api/metrics').expect(200);
      expect(metrics.text).toContain('route="unmatched"');
      expect(metrics.text).not.toContain('nope-1');
    });

    it('records the status a failing request actually returned', async () => {
      harness.app.get(MetricsService).reset();

      await request(http).get('/api/spaces').expect(401);

      const metrics = await request(http).get('/api/metrics').expect(200);
      expect(metrics.text).toMatch(/netlink_http_requests_total\{[^}]*status="401"[^}]*\} 1/);
    });

    it('gives every response a request id, and honours one that was supplied', async () => {
      const generated = await request(http).get('/api/health/live').expect(200);
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

      const supplied = await request(http)
        .get('/api/health/live')
        .set('x-request-id', 'trace-abc-123')
        .expect(200);
      expect(supplied.headers['x-request-id']).toBe('trace-abc-123');
    });

    it('strips anything unexpected out of a supplied request id', async () => {
      // It is echoed into a response header and a log line, and it arrives from
      // outside, so it is bounded and stripped rather than trusted.
      const response = await request(http)
        .get('/api/health/live')
        .set('x-request-id', 'abc<script>alert(1)</script>')
        .expect(200);

      expect(response.headers['x-request-id']).not.toContain('<');
      expect(response.headers['x-request-id']!.length).toBeLessThanOrEqual(64);
    });
  });

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  describe('readiness', () => {
    it('reports each component separately', async () => {
      const health = await request(http).get('/api/health').expect(200);

      expect(health.body.components.database.status).toBe('up');
      expect(health.body.components.mail).toBeDefined();
      expect(health.body.components.rateLimiter).toBeDefined();
      expect(health.body.status).toBe('ok');
    });

    it('answers liveness without touching anything', async () => {
      const live = await request(http).get('/api/health/live').expect(200);
      expect(live.body.status).toBe('ok');
    });
  });
});
