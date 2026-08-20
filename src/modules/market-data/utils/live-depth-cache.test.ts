import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheCurrentLiveDepth, getCurrentLiveDepth } from './live-depth-cache';

test('current live depth updates an observational cache while stale and missing generations cannot overwrite it', () => {
  const cache = new Map<string, { instrumentKey?: unknown; generationId?: unknown; bestBid: number }>();
  assert.equal(cacheCurrentLiveDepth(cache, { instrumentKey:'NSE_FO|one', generationId:7, bestBid:99 }, 7), true);
  assert.equal(cache.get('NSE_FO|one')?.bestBid, 99);
  assert.equal(cacheCurrentLiveDepth(cache, { instrumentKey:'NSE_FO|one', generationId:6, bestBid:98 }, 7), false);
  assert.equal(cache.get('NSE_FO|one')?.bestBid, 99);
  assert.equal(cacheCurrentLiveDepth(cache, { instrumentKey:'NSE_FO|one', bestBid:97 }, 7), false);
  assert.equal(cache.get('NSE_FO|one')?.bestBid, 99);
});

test('a depth accepted by generation N is not readable after active generation advances until N+1 depth arrives', () => {
  const cache = new Map<string, { instrumentKey?: unknown; generationId?: unknown; bestBid: number }>();
  assert.equal(cacheCurrentLiveDepth(cache, { instrumentKey:'NSE_FO|one', generationId:7, bestBid:99 }, 7), true);
  assert.equal(getCurrentLiveDepth(cache, 'NSE_FO|one', 7)?.bestBid, 99);
  assert.equal(getCurrentLiveDepth(cache, 'NSE_FO|one', 8), undefined);
  assert.equal(cacheCurrentLiveDepth(cache, { instrumentKey:'NSE_FO|one', generationId:8, bestBid:101 }, 8), true);
  assert.equal(getCurrentLiveDepth(cache, 'NSE_FO|one', 8)?.bestBid, 101);
});
