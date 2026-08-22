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

// ---- Post-A6 replay hardening: RECONNECT-first artifacts (no preceding DISCONNECT recorded) ----

test('replay hardening: a RECONNECT-first artifact runs a real recovery episode and does not silently drop its own recorded-generation ticks', async () => {
  let backfills = 0;
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25005 }, { connectionGenerationId: 5 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    backfill: async () => { backfills += 1; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0 }; },
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  assert.equal(backfills, 1); // the leading RECONNECT still went through a real (single) recovery episode
  assert.equal(result.reconnects, 1);
  assert.equal(result.v2Evaluations, 2); // both generation-5 ticks were accepted, not run over as stale
  assert.deepEqual(result.dataQualityWarnings, []);
});

test('replay hardening: the same RECONNECT-first shape at generation 1 behaves identically, proving no dependence on a specific generation number', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25005 }, { connectionGenerationId: 1 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.reconnects, 1);
  assert.equal(result.v2Evaluations, 2);
});

test('replay hardening: a failing backfill still gates a RECONNECT-first tick, exactly as it gates the DISCONNECT-first case', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, {
    backfill: async () => ({ ready: false, reason: 'MISSING_MINUTE', missingMinutes: 1, duplicateMinutes: 0 }),
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  assert.equal(result.v2Evaluations, 0); // no accidental fast-path around backfill just because the DISCONNECT wasn't recorded
});

test('replay hardening: metadata events preceding the first market event do not corrupt generation seeding', async () => {
  const events = [
    event('SUBSCRIPTION_INTENT', '2026-08-17T03:44:00.000Z', {}, { connectionGenerationId: 9 }),
    event('CONNECTION_STATE', '2026-08-17T03:44:30.000Z', { previousState: 'CONNECTING', state: 'CONNECTED' }, { connectionGenerationId: 9 }),
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { connectionGenerationId: 9 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 1);
  assert.deepEqual(result.dataQualityWarnings, []);
});

test('replay hardening: a DEPTH event before the first TICK establishes generation context without granting tick-based readiness by itself', async () => {
  const events = [
    event('DEPTH', '2026-08-17T03:45:00.000Z', { quotes: [] }, { connectionGenerationId: 3, instrumentKey: nifty }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 3 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.eventCounts['DEPTH'], 1);
  assert.equal(result.v2Evaluations, 1); // readiness came from the recorded generation, not from the DEPTH event granting it by itself
});

test('replay hardening: a RECONNECT with a missing/invalid recorded generation fails closed with an explicit data-quality warning instead of fabricating one', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: null }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: null }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 0); // no false valid session -- an invalid generation cannot unlock readiness
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:RECONNECT:')));
});

test('replay hardening: when every market event is rejected as stale-generation, the result surfaces an explicit data-quality warning instead of looking like a valid empty session', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 1 }),
    event('RECONNECT', '2026-08-17T03:45:05.000Z', {}, { connectionGenerationId: 2 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 0);
  assert.ok(result.dataQualityWarnings.includes('ALL_MARKET_EVENTS_DISCARDED_STALE_GENERATION'));
});

test('replay hardening: replay determinism is preserved for a RECONNECT-first fixture (two runs produce an identical digest)', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
  ];
  const options = { onReadyEvaluation: () => ({ strategy: 'V2' as const, evaluated: 1 }) };
  const first = await new MarketReplayRunnerService().run(events, options);
  const second = await new MarketReplayRunnerService().run(events, options);
  assert.equal(first.outputDigest, second.outputDigest);
});

test('replay hardening: repeated run() calls on the same runner instance do not leak generation state between runs', async () => {
  const runner = new MarketReplayRunnerService();
  const highGenEvents = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 9 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 9 }),
  ];
  const lowGenEvents = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 1 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
  ];
  const first = await runner.run(highGenEvents, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  const second = await runner.run(lowGenEvents, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(first.v2Evaluations, 1);
  assert.equal(second.v2Evaluations, 1); // generation 1 was not rejected as stale against a leaked generation 9 from the previous run
});

// ---- Correction pass: FINDING 1 -- duplicate/stale RECONNECT must not fabricate a generation ----

test('FINDING 1.A: a duplicate RECONNECT at an unchanged generation does not fabricate generation+1 and does not discard the legitimate tick that follows it', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('RECONNECT', '2026-08-17T03:45:15.000Z', {}, { connectionGenerationId: 5, eventId: 'duplicate-reconnect-gen5' }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: 5 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.reconnects, 1); // only the genuine, strictly-increasing RECONNECT is counted
  assert.equal(result.v2Evaluations, 2); // both legitimate gen5 ticks were evaluated, not silently discarded against a fabricated gen6
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('DUPLICATE_RECONNECT_GENERATION:')));
});

