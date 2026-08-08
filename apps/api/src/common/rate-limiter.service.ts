import { Injectable } from '@nestjs/common';
import { RateLimitStore, type RateLimitResult } from './rate-limit.store';

export type { RateLimitResult } from './rate-limit.store';

/**
 * The rate limiter every caller uses.
 *
 * It knows nothing about where the counters live — that is the store's job, and
 * which store is in use is a deployment decision rather than a code one. What
 * lives here is the one behaviour every caller relies on: a hit is recorded,
 * and the answer says how long to wait.
 */
@Injectable()
export class RateLimiterService {
  constructor(private readonly store: RateLimitStore) {}

  consume(
    key: string,
    limit: number,
    windowSeconds: number,
    now?: number,
  ): Promise<RateLimitResult> {
    return this.store.consume(key, limit, windowSeconds, now);
  }

  /**
   * Clears a bucket after a legitimate success, so one person's typo streak
   * does not lock them out once they get it right.
   */
  reset(key: string): Promise<void> {
    return this.store.reset(key);
  }

  /** Surfaced on the readiness endpoint so a non-shared store is visible. */
  describe(): { kind: string; shared: boolean } {
    return this.store.describe();
  }
}
