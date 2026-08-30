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

// ============================================================================
// B-F2-CAL-2: CALENDAR_DECLARED_SESSION
// ============================================================================

function minuteRow(sourceIndex: number, minuteOfDay: number): HistoricalSourceCandleRow {
  const dayStart = new Date(`${TRADING_DATE}T00:00:00+05:30`).getTime();
  return row(sourceIndex, new Date(dayStart + minuteOfDay * 60_000).toISOString());
}

function calendarRequest(sourceRows: readonly HistoricalSourceCandleRow[], sessionWindows: readonly { windowIndex: number; openMinuteIst: number; closeMinuteIst: number }[]): CanonicalSessionProjectionRequest {
  return { ...request(sourceRows), sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION, sessionWindows };
}

test('CAL-2: a single-window CALENDAR_DECLARED_SESSION accepts rows inside the window and excludes rows outside it as OUTSIDE_CALENDAR_SESSION_WINDOW', () => {
  const window = { windowIndex: 0, openMinuteIst: 1080, closeMinuteIst: 1140 }; // [18:00, 19:00)
  const inWindow = Array.from({ length: 60 }, (_, index) => minuteRow(index, 1080 + index));
  const outsideWindow = minuteRow(999, 555); // 09:15, unrelated regular-hours minute
  const projector = new CanonicalSessionProjectorService();

  const result = projector.project(calendarRequest([outsideWindow, ...inWindow], [window]));

  assert.equal(result.acceptedRows.length, 60);
  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.excludedRows[0].reason, CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW);
});

test('CAL-2: a multi-window CALENDAR_DECLARED_SESSION never bridges the gap between disjoint windows', () => {
  const windows = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const window0Rows = Array.from({ length: 45 }, (_, index) => minuteRow(index, 555 + index));
  const window1Rows = Array.from({ length: 60 }, (_, index) => minuteRow(45 + index, 690 + index));
  const gapRow = minuteRow(999, 645); // squarely inside the [600,690) gap
  const projector = new CanonicalSessionProjectorService();

  const result = projector.project(calendarRequest([...window0Rows, gapRow, ...window1Rows], windows));

  assert.equal(result.acceptedRows.length, 105);
  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.excludedRows[0].reason, CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW);
  assert.equal(result.excludedRows[0].candleTime.toISOString(), gapRow.candleTime.toISOString());
});

test('CAL-2: half-open window boundary -- the last minute before closeMinuteIst is accepted, closeMinuteIst itself is excluded', () => {
  const window = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const lastAccepted = minuteRow(0, 599); // 09:59, the final in-window minute
  const firstExcluded = minuteRow(1, 600); // 10:00, exactly closeMinuteIst -- half-open, must be excluded
  const projector = new CanonicalSessionProjectorService();

  const result = projector.project(calendarRequest([lastAccepted, firstExcluded], [window]));

  assert.equal(result.acceptedRows.length, 1);
  assert.equal(result.acceptedRows[0].candleTime.toISOString(), lastAccepted.candleTime.toISOString());
  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.excludedRows[0].candleTime.toISOString(), firstExcluded.candleTime.toISOString());
  assert.equal(result.excludedRows[0].reason, CanonicalExclusionReason.OUTSIDE_CALENDAR_SESSION_WINDOW);
});

test('CAL-2: openMinuteIst itself IS accepted (half-open window is inclusive of its own open boundary)', () => {
  const window = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const firstAccepted = minuteRow(0, 555);
  const projector = new CanonicalSessionProjectorService();

  const result = projector.project(calendarRequest([firstAccepted], [window]));

  assert.equal(result.acceptedRows.length, 1);
  assert.equal(result.excludedRows.length, 0);
});

test('CAL-2: a row on a different IST calendar date is OUTSIDE_DECLARED_SESSION even under CALENDAR_DECLARED_SESSION (cross-session contamination takes priority over window membership)', () => {
  const window = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const wrongDateRow = row(0, '2026-08-18T09:15:00+05:30'); // TRADING_DATE is 2026-08-17
  const projector = new CanonicalSessionProjectorService();

  const result = projector.project(calendarRequest([wrongDateRow], [window]));

  assert.equal(result.acceptedRows.length, 0);
  assert.equal(result.excludedRows.length, 1);
  assert.equal(result.excludedRows[0].reason, CanonicalExclusionReason.OUTSIDE_DECLARED_SESSION);
});

test('CAL-2: CALENDAR_DECLARED_SESSION with no sessionWindows fails closed rather than silently projecting an empty/implicit session', () => {
  const projector = new CanonicalSessionProjectorService();
  assert.throws(() => projector.project(calendarRequest(normalSessionRows(), [])));
  assert.throws(() =>
    projector.project({ ...request(normalSessionRows()), sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION })
  );
});

test('CAL-2: CALENDAR_DECLARED_SESSION with overlapping windows fails closed (delegated to validateSessionWindows)', () => {
  const overlapping = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 700 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const projector = new CanonicalSessionProjectorService();
  assert.throws(() => projector.project(calendarRequest(normalSessionRows(), overlapping)));
});

test('CAL-2: outcome for a CALENDAR_DECLARED_SESSION is NORMAL_SESSION_PROJECTED (a real per-row projection occurred, not a wholesale exclusion)', () => {
  const window = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 };
  const projector = new CanonicalSessionProjectorService();
  const result = projector.project(calendarRequest([minuteRow(0, 555)], [window]));

  assert.equal(result.outcome, CanonicalSessionProjectionOutcome.NORMAL_SESSION_PROJECTED);
});
