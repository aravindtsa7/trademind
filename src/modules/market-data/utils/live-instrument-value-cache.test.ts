import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cacheCurrentLiveInstrumentValue,
  getCurrentLiveInstrumentValue,
  LiveInstrumentValue,
} from './live-instrument-value-cache';

test('live instrument values become unreadable immediately when the active generation advances', () => {
  const cache = new Map<string, LiveInstrumentValue<number>>();
  assert.equal(cacheCurrentLiveInstrumentValue(cache, 'OPT', 100, 1, 1), true);
  assert.equal(getCurrentLiveInstrumentValue(cache, 'OPT', 1), 100);
  assert.equal(getCurrentLiveInstrumentValue(cache, 'OPT', 2), undefined);
});

test('a late retired-generation value cannot become usable and a fresh jumped generation works', () => {
  const cache = new Map<string, LiveInstrumentValue<number>>();
  cacheCurrentLiveInstrumentValue(cache, 'OPT', 100, 1, 1);
  assert.equal(cacheCurrentLiveInstrumentValue(cache, 'OPT', 101, 1, 3), false);
  assert.equal(getCurrentLiveInstrumentValue(cache, 'OPT', 3), undefined);
  assert.equal(cacheCurrentLiveInstrumentValue(cache, 'OPT', 103, 3, 3), true);
  assert.equal(getCurrentLiveInstrumentValue(cache, 'OPT', 3), 103);
});

test('an EOD premium provider falls back instead of consuming a retired-generation premium', () => {
  const cache = new Map<string, LiveInstrumentValue<number>>();
  cacheCurrentLiveInstrumentValue(cache, 'OPT', 125, 1, 1);
  const premiumFor = (activeGenerationId: number, entryPremium: number) => getCurrentLiveInstrumentValue(cache, 'OPT', activeGenerationId) ?? entryPremium;
  assert.equal(premiumFor(1, 100), 125);
  assert.equal(premiumFor(2, 100), 100);
});
