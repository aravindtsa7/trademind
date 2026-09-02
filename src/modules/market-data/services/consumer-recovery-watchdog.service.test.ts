import assert from 'node:assert/strict';
import test from 'node:test';
import ConsumerRecoveryWatchdogService, { CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON } from './consumer-recovery-watchdog.service';

class FakeScheduler {
  now = 0;
  private nextId = 0;
  private readonly active = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): number { const id = this.nextId++; this.active.set(id, { at: this.now + delayMs, callback }); return id; }
  clearTimeout(handle: unknown): void { this.active.delete(handle as number); }
  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    let next = [...this.active].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, task]) => task.at <= target);
    while (next) {
      this.active.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      next = [...this.active].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, task]) => task.at <= target);
    }
    this.now = target;
  }
  activeCount(): number { return this.active.size; }
}

function harness(budgetMs = 1_000): { scheduler: FakeScheduler; watchdog: ConsumerRecoveryWatchdogService; timeouts: string[] } {
  const scheduler = new FakeScheduler();
  const timeouts: string[] = [];
  const watchdog = new ConsumerRecoveryWatchdogService({
    budgetMs,
    onTimeout: (reason) => timeouts.push(reason),
    now: () => scheduler.now,
    setTimeoutFn: (cb, ms) => scheduler.setTimeout(cb, ms),
    clearTimeoutFn: (handle) => scheduler.clearTimeout(handle),
  });
  return { scheduler, watchdog, timeouts };
}

test('an unresolved episode faults exactly at its own budget', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('DEGRADED');
  scheduler.advanceBy(999);
  assert.equal(timeouts.length, 0);
  scheduler.advanceBy(1);
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('hung backfill (state never leaves BACKFILLING) faults at the deadline', () => {
  const { scheduler, watchdog, timeouts } = harness(500);
  watchdog.onStateChanged('RECONNECTING');
  watchdog.onStateChanged('BACKFILLING');
  scheduler.advanceBy(500);
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('no-fresh-tick (state parks at WAITING_FOR_FRESH_TICK) faults at the deadline', () => {
  const { scheduler, watchdog, timeouts } = harness(500);
  watchdog.onStateChanged('RECONNECTING');
  watchdog.onStateChanged('BACKFILLING');
  watchdog.onStateChanged('WAITING_FOR_FRESH_TICK');
  scheduler.advanceBy(500);
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('repeated physical reconnects during one unresolved episode do not restart the deadline', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('DEGRADED');
  watchdog.onStateChanged('RECONNECTING');
  scheduler.advanceBy(600);
  // A second physical generation advance while still unresolved -- must NOT push the deadline out.
  watchdog.onStateChanged('DEGRADED');
  watchdog.onStateChanged('RECONNECTING');
  watchdog.onStateChanged('CONNECTED');
  watchdog.onStateChanged('BACKFILLING');
  scheduler.advanceBy(399);
  assert.equal(timeouts.length, 0);
  scheduler.advanceBy(1); // total elapsed 1000ms from the FIRST DEGRADED, not the second
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('reaching READY before the deadline cancels the timer cleanly', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('DEGRADED');
  watchdog.onStateChanged('RECONNECTING');
  scheduler.advanceBy(500);
  watchdog.onStateChanged('READY');
  assert.equal(scheduler.activeCount(), 0);
  scheduler.advanceBy(1_000);
  assert.equal(timeouts.length, 0);
});

test('reaching SOURCE_COMPLETE_READY before the deadline cancels the timer cleanly', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('RECONNECTING');
  scheduler.advanceBy(200);
  watchdog.onStateChanged('SOURCE_COMPLETE_READY');
  scheduler.advanceBy(1_000);
  assert.equal(timeouts.length, 0);
});

test('late resolution after the deadline already fired does not resurrect / re-cancel anything harmful', () => {
  const { scheduler, watchdog, timeouts } = harness(500);
  watchdog.onStateChanged('BACKFILLING');
  scheduler.advanceBy(500);
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
  // A late READY arriving after the fault fired must be a harmless no-op, not a second callback.
  watchdog.onStateChanged('READY');
  scheduler.advanceBy(10_000);
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('a stale timer cannot fault a later, distinct recovery episode', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('DEGRADED');
  scheduler.advanceBy(400);
  watchdog.onStateChanged('READY'); // episode 1 resolves, clears/invalidates its timer
  watchdog.onStateChanged('DEGRADED'); // episode 2 begins, fresh deadline
  scheduler.advanceBy(400);
  assert.equal(timeouts.length, 0); // only 400ms into episode 2's own 1000ms budget
  scheduler.advanceBy(600);
  assert.deepEqual(timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('terminal state (FAULTED) clears the timer idempotently', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('RECONNECTING');
  watchdog.onStateChanged('FAULTED');
  assert.equal(scheduler.activeCount(), 0);
  scheduler.advanceBy(2_000);
  assert.equal(timeouts.length, 0);
});

test('stop() cancels a pending timer so it can never fire after strategy termination', () => {
  const { scheduler, watchdog, timeouts } = harness(1_000);
  watchdog.onStateChanged('DEGRADED');
  watchdog.stop();
  assert.equal(scheduler.activeCount(), 0);
  scheduler.advanceBy(5_000);
  assert.equal(timeouts.length, 0);
});

test('two independent watchdog instances (e.g. V4 vs V8) never influence one another', () => {
  const v4 = harness(900); // e.g. V4-style longer budget
  const v8 = harness(120); // e.g. V8-style shorter budget
  v4.watchdog.onStateChanged('BACKFILLING');
  v8.watchdog.onStateChanged('BACKFILLING');
  v8.scheduler.advanceBy(120);
  assert.deepEqual(v8.timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
  assert.equal(v4.timeouts.length, 0); // V8 faulting must not affect V4's own independent budget
  v4.scheduler.advanceBy(900);
  assert.deepEqual(v4.timeouts, [CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON]);
});

test('budgetMs must be a positive finite number', () => {
  assert.throws(() => new ConsumerRecoveryWatchdogService({ budgetMs: 0, onTimeout: () => undefined }), /positive finite/);
  assert.throws(() => new ConsumerRecoveryWatchdogService({ budgetMs: -5, onTimeout: () => undefined }), /positive finite/);
  assert.throws(() => new ConsumerRecoveryWatchdogService({ budgetMs: NaN, onTimeout: () => undefined }), /positive finite/);
});