test('FINDING 1.B: two consecutive RECONNECTs at the same generation behave identically to a single duplicate, with no fabricated generation', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 1 }),
    event('RECONNECT', '2026-08-17T03:45:05.000Z', {}, { connectionGenerationId: 1, eventId: 'duplicate-reconnect-gen1' }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 1 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.reconnects, 1);
  assert.equal(result.v2Evaluations, 1); // the gen1 tick still reaches readiness -- generation was never bumped to 2
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('DUPLICATE_RECONNECT_GENERATION:')));
});

test('FINDING 1.C: a stale RECONNECT recorded below the current generation is rejected explicitly and cannot corrupt generation ownership', async () => {
  const events = [
    event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { connectionGenerationId: 8 }), // normal cold start at gen8
    event('RECONNECT', '2026-08-17T03:45:10.000Z', {}, { connectionGenerationId: 7 }), // stale -- behind the established generation
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: 8 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.reconnects, 0); // the stale RECONNECT was never accepted as a real reconnect
  assert.equal(result.v2Evaluations, 2); // generation ownership stayed at 8 throughout -- both gen8 ticks were evaluated
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('STALE_RECONNECT_GENERATION:')));
});

// ---- Correction pass: FINDING 2 -- generation-ahead market events must be as visible as generation-behind ones ----

test('FINDING 2.A: a TICK recorded ahead of the established generation is rejected with an explicit, deterministic mismatch warning', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 6 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 0);
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('MARKET_EVENT_GENERATION_MISMATCH:TICK:')));
  assert.ok(result.dataQualityWarnings.includes('ALL_MARKET_EVENTS_DISCARDED_STALE_GENERATION'));
});

test('FINDING 2.B: a TICK recorded behind the established generation remains rejected and visible', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 4 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 0);
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('MARKET_EVENT_GENERATION_MISMATCH:TICK:')));
  assert.ok(result.dataQualityWarnings.includes('ALL_MARKET_EVENTS_DISCARDED_STALE_GENERATION'));
});

test('FINDING 2.C: a mix of one valid gen5 tick and one generation-ahead gen6 tick processes the valid one and still surfaces the mismatch -- it does not hide behind the all-discarded warning', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: 6 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 1); // the valid gen5 tick was processed
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('MARKET_EVENT_GENERATION_MISMATCH:TICK:'))); // the gen6 tick is still visible...
  assert.ok(!result.dataQualityWarnings.includes('ALL_MARKET_EVENTS_DISCARDED_STALE_GENERATION')); // ...without falsely claiming everything was discarded
});

// ---- Correction pass: FINDING 3 -- a leading FRESH_TICK_READY must not receive vacuous cold-start continuity ----

test('FINDING 3.A: a leading FRESH_TICK_READY still drives a real, gateable recovery episode -- a failing backfill blocks the tick that follows it', async () => {
  const events = [
    event('FRESH_TICK_READY', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
  ];
  let backfills = 0;
  const result = await new MarketReplayRunnerService().run(events, {
    backfill: async () => { backfills += 1; return { ready: false, reason: 'MISSING_MINUTE', missingMinutes: 1, duplicateMinutes: 0 }; },
    onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }),
  });
  assert.equal(backfills, 1); // the leading FRESH_TICK_READY was NOT given vacuous cold-start continuity -- a real backfill ran
  assert.equal(result.reconnects, 1);
  assert.equal(result.v2Evaluations, 0); // the tick did not bypass the failed recovery continuity
});

test('FINDING 3.B: a leading FRESH_TICK_READY alone does not silently produce a valid-looking ready session', async () => {
  const events = [event('FRESH_TICK_READY', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 })];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 0); // no TICK exists, so nothing was ever evaluated
  assert.equal(result.reconnects, 1); // but a real, auditable recovery episode is on record -- this was not treated as an ordinary already-connected feed
});

test('FINDING 3.C: normal FULL_SESSION cold start (first market event is a plain TICK) is unaffected by the FRESH_TICK_READY-first correction', async () => {
  const events = [event('TICK', '2026-08-17T03:45:00.000Z', { ltp: 25000 }, { connectionGenerationId: 5 })];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.reconnects, 0); // vacuous cold-start continuity, not a synthetic recovery episode
  assert.equal(result.v2Evaluations, 1);
  assert.deepEqual(result.dataQualityWarnings, []);
});

// ---- Correction pass: generation validation hardening -- positive integers only ----

test('generation validation hardening: a fractional recorded generation is rejected, not silently accepted as valid', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 1.5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 1.5 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 0);
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:RECONNECT:')));
});

// ---- Correction pass: determinism of the new warning vocabulary ----

