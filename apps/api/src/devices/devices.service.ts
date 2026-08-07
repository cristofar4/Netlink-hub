import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedDevice } from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { LiveGateway } from '../live/live.gateway';
import type { RequestContext } from '../common/request-context';
import { toAuthenticatedDevice } from '../auth/auth.service';

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly live: LiveGateway,
  ) {}

  /** Every device on the account, newest first, with the caller's own marked. */
  async list(userId: string, currentDeviceId: string): Promise<AuthenticatedDevice[]> {
    const devices = await this.prisma.device.findMany({
      where: { userId },
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    });
    return devices.map((device) => toAuthenticatedDevice(device, device.id === currentDeviceId));
  }

  async rename(
    userId: string,
    deviceId: string,
    name: string,
    context: RequestContext,
  ): Promise<AuthenticatedDevice> {
    const device = await this.requireOwnDevice(userId, deviceId);
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: { name },
    });

    await this.audit.record({
      action: 'device.renamed',
      outcome: 'success',
      actorUserId: userId,
      actorDeviceId: deviceId,
      context,
      metadata: { previousName: device.name, newName: name },
    });

    return toAuthenticatedDevice(updated);
  }

  /**
   * Revokes one device.
   *
   * Scoped strictly to the one row and its own refresh tokens: every other
   * device on the account keeps working, which is the behaviour an owner
   * expects when removing a lost laptop.
   */
  async revoke(
    userId: string,
    deviceId: string,
    context: RequestContext,
  ): Promise<AuthenticatedDevice> {
    const device = await this.requireOwnDevice(userId, deviceId);

    if (device.revokedAt) {
      return toAuthenticatedDevice(device);
    }

    const revoked = await this.prisma.device.update({
      where: { id: device.id },
      data: { revokedAt: new Date(), trusted: false, trustedAt: null },
    });

    const killedSessions = await this.sessions.revokeDeviceSessions(device.id, 'device_revoked');

    // An open live socket is a channel like any other, so it goes too —
    // otherwise revocation would be immediate for HTTP and not for push.
    this.live.disconnectDevice(device.id);

    // Any pending verification for this device is dead too, so a code already
    // in someone's inbox cannot be used to bring it back.
    await this.prisma.challenge.updateMany({
      where: { deviceId: device.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await this.audit.record({
      action: 'device.revoked',
      outcome: 'success',
      actorUserId: userId,
      actorDeviceId: context ? deviceId : null,
      targetDeviceId: device.id,
      context,
      metadata: { deviceName: device.name, sessionsEnded: killedSessions },
    });

    return toAuthenticatedDevice(revoked);
  }

  private async requireOwnDevice(userId: string, deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('That device was not found.');
    // Not found vs. not yours are both answered as "not found" to callers, but
    // the distinction matters here: a cross-account attempt is a security event.
    if (device.userId !== userId) {
      throw new ForbiddenException('That device does not belong to your account.');
    }
    return device;
  }
}
