import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicReplayClock } from './market-replay-clock';

test('replay clock advances scheduled callbacks only as event time advances', () => {
  const clock = new DeterministicReplayClock();
  const fired: string[] = [];
  clock.advanceTo(new Date('2026-08-17T03:45:00.000Z'));
  clock.setTimeout(() => fired.push(clock.now().toISOString()), 1_000);
  clock.advanceTo(new Date('2026-08-17T03:45:00.999Z'));
  assert.deepEqual(fired, []);
  clock.advanceTo(new Date('2026-08-17T03:45:01.000Z'));
  assert.deepEqual(fired, ['2026-08-17T03:45:01.000Z']);
});
