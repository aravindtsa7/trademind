import assert from 'node:assert/strict';
import test from 'node:test';
import { v4NiftyAuthorizedOverfullNormalizations } from './helpers/v4-nifty-authorized-overfull-normalizations';

test('V4 NIFTY normalization authorization contains only the two approved August 4 CE contract/date sessions', () => {
  assert.deepEqual(v4NiftyAuthorizedOverfullNormalizations, [
    { instrumentKey: 'NSE_FO|65858|04-08-2026', tradingDate: '2026-08-04' },
    { instrumentKey: 'NSE_FO|65860|04-08-2026', tradingDate: '2026-08-04' },
  ]);
});
