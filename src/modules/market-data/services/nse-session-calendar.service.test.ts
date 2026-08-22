import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NseSessionCalendar,
  NseSessionClock,
  NseSessionEodCoordinator,
  isAtOrAfterNseSessionClose,
  isWithinNseSession,
} from './nse-session-calendar.service';

const ist = (date: string, time: string) => new Date(`${date}T${time}+05:30`);

test('central NSE derivatives boundary is explicit IST: 15:39:59 active and 15:40:00 EOD', () => {
  assert.equal(isWithinNseSession(ist('2026-08-17', '15:39:59')), true);
  assert.equal(isAtOrAfterNseSessionClose(ist('2026-08-17', '15:39:59')), false);
  assert.equal(isAtOrAfterNseSessionClose(ist('2026-08-17', '15:40:00')), true);
  // UTC date differs, proving the policy uses Asia/Kolkata rather than host time.
  assert.equal(isWithinNseSession(new Date('2026-08-17T10:09:59.000Z')), true);
});

test('calendar supports deterministic holiday and special early-close overrides without a network dependency', () => {
  const calendar = new NseSessionCalendar({ overrides: {
    '2026-08-18': { closed: true, note: 'LOCAL_TEST_HOLIDAY' },
    '2026-08-19': { closeIst: '13:00', note: 'LOCAL_TEST_EARLY_CLOSE' },
  } });
  assert.equal(calendar.isWithinSession(ist('2026-08-18', '10:00:00')), false);
  assert.equal(calendar.isAtOrAfterClose(ist('2026-08-19', '12:59:59')), false);
  assert.equal(calendar.isAtOrAfterClose(ist('2026-08-19', '13:00:00')), true);
});

