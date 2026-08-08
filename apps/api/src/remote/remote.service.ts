import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  REMOTE_CONNECT_TIMEOUT_SECONDS,
  REMOTE_GRANT_TTL_SECONDS,
  REMOTE_IDLE_TIMEOUT_SECONDS,
  REMOTE_MAX_DURATION_SECONDS,
  REMOTE_MODE_PERMISSIONS,
  statusFromHeartbeat,
  strategyFromCandidateTypes,
  type ConnectionStrategy,
  type CreateRemoteSessionRequest,
  type Permission,
  type RemoteEndReason,
  type RemoteGrantEnvelope,
  type RemoteSessionMode,
  type RemoteSessionSummary,
  type RemoteSessionTicket,
  type RemoteSignal,
  type RemoteSignalRequest,
  type SignalRole,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SpacesService } from '../spaces/spaces.service';
import { LiveGateway } from '../live/live.gateway';
import { ChallengeService } from '../auth/challenge.service';
import type { RequestContext } from '../common/request-context';
import type { AgentPrincipal } from '../agents/agent-signature.guard';
import { GrantSigner } from './grant-signer';
import { IceService } from './ice.service';

type SessionRow = {
  id: string;
  spaceId: string;
  agentId: string;
  viewerId: string;
  mode: RemoteSessionMode;
  state: 'pending' | 'connecting' | 'active' | 'ended';
  strategy: string;
  issuedAt: Date;
  expiresAt: Date;
  connectedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  agent: { device: { name: string } };
  viewer: { name: string };
};

const SESSION_INCLUDE = {
  agent: { include: { device: { select: { name: true } } } },
  viewer: { select: { name: true } },
} as const;

/**
 * Remote desktop sessions.
 *
 * What this service is responsible for is narrower than it looks, and the
 * boundary is the whole design:
 *
 *   * It decides **whether** a session may happen, and in which mode.
 *   * It signs a grant that fixes the mode beyond the viewer's reach.
 *   * It brokers the handful of messages the two peers need to find each other.
 *   * It records that the session happened, and closes it when it should end.
 *
 * It never sees a pixel or a keystroke. Those go peer to peer, encrypted by
 * DTLS-SRTP, which is why a compromise of this server cannot replay someone's
 * screen — there is nothing here to replay.
 */
