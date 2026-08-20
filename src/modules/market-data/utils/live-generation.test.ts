import assert from 'node:assert/strict';
import test from 'node:test';
import { isCurrentLiveGeneration } from './live-generation';

test('live generation requires a present finite exact match', () => {
  assert.equal(isCurrentLiveGeneration(7, 7), true);
  assert.equal(isCurrentLiveGeneration(6, 7), false);
  assert.equal(isCurrentLiveGeneration(undefined, 7), false);
  assert.equal(isCurrentLiveGeneration(null, 7), false);
  assert.equal(isCurrentLiveGeneration(Number.NaN, 7), false);
  assert.equal(isCurrentLiveGeneration(7, undefined), false);
});
