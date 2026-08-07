import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AGENT_HEARTBEAT_INTERVAL_SECONDS,
  AGENT_OFFLINE_AFTER_SECONDS,
  ENROLLMENT_TOKEN_TTL_SECONDS,
  statusFromHeartbeat,
  type AgentEnrollRequest,
  type AgentEnrollResponse,
  type AgentHeartbeatRequest,
  type AgentHeartbeatResponse,
  type AgentResourceReport,
  type AgentSummary,
  type ResourceSummary,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokenService } from '../crypto/token.service';
import { SpacesService } from '../spaces/spaces.service';
import { LiveGateway } from '../live/live.gateway';
import type { RequestContext } from '../common/request-context';
import type { AgentPrincipal } from './agent-signature.guard';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly spaces: SpacesService,
    private readonly live: LiveGateway,
  ) {}

  // -------------------------------------------------------------------------
  // Enrollment
  // -------------------------------------------------------------------------

  /**
   * Mints a short-lived token the desktop app hands to the local agent.
   *
   * This is what keeps the owner's password out of the background service: the
   * window is already authenticated, so it vouches for the agent once, briefly,
   * and the agent proves everything after that with its own key.
   */
  async createEnrollmentToken(
    userId: string,
    spaceId: string,
    context: RequestContext,
  ): Promise<{ token: string; expiresAt: string; spaceId: string }> {
    await this.spaces.requireOwner(userId, spaceId, context);

    const token = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_SECONDS * 1000);

    await this.prisma.agentEnrollmentToken.create({
      data: { spaceId, userId, tokenHash: this.tokens.hashSecret(token), expiresAt },
    });

    return { token, expiresAt: expiresAt.toISOString(), spaceId };
  }

  /**
   * Enrolls an agent installation into a Space.
   *
   * The request is already proven to come from a device holding the matching
   * private key (the signature guard did that). The enrollment token proves the
   * owner authorised *this* installation to join *this* Space.
   */
  async enroll(input: AgentEnrollRequest, context: RequestContext): Promise<AgentEnrollResponse> {
    const tokenHash = this.tokens.hashSecret(input.enrollmentToken);
    const enrollment = await this.prisma.agentEnrollmentToken.findUnique({
      where: { tokenHash },
      include: { space: true },
    });

    if (!enrollment || enrollment.usedAt || enrollment.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'This enrollment link is no longer valid. Start again from the NetLink window.',
      );
    }

    // Single use, claimed by a conditional update so two agents racing on the
    // same token cannot both enroll.
    const claimed = await this.prisma.agentEnrollmentToken.updateMany({
      where: { id: enrollment.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('This enrollment link has already been used.');
    }

    const device = await this.upsertAgentDevice(enrollment.userId, input, context);

    const agent = await this.prisma.agent.upsert({
      where: { deviceId: device.id },
      create: {
        spaceId: enrollment.spaceId,
        deviceId: device.id,
        status: 'online',
        lastHeartbeatAt: new Date(),
      },
      update: {
        spaceId: enrollment.spaceId,
        status: 'online',
        lastHeartbeatAt: new Date(),
      },
    });

    await this.audit.record({
      action: 'device.registered',
      outcome: 'success',
      actorUserId: enrollment.userId,
      actorDeviceId: device.id,
      spaceId: enrollment.spaceId,
      context,
      metadata: { kind: 'agent', name: input.name },
    });

    this.live.publishToSpace(enrollment.spaceId, {
      type: 'agent.status',
      spaceId: enrollment.spaceId,
      agentId: agent.id,
      status: 'online',
      at: new Date().toISOString(),
    });

    return {
      deviceId: device.id,
      spaceId: enrollment.spaceId,
      spaceName: enrollment.space.name,
      heartbeatIntervalSeconds: AGENT_HEARTBEAT_INTERVAL_SECONDS,
    };
  }

  /**
   * The agent's Device row.
   *
   * An agent is a device like any other — it is listed, renamed and revoked
   * alongside the owner's laptops. It is created already trusted because the
   * owner authorised it explicitly through the enrollment token, which is a
   * stronger signal than an emailed code.
   */
  private async upsertAgentDevice(
    userId: string,
    input: AgentEnrollRequest,
    context: RequestContext,
  ) {
    const existing = await this.prisma.device.findUnique({
      where: { userId_installationId: { userId, installationId: input.installationId } },
    });

    if (existing) {
      if (existing.publicKey !== input.publicKey) {
        throw new BadRequestException(
          'This installation no longer matches its registered device identity.',
        );
      }
      if (existing.revokedAt) {
        throw new BadRequestException(
          'This device was removed from your account. Reinstall NetLink to enroll it again.',
        );
      }
      return this.prisma.device.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          osVersion: input.osVersion ?? existing.osVersion,
          appVersion: input.appVersion ?? existing.appVersion,
          lastSeenAt: new Date(),
          lastIpAddress: context.ipAddress,
        },
      });
    }

    const keyOwner = await this.prisma.device.findUnique({ where: { publicKey: input.publicKey } });
    if (keyOwner) {
      throw new BadRequestException('This device identity is already registered.');
    }

    return this.prisma.device.create({
      data: {
        userId,
        installationId: input.installationId,
        name: input.name,
        platform: input.platform as never,
        kind: 'agent',
        osVersion: input.osVersion ?? null,
        appVersion: input.appVersion ?? null,
        publicKey: input.publicKey,
        trusted: true,
        trustedAt: new Date(),
        lastSeenAt: new Date(),
        lastIpAddress: context.ipAddress,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  async heartbeat(
    principal: AgentPrincipal,
    input: AgentHeartbeatRequest,
  ): Promise<AgentHeartbeatResponse> {
    // The signature already proved which device is calling, so the deviceId in
    // the body is only accepted when it agrees with it.
    if (input.deviceId !== principal.deviceId) {
      throw new BadRequestException('This heartbeat does not match the signing device.');
    }

    const agent = await this.prisma.agent.findUnique({
      where: { deviceId: principal.deviceId },
      include: { device: { select: { revokedAt: true } } },
    });

    if (!agent) {
      return {
        acknowledged: false,
        revoked: false,
        message: 'This installation is not enrolled in a Space yet.',
        heartbeatIntervalSeconds: AGENT_HEARTBEAT_INTERVAL_SECONDS,
        pendingCommands: [],
      };
    }

    if (agent.device.revokedAt) {
      return {
        acknowledged: false,
        revoked: true,
        message: 'This device was revoked by its owner.',
        heartbeatIntervalSeconds: AGENT_HEARTBEAT_INTERVAL_SECONDS,
        pendingCommands: [],
      };
    }

    const wasOffline = agent.status !== 'online';
    const now = new Date();

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: input.status === 'online' ? 'online' : 'unreachable',
        lastHeartbeatAt: now,
        localIpAddress: input.localIpAddress ?? agent.localIpAddress,
        macAddress: input.macAddress ?? agent.macAddress,
        wakeOnLanReady: input.wakeOnLanReady,
        isWakeHelper: input.isWakeHelper,
      },
    });

    await this.prisma.device.update({
      where: { id: principal.deviceId },
      data: { lastSeenAt: now, appVersion: input.appVersion ?? undefined },
    });

    // Only a transition is pushed and audited. A heartbeat every 30 seconds
    // that changes nothing is noise in both the audit log and the UI.
    if (wasOffline) {
      this.live.publishToSpace(agent.spaceId, {
        type: 'agent.status',
        spaceId: agent.spaceId,
        agentId: agent.id,
        status: 'online',
        at: now.toISOString(),
      });
      await this.audit.record({
        action: 'device.heartbeat',
        outcome: 'success',
        actorUserId: principal.userId,
        actorDeviceId: principal.deviceId,
        spaceId: agent.spaceId,
        metadata: { transition: 'offline_to_online' },
      });
    }

    return {
      acknowledged: true,
      revoked: false,
      heartbeatIntervalSeconds: AGENT_HEARTBEAT_INTERVAL_SECONDS,
      pendingCommands: [],
    };
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  /**
   * Records what an agent can offer.
   *
   * Reporting a resource does not share it. Everything arrives disabled unless
   * the owner had already enabled that exact target, so an agent cannot expose
   * a folder or printer by announcing it.
   */
  async reportResources(
    principal: AgentPrincipal,
    input: AgentResourceReport,
  ): Promise<{ accepted: number }> {
    if (input.deviceId !== principal.deviceId) {
      throw new BadRequestException('This report does not match the signing device.');
    }

    const agent = await this.prisma.agent.findUnique({ where: { deviceId: principal.deviceId } });
    if (!agent) throw new NotFoundException('This installation is not enrolled in a Space.');

    for (const resource of input.resources) {
      await this.prisma.resource.upsert({
        where: {
          agentId_kind_target: {
            agentId: agent.id,
            kind: resource.kind as never,
            target: resource.target,
          },
        },
        create: {
          spaceId: agent.spaceId,
          agentId: agent.id,
          kind: resource.kind as never,
          name: resource.name,
          target: resource.target,
          // Deny by default: discovering a printer is not the same as sharing it.
          enabled: false,
          metadata: resource.metadata ?? undefined,
        },
        update: {
          name: resource.name,
          metadata: resource.metadata ?? undefined,
        },
      });
    }

    this.live.publishToSpace(agent.spaceId, {
      type: 'resources.updated',
      spaceId: agent.spaceId,
      agentId: agent.id,
    });

    return { accepted: input.resources.length };
  }

  // -------------------------------------------------------------------------
  // Owner-facing reads
  // -------------------------------------------------------------------------

  async listAgents(userId: string, spaceId: string): Promise<AgentSummary[]> {
    const grant = await this.spaces.requirePermission(userId, spaceId, 'devices.view');
    const isOwner = grant.role === 'owner';

    const agents = await this.prisma.agent.findMany({
      where: { spaceId },
      include: { device: { select: { name: true, appVersion: true, revokedAt: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const now = new Date();
    return agents
      .filter((agent) => !agent.device.revokedAt)
      .map((agent) => ({
        id: agent.id,
        spaceId: agent.spaceId,
        deviceId: agent.deviceId,
        name: agent.device.name,
        // Computed from the heartbeat rather than read from the column, so an
        // agent that died without saying goodbye still shows as offline.
        status: statusFromHeartbeat(agent.lastHeartbeatAt, now),
        lastHeartbeatAt: agent.lastHeartbeatAt ? agent.lastHeartbeatAt.toISOString() : null,
        isWakeHelper: agent.isWakeHelper,
        wakeOnLanReady: agent.wakeOnLanReady,
        // A member has no use for the local network address of someone else's
        // computer, so only the owner sees it.
        localIpAddress: isOwner ? agent.localIpAddress : null,
        macAddress: isOwner ? agent.macAddress : null,
        appVersion: agent.device.appVersion,
        createdAt: agent.createdAt.toISOString(),
      }));
  }

  async listResources(
    userId: string,
    spaceId: string,
    kind?: 'folder' | 'printer',
  ): Promise<ResourceSummary[]> {
    await this.spaces.requirePermission(userId, spaceId, 'devices.view');

    const resources = await this.prisma.resource.findMany({
      where: { spaceId, ...(kind ? { kind } : {}) },
      include: { agent: { include: { device: { select: { name: true } } } } },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });

    return resources.map((resource) => ({
      id: resource.id,
      spaceId: resource.spaceId,
      agentId: resource.agentId,
      agentName: resource.agent.device.name,
      kind: resource.kind,
      name: resource.name,
      target: resource.target,
      enabled: resource.enabled,
      metadata: (resource.metadata as ResourceSummary['metadata']) ?? null,
      createdAt: resource.createdAt.toISOString(),
    }));
  }

  /** Turning a resource on is the moment it becomes shared, so only an owner may. */
  async setResourceEnabled(
    userId: string,
    spaceId: string,
    resourceId: string,
    enabled: boolean,
    context: RequestContext,
  ): Promise<ResourceSummary> {
    await this.spaces.requireOwner(userId, spaceId, context);

    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: { agent: { include: { device: { select: { name: true } } } } },
    });
    if (!resource || resource.spaceId !== spaceId) {
      throw new NotFoundException('That resource was not found.');
    }

    const updated = await this.prisma.resource.update({
      where: { id: resourceId },
      data: { enabled },
      include: { agent: { include: { device: { select: { name: true } } } } },
    });

    await this.audit.record({
      action: enabled ? 'resource.enabled' : 'resource.disabled',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: { kind: resource.kind, name: resource.name },
    });

    this.live.publishToSpace(spaceId, {
      type: 'resources.updated',
      spaceId,
      agentId: resource.agentId,
    });

    return {
      id: updated.id,
      spaceId: updated.spaceId,
      agentId: updated.agentId,
      agentName: updated.agent.device.name,
      kind: updated.kind,
      name: updated.name,
      target: updated.target,
      enabled: updated.enabled,
      metadata: (updated.metadata as ResourceSummary['metadata']) ?? null,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Marks agents offline once their heartbeats stop.
   *
   * `listAgents` already computes status from the heartbeat timestamp, so this
   * exists to make the stored column agree — which matters for the counts on
   * the Spaces list and for anything that queries by status.
   */
  async reapStaleAgents(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - AGENT_OFFLINE_AFTER_SECONDS * 1000);
    const result = await this.prisma.agent.updateMany({
      where: {
        status: { not: 'offline' },
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
      },
      data: { status: 'offline' },
    });
    return result.count;
  }
}
