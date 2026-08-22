import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

test('live V2, V4 and V8 candle adapters receive their active WebSocket generation providers', () => {
  const v2 = source('src/tests/test-live-paper-trading.ts');
  const v4 = source('src/tests/test-live-v4-nifty-momentum-shadow.ts');
  const v8 = source('src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts');
  assert.ok(v2.includes('LiveCandleEventAdapterService(liveCandleBuilder, eventBus, () => connectionManager.getGenerationId())'));
  assert.ok(v4.includes('LiveCandleEventAdapterService(new LiveCandleBuilderService(), eventBus, () => connection.getGenerationId())'));
  assert.ok(v8.includes('LiveCandleEventAdapterService(new LiveCandleBuilderService(), eventBus, () => connection.getGenerationId())'));
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
