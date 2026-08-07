import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { LiveEvent } from '@netlink/contracts';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../prisma/prisma.service';

type Subscriber = {
  socket: WebSocket;
  userId: string;
  deviceId: string;
  /** Spaces this connection is allowed to hear about, resolved at connect. */
  spaceIds: Set<string>;
};

/**
 * Live updates for the desktop app.
 *
 * The dashboard shows whether a computer is online. Polling for that would
 * either be slow to notice or wasteful, so the server pushes the transition
 * when it happens.
 *
 * Nothing is broadcast globally. A connection is authenticated at handshake
 * and joined only to the Spaces that person is a member of, so an event can
 * only ever reach someone already entitled to the state it describes.
 */
@Injectable()
@WebSocketGateway({ path: '/api/live' })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(LiveGateway.name);
  private readonly subscribers = new Map<WebSocket, Subscriber>();

  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const token = extractToken(request);
      if (!token) {
        return closeWith(socket, 4401, 'Sign in to receive live updates.');
      }

      const claims = await this.sessions.verifyAccessToken(token);

      // The token alone is not enough — the device must still be valid, exactly
      // as on every HTTP request. A socket opened just before a revocation must
      // not keep streaming afterwards.
      const device = await this.prisma.device.findUnique({
        where: { id: claims.did },
        select: { id: true, userId: true, revokedAt: true },
      });
      if (!device || device.revokedAt || device.userId !== claims.sub) {
        return closeWith(socket, 4401, 'This device no longer has access.');
      }

      const memberships = await this.prisma.spaceMember.findMany({
        where: { userId: claims.sub, suspended: false },
        select: { spaceId: true },
      });

      this.subscribers.set(socket, {
        socket,
        userId: claims.sub,
        deviceId: device.id,
        spaceIds: new Set(memberships.map((m) => m.spaceId)),
      });

      send(socket, { type: 'ping', at: new Date().toISOString() });
    } catch (error) {
      this.logger.debug(`Live connection refused: ${(error as Error).message}`);
      closeWith(socket, 4401, 'Sign in to receive live updates.');
    }
  }

  handleDisconnect(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  /** Pushes an event to every connection entitled to the Space it concerns. */
  publishToSpace(spaceId: string, event: LiveEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.spaceIds.has(spaceId)) {
        send(subscriber.socket, event);
      }
    }
  }

  /** Pushes to one person across all their open windows. */
  publishToUser(userId: string, event: LiveEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.userId === userId) send(subscriber.socket, event);
    }
  }

  /**
   * Drops every connection held by a device.
   *
   * Called on revocation: an open socket is a live channel, and leaving one
   * running would make revocation less immediate than it claims to be.
   */
  disconnectDevice(deviceId: string): void {
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.deviceId === deviceId) {
        closeWith(subscriber.socket, 4401, 'This device no longer has access.');
        this.subscribers.delete(subscriber.socket);
      }
    }
  }

  /** Adds a Space to a person's open connections, after they join or create one. */
  grantSpaceAccess(userId: string, spaceId: string): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.userId === userId) subscriber.spaceIds.add(spaceId);
    }
  }

  /** Removes a Space from a person's open connections, after access is revoked. */
  revokeSpaceAccess(userId: string, spaceId: string): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.userId === userId) subscriber.spaceIds.delete(spaceId);
    }
  }

  get connectionCount(): number {
    return this.subscribers.size;
  }
}

function extractToken(request: IncomingMessage): string | null {
  // Browsers cannot set headers on a WebSocket handshake, so the token comes in
  // the query string. It is a 15-minute access token, never the refresh token.
  const url = new URL(request.url ?? '/', 'http://localhost');
  const fromQuery = url.searchParams.get('access_token');
  if (fromQuery) return fromQuery;

  const header = request.headers.authorization;
  if (header) {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value;
  }
  return null;
}

function send(socket: WebSocket, event: LiveEvent): void {
  // 1 === OPEN. Writing to a closing socket throws, and a failed push must
  // never take down the request that triggered it.
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    /* the disconnect handler will clean this connection up */
  }
}

function closeWith(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    /* already gone */
  }
}
