import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  GIGABYTE,
  type DataProviderAdapter,
  type ProviderAccount,
  type ProviderAllocation,
  type ProviderBalance,
  type ProviderPlan,
  type ProviderUsage,
} from '@netlink/contracts';

/**
 * The Demo Provider.
 *
 * This moves **no real bytes**. It exists so the Data Pool can be built,
 * demonstrated and tested before a commercial agreement with a telecom, ISP or
 * MVNO exists. `isReal` is false, and every surface that shows a pool reads
 * that flag and labels the pool as a demo — the one thing this fixture must
 * never do is be mistaken for real network usage.
 *
 * It is seeded with a 100 GB balance and generates plausible usage: sessions
 * of a few minutes carrying tens to hundreds of megabytes, weighted towards
 * evenings, because a flat synthetic curve would hide exactly the bugs that
 * bursty usage exposes.
 */
@Injectable()
export class DemoDataProvider implements DataProviderAdapter {
  readonly name = 'demo';
  readonly isReal = false;

  private readonly logger = new Logger(DemoDataProvider.name);

  /** The owner's own plan in this fixture. */
  private static readonly PLAN_BYTES = BigInt(100 * GIGABYTE);

  private readonly allocations = new Map<string, ProviderAllocation & { subscriberRef: string }>();
  private readonly usage = new Map<string, ProviderUsage>();

  async verifyAccount(input: { accountRef: string }): Promise<ProviderAccount> {
    // A real adapter would check the number against the carrier. The demo
    // accepts anything that looks like an account reference and says so.
    const trimmed = input.accountRef.trim();
    return {
      accountRef: trimmed,
      verified: trimmed.length >= 4,
      displayName: trimmed.length >= 4 ? `Demo account ${maskRef(trimmed)}` : null,
    };
  }

  async getBalance(input: { accountRef: string }): Promise<ProviderBalance> {
    const consumed = [...this.usage.values()].reduce(
      (total, entry) => total + BigInt(entry.usedBytes),
      0n,
    );
    const remaining = DemoDataProvider.PLAN_BYTES - consumed;

    return {
      balanceBytes: (remaining > 0n ? remaining : 0n).toString(),
      resetsAt: endOfMonth().toISOString(),
      ...(input.accountRef ? {} : {}),
    };
  }

  async getPlan(_input: { accountRef: string }): Promise<ProviderPlan> {
    const now = new Date();
    return {
      name: 'Demo 100 GB monthly',
      totalBytes: DemoDataProvider.PLAN_BYTES.toString(),
      periodStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      periodEnd: endOfMonth().toISOString(),
    };
  }

  async createAllocation(input: {
    accountRef: string;
    subscriberRef: string;
    totalBytes: string;
    dailyBytes: string | null;
    expiresAt: string;
  }): Promise<ProviderAllocation> {
    const allocation: ProviderAllocation & { subscriberRef: string } = {
      providerAllocationId: `demo-${randomUUID()}`,
      status: 'active',
      totalBytes: input.totalBytes,
      dailyBytes: input.dailyBytes,
      expiresAt: input.expiresAt,
      subscriberRef: input.subscriberRef,
    };
    this.allocations.set(allocation.providerAllocationId, allocation);
    this.usage.set(allocation.providerAllocationId, {
      usedBytes: '0',
      usedTodayBytes: '0',
      events: [],
    });

    this.logger.log(
      `Demo allocation ${allocation.providerAllocationId} created — no real data is being shared`,
    );
    return stripInternal(allocation);
  }

  async updateAllocation(input: {
    providerAllocationId: string;
    totalBytes?: string;
    dailyBytes?: string | null;
    expiresAt?: string;
  }): Promise<ProviderAllocation> {
    const existing = this.requireAllocation(input.providerAllocationId);
    if (input.totalBytes !== undefined) existing.totalBytes = input.totalBytes;
    if (input.dailyBytes !== undefined) existing.dailyBytes = input.dailyBytes;
    if (input.expiresAt !== undefined) existing.expiresAt = input.expiresAt;
    return stripInternal(existing);
  }

  async pauseAllocation(input: {
    providerAllocationId: string;
    paused: boolean;
  }): Promise<ProviderAllocation> {
    const existing = this.requireAllocation(input.providerAllocationId);
    existing.status = input.paused ? 'paused' : 'active';
    return stripInternal(existing);
  }

  async revokeAllocation(input: { providerAllocationId: string }): Promise<void> {
    const existing = this.allocations.get(input.providerAllocationId);
    if (existing) existing.status = 'revoked';
  }