@Injectable()
export class RemoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
    private readonly live: LiveGateway,
    private readonly grants: GrantSigner,
    private readonly ice: IceService,
    private readonly challenges: ChallengeService,
  ) {}

  // -------------------------------------------------------------------------
  // Starting a session
  // -------------------------------------------------------------------------

  /**
   * Sends the confirmation code that a control session needs.
   *
   * Taking over someone's keyboard sits alongside restarting their machine:
   * holding the permission is necessary but not sufficient, because the thing
   * that most often goes wrong is not a missing grant, it is a session someone
   * else is sitting in front of.
   */
  async requestStepUp(
    userId: string,
    spaceId: string,
    exposeDevCode: boolean,
  ): Promise<{ challengeId: string; maskedEmail: string; expiresAt: string; devCode?: string }> {
    await this.spaces.requirePermission(userId, spaceId, 'devices.control');

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

  async createSession(
    userId: string,
    deviceId: string,
    spaceId: string,
    input: CreateRemoteSessionRequest,
    context: RequestContext,
  ): Promise<RemoteSessionTicket> {
    // Every permission the mode needs, checked individually. Control needs
    // observe as well — controlling a machine you cannot see is not a coherent
    // thing to grant, and requiring both means an owner who revokes observe has
    // actually revoked control too.
    const needed = REMOTE_MODE_PERMISSIONS[input.mode] as readonly Permission[];
    for (const permission of needed) {
      await this.spaces.requirePermission(userId, spaceId, permission, context);
    }

    const agent = await this.prisma.agent.findUnique({
      where: { id: input.agentId },
      include: { device: { select: { name: true, revokedAt: true } } },
    });
    if (!agent || agent.spaceId !== spaceId || agent.device.revokedAt) {
      throw new NotFoundException('That computer was not found in this Space.');
    }

    if (statusFromHeartbeat(agent.lastHeartbeatAt) !== 'online') {
      throw new ConflictException(
        'That computer is not online. Turn it on from Device Power and Wake first.',
      );
    }

    if (input.mode === 'control') {
      await this.verifyStepUp(userId, spaceId, input, context);
    }

    // One live session per computer. Two people driving the same mouse is not a
    // feature, and a second viewer silently watching is worse.
    await this.expireStale();
    const existing = await this.prisma.remoteSession.findFirst({
      where: { agentId: agent.id, state: { in: ['pending', 'connecting', 'active'] } },
      include: SESSION_INCLUDE,
    });
    if (existing) {
      if (existing.viewerId !== userId) {
        await this.audit.record({
          action: 'remote.session.denied',
          outcome: 'denied',
          actorUserId: userId,
          actorDeviceId: deviceId,
          spaceId,
          context,
          metadata: { reason: 'already_in_use' },
        });
        throw new ConflictException('Someone else is already connected to that computer.');
      }
      // The same person reconnecting — their own stale session should not lock
      // them out of the machine they are trying to reach.
      await this.close(existing.id, 'viewer_left', 'Replaced by a new session');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + REMOTE_GRANT_TTL_SECONDS * 1000);
    const nonce = randomBytes(18).toString('base64url');

    const session = await this.prisma.remoteSession.create({
      data: {
        id: randomUUID(),
        spaceId,
        agentId: agent.id,
        viewerId: userId,
        viewerDeviceId: deviceId,
        mode: input.mode,
        state: 'pending',
        nonce,
        issuedAt: now,
        expiresAt,
        lastSeenAt: now,
      },
      include: SESSION_INCLUDE,
    });

    await this.audit.record({
      action: 'remote.session.started',
      outcome: 'success',
      actorUserId: userId,
      actorDeviceId: deviceId,
      spaceId,
      context,
      metadata: { mode: input.mode, agentId: agent.id, sessionId: session.id },
    });

    this.live.publishToSpace(spaceId, {
      type: 'remote.session',
      spaceId,
      sessionId: session.id,
      agentId: agent.id,
      state: 'pending',
    });

    return {
      session: toSummary(session as SessionRow, userId),
      iceServers: this.ice.serversFor(session.id, now),
      relayAvailable: this.ice.relayAvailable(),
    };
  }

  private async verifyStepUp(
    userId: string,
    spaceId: string,
    input: CreateRemoteSessionRequest,
    context: RequestContext,
  ): Promise<void> {
    if (!input.stepUpChallengeId || !input.stepUpCode) {
      throw new ForbiddenException(
        'Confirm this with the six-digit code we sent to your email before taking control.',
      );
    }

    const result = await this.challenges.consume({
      challengeId: input.stepUpChallengeId,
      code: input.stepUpCode,
      purpose: 'step_up',
    });

    if (!result.ok || result.challenge.userId !== userId) {
      await this.audit.record({
        action: 'remote.session.denied',
        outcome: 'denied',
        actorUserId: userId,
        spaceId,
        context,
        metadata: { reason: 'step_up_failed', mode: input.mode },
      });
      throw new ForbiddenException('That confirmation code is not correct.');
    }
  }

  // -------------------------------------------------------------------------
  // Reading sessions
  // -------------------------------------------------------------------------

  async listSessions(userId: string, spaceId: string, limit = 20): Promise<RemoteSessionSummary[]> {
    await this.spaces.requirePermission(userId, spaceId, 'devices.observe');
    await this.expireStale();

    const rows = await this.prisma.remoteSession.findMany({
      where: { spaceId },
      include: SESSION_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((row) => toSummary(row as SessionRow, userId));
  }

  async getSession(userId: string, sessionId: string): Promise<RemoteSessionSummary> {
    const session = await this.requireViewerSession(userId, sessionId);
    return toSummary(session, userId);
  }

  /**
   * Marks the viewer as still present.
   *
   * Without this a closed laptop leaves a session that the host believes is
   * live, which is the one failure mode where a person could be watched without
   * anyone watching.
   */
  async heartbeat(userId: string, sessionId: string): Promise<RemoteSessionSummary> {
    const session = await this.requireViewerSession(userId, sessionId);
    if (session.state === 'ended') return toSummary(session, userId);

    const updated = await this.prisma.remoteSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
      include: SESSION_INCLUDE,
    });
    return toSummary(updated as SessionRow, userId);
  }

  // -------------------------------------------------------------------------
  // Signalling
  // -------------------------------------------------------------------------

  /**
   * Posts one signalling message for the other peer.
   *
   * Offers, answers and ICE candidates only. The payload is bounded and the
   * server does not parse it — but it is also not a general channel: a session
   * exists between exactly two parties who could already send each other
   * anything they liked over the connection this is establishing.
   */
  async postSignal(
    from: SignalRole,
    sessionId: string,
    input: RemoteSignalRequest,
    ownerId: string,
  ): Promise<{ seq: number }> {
    const session =
      from === 'viewer'
        ? await this.requireViewerSession(ownerId, sessionId)
        : await this.requireHostSession(ownerId, sessionId);

    if (session.state === 'ended') {
      throw new ConflictException('That session has ended.');
    }
    if (session.expiresAt.getTime() <= Date.now() && session.state === 'pending') {
      await this.close(session.id, 'connect_timeout', null);
      throw new ConflictException('That session expired before it connected.');
    }

    if (input.kind === 'bye') {
      await this.close(session.id, from === 'viewer' ? 'viewer_left' : 'host_ended', null);
      return { seq: 0 };
    }

    // Seeing an offer or an answer means the peers are actually talking, which
    // is a more truthful "connecting" than the moment the button was pressed.
    if (session.state === 'pending' && (input.kind === 'offer' || input.kind === 'answer')) {
      await this.prisma.remoteSession.update({
        where: { id: session.id },
        data: { state: 'connecting' },
      });
    }

    const seq = await this.appendSignal(session.id, from, input.kind, input.payload);

    this.live.publishToSpace(session.spaceId, {
      type: 'remote.signal',
      spaceId: session.spaceId,
      sessionId: session.id,
      from,
      seq,
    });

    return { seq };
  }

  /**
   * Appends a signal, serialised against every other append to the same session.
   *
   * ICE does not gather candidates one at a time — a peer emits several within
   * the same few milliseconds, and they arrive here concurrently. Reading the
   * highest sequence number and then inserting is a read-modify-write, so
   * several writers pick the same number and all but one are refused by the
   * unique constraint. Retrying does not help when a dozen of them are racing:
   * they collide on the retry too.
   *
   * So the session row is locked for the duration of the append. Appends to one
   * session are serialised; appends to different sessions do not touch each
   * other. The lock is held for a single insert, and a signalling exchange is a
   * handful of messages lasting a couple of seconds.
   *
   * The ordering that buys is not cosmetic: a candidate delivered before the
   * answer it belongs to is dropped by the peer, and a connection then fails for
   * reasons nobody can reconstruct afterwards.
   */
  private async appendSignal(
    sessionId: string,
    from: SignalRole,
    kind: string,
    payload: string,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // `id` is a text column, not a uuid one — Prisma's String @id maps to
      // TEXT — so no cast, or Postgres refuses to compare the two types.
      await tx.$executeRaw`SELECT id FROM remote_sessions WHERE id = ${sessionId} FOR UPDATE`;

      const last = await tx.remoteSignal.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = (last?.seq ?? 0) + 1;

      await tx.remoteSignal.create({
        data: { sessionId, seq, from, kind, payload },
      });
      return seq;
    });
  }

  /**
   * Reads the messages written by the *other* side and marks them delivered.
   *
   * Delivery is recorded rather than the reader tracking a cursor, so a peer
   * that reconnects mid-negotiation does not silently miss a candidate and then
   * fail to connect for reasons nobody can reconstruct.
   */
  async collectSignals(
    forRole: SignalRole,
    sessionId: string,
    ownerId: string,
  ): Promise<RemoteSignal[]> {
    const session =
      forRole === 'viewer'
        ? await this.requireViewerSession(ownerId, sessionId)
        : await this.requireHostSession(ownerId, sessionId);

    const other: SignalRole = forRole === 'viewer' ? 'host' : 'viewer';
    const rows = await this.prisma.remoteSignal.findMany({
      where: { sessionId: session.id, from: other, deliveredAt: null },
      orderBy: { seq: 'asc' },
      take: 200,
    });

    if (rows.length > 0) {
      await this.prisma.remoteSignal.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { deliveredAt: new Date() },
      });
    }

    return rows.map((row) => ({
      seq: row.seq,
      sessionId: row.sessionId,
      from: row.from as SignalRole,
      kind: row.kind as RemoteSignal['kind'],
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // The agent side
  // -------------------------------------------------------------------------

  /**
   * Signed grants waiting for this agent.
   *
   * The agent gets the grant, not the session row: everything it needs to
   * decide is inside the signature, so it never has to trust the transport that
   * carried it or the viewer that connects afterwards.
   */
  async pendingGrantsFor(principal: AgentPrincipal): Promise<RemoteGrantEnvelope[]> {
    const agent = await this.prisma.agent.findUnique({ where: { deviceId: principal.deviceId } });
    if (!agent) return [];

    await this.expireStale();
    const sessions = await this.prisma.remoteSession.findMany({
      where: { agentId: agent.id, state: { in: ['pending', 'connecting'] } },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });

    return sessions.map((session) =>
      this.grants.sign({
        sessionId: session.id,
        spaceId: session.spaceId,
        agentId: session.agentId,
        mode: session.mode,
        requestedBy: session.viewerId,
        issuedAt: session.issuedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        nonce: session.nonce,
      }),
    );
  }

  /** The agent reporting that the peer connection came up. */
  async markConnected(
    principal: AgentPrincipal,
    sessionId: string,
    localCandidateType?: string,
    remoteCandidateType?: string,
  ): Promise<{ ok: true }> {
    const session = await this.requireHostSession(principal.userId, sessionId, principal.deviceId);
    if (session.state === 'ended') throw new ConflictException('That session has ended.');

    const now = new Date();
    const updated = await this.prisma.remoteSession.update({
      where: { id: session.id },
      data: {
        state: 'active',
        connectedAt: session.connectedAt ?? now,
        lastSeenAt: now,
        strategy: strategyFromCandidateTypes(localCandidateType, remoteCandidateType),
      },
    });

    this.live.publishToSpace(session.spaceId, {
      type: 'remote.session',
      spaceId: session.spaceId,
      sessionId: session.id,
      agentId: session.agentId,
      state: 'active',
    });

    void updated;
    return { ok: true };
  }

  /**
   * The agent reporting that a view-only session tried to send input.
   *
   * The refusal already happened on the host — this is not a request for
   * permission, it is a notification that someone's client is not the client we
   * shipped. Worth an audit record precisely because it should never occur.
   */
  async reportViolation(
    principal: AgentPrincipal,
    sessionId: string,
    count: number,
  ): Promise<{ ok: true }> {
    const session = await this.requireHostSession(principal.userId, sessionId, principal.deviceId);

    await this.prisma.remoteSession.update({
      where: { id: session.id },
      data: { refusedInputs: { increment: count } },
    });

    await this.audit.record({
      action: 'remote.input.refused',
      outcome: 'denied',
      actorUserId: session.viewerId,
      spaceId: session.spaceId,
      metadata: { sessionId: session.id, agentId: session.agentId, count },
    });

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Ending
  // -------------------------------------------------------------------------

  async endSession(
    userId: string,
    sessionId: string,
    reason: RemoteEndReason,
    context?: RequestContext,
  ): Promise<RemoteSessionSummary> {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('That session was not found.');

    // Either end may hang up, and so may an owner who is neither: it is their
    // Space, and being able to stop a session on your own machine should not
    // depend on which side started it.
    const isViewer = session.viewerId === userId;
    if (!isViewer) {
      await this.spaces.requireOwner(userId, session.spaceId);
    }

    const ended = await this.close(
      session.id,
      reason,
      null,
      isViewer ? userId : session.viewerId,
      context,
    );
    return toSummary(ended, userId);
  }

  /**
   * Closes a session and says why.
   *
   * Idempotent: a viewer hanging up at the same moment the host does should not
   * produce two end records or a 500.
   */
  private async close(
    sessionId: string,
    reason: RemoteEndReason,
    detail: string | null,
    actorUserId?: string,
    context?: RequestContext,
  ): Promise<SessionRow> {
    const current = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    if (!current) throw new NotFoundException('That session was not found.');
    if (current.state === 'ended') return current as SessionRow;

    const ended = await this.prisma.remoteSession.update({
      where: { id: sessionId },
      data: { state: 'ended', endedAt: new Date(), endReason: reason, ...(detail ? {} : {}) },
      include: SESSION_INCLUDE,
    });

    // The signalling messages have no value once the session is over, and they
    // are the only remote-desktop bytes the server ever holds.
    await this.prisma.remoteSignal.deleteMany({ where: { sessionId } });

    await this.audit.record({
      action: 'remote.session.ended',
      outcome: 'success',
      actorUserId: actorUserId ?? current.viewerId,
      spaceId: current.spaceId,
      context,
      metadata: {
        sessionId,
        reason,
        mode: current.mode,
        agentId: current.agentId,
        seconds: current.connectedAt
          ? Math.round((Date.now() - current.connectedAt.getTime()) / 1000)
          : 0,
      },
    });

    this.live.publishToSpace(current.spaceId, {
      type: 'remote.session',
      spaceId: current.spaceId,
      sessionId,
      agentId: current.agentId,
      state: 'ended',
    });

    return ended as SessionRow;
  }

  /**
   * Closes sessions that should no longer be live.
   *
   * Run on every read rather than on a timer, so a control plane that was
   * restarted does not leave a session apparently active because a background
   * job was not running. Four separate conditions, because "still connected"
   * can stop being true in four genuinely different ways.
   */
  async expireStale(now: Date = new Date()): Promise<number> {
    const candidates = await this.prisma.remoteSession.findMany({
      where: { state: { in: ['pending', 'connecting', 'active'] } },
      include: { agent: { select: { lastHeartbeatAt: true } } },
      take: 200,
    });

    let closed = 0;
    for (const session of candidates) {
      let reason: RemoteEndReason | null = null;

      if (session.state !== 'active' && session.expiresAt.getTime() <= now.getTime()) {
        reason = 'connect_timeout';
      } else if (
        session.state === 'connecting' &&
        now.getTime() - session.issuedAt.getTime() > REMOTE_CONNECT_TIMEOUT_SECONDS * 1000
      ) {
        reason = 'connect_timeout';
      } else if (
        now.getTime() - session.lastSeenAt.getTime() >
        REMOTE_IDLE_TIMEOUT_SECONDS * 1000
      ) {
        reason = 'idle_timeout';
      } else if (
        session.connectedAt &&
        now.getTime() - session.connectedAt.getTime() > REMOTE_MAX_DURATION_SECONDS * 1000
      ) {
        reason = 'max_duration';
      } else if (statusFromHeartbeat(session.agent.lastHeartbeatAt, now) !== 'online') {
        reason = 'host_offline';
      }

      if (reason) {
        await this.close(session.id, reason, null);
        closed += 1;
      }
    }
    return closed;
  }

  /**
   * Ends every live session belonging to a device.
   *
   * Called when a device is revoked. A revoked device losing its API access
   * while its peer connection keeps streaming a screen would make revocation a
   * half-measure, and revocation is the one control a person reaches for when
   * something has actually gone wrong.
   */
  async endSessionsForDevice(deviceId: string): Promise<number> {
    const sessions = await this.prisma.remoteSession.findMany({
      where: { viewerDeviceId: deviceId, state: { in: ['pending', 'connecting', 'active'] } },
      select: { id: true },
    });
    for (const session of sessions) {
      await this.close(session.id, 'permission_revoked', null);
    }
    return sessions.length;
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  private async requireViewerSession(userId: string, sessionId: string): Promise<SessionRow> {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    // A session that is not yours is not distinguishable from one that does not
    // exist, so a session id cannot be probed for.
    if (!session || session.viewerId !== userId) {
      throw new NotFoundException('That session was not found.');
    }
    return session as SessionRow;
  }

  /**
   * The host side, addressed either by the agent itself or by the space owner.
   *
   * When an agent calls, `deviceId` is supplied and the session must belong to
   * *that* agent — an agent authenticating successfully says nothing about
   * which computer a session was for.
   */
  private async requireHostSession(
    userId: string,
    sessionId: string,
    deviceId?: string,
  ): Promise<SessionRow> {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { ...SESSION_INCLUDE, agent: { include: { device: { select: { name: true } } } } },
    });
    if (!session) throw new NotFoundException('That session was not found.');

    if (deviceId) {
      const agent = await this.prisma.agent.findUnique({ where: { deviceId } });
      if (!agent || agent.id !== session.agentId) {
        throw new NotFoundException('That session was not found.');
      }
      return session as SessionRow;
    }

    await this.spaces.requireOwner(userId, session.spaceId);
    return session as SessionRow;
  }
}

function toSummary(session: SessionRow, viewerId: string): RemoteSessionSummary {
  return {
    id: session.id,
    spaceId: session.spaceId,
    agentId: session.agentId,
    agentName: session.agent.device.name,
    mode: session.mode,
    state: session.state,
    viewerName: session.viewer.name,
    isMine: session.viewerId === viewerId,
    strategy: session.strategy as ConnectionStrategy,
    startedAt: session.issuedAt.toISOString(),
    connectedAt: session.connectedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    endReason: (session.endReason as RemoteEndReason | null) ?? null,
    expiresAt: session.expiresAt.toISOString(),
  };
}
