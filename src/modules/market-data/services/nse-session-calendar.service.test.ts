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