  async getUsage(input: { providerAllocationId: string; since?: string }): Promise<ProviderUsage> {
    const allocation = this.allocations.get(input.providerAllocationId);
    const recorded = this.usage.get(input.providerAllocationId) ?? {
      usedBytes: '0',
      usedTodayBytes: '0',
      events: [],
    };

    // A paused or revoked allocation consumes nothing more, which is the whole
    // point of pausing one.
    if (!allocation || allocation.status !== 'active') return recorded;

    const generated = this.generateSession(allocation, recorded);
    if (generated) {
      recorded.events.push(generated);
      recorded.usedBytes = (BigInt(recorded.usedBytes) + BigInt(generated.bytes)).toString();
      recorded.usedTodayBytes = (
        BigInt(recorded.usedTodayBytes) + BigInt(generated.bytes)
      ).toString();
      this.usage.set(input.providerAllocationId, recorded);
    }

    if (input.since) {
      const cutoff = new Date(input.since).getTime();
      return {
        ...recorded,
        events: recorded.events.filter((event) => new Date(event.occurredAt).getTime() >= cutoff),
      };
    }
    return recorded;
  }

  async handleProviderWebhook(input: {
    signature: string | null;
    rawBody: string;
  }): Promise<Array<{ providerAllocationId: string; usage: ProviderUsage }>> {
    // Even the demo verifies a signature. A real adapter that skipped this
    // would let anyone POST usage and inflate somebody's bill, so the shape of
    // the check is worth establishing here rather than bolting on later.
    const expected = createHash('sha256')
      .update(`demo-webhook.${input.rawBody}`)
      .digest('base64url');

    if (!input.signature || input.signature !== expected) {
      throw new Error('netlink: the demo webhook signature did not verify');
    }

    const payload = JSON.parse(input.rawBody) as {
      allocations?: Array<{ providerAllocationId: string; bytes: string; sessionSeconds?: number }>;
    };

    const results: Array<{ providerAllocationId: string; usage: ProviderUsage }> = [];
    for (const entry of payload.allocations ?? []) {
      const recorded = this.usage.get(entry.providerAllocationId);
      if (!recorded) continue;

      const event = {
        providerRef: `demo-hook-${randomUUID()}`,
        bytes: entry.bytes,
        sessionSeconds: entry.sessionSeconds ?? 60,
        occurredAt: new Date().toISOString(),
      };
      recorded.events.push(event);
      recorded.usedBytes = (BigInt(recorded.usedBytes) + BigInt(entry.bytes)).toString();
      recorded.usedTodayBytes = (BigInt(recorded.usedTodayBytes) + BigInt(entry.bytes)).toString();
      results.push({ providerAllocationId: entry.providerAllocationId, usage: recorded });
    }
    return results;
  }

  /** Test hook: the exact signature the demo webhook expects for a payload. */
  static webhookSignature(rawBody: string): string {
    return createHash('sha256').update(`demo-webhook.${rawBody}`).digest('base64url');
  }

  /** Test hook: resets all fixture state between cases. */
  reset(): void {
    this.allocations.clear();
    this.usage.clear();
  }

  /**
   * Invents one plausible session, or nothing.
   *
   * Weighted towards evenings and capped by what is left, so the fixture
   * produces the bursty, saturating shape that real usage has — which is what
   * exercises the limit and exhaustion paths.
   */
  private generateSession(
    allocation: ProviderAllocation,
    recorded: ProviderUsage,
  ): ProviderUsage['events'][number] | null {
    const remaining = BigInt(allocation.totalBytes) - BigInt(recorded.usedBytes);
    if (remaining <= 0n) return null;

    const hour = new Date().getHours();
    const likelihood = hour >= 18 && hour <= 23 ? 0.8 : hour >= 7 ? 0.45 : 0.1;
    if (Math.random() > likelihood) return null;

    // 20 MB to 400 MB, the range a video call or a few videos actually covers.
    const megabytes = 20 + Math.floor(Math.random() * 380);
    let bytes = BigInt(megabytes) * 1_000_000n;
    if (bytes > remaining) bytes = remaining;

    const dailyLimit = allocation.dailyBytes ? BigInt(allocation.dailyBytes) : null;
    if (dailyLimit) {
      const todayRemaining = dailyLimit - BigInt(recorded.usedTodayBytes);
      if (todayRemaining <= 0n) return null;
      if (bytes > todayRemaining) bytes = todayRemaining;
    }
    if (bytes <= 0n) return null;

    return {
      providerRef: `demo-${randomUUID()}`,
      bytes: bytes.toString(),
      sessionSeconds: 60 + Math.floor(Math.random() * 900),
      occurredAt: new Date().toISOString(),
    };
  }

  private requireAllocation(id: string): ProviderAllocation & { subscriberRef: string } {
    const existing = this.allocations.get(id);
    if (!existing) throw new Error(`netlink: no demo allocation ${id}`);
    return existing;
  }
}

function stripInternal(
  allocation: ProviderAllocation & { subscriberRef: string },
): ProviderAllocation {
  const { subscriberRef: _subscriberRef, ...rest } = allocation;
  return { ...rest };
}

function endOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
}

function maskRef(ref: string): string {
  if (ref.length <= 4) return '•'.repeat(ref.length);
  return `${'•'.repeat(ref.length - 4)}${ref.slice(-4)}`;
}
