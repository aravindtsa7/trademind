import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const runtimePaths: Record<'V2' | 'V4' | 'V8', string> = {
  V2: 'src/tests/test-live-paper-trading.ts',
  V4: 'src/tests/test-live-v4-nifty-momentum-shadow.ts',
  V8: 'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts',
};

test('live V2, V4 and V8 candle adapters receive their active WebSocket generation providers', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  assert.ok(v2.includes('LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connectionManager.getGenerationId())'));
  // A7-H2: V4 and V8 now hold their LiveCandleBuilderService in its own named variable too
  // (not constructed inline), so the recovery coordinator's onLiveConstructionBoundary
  // callback has something to wire setLiveConstructionBoundary(...) to.
  assert.ok(v4.includes('LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connection.getGenerationId())'));
  assert.ok(v8.includes('LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connection.getGenerationId())'));
});

test('V2 forward-journal depth cache delegates to the strict current-generation cache helper', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  assert.ok(v2.includes('cacheCurrentLiveDepth(latestDepthByInstrument, event, connectionManager.getGenerationId())'));
  assert.ok(v2.includes('getCurrentLiveDepth(latestDepthByInstrument, action.instrumentKey, connectionManager.getGenerationId())'));
  assert.ok(v2.includes('cacheCurrentLiveInstrumentValue(latestPremiumByInstrument, tick.instrumentKey, tick.ltp, tick.generationId, connectionManager.getGenerationId())'));
  assert.ok(v2.includes('getCurrentLiveInstrumentValue(latestPremiumByInstrument, instrumentKey, connectionManager.getGenerationId())'));
});

test('V8 and V12 rotate live-only cache state on an accepted new connection generation', () => {
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  const v12 = source('src/tests/collect-v12-nifty-option-order-flow.ts');
  assert.ok(v8.includes('const latestGenerationScope = new LiveGenerationCacheScope()'));
  assert.ok(v8.includes('() => latest.clear()'));
  assert.ok(v12.includes('const liveCacheGeneration=new LiveGenerationCacheScope()'));
  assert.ok(v12.includes('()=>{ticks.clear();previousBook.clear();latestOptions.clear();rotation.beginGeneration(generationId);}'));
  assert.ok(v12.includes('new V12UniverseRotationCoordinator'));
});

test('live runtimes reset reconnect history only through current-generation health confirmation', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  const v12 = source('src/tests/collect-v12-nifty-option-order-flow.ts');
  for (const runtime of [v2,v4,v8,v12]) assert.ok(runtime.includes('health.confirmRecoveryReady('));
  for (const runtime of [v2,v4,v8]) assert.ok(runtime.includes('connection') && runtime.includes('.failRecovery('));
  assert.ok(v12.includes("connection.on('reconnectFailed'"));
});

// ---- A6: initial current-generation market-data readiness wiring ----

test('A6: V2, V4 and V8 seed the recovery coordinator with the real ConnectionManager generation on every connected event', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  for (const runtime of [v2, v4, v8]) {
    assert.ok(runtime.includes(".on('connected'"), 'expected a connected-event listener');
    assert.ok(runtime.includes('recovery.handleInitialConnected('), 'expected the connected listener to seed the coordinator');
  }
});

test('A6: V2, V4 and V8 gate StrategyHostLifecycle RUNNING on an onReady hook that awaits current-generation readiness', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  for (const runtime of [v2, v4, v8]) {
    assert.ok(runtime.includes('onReady'), 'expected an onReady hook');
    assert.ok(runtime.includes('recovery.waitUntilReady('), 'expected onReady to await the race-safe readiness wait');
  }
});

test('A6: V4 and V8 register their message/tick/candle listeners and start adapters before StrategyHostLifecycle.start() -- RUNNING can no longer precede listener wiring', () => {
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  for (const [runtime, listenerMarker] of [
    [v4, "connection.on('message', onMessage)"],
    [v8, "connection.on('message', (b: Buffer"],
  ] as const) {
    const listenerIndex = runtime.indexOf(listenerMarker);
    const startIndex = runtime.indexOf('await host.start();');
    assert.ok(listenerIndex >= 0, `expected to find ${listenerMarker}`);
    assert.ok(startIndex >= 0, 'expected to find await host.start();');
    assert.ok(listenerIndex < startIndex, 'expected the message listener to be wired before host.start()');
  }
});

