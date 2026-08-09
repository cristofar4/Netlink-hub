import { Injectable, NotFoundException } from '@nestjs/common';
import {
  HEALTH_DATA_REMAINING_FLOOR,
  HEALTH_SECURITY_WINDOW_HOURS,
  HEALTH_SIGNAL_WEIGHTS,
  evaluatePermission,
  healthScore,
  projectDaysRemaining,
  remainingBytes,
  statusFromHeartbeat,
  USAGE_HISTORY_DEFAULT_DAYS,
  type HealthSignal,
  type SpaceOverview,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesService } from '../spaces/spaces.service';
import { DataService } from '../data/data.service';

/**
 * One request that answers "how is this Space doing?".
 *
 * The Overview screen used to ask five endpoints and assemble the answer in the
 * browser, which meant the summary could disagree with itself while the last
 * response was still in flight. It is computed here instead, from one
 * consistent read.
 *
 * Every number is a count of something in the database. Nothing on this screen
 * is a plausible-looking constant: a Space with no computers reports no
 * computers, and the health score says which check failed.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly data: DataService,
  ) {}

  async forSpace(userId: string, spaceId: string): Promise<SpaceOverview> {
    const grant = await this.spaces.grantFor(userId, spaceId);
    // Not a member: answered as "not found", so the endpoint cannot be used to
    // discover which Space ids exist.
    if (!grant) throw new NotFoundException('That Space was not found.');

    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      include: {
        agents: {
          select: { lastHeartbeatAt: true, isWakeHelper: true, wakeOnLanReady: true },
        },
        resources: { select: { kind: true, enabled: true } },
        _count: { select: { members: true } },
      },
    });
    if (!space) throw new NotFoundException('That Space was not found.');

    const now = new Date();
    const online = space.agents.filter(
      (agent) => statusFromHeartbeat(agent.lastHeartbeatAt, now) === 'online',
    );
    // A Wake Helper is only useful if it is awake itself — an offline helper
    // cannot send the magic packet that turns anything on.
    const wakeHelpers = online.filter((agent) => agent.isWakeHelper);
    const sharedResources = space.resources.filter((resource) => resource.enabled);

    const activeSessionCount = await this.prisma.remoteSession.count({
      where: { spaceId, state: { in: ['pending', 'connecting', 'active'] } },
    });

    const data = evaluatePermission(grant, 'data.manage').allowed
      ? await this.dataSummary(userId, spaceId)
      : null;

    const since = new Date(now.getTime() - HEALTH_SECURITY_WINDOW_HOURS * 60 * 60 * 1000);
    const recentDenials = await this.prisma.auditEvent.count({
      where: { spaceId, createdAt: { gte: since }, outcome: { in: ['denied', 'failure'] } },
    });

    const signals: HealthSignal[] = [
      {
        id: 'computers.online',
        label: 'A computer is reachable',
        ok: online.length > 0,
        detail:
          space.agents.length === 0
            ? 'No computer has been set up in this Space yet.'
            : online.length > 0
              ? `${online.length} of ${space.agents.length} online.`
              : 'Every computer here is offline.',
        weight: HEALTH_SIGNAL_WEIGHTS['computers.online'],
      },
      {
        id: 'security.clean',
        label: 'No refused access recently',
        ok: recentDenials === 0,
        detail:
          recentDenials === 0
            ? `Nothing refused in the last ${HEALTH_SECURITY_WINDOW_HOURS} hours.`
            : `${recentDenials} request${recentDenials === 1 ? '' : 's'} refused in the last ${HEALTH_SECURITY_WINDOW_HOURS} hours.`,
        weight: HEALTH_SIGNAL_WEIGHTS['security.clean'],
      },
      {
        id: 'data.connected',
        label: 'Data Pool connected',
        ok: data !== null,
        detail: data
          ? 'Sharing from a connected account.'
          : 'No data account is connected to this Space.',
        weight: HEALTH_SIGNAL_WEIGHTS['data.connected'],
      },
      {
        id: 'data.remaining',
        label: 'Data allowance is healthy',
        ok: data !== null && aboveFloor(data.remainingBytes, data.balanceBytes),
        detail: data
          ? aboveFloor(data.remainingBytes, data.balanceBytes)
            ? 'More than a tenth of the allowance is left.'
            : 'Less than a tenth of the allowance is left.'
          : 'No data account is connected to this Space.',
        weight: HEALTH_SIGNAL_WEIGHTS['data.remaining'],
      },
      {
        id: 'wake.helper',
        label: 'A Wake Helper is online',
        ok: wakeHelpers.length > 0,
        detail:
          wakeHelpers.length > 0
            ? 'An offline computer here can be turned on remotely.'
            : 'Nothing here can turn on a computer that is powered off.',
        weight: HEALTH_SIGNAL_WEIGHTS['wake.helper'],
      },
      {
        id: 'resources.shared',
        label: 'Something is shared',
        ok: sharedResources.length > 0,
        detail:
          sharedResources.length > 0
            ? `${sharedResources.length} folder${sharedResources.length === 1 ? '' : 's'} or printer${sharedResources.length === 1 ? '' : 's'} approved.`
            : 'No folder or printer has been approved yet.',
        weight: HEALTH_SIGNAL_WEIGHTS['resources.shared'],
      },
    ];

    return {
      spaceId,
      spaceName: space.name,
      isOwner: space.ownerId === userId,
      agentCount: space.agents.length,
      onlineAgentCount: online.length,
      folderCount: sharedResources.filter((resource) => resource.kind === 'folder').length,
      printerCount: sharedResources.filter((resource) => resource.kind === 'printer').length,
      memberCount: space._count.members,
      activeSessionCount,
      data,
      health: { score: healthScore(signals), signals },
    };
  }

  /**
   * The pool, plus how long it lasts at the recent rate.
   *
   * A Space with no pool is not an error here — it is a Space nobody has
   * connected an account to yet — so the absence is reported as `null` rather
   * than thrown.
   */
  private async dataSummary(userId: string, spaceId: string): Promise<SpaceOverview['data']> {
    const pool = await this.prisma.dataPool.findUnique({
      where: { spaceId },
      select: { id: true },
    });
    if (!pool) return null;

    const summary = await this.data.poolSummary(userId, spaceId);
    const usage = await this.data.usageSeries(userId, spaceId, USAGE_HISTORY_DEFAULT_DAYS);
    const remaining = remainingBytes(summary.balanceBytes, summary.usedBytes);

    return {
      isDemo: summary.isDemo,
      balanceBytes: summary.balanceBytes,
      usedBytes: summary.usedBytes,
      remainingBytes: remaining,
      projectedDaysRemaining: projectDaysRemaining(remaining, usage.dailyAverageBytes),
    };
  }
}

/** True when more than the floor share of the balance is still unspent. */
function aboveFloor(remaining: string, balance: string): boolean {
  const total = BigInt(balance);
  if (total === 0n) return false;
  // Compared in integer arithmetic — a float ratio of two byte counts this
  // large loses precision exactly where the threshold sits.
  return BigInt(remaining) * 100n > total * BigInt(Math.round(HEALTH_DATA_REMAINING_FLOOR * 100));
}
