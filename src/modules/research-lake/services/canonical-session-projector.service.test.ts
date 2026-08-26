import assert from 'node:assert/strict';
import test from 'node:test';
import CanonicalSessionProjectorService from './canonical-session-projector.service';
import { HistoricalAssetType } from '../domain/historical-asset.types';
import { HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import {
  CanonicalExclusionReason,
  CanonicalSessionDeclaration,
  CanonicalSessionProjectionOutcome,
  CanonicalSessionProjectionRequest,
  CanonicalSourceOrderAnomalyReason,
} from '../domain/canonical-session.types';

const TRADING_DATE = '2026-08-17';
const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

function row(sourceIndex: number, isoTimeWithOffset: string, overrides: Partial<HistoricalSourceCandleRow> = {}): HistoricalSourceCandleRow {
  return {
    sourceIndex,
    candleTime: new Date(isoTimeWithOffset),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function normalSessionRows(): HistoricalSourceCandleRow[] {
  const start = new Date(`${TRADING_DATE}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) =>
    row(index, new Date(start + index * 60_000).toISOString())
  );
}

function request(sourceRows: readonly HistoricalSourceCandleRow[]): CanonicalSessionProjectionRequest {
  return {
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    tradingDate: TRADING_DATE,
    sessionDeclaration: CanonicalSessionDeclaration.NORMAL_NIFTY_SESSION,
    sourceRows,
  };
}

test('378-row provider response accepts exactly the 375 canonical rows and retains typed exclusion evidence', () => {
  const rows = normalSessionRows();
  rows.unshift(row(9999, `${TRADING_DATE}T09:07:00+05:30`));
  rows.push(row(10000, `${TRADING_DATE}T15:30:00+05:30`));
  rows.push(row(10001, `${TRADING_DATE}T15:31:00+05:30`));

  const projector = new CanonicalSessionProjectorService();
  const result = projector.project(request(rows));

  assert.equal(result.outcome, CanonicalSessionProjectionOutcome.NORMAL_SESSION_PROJECTED);
  assert.equal(result.sourceRowCount, 378);
  assert.equal(result.acceptedRows.length, 375);
  assert.equal(result.excludedRows.length, 3);
  assert.deepEqual(
    result.excludedRows.map((exclusion) => [exclusion.candleTime.toISOString(), exclusion.reason]),
    [
      [new Date(`${TRADING_DATE}T09:07:00+05:30`).toISOString(), CanonicalExclusionReason.PRE_MARKET_ROW],
      [new Date(`${TRADING_DATE}T15:30:00+05:30`).toISOString(), CanonicalExclusionReason.POST_SOURCE_ROW],
      [new Date(`${TRADING_DATE}T15:31:00+05:30`).toISOString(), CanonicalExclusionReason.POST_SOURCE_ROW],
    ]
  );
});

test('a NIFTY_OPTION late row is excluded as POST_MARKET_ROW rather than POST_SOURCE_ROW', () => {
  const rows = [...normalSessionRows(), row(999, `${TRADING_DATE}T15:30:00+05:30`)];
  const projector = new CanonicalSessionProjectorService();
  const result = projector.project({ ...request(rows), assetType: HistoricalAssetType.NIFTY_OPTION });

  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.excludedRows[0].reason, CanonicalExclusionReason.POST_MARKET_ROW);
});

test('a row on a different IST calendar date is excluded as OUTSIDE_DECLARED_SESSION (cross-session contamination)', () => {
  const rows = [...normalSessionRows(), row(999, '2026-08-18T09:15:00+05:30')];
  const projector = new CanonicalSessionProjectorService();
  const result = projector.project(request(rows));

  assert.equal(result.acceptedRows.length, 375);
  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.excludedRows[0].reason, CanonicalExclusionReason.OUTSIDE_DECLARED_SESSION);
});

test('an undeclared special session is excluded wholesale, never forced through the normal-session contract', () => {
  const rows = normalSessionRows().slice(0, 100); // an arbitrary, non-375 shape
  const projector = new CanonicalSessionProjectorService();
  const result = projector.project({
    ...request(rows),
    sessionDeclaration: CanonicalSessionDeclaration.UNDECLARED_SPECIAL_SESSION,
  });

  assert.equal(result.outcome, CanonicalSessionProjectionOutcome.SPECIAL_SESSION_EXCLUDED);
  assert.equal(result.sourceRowCount, 100);
  assert.equal(result.acceptedRows.length, 0);
  assert.equal(result.excludedRows.length, 0);
});

test('out-of-order source input still produces the same deterministic projection as the in-order input', () => {
  const inOrder = normalSessionRows();
  const shuffled = [...inOrder].reverse();
  const projector = new CanonicalSessionProjectorService();

  const inOrderResult = projector.project(request(inOrder));
  const shuffledResult = projector.project(request(shuffled));

  assert.deepEqual(
    shuffledResult.acceptedRows.map((r) => r.candleTime.toISOString()),
    inOrderResult.acceptedRows.map((r) => r.candleTime.toISOString())
  );
});

test('projection is deterministic across repeated calls on the same input', () => {
  const rows = normalSessionRows();
  const projector = new CanonicalSessionProjectorService();

  const first = projector.project(request(rows));
  const second = projector.project(request(rows));

  assert.deepEqual(
    first.acceptedRows.map((r) => r.candleTime.toISOString()),
    second.acceptedRows.map((r) => r.candleTime.toISOString())
  );
});

test('the projector does not mutate the caller-supplied source array or row objects', () => {
  const rows = normalSessionRows();
  const frozenRows = rows.map((r) => Object.freeze({ ...r }));
  const frozenArray = Object.freeze(frozenRows);
  const originalFirstTime = frozenArray[0].candleTime.getTime();

  const projector = new CanonicalSessionProjectorService();
  assert.doesNotThrow(() => projector.project(request(frozenArray)));

  assert.equal(frozenArray.length, 375);
  assert.equal(frozenArray[0].candleTime.getTime(), originalFirstTime);
});

test('no fabricated rows and no gap filling: an incomplete source produces fewer accepted rows, not a padded 375', () => {
  const rows = normalSessionRows().slice(0, 200);
  const projector = new CanonicalSessionProjectorService();
  const result = projector.project(request(rows));

  assert.equal(result.acceptedRows.length, 200);
  assert.equal(result.excludedRows.length, 0);
});

test('BLOCKER 1 regression: an adjacent swap in the raw source retains typed source-order-anomaly evidence even though acceptedRows is sorted canonical', () => {
  const rows = normalSessionRows();
  // Swap the raw (09:16, 09:17) pair at indices 1 and 2 -- 375 otherwise-perfect rows, one adjacent swap.
  const swappedRaw = [...rows];
  [swappedRaw[1], swappedRaw[2]] = [swappedRaw[2], swappedRaw[1]];

  const projector = new CanonicalSessionProjectorService();
  const result = projector.project(request(swappedRaw));

  // acceptedRows remains the fully sorted canonical 375-row session.
  assert.equal(result.acceptedRows.length, 375);
  assert.deepEqual(
    result.acceptedRows.map((r) => r.candleTime.toISOString()),
    normalSessionRows().map((r) => r.candleTime.toISOString())
  );
  assert.equal(result.excludedRows.length, 0);

  // But the raw provider-order anomaly is retained as explicit typed evidence.
  assert.equal(result.sourceOrderAnomalies.length, 1);
  const [anomaly] = result.sourceOrderAnomalies;
  assert.equal(anomaly.reason, CanonicalSourceOrderAnomalyReason.NON_MONOTONIC_ORDER);
  assert.equal(anomaly.sourceIndex, rows[1].sourceIndex); // the row that arrived out of order (raw 09:16)
  assert.equal(anomaly.previousSourceCandleTime.toISOString(), rows[2].candleTime.toISOString()); // raw predecessor was 09:17
  assert.equal(anomaly.currentSourceCandleTime.toISOString(), rows[1].candleTime.toISOString()); // raw current was 09:16
});

test('BLOCKER 1 regression: source-order-anomaly detection is deterministic across repeated calls on the same swapped input', () => {
  const rows = normalSessionRows();
  const swappedRaw = [...rows];
  [swappedRaw[1], swappedRaw[2]] = [swappedRaw[2], swappedRaw[1]];

  const projector = new CanonicalSessionProjectorService();
  const first = projector.project(request(swappedRaw));
  const second = projector.project(request(swappedRaw));

  assert.deepEqual(
    first.sourceOrderAnomalies.map((a) => [a.reason, a.sourceIndex, a.previousSourceCandleTime.toISOString(), a.currentSourceCandleTime.toISOString()]),
    second.sourceOrderAnomalies.map((a) => [a.reason, a.sourceIndex, a.previousSourceCandleTime.toISOString(), a.currentSourceCandleTime.toISOString()])
  );
});

test('a well-ordered raw source produces no source-order anomalies', () => {
  const rows = normalSessionRows();
  const projector = new CanonicalSessionProjectorService();
  const result = projector.project(request(rows));

  assert.equal(result.sourceOrderAnomalies.length, 0);
});
