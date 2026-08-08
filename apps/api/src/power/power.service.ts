import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  POWER_ACTION_PERMISSIONS,
  POWER_COMMAND_TTL_SECONDS,
  POWER_COUNTDOWN_SECONDS,
  isDestructivePowerAction,
  requiresTargetOnline,
  statusFromHeartbeat,
  type AgentPowerState,
  type Permission,
  type PowerAction,
  type PowerCommandRequest,
  type PowerCommandSummary,
  type PowerResult,
  type WakeReadiness,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SpacesService } from '../spaces/spaces.service';
import { LiveGateway } from '../live/live.gateway';
import { ChallengeService } from '../auth/challenge.service';
import type { RequestContext } from '../common/request-context';
import type { AgentPrincipal } from '../agents/agent-signature.guard';
import { CommandSigner, type SignedCommand } from './command-signer';

@Injectable()
export class PowerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
    private readonly live: LiveGateway,
    private readonly signer: CommandSigner,
    private readonly challenges: ChallengeService,
  ) {}

  // -------------------------------------------------------------------------
  // What the UI needs before it offers a button
  // -------------------------------------------------------------------------

  /**
   * The power state of every computer in a Space.
   *
   * Each action reports whether it can be attempted *and why not*, so the UI
   * can disable a button with a real explanation instead of hiding it or
   * letting the user find out by being refused.
   */
  async spacePowerState(userId: string, spaceId: string): Promise<AgentPowerState[]> {
    const grant = await this.spaces.requirePermission(userId, spaceId, 'devices.view');

    const agents = await this.prisma.agent.findMany({
      where: { spaceId },
      include: { device: { select: { name: true, revokedAt: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const now = new Date();
    const live = agents.filter((agent) => !agent.device.revokedAt);
    const onlineHelpers = live.filter(
      (agent) => agent.isWakeHelper && statusFromHeartbeat(agent.lastHeartbeatAt, now) === 'online',
    );

    const states: AgentPowerState[] = [];

    for (const agent of live) {
      const online = statusFromHeartbeat(agent.lastHeartbeatAt, now) === 'online';

      // A helper on the same local network. Comparing the /24 is a heuristic,
      // not proof — but a magic packet is a broadcast, so "same subnet" is
      // genuinely the condition, and claiming certainty we do not have would be
      // worse than showing the owner what we checked.
      const helper = onlineHelpers.find(
        (candidate) =>
          candidate.id !== agent.id &&
          sameLocalNetwork(candidate.localIpAddress, agent.localIpAddress),
      );

      const wake = this.wakeReadiness(agent, helper ?? null);

      const pending = await this.pendingCommand(agent.id);

      states.push({
        agentId: agent.id,
        agentName: agent.device.name,
        online,
        isWakeHelper: agent.isWakeHelper,
        actions: (Object.keys(POWER_ACTION_PERMISSIONS) as PowerAction[]).map((action) => {
          const permission = POWER_ACTION_PERMISSIONS[action] as Permission;
          const held = grant.permissions.includes(permission);

          let reason: string | null = null;
          if (!held) reason = 'You do not have permission for this action';
          else if (requiresTargetOnline(action) && !online) reason = 'This computer is not online';
          else if (action === 'power.wake' && online) reason = 'This computer is already on';
          else if (action === 'power.wake' && !wake.ready)
            reason = wake.blockers[0] ?? 'Not ready to wake';
          else if (action === 'power.cancel' && !pending) reason = 'Nothing is pending';

          return {
            action,
            allowed: reason === null,
            requiresStepUp: isDestructivePowerAction(action),
            reason,
          };
        }),
        wake,
        pending,
      });
    }

    return states;
  }

  private wakeReadiness(
    agent: {
      wakeOnLanReady: boolean;
      macAddress: string | null;
      localIpAddress: string | null;
    },
    helper: { id: string; device: { name: string } } | null,
  ): WakeReadiness {
    const wakeOnLanEnabled = agent.wakeOnLanReady;
    const networkAdapterFound = Boolean(agent.macAddress);
    const wakeCapableLink = Boolean(agent.macAddress);
    const targetMacRegistered = Boolean(agent.macAddress);
    const wakeHelperOnline = helper !== null;

    const blockers: string[] = [];
    if (!wakeOnLanEnabled) {
      blockers.push('Wake-on-LAN is turned off in the BIOS or network adapter settings');
    }
    if (!networkAdapterFound) blockers.push('No wake-capable network adapter was found');
    if (!wakeCapableLink) {
      blockers.push('This computer is not on Ethernet or a supported wake-capable connection');
    }
    if (!targetMacRegistered) {
      blockers.push("This computer's network address has not been registered yet");
    }
    if (!wakeHelperOnline) {
      blockers.push('No Wake Helper is online on the same local network');
    }

    return {
      wakeOnLanEnabled,
      networkAdapterFound,
      // Undetectable on most desktops. Shown, never a blocker — treating
      // "unknown" as "not ready" would disable wake on hardware where it works.
      powerConnected: null,
      wakeHelperOnline,
      wakeCapableLink,
      targetMacRegistered,
      ready:
        wakeOnLanEnabled &&
        networkAdapterFound &&
        wakeCapableLink &&
        targetMacRegistered &&
        wakeHelperOnline,
      blockers,
      helperAgentId: helper?.id ?? null,
      helperAgentName: helper?.device.name ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  /**
   * Sends a fresh six-digit code before a restart or shutdown.
   *
   * Holding the permission is not enough for an action that will interrupt
   * whoever is at the machine — this proves the person asking still controls
   * the account's mailbox right now.
   */
  async requestStepUp(
    userId: string,
    spaceId: string,
    action: PowerAction,
    exposeDevCode: boolean,
  ) {
    await this.spaces.requirePermission(
      userId,
      spaceId,
      POWER_ACTION_PERMISSIONS[action] as Permission,
    );

    if (!isDestructivePowerAction(action)) {
      throw new BadRequestException('That action does not require confirmation.');
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const issued = await this.challenges.issue({
      userId,
      userEmail: user.email,
      userName: user.name,
      purpose: 'step_up',
      exposeDevCode,
    });
    return issued.response;
  }

  // -------------------------------------------------------------------------
  // Issuing a command
  // -------------------------------------------------------------------------

  async requestCommand(
    userId: string,
    deviceId: string,
    spaceId: string,
    input: PowerCommandRequest,
    context: RequestContext,
  ): Promise<PowerCommandSummary> {
    const permission = POWER_ACTION_PERMISSIONS[input.action] as Permission;
    await this.spaces.requirePermission(userId, spaceId, permission, context);

    const agent = await this.prisma.agent.findUnique({
      where: { id: input.targetAgentId },
      include: { device: { select: { name: true, revokedAt: true } } },
    });
    if (!agent || agent.spaceId !== spaceId || agent.device.revokedAt) {
      throw new NotFoundException('That computer was not found in this Space.');
    }

    if (input.action === 'power.cancel') {
      return this.cancelPending(userId, spaceId, agent.id, context);
    }

    // Step-up before anything else is written down, so a failed confirmation
    // leaves no trace of a command that was never authorised.
    if (isDestructivePowerAction(input.action)) {
      await this.verifyStepUp(userId, spaceId, input, context);
    }

    const online = statusFromHeartbeat(agent.lastHeartbeatAt) === 'online';

    if (requiresTargetOnline(input.action) && !online) {
      throw new ConflictException('That computer is not online. Turn it on first, then try again.');
    }

    let helperId: string | null = null;

    if (input.action === 'power.wake') {
      if (online) throw new ConflictException('That computer is already on.');

      const helpers = await this.prisma.agent.findMany({
        where: { spaceId, isWakeHelper: true, NOT: { id: agent.id } },
        include: { device: { select: { name: true, revokedAt: true } } },
      });
      const helper = helpers.find(
        (candidate) =>
          !candidate.device.revokedAt &&
          statusFromHeartbeat(candidate.lastHeartbeatAt) === 'online' &&
          sameLocalNetwork(candidate.localIpAddress, agent.localIpAddress),
      );

      const readiness = this.wakeReadiness(agent, helper ?? null);
      if (!readiness.ready) {
        // The UI already showed these; repeating the first one here means the
        // API refuses for a reason the person can act on.
        throw new ConflictException(readiness.blockers[0] ?? 'This computer cannot be woken yet.');
      }
      helperId = helper?.id ?? null;
    }

    // One outstanding command per machine. Queueing a second restart behind the
    // first is never what someone means by clicking twice.
    const existing = await this.pendingCommand(agent.id);
    if (existing) {
      throw new ConflictException(
        `A ${existing.action.replace('power.', '')} is already pending on that computer.`,
      );
    }

    const now = new Date();
    const countdown = isDestructivePowerAction(input.action);

    const command = await this.prisma.powerCommand.create({
      data: {
        spaceId,
        targetAgentId: agent.id,
        helperAgentId: helperId,
        action: input.action,
        // A destructive command sits in countdown, visible and cancellable,
        // before it is collectable at all.
        state: countdown ? 'countdown' : 'pending',
        requestedById: userId,
        requestedByDeviceId: deviceId,
        nonce: randomBytes(18).toString('base64url'),
        expiresAt: new Date(
          now.getTime() +
            (POWER_COMMAND_TTL_SECONDS + (countdown ? POWER_COUNTDOWN_SECONDS : 0)) * 1000,
        ),
        executeAt: countdown ? new Date(now.getTime() + POWER_COUNTDOWN_SECONDS * 1000) : now,
      },
      include: {
        targetAgent: { include: { device: { select: { name: true } } } },
        helperAgent: { include: { device: { select: { name: true } } } },
      },
    });

    await this.audit.record({
      action: 'power.command.requested',
      outcome: 'success',
      actorUserId: userId,
      actorDeviceId: deviceId,
      targetDeviceId: agent.deviceId,
      spaceId,
      context,
      metadata: {
        powerAction: input.action,
        helper: helperId ?? 'none',
        countdownSeconds: countdown ? POWER_COUNTDOWN_SECONDS : 0,
      },
    });

    return toSummary(command);
  }

  private async verifyStepUp(
    userId: string,
    spaceId: string,
    input: PowerCommandRequest,
    context: RequestContext,
  ): Promise<void> {
    if (!input.stepUpChallengeId || !input.stepUpCode) {
      throw new ForbiddenException(
        'Confirm this action with the six-digit code we sent to your email.',
      );
    }

    const result = await this.challenges.consume({
      challengeId: input.stepUpChallengeId,
      code: input.stepUpCode,
      purpose: 'step_up',
    });

    if (!result.ok || result.challenge.userId !== userId) {
      await this.audit.record({
        action: 'power.command.requested',
        outcome: 'denied',
        actorUserId: userId,
        spaceId,
        context,
        metadata: { powerAction: input.action, reason: 'step_up_failed' },
      });
      throw new ForbiddenException('That confirmation code is not correct.');
    }
  }

  /** Calls off a command that is still in its countdown. */
  private async cancelPending(
    userId: string,
    spaceId: string,
    agentId: string,
    context: RequestContext,
  ): Promise<PowerCommandSummary> {
    const pending = await this.prisma.powerCommand.findFirst({
      where: { targetAgentId: agentId, state: { in: ['countdown', 'pending', 'sent'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        targetAgent: { include: { device: { select: { name: true } } } },
        helperAgent: { include: { device: { select: { name: true } } } },
      },
    });

    if (!pending) throw new NotFoundException('Nothing is pending on that computer.');

    // A command already collected by the agent cannot be recalled — the agent
    // is acting on it. Saying so is better than a cancel that silently fails.
    if (pending.state === 'sent') {
      throw new ConflictException(
        'That command has already reached the computer and cannot be called back.',
      );
    }

    const cancelled = await this.prisma.powerCommand.update({
      where: { id: pending.id },
      data: { state: 'cancelled', cancelledAt: new Date(), detail: 'Cancelled before it was sent' },
      include: {
        targetAgent: { include: { device: { select: { name: true } } } },
        helperAgent: { include: { device: { select: { name: true } } } },
      },
    });

    await this.audit.record({
      action: 'power.command.result',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: { powerAction: pending.action, result: 'cancelled' },
    });

    return toSummary(cancelled);
  }

  // -------------------------------------------------------------------------
  // Delivery to agents
  // -------------------------------------------------------------------------

  /**
   * Signed commands waiting for this agent.
   *
   * A command in countdown is not handed over until its `executeAt` passes,
   * which is what makes the ten seconds real rather than cosmetic — the agent
   * genuinely cannot act early because it has not been given anything yet.
   *
   * A wake is delivered to the *helper*, not the target: the target is off.
   */
  async collectFor(principal: AgentPrincipal): Promise<SignedCommand[]> {
    const agent = await this.prisma.agent.findUnique({ where: { deviceId: principal.deviceId } });
    if (!agent) return [];

    const now = new Date();

    await this.prisma.powerCommand.updateMany({
      where: { expiresAt: { lt: now }, state: { in: ['pending', 'countdown', 'sent'] } },
      data: { state: 'expired', detail: 'Expired before it was carried out' },
    });

    const due = await this.prisma.powerCommand.findMany({
      where: {
        state: { in: ['pending', 'countdown'] },
        expiresAt: { gt: now },
        OR: [
          // Wakes go to the helper; everything else to the target itself.
          { helperAgentId: agent.id },
          { targetAgentId: agent.id, helperAgentId: null },
        ],
        AND: [{ OR: [{ executeAt: null }, { executeAt: { lte: now } }] }],
      },
      include: { targetAgent: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    const signed: SignedCommand[] = [];

    for (const command of due) {
      // Claim it before signing, so two polls cannot both collect the same
      // command and the agent cannot be handed a duplicate to replay-guard.
      const claimed = await this.prisma.powerCommand.updateMany({
        where: { id: command.id, state: { in: ['pending', 'countdown'] } },
        data: { state: 'sent', deliveredAt: now },
      });
      if (claimed.count === 0) continue;

      signed.push(
        this.signer.sign({
          id: command.id,
          action: command.action,
          // Addressed to the machine that must act. For a wake that is the
          // helper, which is why the helper's device id goes here.
          deviceId: principal.deviceId,
          spaceId: command.spaceId,
          issuedAt: command.issuedAt.toISOString(),
          expiresAt: command.expiresAt.toISOString(),
          nonce: command.nonce,
          requestedBy: command.requestedById,
        }),
      );
    }

    return signed;
  }

  /** Records what the agent actually managed to do. */
  async recordResult(principal: AgentPrincipal, input: PowerResult): Promise<{ recorded: true }> {
    if (input.deviceId !== principal.deviceId) {
      throw new BadRequestException('This result does not match the signing device.');
    }

    const command = await this.prisma.powerCommand.findUnique({
      where: { id: input.commandId },
      include: { targetAgent: true },
    });
    if (!command) throw new NotFoundException('That command was not found.');

    const agent = await this.prisma.agent.findUnique({ where: { deviceId: principal.deviceId } });
    if (!agent || (command.targetAgentId !== agent.id && command.helperAgentId !== agent.id)) {
      throw new ForbiddenException('That command was not addressed to this computer.');
    }

    await this.prisma.powerCommand.update({
      where: { id: command.id },
      data: {
        state: input.succeeded ? 'succeeded' : 'failed',
        acknowledgedAt: new Date(),
        completedAt: new Date(),
        detail: input.detail ?? null,
      },
    });

    await this.audit.record({
      action: 'power.command.result',
      outcome: input.succeeded ? 'success' : 'failure',
      actorUserId: command.requestedById,
      targetDeviceId: command.targetAgent.deviceId,
      spaceId: command.spaceId,
      metadata: {
        powerAction: command.action,
        succeeded: input.succeeded,
        detail: input.detail?.slice(0, 200) ?? null,
      },
    });

    this.live.publishToSpace(command.spaceId, {
      type: 'power.result',
      spaceId: command.spaceId,
      agentId: command.targetAgentId,
      commandId: command.id,
      succeeded: input.succeeded,
    });

    return { recorded: true };
  }

  // -------------------------------------------------------------------------
  // Owner settings
  // -------------------------------------------------------------------------

  async setWakeHelper(
    userId: string,
    spaceId: string,
    agentId: string,
    isWakeHelper: boolean,
    context: RequestContext,
  ): Promise<{ agentId: string; isWakeHelper: boolean }> {
    await this.spaces.requireOwner(userId, spaceId, context);

    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.spaceId !== spaceId) {
      throw new NotFoundException('That computer was not found in this Space.');
    }

    await this.prisma.agent.update({ where: { id: agentId }, data: { isWakeHelper } });
    return { agentId, isWakeHelper };
  }

  /**
   * Registers the MAC address a wake will target.
   *
   * The owner sets this explicitly rather than NetLink trusting whatever an
   * agent last reported — the address is what a magic packet is aimed at, and
   * it should not be changeable by the machine being woken.
   */
  async registerMac(
    userId: string,
    spaceId: string,
    agentId: string,
    macAddress: string,
    context: RequestContext,
  ): Promise<{ agentId: string; macAddress: string }> {
    await this.spaces.requireOwner(userId, spaceId, context);

    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.spaceId !== spaceId) {
      throw new NotFoundException('That computer was not found in this Space.');
    }

    const normalised = macAddress.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const formatted = (normalised.match(/.{2}/g) ?? []).join(':');

    await this.prisma.agent.update({
      where: { id: agentId },
      data: { macAddress: formatted, wakeOnLanReady: true },
    });

    return { agentId, macAddress: formatted };
  }

  async history(userId: string, spaceId: string, limit = 25): Promise<PowerCommandSummary[]> {
    await this.spaces.requirePermission(userId, spaceId, 'devices.view');

    const commands = await this.prisma.powerCommand.findMany({
      where: { spaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: {
        targetAgent: { include: { device: { select: { name: true } } } },
        helperAgent: { include: { device: { select: { name: true } } } },
      },
    });
    return commands.map(toSummary);
  }

  private async pendingCommand(agentId: string): Promise<PowerCommandSummary | null> {
    const now = new Date();
    const pending = await this.prisma.powerCommand.findFirst({
      where: {
        targetAgentId: agentId,
        state: { in: ['pending', 'countdown', 'sent'] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        targetAgent: { include: { device: { select: { name: true } } } },
        helperAgent: { include: { device: { select: { name: true } } } },
      },
    });
    return pending ? toSummary(pending) : null;
  }
}

type CommandRow = {
  id: string;
  spaceId: string;
  action: string;
  state: string;
  targetAgentId: string;
  targetAgent: { device: { name: string } };
  helperAgentId: string | null;
  helperAgent: { device: { name: string } } | null;
  createdAt: Date;
  executeAt: Date | null;
  expiresAt: Date;
  detail: string | null;
};

function toSummary(command: CommandRow): PowerCommandSummary {
  return {
    id: command.id,
    spaceId: command.spaceId,
    action: command.action as PowerAction,
    state: command.state as PowerCommandSummary['state'],
    targetAgentId: command.targetAgentId,
    targetAgentName: command.targetAgent.device.name,
    helperAgentId: command.helperAgentId,
    helperAgentName: command.helperAgent?.device.name ?? null,
    requestedAt: command.createdAt.toISOString(),
    executeAt: command.executeAt ? command.executeAt.toISOString() : null,
    expiresAt: command.expiresAt.toISOString(),
    detail: command.detail,
    // Only before the agent has been handed it. Afterwards the machine is
    // already acting, and pretending otherwise would be a lie.
    cancellable: command.state === 'countdown' || command.state === 'pending',
  };
}

/**
 * Whether two addresses look like the same local network.
 *
 * A magic packet is a subnet broadcast, so this really is the condition — but
 * a /24 comparison is a heuristic, not proof, which is why the readiness panel
 * shows the owner what was checked rather than asserting certainty.
 */
export function sameLocalNetwork(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = a.split('.');
  const right = b.split('.');
  if (left.length !== 4 || right.length !== 4) return false;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}
