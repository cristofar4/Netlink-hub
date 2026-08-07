import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_TRUSTED_DEVICE_PERMISSIONS,
  OWNER_PERMISSIONS,
  evaluatePermission,
  type Permission,
  type PrincipalGrant,
  type SpaceSummary,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../common/request-context';

/**
 * Spaces, and the single place membership is resolved into a capability grant.
 *
 * Every module that needs to know "may this person do this here?" goes through
 * `requirePermission`, so the answer is computed one way rather than
 * re-derived, slightly differently, in each feature.
 */
@Injectable()
export class SpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The Space a new account starts with.
   *
   * Created on first use rather than at registration, so an account that never
   * signs in does not leave an orphan behind.
   */
  async ensureDefaultSpace(userId: string, context?: RequestContext): Promise<string> {
    const existing = await this.prisma.space.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (existing) return existing.id;

    const space = await this.prisma.space.create({
      data: {
        ownerId: userId,
        name: 'My Home',
        members: {
          create: {
            userId,
            role: 'owner',
            permissions: [...OWNER_PERMISSIONS],
          },
        },
      },
    });

    await this.audit.record({
      action: 'space.created',
      outcome: 'success',
      actorUserId: userId,
      spaceId: space.id,
      context,
      metadata: { name: space.name },
    });

    return space.id;
  }

  async listForUser(userId: string): Promise<SpaceSummary[]> {
    const memberships = await this.prisma.spaceMember.findMany({
      where: { userId },
      include: {
        space: {
          include: {
            agents: { select: { id: true, status: true } },
            _count: { select: { members: true, resources: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map(({ space }) => ({
      id: space.id,
      name: space.name,
      ownerId: space.ownerId,
      createdAt: space.createdAt.toISOString(),
      isOwner: space.ownerId === userId,
      agentCount: space.agents.length,
      onlineAgentCount: space.agents.filter((agent) => agent.status === 'online').length,
      memberCount: space._count.members,
      resourceCount: space._count.resources,
    }));
  }

  async create(userId: string, name: string, context: RequestContext): Promise<SpaceSummary> {
    const space = await this.prisma.space.create({
      data: {
        ownerId: userId,
        name,
        members: {
          create: { userId, role: 'owner', permissions: [...OWNER_PERMISSIONS] },
        },
      },
    });

    await this.audit.record({
      action: 'space.created',
      outcome: 'success',
      actorUserId: userId,
      spaceId: space.id,
      context,
      metadata: { name },
    });

    return {
      id: space.id,
      name: space.name,
      ownerId: space.ownerId,
      createdAt: space.createdAt.toISOString(),
      isOwner: true,
      agentCount: 0,
      onlineAgentCount: 0,
      memberCount: 1,
      resourceCount: 0,
    };
  }

  async rename(
    userId: string,
    spaceId: string,
    name: string,
    context: RequestContext,
  ): Promise<{ id: string; name: string }> {
    await this.requirePermission(userId, spaceId, 'members.manage', context);
    const space = await this.prisma.space.update({ where: { id: spaceId }, data: { name } });
    return { id: space.id, name: space.name };
  }

  /**
   * Resolves a person's grant inside a Space.
   *
   * Returns null when they are not a member at all — which callers must treat
   * as "not found" rather than "forbidden", so the API does not confirm that a
   * Space exists to someone with no business knowing.
   */
  async grantFor(userId: string, spaceId: string): Promise<PrincipalGrant | null> {
    const membership = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
    });
    if (!membership) return null;

    return {
      role: membership.role,
      permissions: membership.permissions as Permission[],
      suspended: membership.suspended,
      expiresAt: membership.expiresAt ? membership.expiresAt.toISOString() : null,
    };
  }

  /**
   * The authorisation choke point.
   *
   * Denials are audited, because a member repeatedly trying to reach something
   * they were not granted is exactly the kind of thing an owner should be able
   * to see afterwards.
   */
  async requirePermission(
    userId: string,
    spaceId: string,
    permission: Permission,
    context?: RequestContext,
  ): Promise<PrincipalGrant> {
    const grant = await this.grantFor(userId, spaceId);

    if (!grant) {
      // Not a member. Answered as "not found" so the endpoint cannot be used to
      // discover which Space ids exist.
      throw new NotFoundException('That Space was not found.');
    }

    const decision = evaluatePermission(grant, permission);
    if (!decision.allowed) {
      await this.audit.record({
        action: 'permission.denied',
        outcome: 'denied',
        actorUserId: userId,
        spaceId,
        context,
        metadata: { permission, reason: decision.reason },
      });
      throw new ForbiddenException(describeDenial(decision.reason, permission));
    }

    return grant;
  }

  /**
   * Convenience for endpoints that only an owner may reach.
   *
   * Someone who is not a member at all gets "not found", not "forbidden" —
   * a 403 would confirm the Space exists to a stranger who guessed its id.
   * A member who simply is not the owner gets a real 403, because they already
   * know the Space exists.
   */
  async requireOwner(userId: string, spaceId: string, context?: RequestContext): Promise<void> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { ownerId: true },
    });
    if (!space) throw new NotFoundException('That Space was not found.');

    if (space.ownerId !== userId) {
      const membership = await this.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId } },
        select: { id: true },
      });
      if (!membership) throw new NotFoundException('That Space was not found.');
    }

    if (space.ownerId !== userId) {
      await this.audit.record({
        action: 'permission.denied',
        outcome: 'denied',
        actorUserId: userId,
        spaceId,
        context,
        metadata: { reason: 'not_owner' },
      });
      throw new ForbiddenException('Only the owner of this Space can do that.');
    }
  }

  /** The default grant a newly enrolled personal device receives. */
  static defaultDevicePermissions(): readonly Permission[] {
    return DEFAULT_TRUSTED_DEVICE_PERMISSIONS;
  }
}

function describeDenial(reason: string, permission: Permission): string {
  switch (reason) {
    case 'principal_suspended':
      return 'Your access to this Space is paused.';
    case 'principal_expired':
      return 'Your access to this Space has expired.';
    default:
      return `You do not have permission to do that (${permission}).`;
  }
}
