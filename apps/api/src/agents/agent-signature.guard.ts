import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const ALLOWS_UNENROLLED_AGENT = 'netlink:allowsUnenrolledAgent';

/**
 * Marks the one endpoint an agent may call before it exists as a device:
 * enrollment itself.
 *
 * The signature is still verified — the caller must hold the private key for
 * the public key it presents. What is relaxed is only the requirement that the
 * key already be registered, which enrollment is what creates. Authorisation
 * there comes from the owner's short-lived enrollment token instead.
 */
export const AllowsUnenrolledAgent = () => SetMetadata(ALLOWS_UNENROLLED_AGENT, true);

export type AgentPrincipal = {
  deviceId: string;
  userId: string;
  installationId: string;
  publicKey: string;
};

declare module 'express' {
  interface Request {
    agent?: AgentPrincipal;
  }
}

/** How far an agent's clock may drift from ours before its request is refused. */
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

/**
 * Authenticates a request from a NetLink agent by its Ed25519 signature.
 *
 * The agent holds no session and no bearer token — it proves who it is by
 * signing each request with the device private key that never leaves the
 * machine. The signature covers the method, path, timestamp, nonce and a
 * digest of the body, so a captured request cannot be replayed against a
 * different endpoint or with different content.
 *
 * Three independent checks have to pass: the signature verifies against the
 * public key registered for that installation, the timestamp is recent, and
 * the nonce has not been used before.
 */
@Injectable()
export class AgentSignatureGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const installationId = header(request, 'x-netlink-installation');
    const publicKeyB64 = header(request, 'x-netlink-public-key');
    const timestamp = header(request, 'x-netlink-timestamp');
    const nonce = header(request, 'x-netlink-nonce');
    const signatureB64 = header(request, 'x-netlink-signature');

    if (!installationId || !publicKeyB64 || !timestamp || !nonce || !signatureB64) {
      throw new UnauthorizedException('This request is not signed.');
    }

    // Timestamp first: it is the cheapest check and it bounds how long a
    // captured request stays interesting at all.
    const sentAt = new Date(timestamp);
    if (Number.isNaN(sentAt.getTime())) {
      throw new UnauthorizedException('This request has an invalid timestamp.');
    }
    const skewSeconds = Math.abs(Date.now() - sentAt.getTime()) / 1000;
    if (skewSeconds > MAX_TIMESTAMP_SKEW_SECONDS) {
      throw new UnauthorizedException('This request is too old or too far in the future.');
    }

    // The signature is verified against the key *presented*, and the presented
    // key must then match the one registered for this installation. Doing it
    // this way means a forged signature and an unknown key are both refused,
    // and neither check can be skipped by omitting the other.
    const body = rawBody(request);
    const signingInput = buildSigningInput(
      request.method,
      signedPath(request),
      timestamp,
      nonce,
      body,
    );

    if (!verifyEd25519(publicKeyB64, signingInput, signatureB64)) {
      throw new UnauthorizedException('This request signature is not valid.');
    }

    const device = await this.prisma.device.findUnique({
      where: { publicKey: publicKeyB64 },
      select: {
        id: true,
        userId: true,
        installationId: true,
        publicKey: true,
        revokedAt: true,
      },
    });

    const allowsUnenrolled = this.reflector.getAllAndOverride<boolean>(ALLOWS_UNENROLLED_AGENT, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (device) {
      if (device.installationId !== installationId) {
        throw new UnauthorizedException('This device is not enrolled.');
      }
      if (device.revokedAt) {
        // A revoked agent must be told plainly, because its correct response is
        // to forget its identity rather than keep retrying.
        throw new UnauthorizedException('This device was revoked by its owner.');
      }
    } else if (!allowsUnenrolled) {
      throw new UnauthorizedException('This device is not enrolled.');
    }

    // Nonce last, so a request that fails any earlier check does not consume
    // one — otherwise a forged request could burn a nonce the real agent needs.
    const consumed = await this.consumeNonce(nonce, sentAt);
    if (!consumed) {
      throw new UnauthorizedException('This request has already been used.');
    }

    request.agent = device
      ? {
          deviceId: device.id,
          userId: device.userId,
          installationId: device.installationId,
          publicKey: device.publicKey,
        }
      : // Enrolling for the first time: the key is proven, the device row does
        // not exist yet, and the handler creates it.
        { deviceId: '', userId: '', installationId, publicKey: publicKeyB64 };
    return true;
  }

  /**
   * Records the nonce, returning false if it was already there.
   *
   * The unique primary key does the work: two concurrent requests carrying the
   * same nonce cannot both insert, so exactly one wins.
   */
  private async consumeNonce(nonce: string, sentAt: Date): Promise<boolean> {
    const expiresAt = new Date(sentAt.getTime() + MAX_TIMESTAMP_SKEW_SECONDS * 2 * 1000);
    try {
      await this.prisma.requestNonce.create({
        data: { nonce, scope: 'agent', expiresAt },
      });
    } catch {
      return false;
    }

    // Opportunistic sweep so the table cannot grow without bound. Cheap because
    // `expiresAt` is indexed, and harmless if it races with another request.
    if (Math.random() < 0.02) {
      await this.prisma.requestNonce
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch(() => undefined);
    }
    return true;
  }
}

function header(request: Request, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The path the agent signed.
 *
 * The agent signs the route without the global `/api` prefix, because that
 * prefix is a deployment detail it should not have to know about.
 */
function signedPath(request: Request): string {
  const url = request.originalUrl.split('?')[0] ?? '';
  return url.replace(/^\/api/, '');
}

/**
 * The exact bytes the agent signed.
 *
 * Express has already parsed the body, so it is re-serialised here. That is
 * safe only because both sides use `JSON.stringify` on the same object shape
 * with no key reordering — which is why `rawBody` prefers the captured raw
 * buffer when one is available.
 */
export function buildSigningInput(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): Buffer {
  const digest = createHash('sha256').update(body).digest();
  const header = [
    'netlink.agent.v1',
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    digest.toString('base64url'),
  ].join('\n');
  return Buffer.from(header, 'utf8');
}

function rawBody(request: Request): Buffer {
  const captured = (request as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(captured)) return captured;
  if (request.body === undefined || request.body === null) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(request.body), 'utf8');
}

/** Verifies a base64url Ed25519 signature, returning false rather than throwing. */
export function verifyEd25519(
  publicKeyB64: string,
  message: Buffer,
  signatureB64: string,
): boolean {
  try {
    const rawKey = Buffer.from(publicKeyB64, 'base64url');
    if (rawKey.length !== 32) return false;
    const signature = Buffer.from(signatureB64, 'base64url');
    if (signature.length !== 64) return false;

    // Node has no raw-Ed25519 key import, so the 32 bytes are wrapped in the
    // fixed SPKI prefix for Ed25519 (RFC 8410) to build a usable KeyObject.
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });

    return verifySignature(null, message, key, signature);
  } catch {
    return false;
  }
}

export const CurrentAgent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AgentPrincipal => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.agent) throw new UnauthorizedException('This request is not signed.');
    return request.agent;
  },
);
