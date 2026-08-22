import assert from 'node:assert/strict';
import test from 'node:test';
import MarketReplayRunnerService from './market-replay-runner.service';
import { replayEventId } from './market-replay-recorder.service';
import { marketReplaySchemaVersion, MarketReplayEventEnvelope, MarketReplayEventType } from './market-replay.types';
import PaperFillModelService from '../paper-trading/services/paper-fill-model.service';

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

test('recorded replay quote input produces identical shared fill results and output digest', async () => {
  const events = [event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 })]; const fillModel = new PaperFillModelService();
  const evaluate = () => ({ strategy:'V2' as const, evaluated:1, paperFill:fillModel.fill({ side:'BUY', requestedQuantity:10, intentTimestamp:new Date('2026-08-17T03:44:00.000Z'), quote:{ instrumentKey:'NSE_FO|1', sourceTimestamp:'2026-08-17T03:45:00.000Z', receivedTimestamp:'2026-08-17T03:45:00.000Z', quoteAgeMs:0, ltp:100, bestBid:99, bestAsk:101, bidSize:20, askSize:20, depthLevels:[{ bid:99,bidSize:20,ask:101,askSize:20 }], spreadAbsolute:2, spreadPercent:2, connectionGenerationId:1, dataQuality:'FRESH_DEPTH' } }) });
  const runner = new MarketReplayRunnerService(); const first = await runner.run(events, { onReadyEvaluation:evaluate }); const second = await runner.run(events, { onReadyEvaluation:evaluate });
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

// ---- A6 correction (HIGH-3): replay must not assume a hard-coded initial generation ----

test('A6 correction: a recorded generation-0 DISCONNECT before any market event is not discarded, and backfill runs exactly once before a generation-1 tick can unlock readiness', async () => {
  let backfills = 0;
  const events = [
    event('DISCONNECT', '2026-08-17T03:45:00.000Z', { code: 1006 }, { connectionGenerationId: 0 }),
    event('RECONNECT', '2026-08-17T03:45:10.000Z', {}, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    backfill: async () => { backfills += 1; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }; },
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  const trace = new MarketReplayRunnerService();
  await trace.run(events, {
    backfill: async () => ({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }),
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  assert.equal(backfills, 1); // the recorded disconnect forced exactly one backfill before readiness -- it was not discarded as stale
  assert.equal(result.reconnects, 1);
  assert.equal(result.v2Evaluations, 1); // the generation-1 tick was accepted only after the true recovery sequence completed
  const output = trace.getLastOutputTrace();
  assert.ok(output.includes('recovery:DATA_GAP_DETECTED:{"code":1006,"generationId":0}')); // the generation-0 disconnect was processed, not silently pre-empted
  assert.ok(output.some((line) => line.startsWith('recovery:MARKET_DATA_BACKFILL_STARTED:')));
  assert.ok(output.some((line) => line.startsWith('recovery:MARKET_DATA_BACKFILL_COMPLETED:')));
});

test('A6 correction: a tick recorded at generation 1 alone cannot bypass backfill when a real disconnect/reconnect episode preceded it', async () => {
  const events = [
    event('DISCONNECT', '2026-08-17T03:45:00.000Z', { code: 1006 }, { connectionGenerationId: 0 }),
    event('RECONNECT', '2026-08-17T03:45:10.000Z', {}, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    backfill: async () => ({ ready: false, reason: 'MISSING_MINUTE', missingMinutes: 1, duplicateMinutes: 0 }), // backfill fails
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  assert.equal(result.v2Evaluations, 0); // the tick could not unlock readiness without a successful backfill
});

test('A6 correction: a normal full-session replay whose first market event carries a generation other than 1 still reaches readiness -- no dependency on a hard-coded generation', async () => {
  const events = [
    event('SUBSCRIPTION_INTENT', '2026-08-17T03:44:59.000Z', {}, { connectionGenerationId: 7 }),
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { connectionGenerationId: 7 }),
    event('TICK', '2026-08-17T03:46:00.000Z', { ltp: 25010 }, { connectionGenerationId: 7 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  assert.equal(result.v2Evaluations, 2); // both ticks were accepted at their own recorded generation, not silently dropped as stale against a hard-coded generation 1
});

test('A6 correction: replay determinism is preserved for the generation-0-disconnect fixture (two runs produce an identical digest)', async () => {
  const events = [
    event('DISCONNECT', '2026-08-17T03:45:00.000Z', { code: 1006 }, { connectionGenerationId: 0 }),
    event('RECONNECT', '2026-08-17T03:45:10.000Z', {}, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
  ];
  const options = { onReadyEvaluation: () => ({ strategy: 'V2' as const, evaluated: 1 }) };
  const first = await new MarketReplayRunnerService().run(events, options);
  const second = await new MarketReplayRunnerService().run(events, options);
  assert.equal(first.outputDigest, second.outputDigest);
});
