import assert from 'node:assert/strict';
import test from 'node:test';
import MarketReplayRunnerService from './market-replay-runner.service';
import { replayEventId } from './market-replay-recorder.service';
import { marketReplaySchemaVersion, MarketReplayEventEnvelope, MarketReplayEventType } from './market-replay.types';

const nifty = 'NSE_INDEX|Nifty 50';
function event(type: MarketReplayEventType, receivedTimestamp: string, payload: Record<string, unknown> = {}, overrides: Partial<MarketReplayEventEnvelope> = {}): MarketReplayEventEnvelope {
  const base = { schemaVersion: marketReplaySchemaVersion, eventType: type, instrumentKey: type === 'TICK' || type === 'SUBSCRIPTION_INTENT' ? nifty : null, sourceTimestamp: type === 'TICK' ? receivedTimestamp : null, receivedTimestamp, sequenceNumber: null, connectionGenerationId: 1, runtimeId: 'test', sessionId: '2026-08-17', payload };
  return { ...base, ...overrides, eventId: overrides.eventId ?? replayEventId({ ...base, ...overrides }) } as MarketReplayEventEnvelope;
}

test('identical full-session input produces the same digest, with no network surface', async () => {
  delete process.env.MARKET_REPLAY_RECORD;
  const events = [
    event('SUBSCRIPTION_INTENT', '2026-08-17T03:44:59.000Z'),
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }),
    event('TICK', '2026-08-17T03:46:00.000Z', { ltp: 25010 }),
    event('EOD', '2026-08-17T10:00:00.000Z'),
  ];
  let evaluations = 0;
  const runner = new MarketReplayRunnerService();
  const first = await runner.run(events, { onReadyEvaluation: () => { evaluations += 1; return { strategy: 'V2', evaluated: 1, signals: 1, riskDecision: 'APPROVED' }; } });
  const second = await runner.run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1, signals: 1, riskDecision: 'APPROVED' }) });
  assert.equal(first.outputDigest, second.outputDigest);
  assert.equal(first.v2Evaluations, 2);
  assert.equal(first.v2Signals, 2);
  assert.equal(first.riskApprovals, 2);
  assert.equal(first.candleCounts['1m'], 2);
  assert.equal(first.eodEvents, 1);
  assert.equal(evaluations, 2);
});

test('an in-memory portfolio digest is included deterministically in replay output', async () => {
  const events = [event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 })];
  const runner = new MarketReplayRunnerService();
  const first = await runner.run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1, portfolioDigest: 'portfolio-state-v1' }) });
  const second = await runner.run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1, portfolioDigest: 'portfolio-state-v1' }) });
  assert.equal(first.outputDigest, second.outputDigest);
});

test('FULL_SESSION refuses to fabricate warm-up state and accepts an explicit local fixture', async () => {
  const events = [event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 })];
  const runner = new MarketReplayRunnerService();
  await assert.rejects(() => runner.run(events, { initialState: { mode: 'FULL_SESSION' } }));
  let loaded = false;
  await runner.run(events, { initialState: { mode: 'FULL_SESSION', warmupFixture: () => { loaded = true; } } });
  assert.equal(loaded, true);
});

test('duplicate, stale-generation and recovery events are deterministic and gated until fresh tick', async () => {
  const events = [
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { connectionGenerationId: 1, eventId: 'duplicate-packet' }),
    event('DISCONNECT', '2026-08-17T03:46:00.000Z', { code: 1006 }, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:46:10.000Z', { ltp: 25005 }, { connectionGenerationId: 1 }),
    event('RECONNECT', '2026-08-17T03:46:20.000Z', {}, { connectionGenerationId: 2 }),
    event('TICK', '2026-08-17T03:46:30.000Z', { ltp: 25008 }, { connectionGenerationId: 2 }),
    event('TICK', '2026-08-17T03:46:40.000Z', { ltp: 24999 }, { connectionGenerationId: 1 }),
    event('EOD', '2026-08-17T10:00:00.000Z'),
    event('EOD', '2026-08-17T10:00:01.000Z', {}, { eventId: 'duplicate-eod' }),
  ];
  const observed: string[] = [];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: (input) => { observed.push(input.sourceTimestamp ?? ''); return { strategy: 'V4', evaluated: 1 }; } });
  assert.equal(result.duplicateEvents, 2);
  assert.equal(result.reconnects, 1);
  assert.equal(result.eodEvents, 1);
  assert.equal(result.v4Evaluations, 2);
  assert.deepEqual(observed, ['2026-08-17T03:45:00.000Z', '2026-08-17T03:46:30.000Z']);
});

test('unrecoverable local backfill fails closed and no strategy callback runs after the disconnect', async () => {
  const events = [
    event('DISCONNECT', '2026-08-17T03:46:00.000Z', { code: 1006 }),
    event('RECONNECT', '2026-08-17T03:46:10.000Z', {}, { connectionGenerationId: 2 }),
    event('TICK', '2026-08-17T03:46:20.000Z', { ltp: 25000 }, { connectionGenerationId: 2 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    backfill: async () => ({ ready: false, reason: 'MISSING_MINUTE', missingMinutes: 1, duplicateMinutes: 0 }),
    onReadyEvaluation: () => ({ strategy: 'V8', evaluated: 1, shadowOutcome: true }),
  });
  assert.equal(result.v8Evaluations, 0);
  assert.equal(result.shadowOutcomes, 0);
});

test('a duplicate V2 signal packet cannot create a second replay risk approval or paper outcome', async () => {
  const events = [
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }),
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { eventId: 'same-v2-signal-again' }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1, signals: 1, riskDecision: 'APPROVED', paperOutcome: true }),
  });
  assert.equal(result.v2Signals, 1);
  assert.equal(result.riskApprovals, 1);
  assert.equal(result.paperOutcomes, 1);
});

test('V4, V8 and V12 replay hooks remain execution-free unless an explicit V2 paper output is supplied', async () => {
  const events = [event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 })];
  const result = await new MarketReplayRunnerService().run(events, {
    onReadyEvaluation: () => ({ strategy: 'V12', evaluated: 1 }),
  });
  assert.equal(result.paperOutcomes, 0);
  assert.equal(result.shadowOutcomes, 0);
  assert.equal(result.v2Signals, 0);
  assert.equal(result.v4Signals, 0);
  assert.equal(result.v8Signals, 0);
});

test('corrupt or schema-incompatible replay artifacts fail closed', async () => {
  const runner = new MarketReplayRunnerService();
  await assert.rejects(() => runner.run([{ ...event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }), schemaVersion: 999 }]));
  await assert.rejects(() => runner.run([event('TICK', 'not-a-time', { ltp: 25000 })]));
});

test('golden comparison identifies the first deterministic output divergence', () => {
  const divergence = new MarketReplayRunnerService().findFirstDivergence(['event:0:a:TICK', 'candle:x'], ['event:0:a:TICK', 'risk:APPROVED']);
  assert.deepEqual(divergence, { eventIndex: 1, component: 'candle', expected: 'candle:x', actual: 'risk:APPROVED' });
});
