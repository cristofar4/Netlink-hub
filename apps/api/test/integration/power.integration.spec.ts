import request from 'supertest';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { POWER_COUNTDOWN_SECONDS } from '@netlink/contracts';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';
import { TestAgent } from '../agent-client';
import { verifyEd25519 } from '../../src/agents/agent-signature.guard';
import { buildSigningInput } from '../../src/power/command-signer';

describe('Device Power and Wake (integration)', () => {
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

  /**
   * An owner with a Space and `count` enrolled agents, each already beating and
   * on the same local /24 so wake preconditions can be met.
   */
  async function withAgents(count: number, names: string[] = []) {
    const owner = await signIn('owner@example.com');
    const spaces = await request(http)
      .get('/api/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const spaceId = spaces.body[0].id as string;

    const agents: Array<{ agent: TestAgent; deviceId: string; agentId: string }> = [];

    for (let index = 0; index < count; index += 1) {
      const tokenResponse = await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);

      const agent = new TestAgent();
      const enrolled = await agent
        .post(
          http,
          '/agent/enroll',
          agent.enrollBody(tokenResponse.body.token, names[index] ?? `PC ${index + 1}`),
        )
        .expect(201);

      await agent
        .post(
          http,
          '/agent/heartbeat',
          agent.heartbeatBody(enrolled.body.deviceId, {
            localIpAddress: `192.168.1.${10 + index}`,
            macAddress: `00:1A:2B:3C:4D:${(index + 10).toString(16).padStart(2, '0').toUpperCase()}`,
          }),
        )
        .expect(201);

      const row = await harness.prisma.agent.findFirstOrThrow({
        where: { deviceId: enrolled.body.deviceId },
      });
      agents.push({ agent, deviceId: enrolled.body.deviceId, agentId: row.id });
    }

    return { owner, spaceId, agents };
  }

  /** Completes the step-up flow and returns the confirmation fields. */
  async function stepUp(owner: { token: string }, spaceId: string, action: string) {
    const challenge = await request(http)
      .post(`/api/spaces/${spaceId}/power/step-up`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ action })
      .expect(201);

    return {
      stepUpChallengeId: challenge.body.challengeId as string,
      stepUpCode: readCode(harness.mail, 'owner@example.com'),
    };
  }

  // -------------------------------------------------------------------------
  // State and preconditions
  // -------------------------------------------------------------------------

  describe('power state', () => {
    it('reports which actions are possible and why not', async () => {
      const { owner, spaceId } = await withAgents(1, ['Home PC']);

      const state = await request(http)
        .get(`/api/spaces/${spaceId}/power`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const pc = state.body[0];
      expect(pc.agentName).toBe('Home PC');
      expect(pc.online).toBe(true);

      const byAction = Object.fromEntries(pc.actions.map((a: { action: string }) => [a.action, a]));

      // Online, so these are available.
      expect(byAction['power.restart'].allowed).toBe(true);
      expect(byAction['power.lock'].allowed).toBe(true);
      // ...and wake is not, with a reason a person can act on.
      expect(byAction['power.wake'].allowed).toBe(false);
      expect(byAction['power.wake'].reason).toMatch(/already on/i);
    });

    it('marks the destructive actions as needing confirmation', async () => {
      const { owner, spaceId } = await withAgents(1);

      const state = await request(http)
        .get(`/api/spaces/${spaceId}/power`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const byAction = Object.fromEntries(
        state.body[0].actions.map((a: { action: string }) => [a.action, a]),
      );

      expect(byAction['power.restart'].requiresStepUp).toBe(true);
      expect(byAction['power.shutdown'].requiresStepUp).toBe(true);
      expect(byAction['power.lock'].requiresStepUp).toBe(false);
      expect(byAction['power.sleep'].requiresStepUp).toBe(false);
    });

    it('lists every wake precondition, and says which are unmet', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      // Take it offline so wake becomes relevant.
      await harness.prisma.agent.update({
        where: { id: agents[0]!.agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 600_000) },
      });

      const state = await request(http)
        .get(`/api/spaces/${spaceId}/power`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const { wake } = state.body[0];
      expect(wake).toMatchObject({
        wakeOnLanEnabled: expect.any(Boolean),
        networkAdapterFound: expect.any(Boolean),
        wakeHelperOnline: expect.any(Boolean),
        wakeCapableLink: expect.any(Boolean),
        targetMacRegistered: expect.any(Boolean),
      });
      // Undetectable on most desktops — displayed, never a blocker.
      expect(wake.powerConnected).toBeNull();

      // No helper has been designated, so that is the blocker.
      expect(wake.ready).toBe(false);
      expect(wake.blockers.join(' ')).toMatch(/Wake Helper/i);
    });
  });

  // -------------------------------------------------------------------------
  // Wake
  // -------------------------------------------------------------------------

  describe('wake', () => {
    /** The brief's scenario: Family PC online as helper, Home PC off. */
    async function familyAndHome() {
      const { owner, spaceId, agents } = await withAgents(2, ['Home PC', 'Family PC']);
      const home = agents[0]!;
      const family = agents[1]!;

      await request(http)
        .put(`/api/spaces/${spaceId}/power/agents/${family.agentId}/wake-helper`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ isWakeHelper: true })
        .expect(200);

      await request(http)
        .put(`/api/spaces/${spaceId}/power/agents/${home.agentId}/mac`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ macAddress: '00:1A:2B:3C:4D:5E' })
        .expect(200);

      // Home PC is powered off.
      await harness.prisma.agent.update({
        where: { id: home.agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 600_000) },
      });

      return { owner, spaceId, home, family };
    }

    it('is ready once a helper is online on the same network and the MAC is registered', async () => {
      const { owner, spaceId, home } = await familyAndHome();

      const state = await request(http)
        .get(`/api/spaces/${spaceId}/power`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const homeState = state.body.find((s: { agentId: string }) => s.agentId === home.agentId);
      expect(homeState.wake.ready).toBe(true);
      expect(homeState.wake.helperAgentName).toBe('Family PC');
      expect(homeState.wake.blockers).toEqual([]);
    });

    it('delivers the signed command to the helper, not the target', async () => {
      const { owner, spaceId, home, family } = await familyAndHome();

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.wake', targetAgentId: home.agentId })
        .expect(201);

      // The target is off; it cannot collect anything.
      const toTarget = await home.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(toTarget.body).toHaveLength(0);

      // The helper gets it — which is the whole point of a Wake Helper.
      const toHelper = await family.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(toHelper.body).toHaveLength(1);
      expect(toHelper.body[0].command.action).toBe('power.wake');
    });

    it('signs the command so the agent can verify it', async () => {
      const { owner, spaceId, home, family } = await familyAndHome();

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.wake', targetAgentId: home.agentId })
        .expect(201);

      const collected = await family.agent.post(http, '/agent/power/collect', {}).expect(201);
      const envelope = collected.body[0];

      const key = await request(http).get('/api/agent/power/signing-key').expect(200);
      expect(key.body.keyId).toBe(envelope.keyId);

      // Verified exactly as the Go agent does, against the published key.
      expect(
        verifyEd25519(key.body.publicKey, buildSigningInput(envelope.command), envelope.signature),
      ).toBe(true);
    });

    it('refuses a wake with no helper online', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      await harness.prisma.agent.update({
        where: { id: agents[0]!.agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 600_000), macAddress: '00:1A:2B:3C:4D:5E' },
      });

      const response = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.wake', targetAgentId: agents[0]!.agentId })
        .expect(409);

      expect(response.body.message).toMatch(/Wake Helper/i);
    });

    it('refuses a wake when no MAC has been registered', async () => {
      const { owner, spaceId, agents } = await withAgents(2);
      const [target, helper] = agents;

      await request(http)
        .put(`/api/spaces/${spaceId}/power/agents/${helper!.agentId}/wake-helper`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ isWakeHelper: true })
        .expect(200);

      await harness.prisma.agent.update({
        where: { id: target!.agentId },
        data: {
          lastHeartbeatAt: new Date(Date.now() - 600_000),
          macAddress: null,
          wakeOnLanReady: false,
        },
      });

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.wake', targetAgentId: target!.agentId })
        .expect(409);
    });

    it('refuses a wake for a computer that is already on', async () => {
      const { owner, spaceId, agents } = await withAgents(2);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.wake', targetAgentId: agents[0]!.agentId })
        .expect(409);
    });
  });

  // -------------------------------------------------------------------------
  // Step-up and the countdown
  // -------------------------------------------------------------------------

  describe('destructive actions', () => {
    it('refuses a shutdown with no confirmation code', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      const response = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.shutdown', targetAgentId: agents[0]!.agentId })
        .expect(403);

      expect(response.body.message).toMatch(/six-digit code/i);
    });

    it('refuses a wrong confirmation code', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const confirmation = await stepUp(owner, spaceId, 'power.shutdown');

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          action: 'power.shutdown',
          targetAgentId: agents[0]!.agentId,
          stepUpChallengeId: confirmation.stepUpChallengeId,
          stepUpCode: confirmation.stepUpCode === '000000' ? '111111' : '000000',
        })
        .expect(403);

      expect(await harness.prisma.powerCommand.count()).toBe(0);
    });

    it('accepts a correct code and starts a ten-second countdown', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const confirmation = await stepUp(owner, spaceId, 'power.shutdown');

      const command = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          action: 'power.shutdown',
          targetAgentId: agents[0]!.agentId,
          ...confirmation,
        })
        .expect(201);

      expect(command.body.state).toBe('countdown');
      expect(command.body.cancellable).toBe(true);

      const seconds = (new Date(command.body.executeAt).getTime() - Date.now()) / 1000;
      expect(seconds).toBeGreaterThan(POWER_COUNTDOWN_SECONDS - 3);
      expect(seconds).toBeLessThanOrEqual(POWER_COUNTDOWN_SECONDS + 1);
    });

    it('will not hand the command over until the countdown elapses', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const confirmation = await stepUp(owner, spaceId, 'power.shutdown');

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.shutdown', targetAgentId: agents[0]!.agentId, ...confirmation })
        .expect(201);

      // This is what makes the countdown real rather than cosmetic: the agent
      // cannot act early because it has not been given anything.
      const early = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(early.body).toHaveLength(0);

      await harness.prisma.powerCommand.updateMany({
        data: { executeAt: new Date(Date.now() - 1000) },
      });

      const after = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(after.body).toHaveLength(1);
    });

    it('can be cancelled during the countdown', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const confirmation = await stepUp(owner, spaceId, 'power.restart');

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.restart', targetAgentId: agents[0]!.agentId, ...confirmation })
        .expect(201);

      const cancelled = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.cancel', targetAgentId: agents[0]!.agentId })
        .expect(201);

      expect(cancelled.body.state).toBe('cancelled');

      // And it is never handed over afterwards.
      await harness.prisma.powerCommand.updateMany({
        data: { executeAt: new Date(Date.now() - 1000) },
      });
      const collected = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(collected.body).toHaveLength(0);
    });

    it('refuses to cancel a command the computer already has', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);

      // The machine is already acting. Pretending a cancel worked would be a lie.
      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.cancel', targetAgentId: agents[0]!.agentId })
        .expect(409);
    });

    it('does not reuse a step-up code for a second command', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const confirmation = await stepUp(owner, spaceId, 'power.shutdown');

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.shutdown', targetAgentId: agents[0]!.agentId, ...confirmation })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.restart', targetAgentId: agents[0]!.agentId, ...confirmation })
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // Delivery, replay and results
  // -------------------------------------------------------------------------

  describe('delivery', () => {
    it('hands a non-destructive command over immediately', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      const collected = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(collected.body).toHaveLength(1);
      expect(collected.body[0].command.action).toBe('power.lock');
    });

    it('hands each command over exactly once', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      const first = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);
      const second = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);

      expect(first.body).toHaveLength(1);
      expect(second.body).toHaveLength(0);
    });

    it('gives every command a distinct nonce', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      for (let i = 0; i < 3; i += 1) {
        const command = await request(http)
          .post(`/api/spaces/${spaceId}/power/commands`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
          .expect(201);

        await agents[0]!.agent.post(http, '/agent/power/collect', {});
        // Report before asking for the next one: a delivered command is still
        // outstanding until the agent says what happened.
        await agents[0]!.agent
          .post(http, '/agent/power/result', {
            deviceId: agents[0]!.deviceId,
            commandId: command.body.id,
            succeeded: true,
          })
          .expect(201);
      }

      const nonces = (await harness.prisma.powerCommand.findMany()).map((c) => c.nonce);
      expect(new Set(nonces).size).toBe(nonces.length);
    });

    it('never hands one computer another computer’s command', async () => {
      const { owner, spaceId, agents } = await withAgents(2);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      const wrongMachine = await agents[1]!.agent
        .post(http, '/agent/power/collect', {})
        .expect(201);
      expect(wrongMachine.body).toHaveLength(0);
    });

    it('does not deliver an expired command', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      await harness.prisma.powerCommand.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const collected = await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);
      expect(collected.body).toHaveLength(0);

      const stored = await harness.prisma.powerCommand.findFirstOrThrow();
      expect(stored.state).toBe('expired');
    });

    it('refuses one pending command per computer', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      // Clicking twice should not queue a second action behind the first.
      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.sleep', targetAgentId: agents[0]!.agentId })
        .expect(409);
    });

    it('records the result and audits it', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      const command = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      await agents[0]!.agent.post(http, '/agent/power/collect', {}).expect(201);

      await agents[0]!.agent
        .post(http, '/agent/power/result', {
          deviceId: agents[0]!.deviceId,
          commandId: command.body.id,
          succeeded: true,
          detail: 'Workstation locked',
        })
        .expect(201);

      const stored = await harness.prisma.powerCommand.findFirstOrThrow();
      expect(stored.state).toBe('succeeded');
      expect(stored.detail).toBe('Workstation locked');

      const audit = await harness.prisma.auditEvent.findMany({
        where: { action: 'power.command.result' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.outcome).toBe('success');
    });

    it('refuses a result for a command addressed elsewhere', async () => {
      const { owner, spaceId, agents } = await withAgents(2);

      const command = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      await agents[1]!.agent
        .post(http, '/agent/power/result', {
          deviceId: agents[1]!.deviceId,
          commandId: command.body.id,
          succeeded: true,
        })
        .expect(403);
    });

    it('records a failure honestly', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      const command = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.sleep', targetAgentId: agents[0]!.agentId })
        .expect(201);

      await agents[0]!.agent.post(http, '/agent/power/collect', {});
      await agents[0]!.agent
        .post(http, '/agent/power/result', {
          deviceId: agents[0]!.deviceId,
          commandId: command.body.id,
          succeeded: false,
          detail: 'SetSuspendState failed',
        })
        .expect(201);

      const stored = await harness.prisma.powerCommand.findFirstOrThrow();
      expect(stored.state).toBe('failed');

      const audit = await harness.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'power.command.result' },
      });
      expect(audit.outcome).toBe('failure');
    });
  });

  // -------------------------------------------------------------------------
  // Authorisation
  // -------------------------------------------------------------------------

  describe('authorisation', () => {
    /** A member of the Space holding exactly `permissions`. */
    async function memberWith(spaceId: string, ownerToken: string, permissions: string[]) {
      const member = await signIn('member@example.com');

      const pass = await request(http)
        .post(`/api/spaces/${spaceId}/data/passes`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          kind: 'custom',
          permissions,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      await request(http)
        .post('/api/passes/claim')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ token: pass.body.claimToken })
        .expect(201);

      return member;
    }

    it('gives an invited member no power permissions by default', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const member = await memberWith(spaceId, owner.token, ['devices.view']);

      for (const action of [
        'power.wake',
        'power.restart',
        'power.shutdown',
        'power.lock',
        'power.sleep',
      ]) {
        await request(http)
          .post(`/api/spaces/${spaceId}/power/commands`)
          .set('Authorization', `Bearer ${member.token}`)
          .send({ action, targetAgentId: agents[0]!.agentId })
          .expect(403);
      }
    });

    it('allows exactly the action a member was granted, and no other', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const member = await memberWith(spaceId, owner.token, ['devices.view', 'power.lock']);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ action: 'power.sleep', targetAgentId: agents[0]!.agentId })
        .expect(403);
    });

    it('refuses a Data-Only member every power action', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const member = await memberWith(spaceId, owner.token, ['data.use']);

      const response = await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(403);

      expect(response.body.message).toMatch(/permission/i);
    });

    it('refuses a computer in another Space', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      const other = await signIn('other@example.com');
      const otherSpaces = await request(http)
        .get('/api/spaces')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      await request(http)
        .post(`/api/spaces/${otherSpaces.body[0].id}/power/commands`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(404);

      void spaceId;
      void owner;
    });

    it('rejects an unknown action outright', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      // There is no verb here that runs a program, and the schema is what
      // guarantees a new one cannot arrive over the wire.
      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.exec', targetAgentId: agents[0]!.agentId })
        .expect(400);
    });

    it('lets only the owner designate a Wake Helper or register a MAC', async () => {
      const { owner, spaceId, agents } = await withAgents(1);
      const member = await memberWith(spaceId, owner.token, ['devices.view', 'power.wake']);

      await request(http)
        .put(`/api/spaces/${spaceId}/power/agents/${agents[0]!.agentId}/wake-helper`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ isWakeHelper: true })
        .expect(403);

      await request(http)
        .put(`/api/spaces/${spaceId}/power/agents/${agents[0]!.agentId}/mac`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ macAddress: '00:1A:2B:3C:4D:5E' })
        .expect(403);
    });

    it('rejects a malformed MAC address', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .put(`/api/spaces/${spaceId}/power/agents/${agents[0]!.agentId}/mac`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ macAddress: 'not-a-mac' })
        .expect(400);
    });

    it('records every request in the audit trail', async () => {
      const { owner, spaceId, agents } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: agents[0]!.agentId })
        .expect(201);

      const audit = await harness.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'power.command.requested' },
      });
      expect(audit.outcome).toBe('success');
      expect((audit.metadata as { powerAction: string }).powerAction).toBe('power.lock');
    });

    it('refuses an unsigned collect', async () => {
      await request(http).post('/api/agent/power/collect').send({}).expect(401);
    });

    it('404s on a computer that does not exist', async () => {
      const { owner, spaceId } = await withAgents(1);

      await request(http)
        .post(`/api/spaces/${spaceId}/power/commands`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ action: 'power.lock', targetAgentId: randomUUID() })
        .expect(404);
    });
  });
});
