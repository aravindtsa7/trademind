import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNiftyIndexGapImputationAuthorized,
  NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION,
  NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID,
  NIFTY_2022_03_07_INDEX_GAP_LEFT_ANCHOR_MINUTE_IST,
  NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST,
  NIFTY_2022_03_07_INDEX_GAP_RIGHT_ANCHOR_MINUTE_IST,
  NiftyIndexGapImputationNotAuthorizedError,
} from './nifty-index-gap-imputation-authorization';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../services/nifty-underlying-identity';

function validRequest(overrides: Partial<Parameters<typeof assertNiftyIndexGapImputationAuthorized>[0]> = {}) {
  return {
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    timeframe: NIFTY_UNDERLYING_TIMEFRAME,
    tradingDate: '2022-03-07',
    missingMinutesIst: [...NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST],
    ...overrides,
  };
}

test('authorization descriptor matches the locked NIFTY_2022_03_07_INDEX_GAP_V1 facts', () => {
  assert.equal(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.authorizationId, NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID);
  assert.equal(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.tradingDate, '2022-03-07');
  assert.equal(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.instrumentKey, NIFTY_INDEX_INSTRUMENT_KEY);
  assert.equal(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.timeframe, NIFTY_UNDERLYING_TIMEFRAME);
  assert.deepEqual([...NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst], [622, 623, 624]);
  assert.equal(NIFTY_2022_03_07_INDEX_GAP_LEFT_ANCHOR_MINUTE_IST, 621); // 10:21 IST
  assert.equal(NIFTY_2022_03_07_INDEX_GAP_RIGHT_ANCHOR_MINUTE_IST, 625); // 10:25 IST
});

// ---- B-M7.1-BLOCKER-01: runtime-immutable authorization -------------------

test('1. the outer authorization object is frozen', () => {
  assert.ok(Object.isFrozen(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION));
});

test('2. the nested missingMinutesIst array is frozen, both on the descriptor and the standalone export', () => {
  assert.ok(Object.isFrozen(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst));
  assert.ok(Object.isFrozen(NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST));
});

test('3. attempted push/splice/index-assignment on the exported array throws (strict mode) and cannot alter the canonical values', () => {
  assert.throws(() => (NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST as number[]).push(999), TypeError);
  assert.throws(() => (NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST as number[]).splice(0, 1, 111), TypeError);
  assert.throws(() => {
    (NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST as number[])[0] = 111;
  }, TypeError);
  assert.throws(() => (NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst as number[]).push(999), TypeError);
  assert.throws(() => {
    (NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst as number[])[0] = 111;
  }, TypeError);
  assert.throws(() => {
    (NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION as { authorizationId: string }).authorizationId = 'SOMETHING_ELSE';
  }, TypeError);
});

test('4. values remain exactly [622,623,624] after every mutation attempt above', () => {
  assert.deepEqual([...NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST], [622, 623, 624]);
  assert.deepEqual([...NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst], [622, 623, 624]);
});

test('6. even a caller holding the exported descriptor/array reference cannot mutate production authorization -- assertion still rejects an attempted "widened" gap after every mutation attempt', () => {
  try {
    (NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST as number[]).push(999);
  } catch {
    // expected to throw -- attempt anyway, in case freezing were ever weakened
  }
  try {
    (NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst as number[])[1] = 111;
  } catch {
    // expected to throw
  }
  assert.throws(
    () => assertNiftyIndexGapImputationAuthorized({ instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, tradingDate: '2022-03-07', missingMinutesIst: [622, 623, 624, 999] }),
    NiftyIndexGapImputationNotAuthorizedError
  );
  assert.doesNotThrow(() =>
    assertNiftyIndexGapImputationAuthorized({ instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, tradingDate: '2022-03-07', missingMinutesIst: [622, 623, 624] })
  );
});

test('the standalone exported missingMinutesIst array and the descriptor field are independent frozen copies -- not the same object identity', () => {
  assert.notEqual(NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST, NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst);
  assert.deepEqual([...NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST], [...NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst]);
});

// ---- C: March 7 exact gap authorized ----

test('the exact authorized request passes', () => {
  assert.doesNotThrow(() => assertNiftyIndexGapImputationAuthorized(validRequest()));
});

test('the exact authorized request passes regardless of the input array order (compared as a set)', () => {
  assert.doesNotThrow(() => assertNiftyIndexGapImputationAuthorized(validRequest({ missingMinutesIst: [624, 622, 623] })));
});

// ---- C: same gap on another date rejected ----

test('the identical missing-minute set on a different date is rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ tradingDate: '2022-03-08' })), NiftyIndexGapImputationNotAuthorizedError);
});

// ---- C: another instrument rejected ----

test('a different instrumentKey is rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ instrumentKey: 'NSE_INDEX|Bank Nifty' })), NiftyIndexGapImputationNotAuthorizedError);
});

// ---- C: another timeframe rejected ----

test('a different timeframe is rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ timeframe: '5minute' })), NiftyIndexGapImputationNotAuthorizedError);
});

// ---- C: additional missing minute rejected ----

test('a superset missing-minute set (one extra minute) is rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ missingMinutesIst: [622, 623, 624, 625] })), NiftyIndexGapImputationNotAuthorizedError);
});

test('a subset missing-minute set (one fewer minute) is rejected -- never partial-matches', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ missingMinutesIst: [622, 623] })), NiftyIndexGapImputationNotAuthorizedError);
});

test('a shifted missing-minute set of the same size is rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ missingMinutesIst: [630, 631, 632] })), NiftyIndexGapImputationNotAuthorizedError);
});

test('an empty missing-minute set is rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ missingMinutesIst: [] })), NiftyIndexGapImputationNotAuthorizedError);
});

test('there is never a generic size/threshold fallback: a different exactly-3-minute gap on the authorized date is still rejected', () => {
  assert.throws(() => assertNiftyIndexGapImputationAuthorized(validRequest({ missingMinutesIst: [700, 701, 702] })), NiftyIndexGapImputationNotAuthorizedError);
});