test('A6: V2 preserves its historical + durable-execution warmup hook while also requiring the new live onReady gate', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  assert.ok(v2.includes('V2_WARMUP_NOT_READY'), 'expected the pre-existing historical warmup gate to remain');
  assert.ok(v2.includes('V2_EXECUTION_NOT_READY'), 'expected the pre-existing durable-execution gate to remain');
  const warmupIndex = v2.indexOf('V2_WARMUP_NOT_READY');
  const onReadyIndex = v2.indexOf('onReady: (): Promise<void> => recovery.waitUntilReady(');
  assert.ok(onReadyIndex >= 0, 'expected the live onReady gate');
  assert.ok(warmupIndex < onReadyIndex, 'expected warmup (historical/execution) to remain ordered before the live onReady gate');
});

// ---- A6 post-close hardening: protect the startupComplete ownership latch ----
//
// These are deliberately source-level tripwires, not substitutes for the
// behavioural coverage in market-data-reconnect-safety.integration.test.ts.
// They exist because that behavioural coverage reproduces the recovery/host
// wiring in its own shared harness rather than executing V2/V4/V8's actual
// source, so a regression introduced directly into one runtime file would not
// otherwise be caught: the previously-reproduced race was
//   host.start() pending in onReady -> host DEGRADED -> recovery READY ->
//   persistent recovery listener calls host.recovered() -> host RUNNING ->
//   host.start() also tries RUNNING -> illegal RUNNING->RUNNING -> FAULTED.
// The fix is the startupComplete latch: before host.start() has successfully
// returned RUNNING, only host.start() itself (via onReady) may grant the
// initial RUNNING transition; the persistent recovery.stateChanged listener's
// call to host.recovered() must stay suppressed until then.

test('A6 hardening: V2, V4 and V8 each declare startupComplete false by default (never true, never removed)', () => {
  for (const [name, path] of Object.entries(runtimePaths)) {
    const runtime = source(path);
    assert.match(runtime, /let\s+startupComplete\s*=\s*false\s*;/, `${name}: expected 'let startupComplete = false;'`);
  }
});

