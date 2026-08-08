import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Where rate-limit counters live.
 *
 * The interface is async and the implementations are interchangeable, because
 * the correct answer changes with the deployment: a single instance can count
 * in its own memory, and the moment there are two, counters that do not agree
 * mean the limit is really `limit × replicas`.
 */
export abstract class RateLimitStore {
  abstract consume(
    key: string,
    limit: number,
    windowSeconds: number,
    now?: number,
  ): Promise<RateLimitResult>;

  abstract reset(key: string): Promise<void>;

  /** Describes the store on the health endpoint, so a misconfiguration is visible. */
  abstract describe(): { kind: string; shared: boolean };
}

/**
 * Counters in process memory.
 *
 * Correct for a single instance and nothing else. It is the default because it
 * needs no infrastructure, and the readiness endpoint reports `shared: false`
 * so a two-replica deployment running on it is visible rather than silently
 * enforcing double the intended limit.
 */
@Injectable()
export class MemoryRateLimitStore extends RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
    now = Date.now(),
  ): Promise<RateLimitResult> {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  describe(): { kind: string; shared: boolean } {
    return { kind: 'memory', shared: false };
  }

  /** Drops expired buckets at most once a minute so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Counters in PostgreSQL, shared across every instance.
 *
 * Postgres rather than Redis, deliberately. Redis is the conventional answer
 * and would be faster, but it is another service to run, secure, monitor and
 * fail over — and the thing being stored is a small integer per key per window.
 * The database is already a hard dependency, already backed up, already
 * secured. One `INSERT … ON CONFLICT DO UPDATE … RETURNING` does the whole
 * increment atomically, which is the only property that actually matters here.
 *
 * The point at which this stops being the right call is when auth traffic is
 * high enough that a write per attempt is a meaningful share of database load.
 * That is a long way past where this product is, and the swap is one class.
 */
@Injectable()
export class PostgresRateLimitStore extends RateLimitStore {
  private lastSweep = 0;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
    now = Date.now(),
  ): Promise<RateLimitResult> {
    await this.sweep(now);

    const resetAt = new Date(now + windowSeconds * 1000);
    const nowAt = new Date(now);

    /*
    One statement, so the read and the increment cannot be separated by another
    instance doing the same thing.

    The `CASE` is what makes it a fixed *window* rather than a counter that
    grows forever: if the stored window has already passed, the row is reset to
    1 with a fresh expiry instead of being incremented.
    */
    const rows = await this.prisma.$queryRaw<Array<{ count: number; resetAt: Date }>>`
      INSERT INTO rate_limit_buckets ("key", "count", "resetAt", "updatedAt")
      VALUES (${key}, 1, ${resetAt}, ${nowAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN rate_limit_buckets."resetAt" <= ${nowAt} THEN 1
          ELSE rate_limit_buckets."count" + 1
        END,
        "resetAt" = CASE
          WHEN rate_limit_buckets."resetAt" <= ${nowAt} THEN ${resetAt}
          ELSE rate_limit_buckets."resetAt"
        END,
        "updatedAt" = ${nowAt}
      RETURNING "count", "resetAt"
    `;

    const row = rows[0];
    if (!row) {
      // The insert always returns a row. If it somehow did not, refusing the
      // request is the safe reading — a rate limiter that fails open is not one.
      return { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds };
    }

    if (row.count > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((row.resetAt.getTime() - now) / 1000)),
      };
    }
    return { allowed: true, remaining: limit - row.count, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    await this.prisma.rateLimitBucket.deleteMany({ where: { key } });
  }

  describe(): { kind: string; shared: boolean } {
    return { kind: 'postgres', shared: true };
  }

  /** Expired rows are dead weight; swept at most once a minute per instance. */
  private async sweep(now: number): Promise<void> {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    await this.prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lte: new Date(now) } } });
  }
}
