import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DATA_ONLY_PERMISSIONS,
  USAGE_HISTORY_MAX_DAYS,
  USAGE_HISTORY_MIN_DAYS,
  evaluatePermission,
  remainingBytes,
  type CreatePassRequest,
  type DataPoolSummary,
  type DataProviderAdapter,
  type DataUsageSeries,
  type MemberAccessRow,
  type MyAllocation,
  type PassSummary,
  type Permission,
  type UpdateAllocationRequest,
  type UsageBucket,
} from '@netlink/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokenService } from '../crypto/token.service';
import { SpacesService } from '../spaces/spaces.service';
import { LiveGateway } from '../live/live.gateway';
import type { RequestContext } from '../common/request-context';
import { DATA_PROVIDER } from './data.tokens';

@Injectable()
export class DataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly spaces: SpacesService,
    private readonly live: LiveGateway,
    @Inject(DATA_PROVIDER) private readonly provider: DataProviderAdapter,
  ) {}

  // -------------------------------------------------------------------------
  // The pool
  // -------------------------------------------------------------------------

  /**
   * Links a Space to the owner's provider account.
   *
   * The account reference is verified through the adapter before anything is
   * stored, so a typo fails here rather than at the moment someone tries to use
   * their allocation.
   */
  async connectPool(
    userId: string,
    spaceId: string,
    accountRef: string,
    context: RequestContext,
  ): Promise<DataPoolSummary> {
    await this.spaces.requireOwner(userId, spaceId, context);

    const account = await this.provider.verifyAccount({ accountRef });
    if (!account.verified) {
      throw new BadRequestException(
        'That account could not be verified with the provider. Check the number and try again.',
      );
    }

    const plan = await this.provider.getPlan({ accountRef: account.accountRef });

    await this.prisma.dataPool.upsert({
      where: { spaceId },
      create: {
        spaceId,
        provider: this.provider.name,
        accountRef: account.accountRef,
        planName: plan.name,
      },
      update: { accountRef: account.accountRef, planName: plan.name, provider: this.provider.name },
    });

    return this.poolSummary(userId, spaceId);
  }

  async poolSummary(userId: string, spaceId: string): Promise<DataPoolSummary> {
    await this.spaces.requirePermission(userId, spaceId, 'data.manage');

    const pool = await this.prisma.dataPool.findUnique({
      where: { spaceId },
      include: { allocations: true },
    });
    if (!pool) throw new NotFoundException('This Space has no Data Pool yet.');

    const balance = await this.provider.getBalance({ accountRef: pool.accountRef });

    const live = pool.allocations.filter(
      (allocation) => allocation.status === 'active' || allocation.status === 'paused',
    );
    const allocated = live.reduce((total, a) => total + BigInt(a.totalBytes.toFixed(0)), 0n);
    const used = pool.allocations.reduce((total, a) => total + BigInt(a.usedBytes.toFixed(0)), 0n);
    const available = BigInt(balance.balanceBytes) - allocated;

    return {
      spaceId,
      provider: pool.provider,
      // Read by the UI to label a demo pool. Never inferred from the name.
      isDemo: !this.provider.isReal,
      accountRef: maskAccount(pool.accountRef),
      planName: pool.planName,
      balanceBytes: balance.balanceBytes,
      allocatedBytes: allocated.toString(),
      usedBytes: used.toString(),
      availableBytes: (available > 0n ? available : 0n).toString(),
      memberCount: live.length,
    };
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  /**
   * Creates a NetLink Pass.
   *
   * A Data-Only pass is forced to exactly `data.use` regardless of what the
   * request asked for. That is the whole guarantee of the feature, so it is
   * enforced here rather than trusted from the client.
   */
  async createPass(
    userId: string,
    spaceId: string,
    input: CreatePassRequest,
    context: RequestContext,
  ): Promise<PassSummary> {
    await this.spaces.requirePermission(userId, spaceId, 'invitations.create', context);

    const permissions: Permission[] =
      input.kind === 'data_only' ? [...DATA_ONLY_PERMISSIONS] : [...input.permissions];

    if (input.kind === 'data_only') {
      const pool = await this.prisma.dataPool.findUnique({
        where: { spaceId },
        include: { allocations: true },
      });
      if (!pool) {
        throw new BadRequestException('Connect this Space to a data provider before sharing data.');
      }

      // Refuse to promise more than the pool actually holds. Discovering that
      // at the moment someone tries to use their allocation would be worse.
      const summary = await this.poolSummary(userId, spaceId);
      if (BigInt(input.totalBytes ?? '0') > BigInt(summary.availableBytes)) {
        throw new BadRequestException('That is more data than this pool has left to give out.');
      }
    }

    const token = this.tokens.generateOpaqueToken();

    const invitation = await this.prisma.invitation.create({
      data: {
        spaceId,
        createdById: userId,
        inviteeEmail: input.email ?? null,
        tokenHash: this.tokens.hashSecret(token),
        permissions,
        expiresAt: new Date(input.expiresAt),
        allowResharing: input.allowResharing,
        totalDataBytes: input.totalBytes ?? null,
        dailyDataBytes: input.dailyBytes ?? null,
      },
      include: { space: true },
    });

    await this.audit.record({
      action: 'invitation.created',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: {
        kind: input.kind,
        permissions: permissions.join(',') || 'none',
        hasEmail: Boolean(input.email),
      },
    });

    return { ...toPassSummary(invitation), claimToken: token };
  }

  async listPasses(userId: string, spaceId: string): Promise<PassSummary[]> {
    await this.spaces.requirePermission(userId, spaceId, 'members.manage');

    const invitations = await this.prisma.invitation.findMany({
      where: { spaceId },
      include: { space: true },
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map(toPassSummary);
  }

  /**
   * Accepts a pass with the invitee's own NetLink account.
   *
   * The invitee always brings their own account — there is no path where an
   * owner shares a password. The token is single-use and, when addressed to a
   * specific email, only that account can redeem it.
   */
  async claimPass(
    userId: string,
    token: string,
    context: RequestContext,
  ): Promise<{ spaceId: string; spaceName: string; permissions: Permission[] }> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: this.tokens.hashSecret(token) },
      include: { space: true },
    });

    if (
      !invitation ||
      invitation.status !== 'pending' ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('This NetLink Pass is no longer valid.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Account not found.');

    if (invitation.inviteeEmail && invitation.inviteeEmail !== user.email) {
      await this.audit.record({
        action: 'invitation.claimed',
        outcome: 'denied',
        actorUserId: userId,
        spaceId: invitation.spaceId,
        context,
        metadata: { reason: 'wrong_account' },
      });
      throw new ForbiddenException('This Pass was sent to a different email address.');
    }

    if (invitation.space.ownerId === userId) {
      throw new BadRequestException('You already own this Space.');
    }

    // Single use, claimed by a conditional update so two simultaneous
    // redemptions cannot both succeed.
    const claimed = await this.prisma.invitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'claimed', claimedAt: new Date(), claimedByUserId: userId },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('This NetLink Pass has already been used.');
    }

    const permissions = invitation.permissions as Permission[];

    const member = await this.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: invitation.spaceId, userId } },
      create: {
        spaceId: invitation.spaceId,
        userId,
        role: 'invited_member',
        permissions,
        expiresAt: invitation.expiresAt,
      },
      update: { permissions, expiresAt: invitation.expiresAt, suspended: false },
    });

    if (invitation.totalDataBytes) {
      await this.openAllocation({
        spaceId: invitation.spaceId,
        memberId: member.id,
        totalBytes: invitation.totalDataBytes.toFixed(0),
        dailyBytes: invitation.dailyDataBytes ? invitation.dailyDataBytes.toFixed(0) : null,
        expiresAt: invitation.expiresAt,
        allowResharing: invitation.allowResharing,
        subscriberRef: userId,
      });
    }

    await this.audit.record({
      action: 'invitation.claimed',
      outcome: 'success',
      actorUserId: userId,
      spaceId: invitation.spaceId,
      context,
      metadata: { permissions: permissions.join(',') || 'none' },
    });

    // The claimant's open windows can now hear about this Space.
    this.live.grantSpaceAccess(userId, invitation.spaceId);

    return {
      spaceId: invitation.spaceId,
      spaceName: invitation.space.name,
      permissions,
    };
  }

  async revokePass(
    userId: string,
    spaceId: string,
    passId: string,
    context: RequestContext,
  ): Promise<{ revoked: true }> {
    await this.spaces.requirePermission(userId, spaceId, 'members.manage', context);

    const invitation = await this.prisma.invitation.findUnique({ where: { id: passId } });
    if (!invitation || invitation.spaceId !== spaceId) {
      throw new NotFoundException('That Pass was not found.');
    }

    await this.prisma.invitation.update({
      where: { id: passId },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    await this.audit.record({
      action: 'invitation.revoked',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
    });

    return { revoked: true };
  }

  // -------------------------------------------------------------------------
  // Allocations
  // -------------------------------------------------------------------------

  private async openAllocation(input: {
    spaceId: string;
    memberId: string;
    totalBytes: string;
    dailyBytes: string | null;
    expiresAt: Date;
    allowResharing: boolean;
    subscriberRef: string;
  }): Promise<void> {
    const pool = await this.prisma.dataPool.findUnique({ where: { spaceId: input.spaceId } });
    if (!pool) return;

    await this.provider.createAllocation({
      accountRef: pool.accountRef,
      subscriberRef: input.subscriberRef,
      totalBytes: input.totalBytes,
      dailyBytes: input.dailyBytes,
      expiresAt: input.expiresAt.toISOString(),
    });

    await this.prisma.dataAllocation.upsert({
      where: { memberId: input.memberId },
      create: {
        poolId: pool.id,
        spaceId: input.spaceId,
        memberId: input.memberId,
        totalBytes: input.totalBytes,
        dailyBytes: input.dailyBytes,
        expiresAt: input.expiresAt,
        allowResharing: input.allowResharing,
      },
      update: {
        totalBytes: input.totalBytes,
        dailyBytes: input.dailyBytes,
        expiresAt: input.expiresAt,
        status: 'active',
        pausedAt: null,
        revokedAt: null,
      },
    });

    await this.audit.record({
      action: 'data.allocation.created',
      outcome: 'success',
      spaceId: input.spaceId,
      metadata: { totalBytes: input.totalBytes, dailyBytes: input.dailyBytes ?? 'none' },
    });
  }

  /** What a member is allowed to see about themselves — and nothing more. */
  async myAllocation(userId: string, spaceId: string): Promise<MyAllocation> {
    await this.spaces.requirePermission(userId, spaceId, 'data.use');

    const member = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      include: { allocation: true, space: { select: { name: true } } },
    });
    if (!member?.allocation) {
      throw new NotFoundException('You do not have a data allocation in this Space.');
    }

    const allocation = await this.refreshUsage(member.allocation.id);

    return {
      spaceId,
      spaceName: member.space.name,
      status: allocation.status,
      allocatedBytes: allocation.totalBytes.toFixed(0),
      usedBytes: allocation.usedBytes.toFixed(0),
      remainingBytes: remainingBytes(
        allocation.totalBytes.toFixed(0),
        allocation.usedBytes.toFixed(0),
      ),
      dailyLimitBytes: allocation.dailyBytes ? allocation.dailyBytes.toFixed(0) : null,
      usedTodayBytes: allocation.usedTodayBytes.toFixed(0),
      expiresAt: allocation.expiresAt.toISOString(),
      connected: allocation.status === 'active',
    };
  }

  /**
   * Daily usage over a window, for the chart on the Data Pool screen.
   *
   * Two different questions share this one endpoint, answered by what the
   * caller holds: someone who manages the pool sees the whole Space, and a
   * member who merely uses data sees their own allocation and no one else's.
   * The grant is read once and evaluated locally rather than asked for twice,
   * so opening the screen as a member does not write a denial to the audit log
   * on every load.
   *
   * The aggregation happens in the database. Pulling every usage event into the
   * process to add them up would work today and stop working at exactly the
   * scale where the chart becomes interesting.
   */
  async usageSeries(userId: string, spaceId: string, days: number): Promise<DataUsageSeries> {
    const grant = await this.spaces.grantFor(userId, spaceId);
    if (!grant) throw new NotFoundException('That Space was not found.');

    const managesPool = evaluatePermission(grant, 'data.manage').allowed;
    const usesData = evaluatePermission(grant, 'data.use').allowed;
    if (!managesPool && !usesData) {
      throw new ForbiddenException('You do not have access to data usage in this Space.');
    }

    const window = Math.min(
      Math.max(Math.trunc(days), USAGE_HISTORY_MIN_DAYS),
      USAGE_HISTORY_MAX_DAYS,
    );
    const today = startOfUtcDay(new Date());
    const from = new Date(today.getTime() - (window - 1) * DAY_MS);

    const allocations = await this.prisma.dataAllocation.findMany({
      where: managesPool ? { spaceId } : { spaceId, member: { userId } },
      select: { id: true },
    });

    const totals = new Map<string, bigint>();
    if (allocations.length > 0) {
      const rows = await this.prisma.$queryRaw<Array<{ day: Date; bytes: string }>>`
        SELECT date_trunc('day', "occurredAt") AS day, SUM("bytes")::text AS bytes
        FROM data_usage_events
        WHERE "allocationId" IN (${Prisma.join(allocations.map((a) => a.id))})
          AND "occurredAt" >= ${from}
        GROUP BY 1
      `;
      for (const row of rows) totals.set(isoDay(row.day), BigInt(row.bytes));
    }

    // Every day in the window is emitted, including the empty ones: a chart
    // that drops quiet days shows a busy fortnight and a quiet month alike.
    const buckets: UsageBucket[] = [];
    let total = 0n;
    let peak = 0n;
    for (let index = 0; index < window; index += 1) {
      const day = isoDay(new Date(from.getTime() + index * DAY_MS));
      const bytes = totals.get(day) ?? 0n;
      total += bytes;
      if (bytes > peak) peak = bytes;
      buckets.push({ day, bytes: bytes.toString() });
    }

    return {
      spaceId,
      fromDay: buckets[0]?.day ?? isoDay(from),
      toDay: buckets[buckets.length - 1]?.day ?? isoDay(today),
      buckets,
      totalBytes: total.toString(),
      peakBytes: peak.toString(),
      dailyAverageBytes: (total / BigInt(window)).toString(),
    };
  }

  /** The owner's Member Access page. */
  async memberAccess(userId: string, spaceId: string): Promise<MemberAccessRow[]> {
    await this.spaces.requirePermission(userId, spaceId, 'members.manage');

    const members = await this.prisma.spaceMember.findMany({
      where: { spaceId },
      include: {
        user: { select: { id: true, name: true, email: true, devices: true } },
        allocation: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const rows: MemberAccessRow[] = [];
    for (const member of members) {
      const allocation = member.allocation ? await this.refreshUsage(member.allocation.id) : null;

      const activeDevice = member.user.devices.find((device) => !device.revokedAt);

      rows.push({
        memberId: member.id,
        userId: member.user.id,
        name: member.user.name,
        email: member.user.email,
        role: member.role,
        permissions: member.permissions as Permission[],
        suspended: member.suspended,
        expiresAt: member.expiresAt ? member.expiresAt.toISOString() : null,
        connected: allocation ? allocation.status === 'active' : Boolean(activeDevice),
        approvedDeviceName: activeDevice?.name ?? null,
        allocation: allocation
          ? {
              status: allocation.status,
              allocatedBytes: allocation.totalBytes.toFixed(0),
              usedBytes: allocation.usedBytes.toFixed(0),
              usedTodayBytes: allocation.usedTodayBytes.toFixed(0),
              remainingBytes: remainingBytes(
                allocation.totalBytes.toFixed(0),
                allocation.usedBytes.toFixed(0),
              ),
              dailyLimitBytes: allocation.dailyBytes ? allocation.dailyBytes.toFixed(0) : null,
              expiresAt: allocation.expiresAt.toISOString(),
            }
          : null,
      });
    }
    return rows;
  }

  async pauseAllocation(
    userId: string,
    spaceId: string,
    memberId: string,
    paused: boolean,
    context: RequestContext,
  ): Promise<{ status: string }> {
    await this.spaces.requirePermission(userId, spaceId, 'data.manage', context);
    const allocation = await this.requireAllocation(spaceId, memberId);

    await this.prisma.dataAllocation.update({
      where: { id: allocation.id },
      data: {
        status: paused ? 'paused' : 'active',
        pausedAt: paused ? new Date() : null,
      },
    });

    await this.audit.record({
      action: 'data.allocation.paused',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: { paused },
    });

    return { status: paused ? 'paused' : 'active' };
  }

  async updateAllocation(
    userId: string,
    spaceId: string,
    memberId: string,
    input: UpdateAllocationRequest,
    context: RequestContext,
  ): Promise<{ updated: true }> {
    await this.spaces.requirePermission(userId, spaceId, 'data.manage', context);
    const allocation = await this.requireAllocation(spaceId, memberId);

    // Lowering the total below what is already spent would show a negative
    // remaining figure; refusing is clearer than clamping silently.
    if (input.totalBytes && BigInt(input.totalBytes) < BigInt(allocation.usedBytes.toFixed(0))) {
      throw new BadRequestException(
        'That is less than this person has already used. Revoke the allocation instead.',
      );
    }

    await this.prisma.dataAllocation.update({
      where: { id: allocation.id },
      data: {
        ...(input.totalBytes ? { totalBytes: input.totalBytes } : {}),
        ...(input.dailyBytes !== undefined ? { dailyBytes: input.dailyBytes } : {}),
        ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      },
    });

    await this.audit.record({
      action: 'data.allocation.updated',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: {
        totalBytes: input.totalBytes ?? 'unchanged',
        dailyBytes: input.dailyBytes ?? 'unchanged',
      },
    });

    return { updated: true };
  }

  /**
   * Ends a member's access entirely.
   *
   * Revokes the allocation *and* clears the membership's permissions, because
   * leaving a member row with capabilities but no data would be a quiet way for
   * "revoke access" to mean less than it says.
   */
  async revokeAccess(
    userId: string,
    spaceId: string,
    memberId: string,
    context: RequestContext,
  ): Promise<{ revoked: true }> {
    await this.spaces.requirePermission(userId, spaceId, 'members.manage', context);

    const member = await this.prisma.spaceMember.findUnique({
      where: { id: memberId },
      include: { allocation: true },
    });
    if (!member || member.spaceId !== spaceId) {
      throw new NotFoundException('That member was not found.');
    }
    if (member.role === 'owner') {
      throw new BadRequestException('The owner of a Space cannot be removed from it.');
    }

    if (member.allocation) {
      await this.prisma.dataAllocation.update({
        where: { id: member.allocation.id },
        data: { status: 'revoked', revokedAt: new Date() },
      });
    }

    await this.prisma.spaceMember.update({
      where: { id: memberId },
      data: { permissions: [], suspended: true },
    });

    this.live.revokeSpaceAccess(member.userId, spaceId);

    await this.audit.record({
      action: 'data.allocation.revoked',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: { memberId },
    });

    return { revoked: true };
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * Pulls usage from the provider and folds it into our own counters.
   *
   * The daily figure resets by comparing the stored day to today, so no
   * scheduled job is needed and a server that was asleep at midnight still
   * gets the right answer.
   *
   * Exhausting the total or the daily limit pauses the allocation, which is
   * what actually stops further use.
   */
  private async refreshUsage(allocationId: string) {
    const allocation = await this.prisma.dataAllocation.findUniqueOrThrow({
      where: { id: allocationId },
      include: { pool: true },
    });

    if (allocation.status === 'revoked') return allocation;

    if (allocation.expiresAt.getTime() <= Date.now() && allocation.status !== 'expired') {
      return this.prisma.dataAllocation.update({
        where: { id: allocationId },
        data: { status: 'expired' },
        include: { pool: true },
      });
    }

    const today = startOfDay(new Date());
    const dayChanged =
      !allocation.usageDay || startOfDay(allocation.usageDay).getTime() !== today.getTime();

    let usedToday = dayChanged ? 0n : BigInt(allocation.usedTodayBytes.toFixed(0));
    let usedTotal = BigInt(allocation.usedBytes.toFixed(0));

    if (allocation.status === 'active') {
      const usage = await this.provider.getUsage({
        providerAllocationId: allocationId,
        since: allocation.updatedAt.toISOString(),
      });

      for (const event of usage.events) {
        // `providerRef` is unique, so a replayed webhook or an overlapping poll
        // cannot double-count the same bytes.
        const created = await this.prisma.dataUsageEvent
          .create({
            data: {
              allocationId,
              bytes: event.bytes,
              sessionSeconds: event.sessionSeconds,
              providerRef: event.providerRef,
              occurredAt: new Date(event.occurredAt),
            },
          })
          .catch(() => null);

        if (created) {
          usedTotal += BigInt(event.bytes);
          if (startOfDay(new Date(event.occurredAt)).getTime() === today.getTime()) {
            usedToday += BigInt(event.bytes);
          }
        }
      }
    }

    const total = BigInt(allocation.totalBytes.toFixed(0));
    const dailyLimit = allocation.dailyBytes ? BigInt(allocation.dailyBytes.toFixed(0)) : null;

    const exhausted = usedTotal >= total;
    const dailyReached = dailyLimit !== null && usedToday >= dailyLimit;

    const updated = await this.prisma.dataAllocation.update({
      where: { id: allocationId },
      data: {
        usedBytes: usedTotal.toString(),
        usedTodayBytes: usedToday.toString(),
        usageDay: today,
        // Reaching a limit pauses the allocation. Recording usage without
        // stopping anything would make the limit decorative.
        ...(exhausted || dailyReached ? { status: 'paused' as const, pausedAt: new Date() } : {}),
      },
      include: { pool: true },
    });

    this.live.publishToSpace(allocation.spaceId, {
      type: 'data.usage',
      spaceId: allocation.spaceId,
      memberId: allocation.memberId,
      usedBytes: usedTotal.toString(),
    });

    return updated;
  }

  private async requireAllocation(spaceId: string, memberId: string) {
    const allocation = await this.prisma.dataAllocation.findUnique({ where: { memberId } });
    if (!allocation || allocation.spaceId !== spaceId) {
      throw new NotFoundException('That member has no data allocation.');
    }
    return allocation;
  }
}

type InvitationRow = {
  id: string;
  spaceId: string;
  space: { name: string };
  inviteeEmail: string | null;
  permissions: string[];
  status: string;
  totalDataBytes: { toFixed(digits: number): string } | null;
  dailyDataBytes: { toFixed(digits: number): string } | null;
  allowResharing: boolean;
  expiresAt: Date;
  createdAt: Date;
  claimedAt: Date | null;
};

function toPassSummary(invitation: InvitationRow): PassSummary {
  const permissions = invitation.permissions as Permission[];
  const isDataOnly = permissions.length === 1 && permissions[0] === 'data.use';

  return {
    id: invitation.id,
    spaceId: invitation.spaceId,
    spaceName: invitation.space.name,
    inviteeEmail: invitation.inviteeEmail,
    kind: isDataOnly ? 'data_only' : 'custom',
    permissions,
    status:
      invitation.status === 'pending' && invitation.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : (invitation.status as PassSummary['status']),
    totalBytes: invitation.totalDataBytes ? invitation.totalDataBytes.toFixed(0) : null,
    dailyBytes: invitation.dailyDataBytes ? invitation.dailyDataBytes.toFixed(0) : null,
    allowResharing: invitation.allowResharing,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    claimedAt: invitation.claimedAt ? invitation.claimedAt.toISOString() : null,
  };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The usage chart buckets by UTC day rather than by the server's local day.
 *
 * A daily *limit* is a promise to the person using the data, so it resets on
 * their day — that is `startOfDay` above. A chart is a record of what happened,
 * and it has to bucket the same way whichever machine renders it, so it uses
 * UTC. The two are deliberately different, not an inconsistency.
 */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function maskAccount(ref: string): string {
  if (ref.length <= 4) return '•'.repeat(ref.length);
  return `${'•'.repeat(Math.min(ref.length - 4, 8))}${ref.slice(-4)}`;
}
