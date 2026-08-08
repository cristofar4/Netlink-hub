import request from 'supertest';
import type { Server } from 'node:http';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { REMOTE_IDLE_TIMEOUT_SECONDS, type RemoteGrantEnvelope } from '@netlink/contracts';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';
import { TestAgent } from '../agent-client';
import { buildGrantSigningInput } from '../../src/remote/grant-signer';

describe('Remote desktop (integration)', () => {
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
      deviceId: verified.body.device.id as string,
    };
  }

  /** An owner with a Space and one online computer in it. */
  async function withComputer(name = 'Home PC') {
    const owner = await signIn('owner@example.com');
    const spaces = await request(http)
      .get('/api/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const spaceId = spaces.body[0].id as string;

    const tokenResponse = await request(http)
      .post(`/api/spaces/${spaceId}/enrollment-token`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    const agent = new TestAgent();
    const enrolled = await agent
      .post(http, '/agent/enroll', agent.enrollBody(tokenResponse.body.token, name))
      .expect(201);

    await agent
      .post(http, '/agent/heartbeat', agent.heartbeatBody(enrolled.body.deviceId))
      .expect(201);

    const row = await harness.prisma.agent.findFirstOrThrow({
      where: { deviceId: enrolled.body.deviceId },
    });

    return {
      owner,
      spaceId,
      agent,
      deviceId: enrolled.body.deviceId as string,
      agentId: row.id,
    };
  }

  /** Completes the step-up a control session needs. */
  async function stepUp(token: string, spaceId: string) {
    const challenge = await request(http)
      .post(`/api/spaces/${spaceId}/remote/step-up`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    return {
      stepUpChallengeId: challenge.body.challengeId as string,
      stepUpCode: readCode(harness.mail, 'owner@example.com'),
    };
  }

  /** Connects the demo Data Pool a Pass has to be issued against. */
  async function connectPool(token: string, spaceId: string) {
    const existing = await harness.prisma.dataPool.findFirst({ where: { spaceId } });
    if (existing) return;
    await request(http)
      .post(`/api/spaces/${spaceId}/data/pool`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accountRef: '08031234567' })
      .expect(201);
  }

  async function startView(token: string, spaceId: string, agentId: string) {
    return request(http)
      .post(`/api/spaces/${spaceId}/remote/sessions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ agentId, mode: 'view' })
      .expect(201);
  }

  /**
   * Invites a member with an exact permission list and signs them in.
   *
   * A pass needs a pool behind it, so one is connected first. `connect` is
   * idempotent enough for this — the same Space may be set up twice in a test
   * that invites two people.
   */
  async function inviteMember(
    ownerToken: string,
    spaceId: string,
    email: string,
    permissions: string[],
  ) {
    await connectPool(ownerToken, spaceId);

    const pass = await request(http)
      .post(`/api/spaces/${spaceId}/data/passes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email,
        kind: 'custom',
        permissions,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      })
      .expect(201);

    const member = await signIn(email);
    await request(http)
      .post('/api/passes/claim')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ token: pass.body.claimToken })
      .expect(201);

    return member;
  }

  // -------------------------------------------------------------------------
  // Permission
  // -------------------------------------------------------------------------

  describe('who may start a session', () => {
    it('lets an owner start a view session on their own computer', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      const ticket = await startView(owner.token, spaceId, agentId);

      expect(ticket.body.session.mode).toBe('view');
      expect(ticket.body.session.state).toBe('pending');
      expect(ticket.body.session.agentName).toBe('Home PC');
      expect(ticket.body.session.isMine).toBe(true);
    });

    it('refuses a view session to a member without devices.observe', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const member = await inviteMember(owner.token, spaceId, 'nosy@example.com', ['devices.view']);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, mode: 'view' })
        .expect(403);
    });

    /**
     * The reason `devices.observe` exists as its own capability. A member who
     * may watch must not thereby be able to type.
     */
    it('refuses a control session to a member who may only observe', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const member = await inviteMember(owner.token, spaceId, 'watcher@example.com', [
        'devices.view',
        'devices.observe',
      ]);

      // Watching is fine.
      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, mode: 'view' })
        .expect(201);

      // Typing is not.
      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, mode: 'control' })
        .expect(403);
    });

    it('refuses control to someone granted control but not observe', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const member = await inviteMember(owner.token, spaceId, 'partial@example.com', [
        'devices.view',
        'devices.control',
      ]);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, mode: 'control' })
        .expect(403);
    });

    it('hides the Space entirely from someone who is not a member', async () => {
      const { spaceId, agentId } = await withComputer();
      const stranger = await signIn('stranger@example.com');

      // 404, not 403 — a 403 would confirm the Space exists.
      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ agentId, mode: 'view' })
        .expect(404);
    });

    it('records a denial in the audit trail', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const member = await inviteMember(owner.token, spaceId, 'denied@example.com', [
        'devices.view',
      ]);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, mode: 'view' })
        .expect(403);

      const denials = await harness.prisma.auditEvent.findMany({
        where: { action: 'permission.denied', spaceId },
      });
      expect(denials.length).toBeGreaterThan(0);
    });
  });

  describe('confirmation before taking control', () => {
    it('refuses a control session without a confirmation code', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      const refused = await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, mode: 'control' })
        .expect(403);

      expect(refused.body.message).toMatch(/six-digit code/i);
    });

    it('refuses a wrong confirmation code', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const { stepUpChallengeId } = await stepUp(owner.token, spaceId);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, mode: 'control', stepUpChallengeId, stepUpCode: '000000' })
        .expect(403);
    });

    it('accepts a control session with the right code', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const confirmation = await stepUp(owner.token, spaceId);

      const ticket = await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, mode: 'control', ...confirmation })
        .expect(201);

      expect(ticket.body.session.mode).toBe('control');
    });

    it('does not accept the same confirmation code twice', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const confirmation = await stepUp(owner.token, spaceId);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, mode: 'control', ...confirmation })
        .expect(201);

      // The session started above still holds the machine, so end it first —
      // otherwise the second attempt would be refused for being a duplicate
      // session rather than for the reason under test.
      const sessions = await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessions.body[0].id}/end`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, mode: 'control', ...confirmation })
        .expect(403);
    });
  });

  describe('preconditions', () => {
    it('refuses a session to a computer that is offline', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      await harness.prisma.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000), status: 'offline' },
      });

      const refused = await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, mode: 'view' })
        .expect(409);

      expect(refused.body.message).toMatch(/not online/i);
    });

    it('refuses a session to a computer in a different Space', async () => {
      const first = await withComputer();
      const second = await request(http)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${first.owner.token}`)
        .send({ name: 'My Office' })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${second.body.id}/remote/sessions`)
        .set('Authorization', `Bearer ${first.owner.token}`)
        .send({ agentId: first.agentId, mode: 'view' })
        .expect(404);
    });

    it('will not let two people connect to the same computer at once', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const member = await inviteMember(owner.token, spaceId, 'second@example.com', [
        'devices.view',
        'devices.observe',
      ]);

      await startView(owner.token, spaceId, agentId);

      const refused = await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, mode: 'view' })
        .expect(409);

      expect(refused.body.message).toMatch(/already connected/i);
    });

    it('lets the same person reconnect, replacing their own session', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      const first = await startView(owner.token, spaceId, agentId);
      const second = await startView(owner.token, spaceId, agentId);

      expect(second.body.session.id).not.toBe(first.body.session.id);

      const replaced = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: first.body.session.id },
      });
      expect(replaced.state).toBe('ended');
    });
  });

  // -------------------------------------------------------------------------
  // The signed grant
  // -------------------------------------------------------------------------

  describe('the grant handed to the computer', () => {
    it('signs a grant the agent can verify, carrying the mode', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      const grants = await agent.post(http, '/agent/remote/grants', {}).expect(201);
      const envelopes = grants.body as RemoteGrantEnvelope[];

      expect(envelopes).toHaveLength(1);
      const [envelope] = envelopes;
      expect(envelope.grant.sessionId).toBe(ticket.body.session.id);
      expect(envelope.grant.agentId).toBe(agentId);
      expect(envelope.grant.mode).toBe('view');

      // The signature verifies against the published key — the same check the
      // Go agent performs.
      const keyResponse = await request(http).get('/api/agent/power/signing-key').expect(200);
      const spki = Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(keyResponse.body.publicKey, 'base64url'),
      ]);
      const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });

      const ok = verifyEd25519(
        null,
        buildGrantSigningInput(envelope.grant),
        publicKey,
        Buffer.from(envelope.signature, 'base64url'),
      );
      expect(ok).toBe(true);
    });

    /**
     * The claim the whole design rests on. Input goes peer to peer, so the mode
     * has to be un-editable by the peer that would benefit from editing it.
     */
    it('produces a signature that no longer verifies if the mode is changed', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      await startView(owner.token, spaceId, agentId);

      const grants = await agent.post(http, '/agent/remote/grants', {}).expect(201);
      const [envelope] = grants.body as RemoteGrantEnvelope[];

      const keyResponse = await request(http).get('/api/agent/power/signing-key').expect(200);
      const spki = Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(keyResponse.body.publicKey, 'base64url'),
      ]);
      const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });

      const escalated = { ...envelope.grant, mode: 'control' as const };
      const ok = verifyEd25519(
        null,
        buildGrantSigningInput(escalated),
        publicKey,
        Buffer.from(envelope.signature, 'base64url'),
      );
      expect(ok).toBe(false);
    });

    it('does not hand a grant to a different computer', async () => {
      const { owner, spaceId, agentId } = await withComputer('Home PC');

      // A second computer in the same Space.
      const tokenResponse = await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      const other = new TestAgent();
      const enrolled = await other
        .post(http, '/agent/enroll', other.enrollBody(tokenResponse.body.token, 'Office PC'))
        .expect(201);
      await other
        .post(http, '/agent/heartbeat', other.heartbeatBody(enrolled.body.deviceId))
        .expect(201);

      await startView(owner.token, spaceId, agentId);

      const grants = await other.post(http, '/agent/remote/grants', {}).expect(201);
      expect(grants.body).toHaveLength(0);
    });

    it('stops handing out a grant once the session has ended', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${ticket.body.session.id}/end`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      const grants = await agent.post(http, '/agent/remote/grants', {}).expect(201);
      expect(grants.body).toHaveLength(0);
    });

    it('refuses an unsigned request for grants', async () => {
      await request(http).post('/api/agent/remote/grants').send({}).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // ICE
  // -------------------------------------------------------------------------

  describe('ICE servers', () => {
    it('says plainly whether a relay is available', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      // The test configuration has no TURN server, and the ticket says so
      // rather than leaving the UI to spin on a connection that cannot happen.
      expect(ticket.body.relayAvailable).toBe(false);
      expect(Array.isArray(ticket.body.iceServers)).toBe(true);
    });

    it('never returns a long-lived TURN credential', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      for (const server of ticket.body.iceServers) {
        if (!server.username) continue;
        // coturn's REST convention: the username is the expiry, so a credential
        // cannot outlive it.
        const [expiry] = String(server.username).split(':');
        expect(Number(expiry)).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(Number(expiry)).toBeLessThan(Math.floor(Date.now() / 1000) + 3600);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Signalling
  // -------------------------------------------------------------------------

  describe('signalling', () => {
    it('carries an offer to the computer and an answer back', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'offer', payload: '{"type":"offer","sdp":"v=0"}' })
        .expect(201);

      const forHost = await agent
        .post(http, `/agent/remote/sessions/${sessionId}/signals`, {})
        .expect(201);
      expect(forHost.body).toHaveLength(1);
      expect(forHost.body[0].kind).toBe('offer');

      await agent
        .post(http, `/agent/remote/sessions/${sessionId}/signal`, {
          sessionId,
          kind: 'answer',
          payload: '{"type":"answer","sdp":"v=0"}',
        })
        .expect(201);

      const forViewer = await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signals`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(forViewer.body).toHaveLength(1);
      expect(forViewer.body[0].kind).toBe('answer');
    });

    it('does not deliver a message back to the side that wrote it', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'candidate', payload: '{"candidate":"a"}' })
        .expect(201);

      const echoed = await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signals`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(echoed.body).toHaveLength(0);
    });

    it('delivers each message once', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'candidate', payload: '{"candidate":"a"}' })
        .expect(201);

      const first = await agent
        .post(http, `/agent/remote/sessions/${sessionId}/signals`, {})
        .expect(201);
      expect(first.body).toHaveLength(1);

      const second = await agent
        .post(http, `/agent/remote/sessions/${sessionId}/signals`, {})
        .expect(201);
      expect(second.body).toHaveLength(0);
    });

    /**
     * ICE does not gather candidates one at a time — a peer emits several within
     * a few milliseconds and they arrive together. Assigning sequence numbers by
     * reading the highest and then inserting loses that race, and the first real
     * connection attempt is where it shows up.
     */
    it('survives candidates arriving all at once', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      const posts = Array.from({ length: 12 }, (_, index) =>
        request(http)
          .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ sessionId, kind: 'candidate', payload: `{"candidate":${index}}` }),
      );

      const results = await Promise.all(posts);
      for (const result of results) {
        expect(result.status).toBe(201);
      }

      const collected = await agent
        .post(http, `/agent/remote/sessions/${sessionId}/signals`, {})
        .expect(201);
      expect(collected.body).toHaveLength(12);

      // Every one got its own place in the order.
      const seqs = collected.body.map((signal: { seq: number }) => signal.seq);
      expect(new Set(seqs).size).toBe(12);
    });

    it('keeps messages in order', async () => {
      const { owner, spaceId, agent, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      for (const payload of ['{"c":1}', '{"c":2}', '{"c":3}']) {
        await request(http)
          .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ sessionId, kind: 'candidate', payload })
          .expect(201);
      }

      const collected = await agent
        .post(http, `/agent/remote/sessions/${sessionId}/signals`, {})
        .expect(201);
      expect(collected.body.map((s: { payload: string }) => s.payload)).toEqual([
        '{"c":1}',
        '{"c":2}',
        '{"c":3}',
      ]);
    });

    it('will not let one person read another person’s signalling', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const member = await inviteMember(owner.token, spaceId, 'other@example.com', [
        'devices.view',
        'devices.observe',
      ]);
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      // Not their session, so as far as they are concerned it does not exist.
      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signals`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(404);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ sessionId, kind: 'candidate', payload: '{}' })
        .expect(404);
    });

    it('bounds the size of a signalling payload', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'candidate', payload: 'x'.repeat(20_001) })
        .expect(400);
    });

    it('refuses signalling on a session that has ended', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/end`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'candidate', payload: '{}' })
        .expect(409);
    });

    it('discards the signalling messages when the session ends', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'offer', payload: '{"sdp":"v=0"}' })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/end`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      // The only remote-desktop bytes the server ever holds, and they do not
      // outlive the session that needed them.
      const left = await harness.prisma.remoteSignal.count({ where: { sessionId } });
      expect(left).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('the life of a session', () => {
    it('moves to connecting when the peers start talking', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ sessionId, kind: 'offer', payload: '{"sdp":"v=0"}' })
        .expect(201);

      const session = await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(session.body.state).toBe('connecting');
    });

    it('becomes active and records how the media travelled', async () => {
      const { owner, spaceId, agent, agentId, deviceId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await agent
        .post(http, '/agent/remote/connected', {
          deviceId,
          sessionId,
          localCandidateType: 'srflx',
          remoteCandidateType: 'host',
        })
        .expect(201);

      const session = await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(session.body.state).toBe('active');
      expect(session.body.strategy).toBe('direct');
      expect(session.body.connectedAt).not.toBeNull();
    });

    it('reports a relayed connection as relayed', async () => {
      const { owner, spaceId, agent, agentId, deviceId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await agent
        .post(http, '/agent/remote/connected', {
          deviceId,
          sessionId,
          localCandidateType: 'relay',
          remoteCandidateType: 'srflx',
        })
        .expect(201);

      const session = await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(session.body.strategy).toBe('relayed');
    });

    it('will not let one computer report a connection for another', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      const tokenResponse = await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      const other = new TestAgent();
      const enrolled = await other
        .post(http, '/agent/enroll', other.enrollBody(tokenResponse.body.token, 'Office PC'))
        .expect(201);
      await other
        .post(http, '/agent/heartbeat', other.heartbeatBody(enrolled.body.deviceId))
        .expect(201);

      const ticket = await startView(owner.token, spaceId, agentId);

      await other
        .post(http, '/agent/remote/connected', {
          deviceId: enrolled.body.deviceId,
          sessionId: ticket.body.session.id,
          localCandidateType: 'host',
          remoteCandidateType: 'host',
        })
        .expect(404);
    });

    it('ends a session and says why', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      const ended = await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${ticket.body.session.id}/end`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      expect(ended.body.state).toBe('ended');
      expect(ended.body.endReason).toBe('viewer_left');
      expect(ended.body.endedAt).not.toBeNull();
    });

    it('is idempotent about ending', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const url = `/api/spaces/${spaceId}/remote/sessions/${ticket.body.session.id}/end`;

      await request(http)
        .post(url)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);
      await request(http)
        .post(url)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      const records = await harness.prisma.auditEvent.count({
        where: { action: 'remote.session.ended', spaceId },
      });
      expect(records).toBe(1);
    });

    it('closes a session whose viewer stopped saying they were there', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await harness.prisma.remoteSession.update({
        where: { id: sessionId },
        data: {
          state: 'active',
          connectedAt: new Date(),
          lastSeenAt: new Date(Date.now() - (REMOTE_IDLE_TIMEOUT_SECONDS + 60) * 1000),
        },
      });

      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const closed = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(closed.state).toBe('ended');
      expect(closed.endReason).toBe('idle_timeout');
    });

    it('closes a session whose computer went offline', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      await harness.prisma.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000), status: 'offline' },
      });

      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const closed = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: ticket.body.session.id },
      });
      expect(closed.state).toBe('ended');
      expect(closed.endReason).toBe('host_offline');
    });

    it('closes a session that never connected', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      await harness.prisma.remoteSession.update({
        where: { id: ticket.body.session.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const closed = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: ticket.body.session.id },
      });
      expect(closed.state).toBe('ended');
      expect(closed.endReason).toBe('connect_timeout');
    });

    it('keeps a session alive while the viewer keeps saying so', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await harness.prisma.remoteSession.update({
        where: { id: sessionId },
        data: {
          state: 'active',
          connectedAt: new Date(),
          lastSeenAt: new Date(Date.now() - (REMOTE_IDLE_TIMEOUT_SECONDS - 30) * 1000),
        },
      });

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/heartbeat`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);

      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const still = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(still.state).toBe('active');
    });

    /**
     * Revoking a device has to reach the peer connection. Cutting HTTP and the
     * WebSocket while a screen keeps streaming would make revocation a
     * half-measure, and revocation is what a person reaches for when something
     * has actually gone wrong.
     */
    it('ends a live session when the viewer’s device is revoked', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      await request(http)
        .delete(`/api/devices/${owner.deviceId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const closed = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: ticket.body.session.id },
      });
      expect(closed.state).toBe('ended');
      expect(closed.endReason).toBe('permission_revoked');
    });
  });

  // -------------------------------------------------------------------------
  // View-only violations
  // -------------------------------------------------------------------------

  describe('input refused on a view-only session', () => {
    it('records what the computer refused', async () => {
      const { owner, spaceId, agent, agentId, deviceId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;

      await agent
        .post(http, '/agent/remote/violation', {
          deviceId,
          sessionId,
          kind: 'input_on_view_only',
          count: 4,
        })
        .expect(201);

      const session = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.refusedInputs).toBe(4);

      const audit = await harness.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'remote.input.refused', spaceId },
      });
      expect(audit.outcome).toBe('denied');
    });

    it('refuses a violation report from a computer the session was not for', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      const tokenResponse = await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      const other = new TestAgent();
      const enrolled = await other
        .post(http, '/agent/enroll', other.enrollBody(tokenResponse.body.token, 'Office PC'))
        .expect(201);

      const ticket = await startView(owner.token, spaceId, agentId);

      await other
        .post(http, '/agent/remote/violation', {
          deviceId: enrolled.body.deviceId,
          sessionId: ticket.body.session.id,
          kind: 'input_on_view_only',
          count: 1,
        })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  describe('the record', () => {
    it('records the start and the end of a session, with no content', async () => {
      const { owner, spaceId, agentId } = await withComputer();
      const ticket = await startView(owner.token, spaceId, agentId);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${ticket.body.session.id}/end`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'viewer_left' })
        .expect(201);

      const events = await harness.prisma.auditEvent.findMany({
        where: { spaceId, action: { in: ['remote.session.started', 'remote.session.ended'] } },
        orderBy: { createdAt: 'asc' },
      });

      expect(events.map((event) => event.action)).toEqual([
        'remote.session.started',
        'remote.session.ended',
      ]);

      // What was on the screen is not recorded, because it never reached here.
      const serialised = JSON.stringify(events);
      expect(serialised).not.toMatch(/screenshot|frame|jpeg|keystroke|password/i);
    });
  });

  // -------------------------------------------------------------------------
  // Data-Only isolation
  // -------------------------------------------------------------------------

  describe('a Data-Only member', () => {
    it('cannot reach any remote desktop endpoint, even by asking directly', async () => {
      const { owner, spaceId, agentId } = await withComputer();

      await connectPool(owner.token, spaceId);
      const pass = await request(http)
        .post(`/api/spaces/${spaceId}/data/passes`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          email: 'dataonly@example.com',
          kind: 'data_only',
          totalBytes: '1073741824',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        })
        .expect(201);

      const member = await signIn('dataonly@example.com');
      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ token: pass.body.claimToken })
        .expect(201);

      const ticket = await startView(owner.token, spaceId, agentId);
      const sessionId = ticket.body.session.id as string;
      const auth = { Authorization: `Bearer ${member.token}` };

      // Every route, tried directly. Hiding a button is not the control.
      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions`)
        .set(auth)
        .send({ agentId, mode: 'view' })
        .expect(403);

      await request(http).get(`/api/spaces/${spaceId}/remote/sessions`).set(auth).expect(403);

      await request(http).post(`/api/spaces/${spaceId}/remote/step-up`).set(auth).expect(403);

      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}`)
        .set(auth)
        .expect(404);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signal`)
        .set(auth)
        .send({ sessionId, kind: 'offer', payload: '{}' })
        .expect(404);

      await request(http)
        .get(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/signals`)
        .set(auth)
        .expect(404);

      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/heartbeat`)
        .set(auth)
        .expect(404);

      // 403 rather than 404 here: ending someone else's session falls through
      // to the owner check, and they *are* a member of this Space — they just
      // do not own it. Either way the session is not theirs to end.
      await request(http)
        .post(`/api/spaces/${spaceId}/remote/sessions/${sessionId}/end`)
        .set(auth)
        .send({ reason: 'viewer_left' })
        .expect(403);

      // And the owner's session is untouched by any of it.
      const untouched = await harness.prisma.remoteSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(untouched.state).not.toBe('ended');
    });
  });
});
