import assert from 'node:assert/strict';
import test from 'node:test';
import HistoricalProviderRateLimiterService, { HistoricalProviderRateLimiterClock } from './historical-provider-rate-limiter.service';

/** Fully deterministic simulated clock: `sleep` advances the clock by exactly the requested amount and resolves immediately, so tests never wait on a real timer. */
class FakeClock implements HistoricalProviderRateLimiterClock {
  private currentTimeMs = 0;
  now(): number {
    return this.currentTimeMs;
  }
  async sleep(milliseconds: number): Promise<void> {
    this.currentTimeMs += milliseconds;
  }
}

test('sequential requests are spaced by at least minIntervalMs', async () => {
  const clock = new FakeClock();
  const limiter = new HistoricalProviderRateLimiterService(1_000, clock);

  const first = await limiter.schedule(async () => clock.now());
  const second = await limiter.schedule(async () => clock.now());
  const third = await limiter.schedule(async () => clock.now());

  assert.deepEqual([first, second, third], [0, 1_000, 2_000]);
});

test('multiple concurrent callers sharing one limiter are still admitted in call order and spaced deterministically', async () => {
  const clock = new FakeClock();
  const limiter = new HistoricalProviderRateLimiterService(1_000, clock);

  const results = await Promise.all([
    limiter.schedule(async () => ({ caller: 'A', at: clock.now() })),
    limiter.schedule(async () => ({ caller: 'B', at: clock.now() })),
    limiter.schedule(async () => ({ caller: 'C', at: clock.now() })),
  ]);

  assert.deepEqual(results, [
    { caller: 'A', at: 0 },
    { caller: 'B', at: 1_000 },
    { caller: 'C', at: 2_000 },
  ]);
});

test('a task with zero spacing requirement (minIntervalMs = 0) never waits', async () => {
  const clock = new FakeClock();
  const limiter = new HistoricalProviderRateLimiterService(0, clock);

  const first = await limiter.schedule(async () => clock.now());
  const second = await limiter.schedule(async () => clock.now());

  assert.deepEqual([first, second], [0, 0]);
});

test('one failed request does not deadlock following callers, and spacing continues to apply after the failure', async () => {
  const clock = new FakeClock();
  const limiter = new HistoricalProviderRateLimiterService(1_000, clock);

  const first = await limiter.schedule(async () => clock.now());

  await assert.rejects(
    limiter.schedule(async () => {
      throw new Error('simulated transient failure');
    }),
    /simulated transient failure/
  );

  const third = await limiter.schedule(async () => clock.now());

  assert.equal(first, 0);
  // The failed slot at t=1000 still reserved the next slot at t=2000 -- a
  // failure consumes its scheduled slot rather than corrupting spacing for
  // callers behind it.
  assert.equal(third, 2_000);
});

test('concurrently-queued callers where an earlier one fails still resolve or reject independently, with later callers unaffected', async () => {
  const clock = new FakeClock();
  const limiter = new HistoricalProviderRateLimiterService(1_000, clock);

  const outcomes = await Promise.allSettled([
    limiter.schedule(async () => clock.now()),
    limiter.schedule(async () => {
      throw new Error('boom');
    }),
    limiter.schedule(async () => clock.now()),
  ]);

  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal((outcomes[0] as PromiseFulfilledResult<number>).value, 0);
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[2].status, 'fulfilled');
  assert.equal((outcomes[2] as PromiseFulfilledResult<number>).value, 2_000);
});

test('rejects a negative minIntervalMs at construction', () => {
  assert.throws(() => new HistoricalProviderRateLimiterService(-1));
});