test('wall-clock timer reaches EOD exactly once without any market tick', async () => {
  let now = ist('2026-08-17', '15:39:59'); let callback: (() => void) | undefined;
  const clock: NseSessionClock = {
    now: () => now,
    setTimeout: (fn, delay) => { assert.equal(delay, 1_000); callback = fn; return {} as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { callback = undefined; },
  };
  const coordinator = new NseSessionEodCoordinator(undefined, clock); let calls = 0;
  coordinator.schedule(() => { calls += 1; });
  now = ist('2026-08-17', '15:40:00'); callback!(); callback!();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
});

test('scheduling after the weekday close uses one deterministic zero-delay EOD action', async () => {
  let callback: (() => void) | undefined;
  const clock: NseSessionClock = {
    now: () => ist('2026-08-17', '15:40:01'),
    setTimeout: (fn, delay) => { assert.equal(delay, 0); callback = fn; return {} as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { callback = undefined; },
  };
  const coordinator = new NseSessionEodCoordinator(undefined, clock); let calls = 0;
  coordinator.schedule(() => { calls += 1; }); callback!(); callback!();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
});

test('intentional shutdown cancels the scheduled EOD action', async () => {
  let callback: (() => void) | undefined;
  const clock: NseSessionClock = {
    now: () => ist('2026-08-17', '15:39:59'),
    setTimeout: (fn) => { callback = fn; return {} as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { callback = undefined; },
  };
  const coordinator = new NseSessionEodCoordinator(undefined, clock); let calls = 0;
  coordinator.schedule(() => { calls += 1; }); coordinator.cancelScheduled();
  assert.equal(callback, undefined);
  await Promise.resolve();
  assert.equal(calls, 0);
});

/**
 * Fix A fake clock: unlike the single-`callback`-variable mocks above, an
 * early-fire re-arm needs to track a genuine registry of live timers (each
 * `setTimeout` call gets its own handle) so tests can fire a specific timer,
 * assert exactly one is pending, and re-invoke an already-fired closure to
 * prove it is inert -- all without any real sleep.
 */
function fakeClock(initialNow: Date) {
  let now = initialNow;
  const pending = new Map<ReturnType<typeof setTimeout>, { fn: () => void; delay: number }>();
  const clock: NseSessionClock = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      pending.set(handle, { fn, delay });
      return handle;
    },
    clearTimeout: (handle) => { pending.delete(handle); },
  };
  return {
    clock,
    setNow: (value: Date) => { now = value; },
    pendingCount: () => pending.size,
    pendingDelay: (): number => {
      if (pending.size !== 1) throw new Error(`expected exactly one pending timer, found ${pending.size}`);
      return [...pending.values()][0]!.delay;
    },
    /** Fires the single pending timer and returns its callback so a test can re-invoke a stale closure. */
    fireOnly: (): (() => void) => {
      if (pending.size !== 1) throw new Error(`expected exactly one pending timer, found ${pending.size}`);
      const [handle, entry] = [...pending.entries()][0]!;
      pending.delete(handle);
      entry.fn();
      return entry.fn;
    },
  };
}

test('Fix A / early-fire A+B: a callback that fires before the canonical close re-arms exactly one follow-up timer for the remaining delay, then that follow-up fires the action exactly once at close', async () => {
  const helper = fakeClock(ist('2026-08-17', '15:39:00'));
  const coordinator = new NseSessionEodCoordinator(undefined, helper.clock);
  let calls = 0;
  coordinator.schedule(() => { calls += 1; });
  assert.equal(helper.pendingDelay(), 60_000);

  // Callback #1 fires ~200ms before the canonical 15:40:00 close (clock
  // skew / borderline scheduling). The action must not run yet.
  helper.setNow(ist('2026-08-17', '15:39:59.800'));
  helper.fireOnly();
  assert.equal(calls, 0);
  assert.equal(helper.pendingCount(), 1);
  assert.equal(helper.pendingDelay(), 200);

  // Follow-up callback at exactly 15:40:00 -> action runs exactly once.
  helper.setNow(ist('2026-08-17', '15:40:00'));
  helper.fireOnly();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(helper.pendingCount(), 0);
});

test('Fix A / early-fire C: invoking an already-fired early callback a second time does not arm a second follow-up timer', () => {
  const helper = fakeClock(ist('2026-08-17', '15:39:59.800'));
  const coordinator = new NseSessionEodCoordinator(undefined, helper.clock);
  let calls = 0;
  coordinator.schedule(() => { calls += 1; });
  assert.equal(helper.pendingDelay(), 200);

  const staleCallback = helper.fireOnly(); // early -> re-arms follow-up, does not run
  assert.equal(calls, 0);
  assert.equal(helper.pendingCount(), 1);

  staleCallback(); // duplicate invocation of the same already-fired closure
  assert.equal(helper.pendingCount(), 1); // still exactly one active follow-up timer, not two
  assert.equal(calls, 0);
});

test('Fix A / early-fire D: cancelScheduled() after an early re-arm cancels the active follow-up timer and EOD never runs', async () => {
  const helper = fakeClock(ist('2026-08-17', '15:39:59.800'));
  const coordinator = new NseSessionEodCoordinator(undefined, helper.clock);
  let calls = 0;
  coordinator.schedule(() => { calls += 1; });

  helper.fireOnly(); // early -> re-arms follow-up
  assert.equal(helper.pendingCount(), 1);
  coordinator.cancelScheduled();
  assert.equal(helper.pendingCount(), 0);

  helper.setNow(ist('2026-08-17', '15:40:00'));
  await Promise.resolve();
  assert.equal(calls, 0); // nothing left armed; EOD does not run after cancellation
});

test('Fix A / early-fire E: an on-time callback (no early fire) still runs the action exactly once', async () => {
  const helper = fakeClock(ist('2026-08-17', '15:39:00'));
  const coordinator = new NseSessionEodCoordinator(undefined, helper.clock);
  let calls = 0;
  coordinator.schedule(() => { calls += 1; });
  assert.equal(helper.pendingDelay(), 60_000);

  helper.setNow(ist('2026-08-17', '15:40:00'));
  helper.fireOnly();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(helper.pendingCount(), 0); // no follow-up left armed
});

test('Fix A / early-fire F: a late start (already past close) keeps zero-delay scheduling and runs exactly once, with no follow-up timer left armed', async () => {
  const helper = fakeClock(ist('2026-08-17', '15:40:05'));
  const coordinator = new NseSessionEodCoordinator(undefined, helper.clock);
  let calls = 0;
  coordinator.schedule(() => { calls += 1; });
  assert.equal(helper.pendingDelay(), 0);

  helper.fireOnly();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(helper.pendingCount(), 0);
});

test('Fix A / exactly-once proof: early re-arm, follow-up firing, a stale duplicate callback, and a concurrent manual runOnce trigger all resolve to a single EOD execution', async () => {
  const helper = fakeClock(ist('2026-08-17', '15:39:59.800'));
  const coordinator = new NseSessionEodCoordinator(undefined, helper.clock);
  let calls = 0;
  const action = () => { calls += 1; };
  coordinator.schedule(action);

  const staleCallback = helper.fireOnly(); // early -> re-arm, no run
  assert.equal(calls, 0);

  helper.setNow(ist('2026-08-17', '15:40:00'));
  // A concurrent manual/tick-driven EOD trigger races the follow-up timer,
  // exactly like V2/V4/V8's MARKET_EOD tick backstop racing the wall-clock
  // coordinator's own follow-up firing.
  const manualTrigger = coordinator.runOnce(helper.clock.now(), action);
  helper.fireOnly(); // follow-up timer fires at/after close
  staleCallback(); // stale original callback invoked again -- must remain inert

  await manualTrigger;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
});
