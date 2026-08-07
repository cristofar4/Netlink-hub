import request from 'supertest';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';

describe('Device management and audit (integration)', () => {
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

  const email = 'owner@example.com';

  async function newAccount(address = email) {
    const registration = await request(http)
      .post('/api/auth/register')
      .send({ name: 'Owner', email: address, password: strongPassword })
      .expect(202);
    await request(http)
      .post('/api/auth/verify-email')
      .send({
        challengeId: registration.body.challengeId,
        code: readCode(harness.mail, address),
      })
      .expect(200);
  }

  async function enrol(options: { name?: string; address?: string; trust?: boolean } = {}) {
    const address = options.address ?? email;
    const device = makeDevice(options.name ? { name: options.name } : {});
    const login = await request(http)
      .post('/api/auth/login')
      .send({ email: address, password: strongPassword, device })
      .expect(200);

    const verified = await request(http)
      .post('/api/auth/verify-device')
      .send({
        challengeId: login.body.challenge.challengeId,
        code: readCode(harness.mail, address),
        trustDevice: options.trust ?? true,
      })
      .expect(200);

    return {
      identity: device,
      deviceId: verified.body.device.id as string,
      accessToken: verified.body.tokens.accessToken as string,
      refreshToken: verified.body.tokens.refreshToken as string,
    };
  }

  describe('listing', () => {
    it('shows every enrolled device and marks the caller', async () => {
      await newAccount();
      const first = await enrol({ name: 'Home PC' });
      const second = await enrol({ name: 'Family PC' });

      const response = await request(http)
        .get('/api/devices')
        .set('Authorization', `Bearer ${second.accessToken}`)
        .expect(200);

      expect(response.body).toHaveLength(2);
      const names = response.body.map((d: { name: string }) => d.name).sort();
      expect(names).toEqual(['Family PC', 'Home PC']);

      const current = response.body.find((d: { current?: boolean }) => d.current);
      expect(current.id).toBe(second.deviceId);
      expect(
        response.body.find((d: { id: string }) => d.id === first.deviceId).current,
      ).toBeUndefined();
    });

    it("never exposes another account's devices", async () => {
      await newAccount();
      await newAccount('other@example.com');

      const mine = await enrol({ name: 'My PC' });
      await enrol({ name: 'Their PC', address: 'other@example.com' });

      const response = await request(http)
        .get('/api/devices')
        .set('Authorization', `Bearer ${mine.accessToken}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].name).toBe('My PC');
    });

    it('never returns key material or hashes', async () => {
      await newAccount();
      const device = await enrol();

      const response = await request(http)
        .get('/api/devices')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('publicKey');
      expect(serialised).not.toContain('installationId');
      expect(serialised).not.toContain(device.identity.publicKey);
    });
  });

  describe('renaming', () => {
    it("renames the owner's own device", async () => {
      await newAccount();
      const device = await enrol({ name: 'Old Name' });

      const response = await request(http)
        .patch(`/api/devices/${device.deviceId}`)
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ name: 'Living Room PC' })
        .expect(200);

      expect(response.body.name).toBe('Living Room PC');
    });

    it('rejects an empty name', async () => {
      await newAccount();
      const device = await enrol();

      await request(http)
        .patch(`/api/devices/${device.deviceId}`)
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ name: '   ' })
        .expect(400);
    });

    it('refuses to rename a device on another account', async () => {
      await newAccount();
      await newAccount('other@example.com');
      const mine = await enrol();
      const theirs = await enrol({ address: 'other@example.com' });

      await request(http)
        .patch(`/api/devices/${theirs.deviceId}`)
        .set('Authorization', `Bearer ${mine.accessToken}`)
        .send({ name: 'Hijacked' })
        .expect(403);
    });

    it('rejects a non-UUID device id', async () => {
      await newAccount();
      const device = await enrol();

      await request(http)
        .patch('/api/devices/not-a-uuid')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ name: 'x' })
        .expect(400);
    });
  });

  describe('revocation', () => {
    it('immediately stops the revoked device, even mid-token-lifetime', async () => {
      await newAccount();
      const keep = await enrol({ name: 'Home PC' });
      const lost = await enrol({ name: 'Lost Laptop' });

      // The lost laptop works right up until it is revoked.
      await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${lost.accessToken}`)
        .expect(200);

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      // Its access token is still cryptographically valid and unexpired, and it
      // must still be refused.
      await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${lost.accessToken}`)
        .expect(401);
    });

    it('leaves every other device signed in', async () => {
      await newAccount();
      const keep = await enrol({ name: 'Home PC' });
      const alsoKeep = await enrol({ name: 'Office PC' });
      const lost = await enrol({ name: 'Lost Laptop' });

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);
      await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${alsoKeep.accessToken}`)
        .expect(200);

      // ...and they can still renew their sessions.
      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: alsoKeep.refreshToken })
        .expect(200);
    });

    it("kills the revoked device's refresh tokens", async () => {
      await newAccount();
      const keep = await enrol();
      const lost = await enrol();

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: lost.refreshToken })
        .expect(401);
    });

    it('refuses to re-enrol a revoked installation', async () => {
      await newAccount();
      const keep = await enrol();
      const lost = await enrol();

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      const response = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: lost.identity })
        .expect(401);

      expect(response.body.message).toMatch(/removed from your account/i);
    });

    it('clears the trust flag so a re-added device must verify again', async () => {
      await newAccount();
      const keep = await enrol();
      const lost = await enrol();

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      const stored = await harness.prisma.device.findUnique({ where: { id: lost.deviceId } });
      expect(stored?.trusted).toBe(false);
      expect(stored?.revokedAt).not.toBeNull();
    });

    it('invalidates a pending verification code for the revoked device', async () => {
      await newAccount();
      const keep = await enrol();

      // A device mid-verification, with a live code sitting in the mailbox.
      const pendingIdentity = makeDevice({ name: 'Pending PC' });
      const login = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: pendingIdentity })
        .expect(200);
      const pendingCode = readCode(harness.mail, email);

      const pendingDevice = await harness.prisma.device.findFirst({
        where: { installationId: pendingIdentity.installationId },
      });

      await request(http)
        .delete(`/api/devices/${pendingDevice?.id}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      await request(http)
        .post('/api/auth/verify-device')
        .send({
          challengeId: login.body.challenge.challengeId,
          code: pendingCode,
          trustDevice: true,
        })
        .expect(400);
    });

    it('refuses to revoke a device on another account', async () => {
      await newAccount();
      await newAccount('other@example.com');
      const mine = await enrol();
      const theirs = await enrol({ address: 'other@example.com' });

      await request(http)
        .delete(`/api/devices/${theirs.deviceId}`)
        .set('Authorization', `Bearer ${mine.accessToken}`)
        .expect(403);

      const stored = await harness.prisma.device.findUnique({ where: { id: theirs.deviceId } });
      expect(stored?.revokedAt).toBeNull();
    });

    it('404s on a device that does not exist', async () => {
      await newAccount();
      const device = await enrol();

      await request(http)
        .delete(`/api/devices/${randomUUID()}`)
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(404);
    });

    it('is idempotent', async () => {
      await newAccount();
      const keep = await enrol();
      const lost = await enrol();

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);
      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);
    });
  });

  describe('audit trail', () => {
    it('records registration, device enrollment, trust and sign-in', async () => {
      await newAccount();
      const device = await enrol({ name: 'Home PC' });

      const response = await request(http)
        .get('/api/activity')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      const actions = response.body.items.map((item: { action: string }) => item.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'auth.register.started',
          'auth.register.completed',
          'device.registered',
          'device.trusted',
          'auth.device.verification.succeeded',
          'auth.login.succeeded',
        ]),
      );
    });

    it('records a revocation with the device it targeted', async () => {
      await newAccount();
      const keep = await enrol({ name: 'Home PC' });
      const lost = await enrol({ name: 'Lost Laptop' });

      await request(http)
        .delete(`/api/devices/${lost.deviceId}`)
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      const response = await request(http)
        .get('/api/activity')
        .set('Authorization', `Bearer ${keep.accessToken}`)
        .expect(200);

      const revocation = response.body.items.find(
        (item: { action: string }) => item.action === 'device.revoked',
      );
      expect(revocation).toBeDefined();
      expect(revocation.targetDeviceId).toBe(lost.deviceId);
      expect(revocation.outcome).toBe('success');
      expect(revocation.metadata.deviceName).toBe('Lost Laptop');
    });

    it('records failed sign-ins', async () => {
      await newAccount();
      const device = await enrol();

      await request(http)
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword1Here', device: makeDevice() })
        .expect(401);

      const response = await request(http)
        .get('/api/activity')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      const failure = response.body.items.find(
        (item: { action: string }) => item.action === 'auth.login.failed',
      );
      expect(failure).toBeDefined();
      expect(failure.outcome).toBe('failure');
      expect(failure.metadata.reason).toBe('bad_password');
    });

    it('never writes a password, code or token into the audit trail', async () => {
      await newAccount();
      const device = await enrol();

      await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: makeDevice() })
        .expect(200);

      const rows = await harness.prisma.auditEvent.findMany();
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(strongPassword);
      expect(serialised).not.toContain(device.refreshToken);
      expect(serialised).not.toContain('$argon2id$');
    });

    it("shows only the caller's own activity", async () => {
      await newAccount();
      await newAccount('other@example.com');
      const mine = await enrol();
      await enrol({ address: 'other@example.com' });

      const response = await request(http)
        .get('/api/activity')
        .set('Authorization', `Bearer ${mine.accessToken}`)
        .expect(200);

      const users = await harness.prisma.user.findMany();
      const otherUserId = users.find((u) => u.email === 'other@example.com')?.id;
      const leaked = response.body.items.filter(
        (item: { actorUserId: string }) => item.actorUserId === otherUserId,
      );
      expect(leaked).toHaveLength(0);
    });

    it('paginates', async () => {
      await newAccount();
      const device = await enrol();

      const firstPage = await request(http)
        .get('/api/activity?limit=2')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      expect(firstPage.body.items).toHaveLength(2);
      expect(firstPage.body.nextCursor).toEqual(expect.any(String));

      const secondPage = await request(http)
        .get(`/api/activity?limit=2&cursor=${firstPage.body.nextCursor}`)
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      const firstIds = firstPage.body.items.map((i: { id: string }) => i.id);
      const secondIds = secondPage.body.items.map((i: { id: string }) => i.id);
      expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
    });
  });
});
