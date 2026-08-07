import request from 'supertest';
import type { Server } from 'node:http';
import { OTP_MAX_ATTEMPTS } from '@netlink/contracts';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';

describe('Authentication and trusted devices (integration)', () => {
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

  async function registerAndVerify(address = email) {
    const registration = await request(http)
      .post('/api/auth/register')
      .send({ name: 'Owner', email: address, password: strongPassword })
      .expect(202);

    const code = readCode(harness.mail, address);
    await request(http)
      .post('/api/auth/verify-email')
      .send({ challengeId: registration.body.challengeId, code })
      .expect(200);

    return registration.body.challengeId as string;
  }

  /** Signs in a brand-new device all the way through the code prompt. */
  async function signInNewDevice(
    options: { trustDevice: boolean; address?: string } = { trustDevice: true },
  ) {
    const address = options.address ?? email;
    const device = makeDevice();
    const login = await request(http)
      .post('/api/auth/login')
      .send({ email: address, password: strongPassword, device })
      .expect(200);

    expect(login.body.status).toBe('challenge_required');
    const code = readCode(harness.mail, address);

    const verified = await request(http)
      .post('/api/auth/verify-device')
      .send({
        challengeId: login.body.challenge.challengeId,
        code,
        trustDevice: options.trustDevice,
      })
      .expect(200);

    return { device, session: verified.body };
  }

  // -------------------------------------------------------------------------
  // Registration and email verification
  // -------------------------------------------------------------------------

  describe('registration', () => {
    it('creates an unverified account and emails a six-digit code', async () => {
      const response = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      expect(response.body.maskedEmail).toBe('o•••r@example.com');
      expect(response.body.maskedEmail).not.toContain('owner@');
      expect(response.body.challengeId).toEqual(expect.any(String));
      expect(response.body.devCode).toBeUndefined();

      expect(readCode(harness.mail, email)).toMatch(/^\d{6}$/);

      const user = await harness.prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerified).toBe(false);
    });

    it('stores only an Argon2id hash, never the password', async () => {
      await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      const user = await harness.prisma.user.findUnique({ where: { email } });
      expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(user?.passwordHash).not.toContain(strongPassword);
    });

    it('stores only a hash of the code, never the code itself', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      const code = readCode(harness.mail, email);
      const challenge = await harness.prisma.challenge.findUnique({
        where: { id: registration.body.challengeId },
      });

      expect(challenge?.codeHash).not.toContain(code);
      expect(challenge?.codeHash).toHaveLength(64);
    });

    it('rejects a weak password before any account is created', async () => {
      await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: 'short' })
        .expect(400);

      expect(await harness.prisma.user.count()).toBe(0);
    });

    it('rejects a malformed email', async () => {
      await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email: 'not-an-email', password: strongPassword })
        .expect(400);
    });

    it('does not reveal that an email is already registered', async () => {
      await registerAndVerify();
      harness.mail.clear();

      const response = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Someone Else', email, password: strongPassword })
        .expect(202);

      // Same response shape as a genuine registration...
      expect(response.body.challengeId).toEqual(expect.any(String));
      expect(response.body.maskedEmail).toBe('o•••r@example.com');
      // ...but no code was sent to the real owner, and no second account exists.
      expect(harness.mail.outbox).toHaveLength(0);
      expect(await harness.prisma.user.count()).toBe(1);

      // And the decoy challenge cannot be satisfied.
      await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: response.body.challengeId, code: '000000' })
        .expect(400);
    });
  });

  describe('email verification codes', () => {
    it('marks the account verified on the correct code', async () => {
      await registerAndVerify();
      const user = await harness.prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerified).toBe(true);
    });

    it('works only once', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const code = readCode(harness.mail, email);

      await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code })
        .expect(200);

      const replay = await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code })
        .expect(400);

      expect(replay.body.message).toMatch(/already been used/i);
    });

    it('expires after ten minutes', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const code = readCode(harness.mail, email);

      await harness.prisma.challenge.update({
        where: { id: registration.body.challengeId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code })
        .expect(400);

      expect(response.body.message).toMatch(/expired/i);

      const user = await harness.prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerified).toBe(false);
    });

    it('is still valid one second before expiry', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const code = readCode(harness.mail, email);

      await harness.prisma.challenge.update({
        where: { id: registration.body.challengeId },
        data: { expiresAt: new Date(Date.now() + 1000) },
      });

      await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code })
        .expect(200);
    });

    it('caps wrong attempts and then refuses even the correct code', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const realCode = readCode(harness.mail, email);
      const wrongCode = realCode === '000000' ? '111111' : '000000';

      for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        await request(http)
          .post('/api/auth/verify-email')
          .send({ challengeId: registration.body.challengeId, code: wrongCode })
          .expect(400);
      }

      const afterBurn = await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code: realCode })
        .expect(400);

      expect(afterBurn.body.message).toMatch(/already been used|Too many/i);

      const user = await harness.prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerified).toBe(false);
    });

    it('counts down the remaining attempts in the error message', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const realCode = readCode(harness.mail, email);
      const wrongCode = realCode === '000000' ? '111111' : '000000';

      const first = await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code: wrongCode })
        .expect(400);

      expect(first.body.message).toContain(`${OTP_MAX_ATTEMPTS - 1} attempts remaining`);
    });

    it('invalidates the previous code when a new one is sent', async () => {
      const first = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const firstCode = readCode(harness.mail, email);

      // Registering again for the same unverified account re-issues the code.
      const second = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      expect(second.body.challengeId).not.toBe(first.body.challengeId);

      await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: first.body.challengeId, code: firstCode })
        .expect(400);
    });

    it('refuses a device-verification code submitted to the email endpoint', async () => {
      await registerAndVerify();
      const device = makeDevice();
      const login = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device })
        .expect(200);
      const code = readCode(harness.mail, email);

      await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: login.body.challenge.challengeId, code })
        .expect(400);
    });
  });

  describe('resending codes', () => {
    it('rejects a resend inside the cooldown window', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      const response = await request(http)
        .post('/api/auth/resend-code')
        .send({ challengeId: registration.body.challengeId })
        .expect(429);

      expect(response.body.message).toMatch(/wait/i);
    });

    it('issues a new code after the cooldown and kills the old one', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);
      const originalCode = readCode(harness.mail, email);

      await harness.prisma.challenge.update({
        where: { id: registration.body.challengeId },
        data: { lastSentAt: new Date(Date.now() - 120_000) },
      });

      await request(http)
        .post('/api/auth/resend-code')
        .send({ challengeId: registration.body.challengeId })
        .expect(200);

      const newCode = readCode(harness.mail, email);
      expect(harness.mail.outbox).toHaveLength(2);

      if (newCode !== originalCode) {
        await request(http)
          .post('/api/auth/verify-email')
          .send({ challengeId: registration.body.challengeId, code: originalCode })
          .expect(400);
      }

      await request(http)
        .post('/api/auth/verify-email')
        .send({ challengeId: registration.body.challengeId, code: newCode })
        .expect(200);
    });

    it('stops after the resend budget is spent', async () => {
      const registration = await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      for (let i = 0; i < 3; i += 1) {
        await harness.prisma.challenge.update({
          where: { id: registration.body.challengeId },
          data: { lastSentAt: new Date(Date.now() - 120_000) },
        });
        await request(http)
          .post('/api/auth/resend-code')
          .send({ challengeId: registration.body.challengeId })
          .expect(200);
      }

      await harness.prisma.challenge.update({
        where: { id: registration.body.challengeId },
        data: { lastSentAt: new Date(Date.now() - 120_000) },
      });
      await request(http)
        .post('/api/auth/resend-code')
        .send({ challengeId: registration.body.challengeId })
        .expect(429);
    });
  });

  // -------------------------------------------------------------------------
  // Sign-in and new-device verification
  // -------------------------------------------------------------------------

  describe('sign-in', () => {
    it('challenges a first-time device instead of issuing a session', async () => {
      await registerAndVerify();
      harness.mail.clear();

      const response = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: makeDevice() })
        .expect(200);

      expect(response.body.status).toBe('challenge_required');
      expect(response.body.tokens).toBeUndefined();
      expect(response.body.challenge.maskedEmail).toBe('o•••r@example.com');
      expect(readCode(harness.mail, email)).toMatch(/^\d{6}$/);
    });

    it('gives the same generic failure for a wrong password and an unknown account', async () => {
      await registerAndVerify();

      const wrongPassword = await request(http)
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword1Here', device: makeDevice() })
        .expect(401);

      const unknownAccount = await request(http)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: strongPassword, device: makeDevice() })
        .expect(401);

      expect(wrongPassword.body.message).toBe(unknownAccount.body.message);
      // The message must not say *which* factor was wrong, or which addresses
      // have accounts — that is what turns a login endpoint into an oracle.
      expect(wrongPassword.body.message).not.toMatch(
        /incorrect password|wrong password|no account|not registered|unknown (email|account)|does not exist/i,
      );
    });

    it('refuses a login that carries no device identity', async () => {
      await registerAndVerify();
      await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword })
        .expect(400);
    });

    it('issues a session immediately for an already-trusted device', async () => {
      await registerAndVerify();
      const { device } = await signInNewDevice({ trustDevice: true });

      const response = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device })
        .expect(200);

      expect(response.body.status).toBe('authenticated');
      expect(response.body.tokens.accessToken).toEqual(expect.any(String));
      expect(response.body.device.trusted).toBe(true);
    });

    it('challenges again on every sign-in when the device was not trusted', async () => {
      await registerAndVerify();
      const { device } = await signInNewDevice({ trustDevice: false });

      const response = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device })
        .expect(200);

      expect(response.body.status).toBe('challenge_required');
    });

    it('refuses a device whose public key no longer matches its installation', async () => {
      await registerAndVerify();
      const { device } = await signInNewDevice({ trustDevice: true });

      const impostor = { ...device, publicKey: makeDevice().publicKey };
      const response = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: impostor })
        .expect(401);

      expect(response.body.message).toMatch(/device identity/i);
    });

    it('refuses a public key already registered to another account', async () => {
      await registerAndVerify();
      await registerAndVerify('second@example.com');

      const { device } = await signInNewDevice({ trustDevice: true });

      await request(http)
        .post('/api/auth/login')
        .send({
          email: 'second@example.com',
          password: strongPassword,
          device: { ...makeDevice(), publicKey: device.publicKey },
        })
        .expect(400);
    });

    it('does not sign in an unverified account', async () => {
      await request(http)
        .post('/api/auth/register')
        .send({ name: 'Owner', email, password: strongPassword })
        .expect(202);

      const response = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: makeDevice() })
        .expect(200);

      expect(response.body.status).toBe('challenge_required');
      expect(response.body.challenge.purpose).toBe('email_verification');
      expect(response.body.tokens).toBeUndefined();
    });
  });

  describe('new-device verification', () => {
    it('records the device, trust flag and approximate activity', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });

      expect(session.status).toBe('authenticated');
      expect(session.device.trusted).toBe(true);
      expect(session.user.email).toBe(email);

      const stored = await harness.prisma.device.findUnique({ where: { id: session.device.id } });
      expect(stored?.trusted).toBe(true);
      expect(stored?.trustedAt).not.toBeNull();
      expect(stored?.lastSeenAt).not.toBeNull();
    });

    it('leaves the device untrusted when the box is not ticked', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: false });

      expect(session.device.trusted).toBe(false);
      const stored = await harness.prisma.device.findUnique({ where: { id: session.device.id } });
      expect(stored?.trusted).toBe(false);
      expect(stored?.trustedAt).toBeNull();
    });

    it('gives an untrusted device a much shorter session than a trusted one', async () => {
      await registerAndVerify();
      const untrusted = await signInNewDevice({ trustDevice: false });
      const trusted = await signInNewDevice({ trustDevice: true });

      const untrustedExpiry = new Date(untrusted.session.tokens.refreshTokenExpiresAt).getTime();
      const trustedExpiry = new Date(trusted.session.tokens.refreshTokenExpiresAt).getTime();
      expect(trustedExpiry).toBeGreaterThan(untrustedExpiry);
    });

    it('gives every device its own identity rather than a shared one', async () => {
      await registerAndVerify();
      const first = await signInNewDevice({ trustDevice: true });
      const second = await signInNewDevice({ trustDevice: true });

      expect(first.session.device.id).not.toBe(second.session.device.id);
      expect(first.device.publicKey).not.toBe(second.device.publicKey);

      const devices = await harness.prisma.device.findMany();
      expect(devices).toHaveLength(2);
      expect(new Set(devices.map((d) => d.publicKey)).size).toBe(2);
    });

    it('rejects a wrong code and issues no session', async () => {
      await registerAndVerify();
      const login = await request(http)
        .post('/api/auth/login')
        .send({ email, password: strongPassword, device: makeDevice() })
        .expect(200);

      const realCode = readCode(harness.mail, email);
      const wrongCode = realCode === '000000' ? '111111' : '000000';

      await request(http)
        .post('/api/auth/verify-device')
        .send({ challengeId: login.body.challenge.challengeId, code: wrongCode, trustDevice: true })
        .expect(400);

      expect(await harness.prisma.refreshToken.count()).toBe(0);
    });

    it('never returns the private half of anything', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });
      const serialised = JSON.stringify(session);

      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('$argon2id$');
      expect(serialised).not.toContain('codeHash');
      expect(serialised).not.toContain('privateKey');
    });
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  describe('refresh-token rotation', () => {
    it('returns a new pair and invalidates the presented token', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });

      const refreshed = await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken })
        .expect(200);

      expect(refreshed.body.refreshToken).not.toBe(session.tokens.refreshToken);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
    });

    it('treats reuse of a rotated token as theft and kills the whole lineage', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });

      const refreshed = await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken })
        .expect(200);

      // The thief replays the old token.
      const replay = await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken })
        .expect(401);
      expect(replay.body.message).toMatch(/for your security/i);

      // The legitimate client's newer token is dead too — we cannot tell which
      // side is which, so the whole family goes.
      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshed.body.refreshToken })
        .expect(401);
    });

    it('rejects a token that never existed', async () => {
      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'a'.repeat(43) })
        .expect(401);
    });

    it('rejects an expired refresh token', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });

      await harness.prisma.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken })
        .expect(401);
    });

    it('stores refresh tokens only as hashes', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });

      const stored = await harness.prisma.refreshToken.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tokenHash).not.toContain(session.tokens.refreshToken);
      expect(stored[0]?.tokenHash).toHaveLength(64);
    });

    it('ends only the signing-out session on logout', async () => {
      await registerAndVerify();
      const first = await signInNewDevice({ trustDevice: true });
      const second = await signInNewDevice({ trustDevice: true });

      await request(http)
        .post('/api/auth/logout')
        .send({ refreshToken: first.session.tokens.refreshToken })
        .expect(200);

      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: first.session.tokens.refreshToken })
        .expect(401);

      await request(http)
        .post('/api/auth/refresh')
        .send({ refreshToken: second.session.tokens.refreshToken })
        .expect(200);
    });
  });

  describe('protected endpoints', () => {
    it('refuses a request with no token', async () => {
      await request(http).get('/api/auth/me').expect(401);
      await request(http).get('/api/devices').expect(401);
      await request(http).get('/api/activity').expect(401);
    });

    it('refuses a malformed or forged token', async () => {
      await request(http).get('/api/auth/me').set('Authorization', 'Bearer nonsense').expect(401);
      await request(http).get('/api/auth/me').set('Authorization', 'Basic abc').expect(401);
      await request(http).get('/api/auth/me').set('Authorization', 'Bearer').expect(401);
    });

    it('accepts a valid token', async () => {
      await registerAndVerify();
      const { session } = await signInNewDevice({ trustDevice: true });

      const me = await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${session.tokens.accessToken}`)
        .expect(200);

      expect(me.body.email).toBe(email);
      expect(me.body.passwordHash).toBeUndefined();
    });

    it('leaves health checks public', async () => {
      await request(http).get('/api/health/live').expect(200);
      const ready = await request(http).get('/api/health').expect(200);
      expect(ready.body.components.database.status).toBe('up');
    });
  });
});
