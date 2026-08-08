import request from 'supertest';
import type { Server } from 'node:http';

import { GIGABYTE, PERMISSIONS } from '@netlink/contracts';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';
import { TestAgent } from '../agent-client';

const GB = (n: number) => String(n * GIGABYTE);

describe('Data Pool, NetLink Passes and member access (integration)', () => {
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

  /** An owner with a connected demo pool. */
  async function ownerWithPool() {
    const owner = await signIn('owner@example.com');
    const spaces = await request(http)
      .get('/api/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const spaceId = spaces.body[0].id as string;

    await request(http)
      .post(`/api/spaces/${spaceId}/data/pool`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ accountRef: '08031234567' })
      .expect(201);

    return { ...owner, spaceId };
  }

  /** Issues a Data-Only pass and has `guest` claim it. */
  async function dataOnlyGuest(
    owner: { token: string; spaceId: string },
    options: { total?: string; daily?: string | null; email?: string } = {},
  ) {
    const guest = await signIn(options.email ?? 'guest@example.com');

    const pass = await request(http)
      .post(`/api/spaces/${owner.spaceId}/data/passes`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: options.email ?? 'guest@example.com',
        kind: 'data_only',
        totalBytes: options.total ?? GB(5),
        ...(options.daily === null ? {} : { dailyBytes: options.daily ?? GB(1) }),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
      .expect(201);

    await request(http)
      .post('/api/passes/claim')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ token: pass.body.claimToken })
      .expect(201);

    return { ...guest, passId: pass.body.id as string };
  }

  // -------------------------------------------------------------------------
  // The pool
  // -------------------------------------------------------------------------

  describe('connecting a pool', () => {
    it('verifies the account and reports the demo balance', async () => {
      const owner = await ownerWithPool();

      const pool = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/pool`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(pool.body.provider).toBe('demo');
      // The UI reads this flag to label the pool. Getting it wrong would mean
      // presenting a fixture as real network usage.
      expect(pool.body.isDemo).toBe(true);
      expect(BigInt(pool.body.balanceBytes)).toBe(BigInt(100 * GIGABYTE));
      expect(pool.body.planName).toContain('100 GB');
    });

    it('masks the account reference', async () => {
      const owner = await ownerWithPool();
      const pool = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/pool`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(pool.body.accountRef).not.toBe('08031234567');
      expect(pool.body.accountRef.endsWith('4567')).toBe(true);
    });

    it('refuses an account the provider will not verify', async () => {
      const owner = await signIn('owner@example.com');
      const spaces = await request(http)
        .get('/api/spaces')
        .set('Authorization', `Bearer ${owner.token}`);

      await request(http)
        .post(`/api/spaces/${spaces.body[0].id}/data/pool`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ accountRef: '1' })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  describe('creating a pass', () => {
    it('returns the claim token exactly once and stores only a hash', async () => {
      const owner = await ownerWithPool();

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'guest@example.com',
          kind: 'data_only',
          totalBytes: GB(5),
          dailyBytes: GB(1),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      const token = pass.body.claimToken as string;
      expect(token).toEqual(expect.any(String));

      const stored = await harness.prisma.invitation.findMany();
      expect(stored[0]?.tokenHash).not.toContain(token);
      expect(stored[0]?.tokenHash).toHaveLength(64);

      // Listing passes must never hand the token back.
      const listed = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(listed.body[0].claimToken).toBeUndefined();
    });

    it('forces a Data-Only pass to exactly data.use, whatever was asked for', async () => {
      const owner = await ownerWithPool();

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'guest@example.com',
          kind: 'data_only',
          // A client asking for more must not get it.
          permissions: ['files.read', 'power.shutdown', 'devices.control'],
          totalBytes: GB(5),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      expect(pass.body.permissions).toEqual(['data.use']);
    });

    it('refuses to promise more data than the pool has left', async () => {
      const owner = await ownerWithPool();

      await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(500),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(400);
    });

    it('rejects a daily limit larger than the total', async () => {
      const owner = await ownerWithPool();

      await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(1),
          dailyBytes: GB(5),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(400);
    });

    it('rejects an expiry in the past', async () => {
      const owner = await ownerWithPool();

      await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(1),
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        })
        .expect(400);
    });
  });

  describe('claiming a pass', () => {
    it('makes the claimant a member with exactly the granted permissions', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      const membership = await harness.prisma.spaceMember.findFirst({
        where: { userId: guest.userId },
      });
      expect(membership?.role).toBe('invited_member');
      expect(membership?.permissions).toEqual(['data.use']);
    });

    it('works only once', async () => {
      const owner = await ownerWithPool();
      const guest = await signIn('guest@example.com');
      const other = await signIn('other@example.com');

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(1),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ token: pass.body.claimToken })
        .expect(201);

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${other.token}`)
        .send({ token: pass.body.claimToken })
        .expect(400);
    });

    it('refuses an account the pass was not addressed to', async () => {
      const owner = await ownerWithPool();
      const wrongPerson = await signIn('someone-else@example.com');

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'guest@example.com',
          kind: 'data_only',
          totalBytes: GB(1),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${wrongPerson.token}`)
        .send({ token: pass.body.claimToken })
        .expect(403);
    });

    it('refuses an expired pass', async () => {
      const owner = await ownerWithPool();
      const guest = await signIn('guest@example.com');

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(1),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(201);

      await harness.prisma.invitation.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ token: pass.body.claimToken })
        .expect(400);
    });

    it('refuses a revoked pass', async () => {
      const owner = await ownerWithPool();
      const guest = await signIn('guest@example.com');

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(1),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      await request(http)
        .delete(`/api/spaces/${owner.spaceId}/data/passes/${pass.body.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ token: pass.body.claimToken })
        .expect(400);
    });

    it('refuses a token that never existed', async () => {
      const guest = await signIn('guest@example.com');
      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ token: 'a'.repeat(43) })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Data-Only isolation — the heart of the feature
  // -------------------------------------------------------------------------

  describe('Data-Only isolation', () => {
    it('shows the member their allowance and nothing else', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(5), daily: GB(1) });

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      // Everything the brief says a Data-Only member must see.
      expect(mine.body.allocatedBytes).toBe(GB(5));
      expect(mine.body.dailyLimitBytes).toBe(GB(1));
      expect(mine.body).toHaveProperty('usedBytes');
      expect(mine.body).toHaveProperty('remainingBytes');
      expect(mine.body).toHaveProperty('expiresAt');
      expect(mine.body).toHaveProperty('connected');

      // And nothing that would leak the rest of the Space.
      const serialised = JSON.stringify(mine.body);
      expect(serialised).not.toContain('accountRef');
      expect(serialised).not.toContain('balanceBytes');
      expect(mine.body.members).toBeUndefined();
      expect(mine.body.agents).toBeUndefined();
    });

    it('cannot reach computers, files, printers, members or power by hand', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);
      const auth = { Authorization: `Bearer ${guest.token}` };

      // The UI hides these. This asserts the *API* refuses them, which is what
      // actually matters — a member can craft any request they like.
      const forbidden = [
        ['get', `/api/spaces/${owner.spaceId}/agents`],
        ['get', `/api/spaces/${owner.spaceId}/resources`],
        ['get', `/api/spaces/${owner.spaceId}/data/pool`],
        ['get', `/api/spaces/${owner.spaceId}/data/members`],
        ['get', `/api/spaces/${owner.spaceId}/data/passes`],
        ['post', `/api/spaces/${owner.spaceId}/enrollment-token`],
      ] as const;

      for (const [method, path] of forbidden) {
        const response = await request(http)[method](path).set(auth);
        expect([403, 404]).toContain(response.status);
      }
    });

    it('cannot create a Pass of its own, even with resharing off', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${guest.token}`)
        .send({
          kind: 'data_only',
          totalBytes: GB(1),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(403);
    });

    it('cannot pause, edit or revoke anyone — including itself', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await request(http)
        .patch(`/api/spaces/${owner.spaceId}/data/members/${member.id}/pause`)
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ paused: false })
        .expect(403);

      await request(http)
        .patch(`/api/spaces/${owner.spaceId}/data/members/${member.id}/allocation`)
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ totalBytes: GB(999) })
        .expect(403);

      await request(http)
        .delete(`/api/spaces/${owner.spaceId}/data/members/${member.id}`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(403);
    });

    it('cannot see or touch an agent even when one is enrolled', async () => {
      const owner = await ownerWithPool();

      const tokenResponse = await request(http)
        .post(`/api/spaces/${owner.spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      const agent = new TestAgent();
      await agent
        .post(http, '/agent/enroll', agent.enrollBody(tokenResponse.body.token))
        .expect(201);

      const guest = await dataOnlyGuest(owner);

      const response = await request(http)
        .get(`/api/spaces/${owner.spaceId}/agents`)
        .set('Authorization', `Bearer ${guest.token}`);
      expect([403, 404]).toContain(response.status);
    });

    it('records the denial so the owner can see it happened', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      await request(http)
        .get(`/api/spaces/${owner.spaceId}/agents`)
        .set('Authorization', `Bearer ${guest.token}`);

      const denials = await harness.prisma.auditEvent.findMany({
        where: { action: 'permission.denied', actorUserId: guest.userId },
      });
      expect(denials.length).toBeGreaterThan(0);
      expect(denials[0]?.outcome).toBe('denied');
    });

    it('loses everything the moment the owner revokes access', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await request(http)
        .delete(`/api/spaces/${owner.spaceId}/data/members/${member.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(403);

      const after = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { id: member.id },
      });
      expect(after.permissions).toEqual([]);
      expect(after.suspended).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Member access, for the owner
  // -------------------------------------------------------------------------

  describe('member access', () => {
    it('shows every field the owner’s page needs', async () => {
      const owner = await ownerWithPool();
      await dataOnlyGuest(owner, { total: GB(5), daily: GB(1) });

      const members = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/members`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const guestRow = members.body.find(
        (row: { email: string }) => row.email === 'guest@example.com',
      );
      expect(guestRow).toBeDefined();
      expect(guestRow.name).toBeTruthy();
      expect(guestRow.permissions).toEqual(['data.use']);
      expect(guestRow.allocation.allocatedBytes).toBe(GB(5));
      expect(guestRow.allocation.dailyLimitBytes).toBe(GB(1));
      expect(guestRow.allocation).toHaveProperty('usedBytes');
      expect(guestRow.allocation).toHaveProperty('usedTodayBytes');
      expect(guestRow.allocation).toHaveProperty('remainingBytes');
      expect(guestRow.allocation).toHaveProperty('expiresAt');
      expect(guestRow).toHaveProperty('connected');
      expect(guestRow).toHaveProperty('approvedDeviceName');
    });

    it('pauses and resumes a member’s data', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await request(http)
        .patch(`/api/spaces/${owner.spaceId}/data/members/${member.id}/pause`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ paused: true })
        .expect(200);

      const paused = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);
      expect(paused.body.status).toBe('paused');
      expect(paused.body.connected).toBe(false);

      await request(http)
        .patch(`/api/spaces/${owner.spaceId}/data/members/${member.id}/pause`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ paused: false })
        .expect(200);

      const resumed = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);
      expect(resumed.body.status).toBe('active');
    });

    it('changes a limit', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(5), daily: GB(1) });
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await request(http)
        .patch(`/api/spaces/${owner.spaceId}/data/members/${member.id}/allocation`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ totalBytes: GB(10), dailyBytes: GB(2) })
        .expect(200);

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      expect(mine.body.allocatedBytes).toBe(GB(10));
      expect(mine.body.dailyLimitBytes).toBe(GB(2));
    });

    it('refuses to set a total below what is already used', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(5) });
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await harness.prisma.dataAllocation.updateMany({
        where: { memberId: member.id },
        data: { usedBytes: GB(3) },
      });

      await request(http)
        .patch(`/api/spaces/${owner.spaceId}/data/members/${member.id}/allocation`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ totalBytes: GB(1) })
        .expect(400);
    });

    it('will not remove the owner from their own Space', async () => {
      const owner = await ownerWithPool();
      const ownerMember = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { spaceId: owner.spaceId, role: 'owner' },
      });

      await request(http)
        .delete(`/api/spaces/${owner.spaceId}/data/members/${ownerMember.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Usage and limits
  // -------------------------------------------------------------------------

  describe('usage and limits', () => {
    it('pauses an allocation once its total is spent', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(1) });
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      // Consume the whole allowance.
      await harness.prisma.dataAllocation.updateMany({
        where: { memberId: member.id },
        data: { usedBytes: GB(1) },
      });

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      // A limit that records usage without stopping anything is decorative.
      expect(mine.body.status).toBe('paused');
      expect(mine.body.remainingBytes).toBe('0');
    });

    it('never reports negative remaining data', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(1) });
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await harness.prisma.dataAllocation.updateMany({
        where: { memberId: member.id },
        data: { usedBytes: GB(3) },
      });

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      expect(mine.body.remainingBytes).toBe('0');
    });

    it('pauses once the daily limit is reached', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(10), daily: GB(1) });
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await harness.prisma.dataAllocation.updateMany({
        where: { memberId: member.id },
        data: { usedTodayBytes: GB(1), usageDay: startOfToday() },
      });

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      expect(mine.body.status).toBe('paused');
    });

    it('resets the daily figure on a new day without a scheduled job', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner, { total: GB(10), daily: GB(1) });
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      // Yesterday's usage, and the allocation left active.
      await harness.prisma.dataAllocation.updateMany({
        where: { memberId: member.id },
        data: {
          usedTodayBytes: GB(1),
          usageDay: new Date(Date.now() - 2 * 86_400_000),
          status: 'active',
        },
      });

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      expect(BigInt(mine.body.usedTodayBytes)).toBeLessThan(BigInt(GB(1)));
    });

    it('marks an allocation expired once its date passes', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);
      const member = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { userId: guest.userId },
      });

      await harness.prisma.dataAllocation.updateMany({
        where: { memberId: member.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const mine = await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(200);

      expect(mine.body.status).toBe('expired');
      expect(mine.body.connected).toBe(false);
    });

    it('records usage without any destination or browsing detail', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      // Poll a few times so the demo fixture generates something.
      for (let i = 0; i < 8; i += 1) {
        await request(http)
          .get(`/api/spaces/${owner.spaceId}/data/mine`)
          .set('Authorization', `Bearer ${guest.token}`);
      }

      const events = await harness.prisma.dataUsageEvent.findMany();
      for (const event of events) {
        // The columns that exist are quantity, duration and device. There is
        // nowhere for a hostname or a URL to be stored, and this asserts it.
        expect(Object.keys(event).sort()).toEqual(
          [
            'allocationId',
            'bytes',
            'createdAt',
            'deviceId',
            'id',
            'occurredAt',
            'providerRef',
            'sessionSeconds',
          ].sort(),
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Default deny
  // -------------------------------------------------------------------------

  describe('default deny', () => {
    it('gives a custom pass with no permissions nothing at all', async () => {
      const owner = await ownerWithPool();
      const guest = await signIn('guest@example.com');

      const pass = await request(http)
        .post(`/api/spaces/${owner.spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          kind: 'custom',
          permissions: [],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${guest.token}`)
        .send({ token: pass.body.claimToken })
        .expect(201);

      // A member of the Space, holding nothing.
      for (const path of [
        `/api/spaces/${owner.spaceId}/agents`,
        `/api/spaces/${owner.spaceId}/resources`,
        `/api/spaces/${owner.spaceId}/data/mine`,
        `/api/spaces/${owner.spaceId}/data/members`,
      ]) {
        const response = await request(http)
          .get(path)
          .set('Authorization', `Bearer ${guest.token}`);
        expect([403, 404]).toContain(response.status);
      }
    });

    it('refuses every capability to a suspended member', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      await harness.prisma.spaceMember.updateMany({
        where: { userId: guest.userId },
        data: { suspended: true },
      });

      await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(403);
    });

    it('refuses every capability once the membership expires', async () => {
      const owner = await ownerWithPool();
      const guest = await dataOnlyGuest(owner);

      await harness.prisma.spaceMember.updateMany({
        where: { userId: guest.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(http)
        .get(`/api/spaces/${owner.spaceId}/data/mine`)
        .set('Authorization', `Bearer ${guest.token}`)
        .expect(403);
    });

    it('keeps the owner’s capabilities complete', async () => {
      const owner = await ownerWithPool();
      const membership = await harness.prisma.spaceMember.findFirstOrThrow({
        where: { spaceId: owner.spaceId, role: 'owner' },
      });
      expect(membership.permissions.sort()).toEqual([...PERMISSIONS].sort());
    });
  });
});

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
