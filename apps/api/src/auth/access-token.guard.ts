import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';
import { IS_PUBLIC_KEY } from './public.decorator';

export type AuthenticatedPrincipal = {
  userId: string;
  deviceId: string;
  deviceTrusted: boolean;
};

declare module 'express' {
  interface Request {
    principal?: AuthenticatedPrincipal;
  }
}

/**
 * Verifies the bearer access token and re-checks the device on every request.
 *
 * The token alone is not enough: a device revoked a second ago must stop
 * working immediately, even though its 15-minute access token is still
 * cryptographically valid. That is the whole point of revocation, so the
 * database check is not optional here.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request);
    if (!token) throw new UnauthorizedException('Sign in to continue.');

    const claims = await this.sessions.verifyAccessToken(token);

    const device = await this.prisma.device.findUnique({
      where: { id: claims.did },
      select: { id: true, userId: true, trusted: true, revokedAt: true },
    });

    if (!device || device.revokedAt || device.userId !== claims.sub) {
      throw new UnauthorizedException('This device no longer has access. Please sign in again.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, disabledAt: true },
    });
    if (!user || user.disabledAt) {
      throw new UnauthorizedException('Your session is no longer valid.');
    }

    request.principal = {
      userId: claims.sub,
      deviceId: device.id,
      deviceTrusted: device.trusted,
    };
    return true;
  }
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.principal) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    return request.principal;
  },
);
