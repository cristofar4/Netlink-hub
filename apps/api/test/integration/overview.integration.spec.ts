import request from 'supertest';
import type { Server } from 'node:http';

import { GIGABYTE, HEALTH_SIGNAL_WEIGHTS, type HealthSignal } from '@netlink/contracts';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';

const DAY_MS = 86_400_000;
const GB = (n: number) => String(n * GIGABYTE);

/**
 * The Overview screen and the usage chart behind the Data Pool.
 *
 * Both endpoints exist to be *looked at*, which makes them easy to get subtly
 * wrong — a chart that silently drops empty days, or a summary that shows a
 * member someone else's usage, still renders perfectly. These tests check the
 * numbers rather than the fact that a response arrived.
 */
describe('Overview and usage history (integration)', () => {
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

  async function signIn(address: string) {
    const registration = await request(http)
      .post('/api/auth/register')
      .send({ name: address.split('@')[0], email: address, password: strongPassword })
      .expect(202);
    await request(http)
      .post('/api/auth/verify-email')
      .send({ challengeId: registration.body.challengeId, code: readCode(harness.mail, address) })
      .expect(200);

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

    return {
      token: verified.body.tokens.accessToken as string,
      userId: verified.body.user.id as string,
    };
  }

  async function ownerWithSpace() {
    const owner = await signIn('owner@example.com');
    const spaces = await request(http)
      .get('/api/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    return { ...owner, spaceId: spaces.body[0].id as string };
  }

  async function connectPool(owner: { token: string; spaceId: string }) {
    await request(http)
      .post(`/api/spaces/${owner.spaceId}/data/pool`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ accountRef: '08031234567' })
      .expect(201);
  }

  /** Invites someone with a Data-Only pass and has them claim it. */
  async function dataOnlyGuest(owner: { token: string; spaceId: string }, address: string) {
    const guest = await signIn(address);
    const pass = await request(http)
      .post(`/api/spaces/${owner.spaceId}/data/passes`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: address,
        kind: 'data_only',
        totalBytes: GB(5),
        expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      })
      .expect(201);

    await request(http)
      .post('/api/passes/claim')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ token: pass.body.claimToken })
      .expect(201);

    return guest;
  }

  /**
   * Writes a metered usage row directly.
   *
   * The demo provider only ever reports usage as "now", and the point of these
   * tests is what happens across days, so the history is written straight to
   * the table the endpoint reads.
   */
  async function recordUsage(userId: string, bytes: string, daysAgo: number) {
    const allocation = await harness.prisma.dataAllocation.findFirstOrThrow({
      where: { member: { userId } },
      select: { id: true },
    });
    await harness.prisma.dataUsageEvent.create({
      data: {
        allocationId: allocation.id,
        bytes,
        occurredAt: new Date(Date.now() - daysAgo * DAY_MS),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Usage history
  // -------------------------------------------------------------------------

  describe('usage history', () => {
    it('returns one bucket per day, including the days with no usage', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);
      const guest = await dataOnlyGuest(owner, 'guest@example.com');
      await recordUsage(guest.userId, GB(2), 1);

      const usage = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage?days=7`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(usage.body.buckets).toHaveLength(7);
      // A quiet week and a busy week must not render as the same shape.
      expect(usage.body.buckets.filter((b: { bytes: string }) => b.bytes === '0')).toHaveLength(6);
      expect(usage.body.totalBytes).toBe(GB(2));
      expect(usage.body.peakBytes).toBe(GB(2));
      expect(usage.body.buckets[0].day < usage.body.buckets[6].day).toBe(true);
      expect(usage.body.toDay).toBe(new Date().toISOString().slice(0, 10));
    });

    it('leaves usage older than the window out of the totals', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);
      const guest = await dataOnlyGuest(owner, 'guest@example.com');
      await recordUsage(guest.userId, GB(1), 2);
      await recordUsage(guest.userId, GB(3), 40);

      const usage = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage?days=7`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(usage.body.totalBytes).toBe(GB(1));
      // Averaged over the whole window, empty days included, so the projection
      // that divides by it cannot be optimistic.
      expect(usage.body.dailyAverageBytes).toBe(String(BigInt(GB(1)) / 7n));
    });

    it('shows a member their own usage and not the rest of the Space', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);
      const guest = await dataOnlyGuest(owner, 'guest@example.com');
      const other = await dataOnlyGuest(owner, 'other@example.com');

      await recordUsage(guest.userId, GB(2), 1);
      await recordUsage(other.userId, GB(4), 1);

      const asOwner = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage?days=7`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      const asGuest = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage?days=7`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      expect(asOwner.body.totalBytes).toBe(GB(6));
      expect(asGuest.body.totalBytes).toBe(GB(2));
    });

    it('clamps an absurd window instead of refusing it, and ignores nonsense', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);

      const huge = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage?days=5000`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(huge.body.buckets).toHaveLength(90);

      const nonsense = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage?days=banana`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(nonsense.body.buckets).toHaveLength(30);
    });

    it('is not found for someone who is not in the Space', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);
      const stranger = await signIn('stranger@example.com');

      await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/usage`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  describe('overview', () => {
    it('reports an empty Space honestly rather than optimistically', async () => {
      const owner = await ownerWithSpace();

      const overview = await request(http)
        .get(`/api/spaces/${owner.spaceId}/overview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(overview.body.agentCount).toBe(0);
      expect(overview.body.onlineAgentCount).toBe(0);
      expect(overview.body.activeSessionCount).toBe(0);
      expect(overview.body.data).toBeNull();
      expect(overview.body.isOwner).toBe(true);

      // Nothing is set up, so only the "no refused access" check can pass.
      expect(overview.body.health.score).toBe(HEALTH_SIGNAL_WEIGHTS['security.clean']);
      const failed = overview.body.health.signals
        .filter((signal: HealthSignal) => !signal.ok)
        .map((signal: HealthSignal) => signal.id);
      expect(failed).toContain('computers.online');
      expect(failed).toContain('data.connected');
    });

    it('scores exactly the checks that passed, and explains each one', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);

      const overview = await request(http)
        .get(`/api/spaces/${owner.spaceId}/overview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const signals: HealthSignal[] = overview.body.health.signals;
      const expected = signals.reduce(
        (total, signal) => (signal.ok ? total + signal.weight : total),
        0,
      );
      expect(overview.body.health.score).toBe(expected);
      // Every signal carries the sentence the owner reads, passing or failing.
      expect(signals.every((signal) => signal.detail.length > 0)).toBe(true);

      const byId = new Map(signals.map((signal) => [signal.id, signal]));
      expect(byId.get('data.connected')?.ok).toBe(true);
      // A fresh 100 GB demo pool has plenty left.
      expect(byId.get('data.remaining')?.ok).toBe(true);
      expect(overview.body.data.isDemo).toBe(true);
      expect(overview.body.data.balanceBytes).toBe(String(100 * GIGABYTE));
    });

    it('projects how long the data lasts from real usage, and says nothing without it', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);
      const guest = await dataOnlyGuest(owner, 'guest@example.com');

      const before = await request(http)
        .get(`/api/spaces/${owner.spaceId}/overview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      // No usage recorded: a projection here would be an invention.
      expect(before.body.data.projectedDaysRemaining).toBeNull();

      for (let day = 0; day < 30; day += 1) {
        await recordUsage(guest.userId, GB(1), day);
      }

      const after = await request(http)
        .get(`/api/spaces/${owner.spaceId}/overview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(after.body.data.projectedDaysRemaining).toBeGreaterThan(0);
    });

    it('hides the Data Pool from a member who may only use data', async () => {
      const owner = await ownerWithSpace();
      await connectPool(owner);
      const guest = await dataOnlyGuest(owner, 'guest@example.com');

      const overview = await request(http)
        .get(`/api/spaces/${owner.spaceId}/overview`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      // The pool balance belongs to the owner. A Data-Only member sees their
      // own allowance on their own screen, never the whole account.
      expect(overview.body.data).toBeNull();
      expect(overview.body.isOwner).toBe(false);
    });

    it('is not found for someone who is not in the Space', async () => {
      const owner = await ownerWithSpace();
      const stranger = await signIn('stranger@example.com');

      await request(http)
        .get(`/api/spaces/${owner.spaceId}/overview`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);
    });
  });
});
