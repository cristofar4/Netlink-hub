import request from 'supertest';
import type { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { AGENT_OFFLINE_AFTER_SECONDS } from '@netlink/contracts';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';
import { TestAgent } from '../agent-client';

describe('Spaces, agent enrollment and heartbeats (integration)', () => {
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

  /** Signs a person in and returns their access token. */
  async function signIn(address = email) {
    const registration = await request(http)
      .post('/api/auth/register')
      .send({ name: 'Owner', email: address, password: strongPassword })
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
      accessToken: verified.body.tokens.accessToken as string,
      userId: verified.body.user.id as string,
      deviceId: verified.body.device.id as string,
    };
  }

  async function firstSpaceId(accessToken: string) {
    const spaces = await request(http)
      .get('/api/spaces')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return spaces.body[0].id as string;
  }

  async function enrollmentToken(accessToken: string, spaceId: string) {
    const response = await request(http)
      .post(`/api/spaces/${spaceId}/enrollment-token`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    return response.body.token as string;
  }

  // -------------------------------------------------------------------------
  // Spaces
  // -------------------------------------------------------------------------

  describe('spaces', () => {
    it('gives a new account a My Home Space on first look', async () => {
      const owner = await signIn();

      const spaces = await request(http)
        .get('/api/spaces')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(spaces.body).toHaveLength(1);
      expect(spaces.body[0].name).toBe('My Home');
      expect(spaces.body[0].isOwner).toBe(true);
      expect(spaces.body[0].agentCount).toBe(0);
    });

    it('does not create a second default Space on repeat calls', async () => {
      const owner = await signIn();
      await request(http).get('/api/spaces').set('Authorization', `Bearer ${owner.accessToken}`);
      await request(http).get('/api/spaces').set('Authorization', `Bearer ${owner.accessToken}`);

      expect(await harness.prisma.space.count()).toBe(1);
    });

    it('creates and renames additional Spaces', async () => {
      const owner = await signIn();

      const created = await request(http)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: 'My Office' })
        .expect(201);

      expect(created.body.name).toBe('My Office');

      const renamed = await request(http)
        .patch(`/api/spaces/${created.body.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: 'The Shop' })
        .expect(200);

      expect(renamed.body.name).toBe('The Shop');
    });

    it('never shows one account another account’s Spaces', async () => {
      const owner = await signIn();
      const stranger = await signIn('stranger@example.com');
      const ownerSpace = await firstSpaceId(owner.accessToken);
      await firstSpaceId(stranger.accessToken);

      const theirs = await request(http)
        .get('/api/spaces')
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(200);

      expect(theirs.body.map((s: { id: string }) => s.id)).not.toContain(ownerSpace);
    });

    it('answers "not found" rather than "forbidden" for a Space you are not in', async () => {
      const owner = await signIn();
      const stranger = await signIn('stranger@example.com');
      const ownerSpace = await firstSpaceId(owner.accessToken);

      // Not 403 — that would confirm the id exists.
      await request(http)
        .get(`/api/spaces/${ownerSpace}/agents`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Enrollment tokens
  // -------------------------------------------------------------------------

  describe('enrollment tokens', () => {
    it('are minted only by the owner', async () => {
      const owner = await signIn();
      const stranger = await signIn('stranger@example.com');
      const spaceId = await firstSpaceId(owner.accessToken);

      await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);
    });

    it('are stored only as a hash', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);

      const rows = await harness.prisma.agentEnrollmentToken.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).not.toContain(token);
      expect(rows[0]?.tokenHash).toHaveLength(64);
    });

    it('require authentication', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      await request(http).post(`/api/spaces/${spaceId}/enrollment-token`).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Signed agent requests
  // -------------------------------------------------------------------------

  describe('request signatures', () => {
    it('enrolls an agent that signs correctly', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      const response = await agent.post(http, '/agent/enroll', agent.enrollBody(token)).expect(201);

      expect(response.body.spaceId).toBe(spaceId);
      expect(response.body.spaceName).toBe('My Home');
      expect(response.body.deviceId).toEqual(expect.any(String));
      expect(response.body.heartbeatIntervalSeconds).toBe(30);
    });

    it('refuses an unsigned request', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      await request(http).post('/api/agent/enroll').send(agent.enrollBody(token)).expect(401);
    });

    it('refuses a forged signature', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      await agent
        .post(http, '/agent/enroll', agent.enrollBody(token), {
          signature: randomBytes(64).toString('base64url'),
        })
        .expect(401);
    });

    it('refuses a signature over a different body', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      // Sign one payload, then send another. This is the check that stops a
      // captured request being replayed with altered content.
      const honest = agent.enrollBody(token);
      const tampered = { ...honest, name: 'Someone Else’s PC' };

      const raw = Buffer.from(JSON.stringify(honest), 'utf8');
      const timestamp = new Date().toISOString();
      const nonce = randomBytes(16).toString('base64url');

      await agent
        .post(http, '/agent/enroll', tampered, {
          timestamp,
          nonce,
          signature: agent.signOver('POST', '/agent/enroll', timestamp, nonce, raw),
        })
        .expect(401);
    });

    it('refuses a stale timestamp', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      await agent
        .post(http, '/agent/enroll', agent.enrollBody(token), {
          timestamp: new Date(Date.now() - 20 * 60_000).toISOString(),
        })
        .expect(401);
    });

    it('refuses a replayed nonce', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      const enrolled = await agent.post(http, '/agent/enroll', agent.enrollBody(token)).expect(201);
      const nonce = randomBytes(16).toString('base64url');

      await agent
        .post(http, '/agent/heartbeat', agent.heartbeatBody(enrolled.body.deviceId), { nonce })
        .expect(201);

      await agent
        .post(http, '/agent/heartbeat', agent.heartbeatBody(enrolled.body.deviceId), { nonce })
        .expect(401);
    });

    it('does not consume a nonce when an earlier check fails', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();
      const nonce = randomBytes(16).toString('base64url');

      // A forged signature must not burn the nonce, or an attacker could block
      // a legitimate request by sending a broken copy of it first.
      await agent
        .post(http, '/agent/enroll', agent.enrollBody(token), {
          nonce,
          signature: randomBytes(64).toString('base64url'),
        })
        .expect(401);

      await agent.post(http, '/agent/enroll', agent.enrollBody(token), { nonce }).expect(201);
    });

    it('refuses a public key that is not enrolled', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const enrolled = new TestAgent();
      await enrolled.post(http, '/agent/enroll', enrolled.enrollBody(token)).expect(201);

      const stranger = new TestAgent();
      await stranger
        .post(http, '/agent/heartbeat', stranger.heartbeatBody(randomUUID()))
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Enrollment rules
  // -------------------------------------------------------------------------

  describe('enrollment', () => {
    it('refuses a token that was already used', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);

      await new TestAgent().post(http, '/agent/enroll', new TestAgent().enrollBody(token));

      const second = new TestAgent();
      await second.post(http, '/agent/enroll', second.enrollBody(token)).expect(400);
    });

    it('refuses an expired token', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);

      await harness.prisma.agentEnrollmentToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const agent = new TestAgent();
      await agent.post(http, '/agent/enroll', agent.enrollBody(token)).expect(400);
    });

    it('refuses a token that never existed', async () => {
      const agent = new TestAgent();
      await agent
        .post(http, '/agent/enroll', agent.enrollBody(randomBytes(32).toString('base64url')))
        .expect(400);
    });

    it('lists the enrolled agent as a computer in the Space', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();

      await agent.post(http, '/agent/enroll', agent.enrollBody(token, 'Home PC')).expect(201);

      const agents = await request(http)
        .get(`/api/spaces/${spaceId}/agents`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(agents.body).toHaveLength(1);
      expect(agents.body[0].name).toBe('Home PC');
      expect(agents.body[0].status).toBe('online');
    });

    it('shows the agent as a device the owner can revoke', async () => {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();
      await agent.post(http, '/agent/enroll', agent.enrollBody(token, 'Home PC')).expect(201);

      const devices = await request(http)
        .get('/api/devices')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const agentDevice = devices.body.find((d: { kind: string }) => d.kind === 'agent');
      expect(agentDevice).toBeDefined();
      expect(agentDevice.name).toBe('Home PC');
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeats
  // -------------------------------------------------------------------------

  describe('heartbeats', () => {
    async function enrolledAgent() {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();
      const enrolled = await agent.post(http, '/agent/enroll', agent.enrollBody(token)).expect(201);
      return { owner, spaceId, agent, deviceId: enrolled.body.deviceId as string };
    }

    it('acknowledges a beat and records the local address', async () => {
      const { agent, deviceId, owner, spaceId } = await enrolledAgent();

      const beat = await agent
        .post(http, '/agent/heartbeat', agent.heartbeatBody(deviceId))
        .expect(201);

      expect(beat.body.acknowledged).toBe(true);
      expect(beat.body.revoked).toBe(false);

      const agents = await request(http)
        .get(`/api/spaces/${spaceId}/agents`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(agents.body[0].localIpAddress).toBe('192.168.1.42');
      expect(agents.body[0].wakeOnLanReady).toBe(true);
    });

    it('refuses a beat claiming to be a different device', async () => {
      const { agent } = await enrolledAgent();

      await agent.post(http, '/agent/heartbeat', agent.heartbeatBody(randomUUID())).expect(400);
    });

    it('reports the agent offline once its beats stop', async () => {
      const { deviceId, owner, spaceId } = await enrolledAgent();

      await harness.prisma.agent.updateMany({
        where: { deviceId },
        data: {
          lastHeartbeatAt: new Date(Date.now() - (AGENT_OFFLINE_AFTER_SECONDS + 60) * 1000),
        },
      });

      const agents = await request(http)
        .get(`/api/spaces/${spaceId}/agents`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      // Computed from the heartbeat timestamp, so an agent that died without
      // saying goodbye still shows as offline.
      expect(agents.body[0].status).toBe('offline');
    });

    it('tells a revoked agent it was revoked', async () => {
      const { agent, deviceId, owner } = await enrolledAgent();

      await request(http)
        .delete(`/api/devices/${deviceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      // The signature guard refuses a revoked device outright, which is what
      // makes the agent stop rather than keep retrying.
      await agent.post(http, '/agent/heartbeat', agent.heartbeatBody(deviceId)).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  describe('resources', () => {
    async function enrolledAgent() {
      const owner = await signIn();
      const spaceId = await firstSpaceId(owner.accessToken);
      const token = await enrollmentToken(owner.accessToken, spaceId);
      const agent = new TestAgent();
      const enrolled = await agent.post(http, '/agent/enroll', agent.enrollBody(token)).expect(201);
      return { owner, spaceId, agent, deviceId: enrolled.body.deviceId as string };
    }

    it('records reported printers as disabled', async () => {
      const { agent, deviceId, owner, spaceId } = await enrolledAgent();

      await agent
        .post(http, '/agent/resources', {
          deviceId,
          resources: [
            {
              kind: 'printer',
              name: 'Office Laser',
              target: 'Office Laser',
              metadata: { status: 'ready' },
            },
          ],
        })
        .expect(201);

      const resources = await request(http)
        .get(`/api/spaces/${spaceId}/resources`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(resources.body).toHaveLength(1);
      expect(resources.body[0].name).toBe('Office Laser');
      // Discovering a printer is not sharing it.
      expect(resources.body[0].enabled).toBe(false);
    });

    it('does not re-disable a resource the owner already enabled', async () => {
      const { agent, deviceId, owner, spaceId } = await enrolledAgent();

      await agent
        .post(http, '/agent/resources', {
          deviceId,
          resources: [{ kind: 'printer', name: 'Office Laser', target: 'Office Laser' }],
        })
        .expect(201);

      const listed = await request(http)
        .get(`/api/spaces/${spaceId}/resources`)
        .set('Authorization', `Bearer ${owner.accessToken}`);

      await request(http)
        .patch(`/api/spaces/${spaceId}/resources/${listed.body[0].id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ enabled: true })
        .expect(200);

      // A later report must not silently switch it back off.
      await agent
        .post(http, '/agent/resources', {
          deviceId,
          resources: [{ kind: 'printer', name: 'Office Laser', target: 'Office Laser' }],
        })
        .expect(201);

      const after = await request(http)
        .get(`/api/spaces/${spaceId}/resources`)
        .set('Authorization', `Bearer ${owner.accessToken}`);

      expect(after.body[0].enabled).toBe(true);
    });

    it('lets only the owner enable a resource', async () => {
      const { agent, deviceId, owner, spaceId } = await enrolledAgent();
      const stranger = await signIn('stranger@example.com');

      await agent
        .post(http, '/agent/resources', {
          deviceId,
          resources: [{ kind: 'printer', name: 'Office Laser', target: 'Office Laser' }],
        })
        .expect(201);

      const listed = await request(http)
        .get(`/api/spaces/${spaceId}/resources`)
        .set('Authorization', `Bearer ${owner.accessToken}`);

      await request(http)
        .patch(`/api/spaces/${spaceId}/resources/${listed.body[0].id}`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({ enabled: true })
        .expect(404);
    });
  });
});
