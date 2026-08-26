/**
 * Injectable clock, matching the existing `now: () => number` /
 * `sleep: (milliseconds: number) => Promise<void>` convention already used
 * by `PaperEntryQuoteWaiterService` and others in this repo.
 */
export interface HistoricalProviderRateLimiterClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const systemClock: HistoricalProviderRateLimiterClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * One shared, reusable minimum-spacing limiter for ALL outbound historical
 * provider requests. Every B-F2 caller (the provider adapter's fetch calls,
 * across every retry attempt) MUST pass through the SAME instance -- a
 * limiter constructed per-worker cannot prevent independent workers from
 * collectively bursting past the provider's real rate policy.
 *
 * Implementation: a single promise chain (`queueTail`) that every
 * `schedule()` call links onto, so calls are admitted to their spacing
 * check strictly in call order -- never a hidden unbounded worker queue,
 * just one finite chained promise. Each admitted call waits out any
 * remaining time until `nextAvailableAt`, then reserves the next slot
 * (`nextAvailableAt = now + minIntervalMs`) before running `task()`. The
 * chain link is always released in a `finally`, so a `task()` that throws
 * can never leave the limiter deadlocked for callers still queued behind it
 * -- their `schedule()` calls still settle (each with its own
 * resolution/rejection), and rate-limiting continues to apply for
 * everything scheduled after.
 */
export default class HistoricalProviderRateLimiterService {
  private queueTail: Promise<void> = Promise.resolve();
  private nextAvailableAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: HistoricalProviderRateLimiterClock = systemClock
  ) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new Error(`HistoricalProviderRateLimiterService requires a non-negative finite minIntervalMs; received ${minIntervalMs}.`);
    }
  }

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    const admitted = this.queueTail;
    let releaseNext!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });

    await admitted;
    try {
      const waitMs = this.nextAvailableAt - this.clock.now();
      if (waitMs > 0) {
        await this.clock.sleep(waitMs);
      }
      this.nextAvailableAt = this.clock.now() + this.minIntervalMs;
      return await task();
    } finally {
      releaseNext();
    }
  }
}
