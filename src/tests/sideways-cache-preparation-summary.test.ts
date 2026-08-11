import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSidewaysCachePreparation } from './helpers/sideways-cache-preparation-summary';

test('globally deduplicates SIDEWAYS directional session requirements while retaining directional ownership', () => {
  const result = summarizeSidewaysCachePreparation([{ instrumentKey: 'CE', tradingDate: '2026-08-03' }, { instrumentKey: 'SHARED', tradingDate: '2026-08-03' }], [{ instrumentKey: 'PE', tradingDate: '2026-08-03' }, { instrumentKey: 'SHARED', tradingDate: '2026-08-03' }], [{ instrumentKey: 'CE', tradingDate: '2026-08-03', locallyAvailableCandleCount: 0, complete: false }, { instrumentKey: 'PE', tradingDate: '2026-08-03', locallyAvailableCandleCount: 375, complete: true }, { instrumentKey: 'SHARED', tradingDate: '2026-08-03', locallyAvailableCandleCount: 0, complete: false }]);
  assert.equal(result.uniqueRequiredSessions, 3); assert.equal(result.uniqueCompleteSessions, 1); assert.equal(result.uniqueMissingSessions, 2); assert.equal(result.remoteSessionFetchesRequired, 2); assert.equal(result.expectedNewCandleRows, 750); assert.equal(result.ceOnlyMissingSessions.length, 1); assert.equal(result.peOnlyMissingSessions.length, 0); assert.equal(result.sharedDirectionalSessions.length, 1); assert.equal(result.sharedMissingSessions.length, 1); assert.equal(result.allMissingSessionsHaveZeroRows, true);
});
