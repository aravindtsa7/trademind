import assert from 'node:assert/strict';
import test from 'node:test';
import { isAtOrAfterIstSessionEnd, IstSessionEodCoordinator } from './ist-market-session-eod.service';

const ist = (time: string) => new Date(`2026-08-12T${time}+05:30`);

test('IST derivatives session remains open at 15:39:59 and enters EOD at 15:40:00', () => {
  assert.equal(isAtOrAfterIstSessionEnd(ist('15:39:59')), false);
  assert.equal(isAtOrAfterIstSessionEnd(ist('15:40:00')), true);
});

test('EOD coordinator executes shutdown and summary only once despite repeated late events', async () => {
  const coordinator = new IstSessionEodCoordinator(); let calls = 0;
  assert.equal(await coordinator.runOnce(ist('15:39:59'), () => { calls += 1; }), false);
  await Promise.all([coordinator.runOnce(ist('15:40:00'), () => { calls += 1; }), coordinator.runOnce(ist('15:41:00'), () => { calls += 1; })]);
  assert.equal(calls, 1);
});
