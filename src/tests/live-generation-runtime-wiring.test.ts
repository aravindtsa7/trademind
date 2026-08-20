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