test('correction pass determinism: duplicate RECONNECT and generation-mismatch warnings are stable, deduplicated and identically ordered across repeated runs', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 6 }),
    event('RECONNECT', '2026-08-17T03:45:15.000Z', {}, { connectionGenerationId: 5, eventId: 'duplicate-reconnect-gen5-determinism' }),
  ];
  const options = { onReadyEvaluation: () => ({ strategy: 'V2' as const, evaluated: 1 }) };
  const first = await new MarketReplayRunnerService().run(events, options);
  const second = await new MarketReplayRunnerService().run(events, options);
  assert.equal(first.outputDigest, second.outputDigest);
  assert.deepEqual(first.dataQualityWarnings, second.dataQualityWarnings);
  assert.deepEqual(first.dataQualityWarnings, [...first.dataQualityWarnings].sort()); // stable, sorted ordering
});

// ---- Correction pass: FINDING 5 -- a null/invalid generation on a market event must never
// inherit generation ownership through `?? activeGeneration` once a legitimate generation exists ----

test('null-generation hardening: a TICK recorded with a null generation after a legitimate generation is established is rejected, not silently inherited', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: null }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 1); // only the valid gen5 tick was evaluated -- the null tick caused no additional evaluation
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:TICK:')));
  assert.ok(!result.dataQualityWarnings.some((warning) => warning.startsWith('MARKET_EVENT_GENERATION_MISMATCH:'))); // rejected as invalid, not as a mismatch
});

test('null-generation hardening: a DEPTH recorded with a null generation after a legitimate generation is established is rejected and cannot mutate coordinator state', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('DEPTH', '2026-08-17T03:45:20.000Z', { quotes: [] }, { connectionGenerationId: null, instrumentKey: nifty }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 1); // the null DEPTH triggered no additional evaluation or coordinator mutation
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:DEPTH:')));
});

test('null-generation hardening: a non-leading FRESH_TICK_READY recorded with a null generation is rejected and cannot fabricate a false readiness transition', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('FRESH_TICK_READY', '2026-08-17T03:45:20.000Z', {}, { connectionGenerationId: null }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 1); // readiness was already established by the valid gen5 tick; the null event adds nothing
  assert.equal(result.reconnects, 1); // no second/synthetic recovery episode was created by the rejected null event
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:FRESH_TICK_READY:')));
});

for (const invalidGeneration of [0, -1, 1.5, NaN, Infinity]) {
  test(`null-generation hardening: a TICK recorded with generation ${invalidGeneration} after a legitimate generation is established is rejected, not silently inherited`, async () => {
    const events = [
      event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
      event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
      event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: invalidGeneration }),
    ];
    const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
    assert.equal(result.v2Evaluations, 1);
    assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:TICK:')));
  });
}

test('null-generation hardening: a valid gen5 TICK following RECONNECT gen5 remains unaffected by the null-generation validation', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 1);
  assert.deepEqual(result.dataQualityWarnings, []);
});

test('null-generation hardening: an invalid null-generation TICK sandwiched between two valid gen5 ticks does not poison the valid ticks', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: null }),
    event('TICK', '2026-08-17T03:45:30.000Z', { ltp: 25020 }, { connectionGenerationId: 5 }),
  ];
  const result = await new MarketReplayRunnerService().run(events, { onReadyEvaluation: () => ({ strategy: 'V2', evaluated: 1 }) });
  assert.equal(result.v2Evaluations, 2); // both valid gen5 ticks were processed; the null tick neither blocked nor poisoned them
  assert.ok(result.dataQualityWarnings.some((warning) => warning.startsWith('INVALID_REPLAY_GENERATION:TICK:')));
  assert.ok(!result.dataQualityWarnings.includes('ALL_MARKET_EVENTS_DISCARDED_STALE_GENERATION')); // not every market event was invalid/mismatched
});

test('null-generation hardening: replay determinism is preserved for a null-generation-TICK fixture (two runs produce an identical digest and warnings)', async () => {
  const events = [
    event('RECONNECT', '2026-08-17T03:45:00.000Z', {}, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:10.000Z', { ltp: 25000 }, { connectionGenerationId: 5 }),
    event('TICK', '2026-08-17T03:45:20.000Z', { ltp: 25010 }, { connectionGenerationId: null }),
  ];
  const options = { onReadyEvaluation: () => ({ strategy: 'V2' as const, evaluated: 1 }) };
  const first = await new MarketReplayRunnerService().run(events, options);
  const second = await new MarketReplayRunnerService().run(events, options);
  assert.equal(first.outputDigest, second.outputDigest);
  assert.deepEqual(first.dataQualityWarnings, second.dataQualityWarnings);
});
