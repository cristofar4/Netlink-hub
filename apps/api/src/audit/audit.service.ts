import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction, AuditOutcome, AuditRecord } from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../common/request-context';

export type AuditInput = {
  action: AuditAction;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  targetDeviceId?: string | null;
  spaceId?: string | null;
  context?: RequestContext | null;
  metadata?: Record<string, string | number | boolean | null> | null;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one audit record.
   *
   * Auditing must never be the reason a legitimate request fails, so a write
   * failure is logged loudly and swallowed. It must also never be a channel for
   * sensitive data, so metadata is scrubbed on the way in.
   */
  async record(input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          action: input.action,
          outcome: input.outcome,
          actorUserId: input.actorUserId ?? null,
          actorDeviceId: input.actorDeviceId ?? null,
          targetDeviceId: input.targetDeviceId ?? null,
          spaceId: input.spaceId ?? null,
          ipAddress: input.context?.ipAddress ?? null,
          userAgent: input.context?.userAgent ?? null,
          approximateLocation: input.context?.approximateLocation ?? null,
          metadata: scrubMetadata(input.metadata),
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write audit event ${input.action}: ${(error as Error).message}`);
    }
  }

  async listForUser(
    userId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await this.prisma.auditEvent.findMany({
      where: { actorUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map(toRecord),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}

/**
 * Audit metadata is small structured detail, never content. Anything that looks
 * like a secret is dropped rather than written, so a careless call site cannot
 * turn the audit log into a credential store.
 */
const FORBIDDEN_METADATA_KEYS = [
  'password',
  'code',
  'otp',
  'token',
  'secret',
  'privatekey',
  'private_key',
  'authorization',
  'cookie',
  'content',
  'body',
];

export function scrubMetadata(
  metadata: Record<string, string | number | boolean | null> | null | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const normalised = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEYS.some((forbidden) => normalised.includes(forbidden))) continue;
    clean[key] = typeof value === 'string' ? value.slice(0, 256) : value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

type AuditRow = {
  id: string;
  action: string;
  outcome: string;
  createdAt: Date;
  actorUserId: string | null;
  actorDeviceId: string | null;
  targetDeviceId: string | null;
  spaceId: string | null;
  approximateLocation: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
};

function toRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    action: row.action as AuditAction,
    outcome: row.outcome as AuditOutcome,
    createdAt: row.createdAt.toISOString(),
    actorUserId: row.actorUserId,
    actorDeviceId: row.actorDeviceId,
    targetDeviceId: row.targetDeviceId,
    spaceId: row.spaceId,
    approximateLocation: row.approximateLocation,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    metadata: (row.metadata as AuditRecord['metadata']) ?? null,
  };
}
