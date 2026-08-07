import { Injectable } from '@nestjs/common';

type Bucket = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Fixed-window rate limiter held in process memory.
 *
 * This is deliberately simple and deliberately per-instance. It is enough to
 * blunt credential stuffing and OTP brute force against a single-instance
 * deployment, which is what the MVP ships. Phase 7 replaces the storage with a
 * shared store (Redis) so limits hold across replicas — the interface here is
 * what that swap has to satisfy, and nothing outside this class knows where the
 * counters live.
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  /**
   * Records one hit against `key` and reports whether it is within `limit` for
   * the current `windowSeconds` window.
   */
  consume(key: string, limit: number, windowSeconds: number, now = Date.now()): RateLimitResult {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + windowSeconds * 1000;
      this.buckets.set(key, { count: 1, resetAt });
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

  /** Clears a bucket after a legitimate success, so one user's typo streak does not lock them out. */
  reset(key: string): void {
    this.buckets.delete(key);
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