test('A6 hardening: V2, V4 and V8 gate the persistent recovery listener\'s host.recovered() call behind startupComplete', () => {
  // Tolerates `if (startupComplete)`/`else if (startupComplete)` in either
  // single-line or multi-line form (V2/V4/V8 differ in layout), but requires
  // the conditional to sit directly against the recovered() call itself --
  // an unconditional `void host?.recovered(...)` (the regressed shape) cannot
  // match this.
  const guardedRecoveredCall = /(?:if|else if)\s*\(\s*startupComplete\s*\)\s*\{?\s*void\s+host\?\.recovered\(/;
  for (const [name, path] of Object.entries(runtimePaths)) {
    const runtime = source(path);
    assert.match(runtime, guardedRecoveredCall, `${name}: expected host?.recovered(...) to be called only when startupComplete is true`);
  }
});

test('A6 hardening: V2, V4 and V8 flip startupComplete = true only after host.start() has returned RUNNING, never before', () => {
  const runningGuard = "if (host.getState() !== 'RUNNING') return;";
  for (const [name, path] of Object.entries(runtimePaths)) {
    const runtime = source(path);
    const hostStartIndex = runtime.indexOf('await host.start();');
    const runningGuardIndex = runtime.indexOf(runningGuard);
    const completeAssignmentIndex = runtime.search(/startupComplete\s*=\s*true/);
    assert.ok(hostStartIndex >= 0, `${name}: expected 'await host.start();'`);
    assert.ok(runningGuardIndex >= 0, `${name}: expected the RUNNING-state guard '${runningGuard}'`);
    assert.ok(completeAssignmentIndex >= 0, `${name}: expected a 'startupComplete = true' assignment`);
    assert.ok(hostStartIndex < runningGuardIndex, `${name}: expected the RUNNING-state guard to be ordered after host.start() resolves`);
    assert.ok(runningGuardIndex < completeAssignmentIndex, `${name}: expected startupComplete to be set true only after the RUNNING-state guard, never before it or before host.start() resolves`);
  }
});

test('A6 hardening: V2, V4 and V8 still route recovery DEGRADED to host.degrade() unconditionally -- the startupComplete latch must not suppress degrade during startup', () => {
  const degradedCheck = /state\s*===\s*'DEGRADED'/;
  for (const [name, path] of Object.entries(runtimePaths)) {
    const runtime = source(path);
    const degradedMatch = degradedCheck.exec(runtime);
    assert.ok(degradedMatch, `${name}: expected a recovery 'DEGRADED' state check`);
    const degradedIndex = degradedMatch!.index;
    const degradeCallIndex = runtime.indexOf('host?.degrade(', degradedIndex);
    assert.ok(degradeCallIndex >= 0, `${name}: expected host?.degrade(...) to follow the DEGRADED state check`);
    const between = runtime.slice(degradedIndex, degradeCallIndex);
    assert.ok(between.length < 200, `${name}: host?.degrade(...) is unexpectedly far from the DEGRADED state check -- wiring may have changed shape`);
    assert.ok(!between.includes('startupComplete'), `${name}: the DEGRADED -> host.degrade() path must remain unconditional during startup, not gated by startupComplete`);
  }
});

test('A6 hardening: V2, V4 and V8 share the identical declare -> guard -> start -> complete ordering for startupComplete, despite differing source layout', () => {
  // The same four-point ordering chain, checked identically across all three
  // runtimes regardless of each file's own formatting style (V2 multi-line,
  // V4 dense single-line, V8 multi-line with braces) -- proves the invariant
  // is structural, not incidental to one runtime's particular layout.
  const guardedRecoveredCall = /(?:if|else if)\s*\(\s*startupComplete\s*\)\s*\{?\s*void\s+host\?\.recovered\(/;
  const runningGuard = "if (host.getState() !== 'RUNNING') return;";
  for (const [name, path] of Object.entries(runtimePaths)) {
    const runtime = source(path);
    const declarationIndex = runtime.search(/let\s+startupComplete\s*=\s*false\s*;/);
    const guardedCallMatch = guardedRecoveredCall.exec(runtime);
    const hostStartIndex = runtime.indexOf('await host.start();');
    const runningGuardIndex = runtime.indexOf(runningGuard);
    const completeAssignmentIndex = runtime.search(/startupComplete\s*=\s*true/);
    assert.ok(
      declarationIndex >= 0 && guardedCallMatch && hostStartIndex >= 0 && runningGuardIndex >= 0 && completeAssignmentIndex >= 0,
      `${name}: missing one or more startupComplete invariant elements`,
    );
    assert.ok(
      declarationIndex < guardedCallMatch!.index
        && guardedCallMatch!.index < hostStartIndex
        && hostStartIndex < runningGuardIndex
        && runningGuardIndex < completeAssignmentIndex,
      `${name}: expected declare(${declarationIndex}) < guarded-recovered-call(${guardedCallMatch?.index}) < await-host.start(${hostStartIndex}) < RUNNING-guard(${runningGuardIndex}) < startupComplete=true(${completeAssignmentIndex})`,
    );
  }
});

// ---- A7-H1: cold-start REST→LIVE continuity reconciliation wiring ----
//
// These tests actually INSTANTIATE the live service class (not just read source
// strings) so that a JSDoc-corruption or edit accident that removes
// handleInitialConnected from the compiled class is caught at test-time rather
// than discovered on the next live V8 run.

test('A7-H1: MarketDataRecoveryCoordinatorService.handleInitialConnected is a callable function at runtime', () => {
  const inst = new MarketDataRecoveryCoordinatorService({
    backfill: async () => ({ ready: true, reason: 'ok', missingMinutes: 0, duplicateMinutes: 0 }),
    isMarketSession: () => true,
  });
  assert.equal(typeof inst.handleInitialConnected, 'function',
    'handleInitialConnected must be a function; if it is undefined the method body was lost in the compiled class (JSDoc corruption or missing method declaration)');
});

test('A7-H1: handleInitialConnected seeds the generation and grants backfillReady so a live tick alone can reach READY', () => {
  const inst = new MarketDataRecoveryCoordinatorService({
    backfill: async () => ({ ready: true, reason: 'ok', missingMinutes: 0, duplicateMinutes: 0 }),
    isMarketSession: () => true,
    nowMs: () => 1_000,
  });
  assert.equal(inst.getGenerationId(), 0, 'generation starts at 0');
  assert.equal(inst.isEvaluationReady(), false, 'not ready before handleInitialConnected');
  inst.handleInitialConnected({ generationId: 1, connectedAt: new Date(1_000) });
  assert.equal(inst.getGenerationId(), 1, 'generation seeded to 1 after handleInitialConnected');
  assert.equal(inst.isEvaluationReady(), false, 'not ready until a live tick also arrives');
  inst.handleLiveTick({ sourceTimestamp: new Date(1_000), receivedAt: new Date(1_001), generationId: 1 });
  assert.equal(inst.isEvaluationReady(), true, 'READY after handleInitialConnected + handleLiveTick');
});

test('A7-H1: handleInitialConnected with no getLastSeededCompletedMinute uses legacy unconditional grant path', () => {
  const inst = new MarketDataRecoveryCoordinatorService({
    backfill: async () => ({ ready: true, reason: 'ok', missingMinutes: 0, duplicateMinutes: 0 }),
    isMarketSession: () => true,
    nowMs: () => 1_000,
    // getLastSeededCompletedMinute intentionally absent → returns undefined → legacy path
  });
  inst.handleInitialConnected({ generationId: 1, connectedAt: new Date(1_000) });
  assert.equal(inst.getGenerationId(), 1);
  // backfillReady must have been granted immediately (no reconciliation configured)
  inst.handleLiveTick({ sourceTimestamp: new Date(1_000), receivedAt: new Date(1_001), generationId: 1 });
  assert.equal(inst.isEvaluationReady(), true, 'READY with legacy (no getLastSeededCompletedMinute) path');
});

test('A7-H1: V2, V4 and V8 source files supply getLastSeededCompletedMinute to the coordinator callbacks', () => {
  for (const [name, path] of Object.entries(runtimePaths)) {
    const runtime = source(path);
    assert.ok(
      runtime.includes('getLastSeededCompletedMinute'),
      `${name}: expected getLastSeededCompletedMinute to be wired into MarketDataRecoveryCoordinatorService callbacks`,
    );
  }
});

test('A7-H5: V4 consumes the positive source-close barrier before shutdown can stop recovery', () => {
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const finishStart = v4.indexOf('const finishEod = async');
  const finishEnd = v4.indexOf("connection.on('unexpectedDisconnect'", finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart);
  const finishEod = v4.slice(finishStart, finishEnd);
  // 2026-08-26 fix: the EOD barrier now requests the terminal boundary explicitly (generationId
  // + boundaryAt + requiredCompletedMinute) rather than relying on the coordinator's cached
  // per-generation obligation -- see market-data-recovery-coordinator.service.ts's
  // completePendingBoundaryReconciliation() doc for why an implicit, unscoped call is unsafe.
  const barrier = finishEod.indexOf('await recovery.completePendingBoundaryReconciliation({');
  const shutdown = finishEod.indexOf('await shutdown(');
  assert.ok(barrier >= 0, 'V4 EOD must consume the shared positive reconciliation result, explicitly scoped to the terminal source boundary');
  assert.ok(shutdown > barrier, 'V4 must consume the result before shutdown calls recovery.stop()');
  assert.ok(finishEod.includes("boundaryReconciliation.outcome === 'NOT_RECOVERED'"));
  assert.ok(finishEod.includes('sourceCloseRecoveryFailed'));
  assert.ok(v4.includes('if (!eodStarted && !closing) candleEvents.start()'), 'terminal recovery must not restart live processing');
});
