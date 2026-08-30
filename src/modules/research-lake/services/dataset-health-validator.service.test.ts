import assert from 'node:assert/strict';
import test from 'node:test';
import CanonicalSessionProjectorService from './canonical-session-projector.service';
import DatasetHealthValidatorService from './dataset-health-validator.service';
import { HistoricalAssetType } from '../domain/historical-asset.types';
import { CanonicalHistoricalCandle, HistoricalSourceCandleRow } from '../domain/canonical-historical-candle';
import {
  CanonicalSessionDeclaration,
  CanonicalSessionProjectionOutcome,
  CanonicalSessionProjectionRequest,
  CanonicalSessionProjectionResult,
} from '../domain/canonical-session.types';
import { DatasetHealthIssueReason, DatasetHealthStatus } from '../domain/dataset-health.types';

const TRADING_DATE = '2026-08-17';
const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

const projector = new CanonicalSessionProjectorService();
const validator = new DatasetHealthValidatorService();

function sourceRow(sourceIndex: number, isoTimeWithOffset: string, overrides: Partial<HistoricalSourceCandleRow> = {}): HistoricalSourceCandleRow {
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

function normalSessionSourceRows(overridesByMinuteIndex: Map<number, Partial<HistoricalSourceCandleRow>> = new Map()): HistoricalSourceCandleRow[] {
  const start = new Date(`${TRADING_DATE}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) =>
    sourceRow(index, new Date(start + index * 60_000).toISOString(), overridesByMinuteIndex.get(index) ?? {})
  );
}

function projectionRequest(sourceRows: readonly HistoricalSourceCandleRow[], assetType = HistoricalAssetType.NIFTY_INDEX): CanonicalSessionProjectionRequest {
  return {
    assetType,
    instrumentKey: INSTRUMENT_KEY,
    tradingDate: TRADING_DATE,
    sessionDeclaration: CanonicalSessionDeclaration.NORMAL_NIFTY_SESSION,
    sourceRows,
  };
}

function project(sourceRows: readonly HistoricalSourceCandleRow[], assetType = HistoricalAssetType.NIFTY_INDEX): CanonicalSessionProjectionResult {
  return projector.project(projectionRequest(sourceRows, assetType));
}

test('an exact healthy 375-row NIFTY session is HEALTHY', () => {
  const report = validator.validate(project(normalSessionSourceRows()));

  assert.equal(report.status, DatasetHealthStatus.HEALTHY);
  assert.equal(report.canonicalRowCount, 375);
  assert.equal(report.expectedRowCount, 375);
  assert.equal(report.excludedRowCount, 0);
  assert.equal(report.missingMinuteCount, 0);
  assert.equal(report.duplicateTimestampCount, 0);
  assert.equal(report.issues.length, 0);
});

test('a 378-row provider response normalizes to NORMALIZED_WITH_EXCLUSIONS, not silently pretending the raw input was canonical', () => {
  const rows = normalSessionSourceRows();
  rows.unshift(sourceRow(9999, `${TRADING_DATE}T09:07:00+05:30`));
  rows.push(sourceRow(10000, `${TRADING_DATE}T15:30:00+05:30`));
  rows.push(sourceRow(10001, `${TRADING_DATE}T15:31:00+05:30`));

  const projection = project(rows);
  assert.equal(projection.sourceRowCount, 378);
  const report = validator.validate(projection);

  assert.equal(report.status, DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS);
  assert.equal(report.sourceRowCount, 378);
  assert.equal(report.canonicalRowCount, 375);
  assert.equal(report.excludedRowCount, 3);
});

test('a session missing exactly one canonical minute is INCOMPLETE, with the exact missing minute identified', () => {
  const rows = normalSessionSourceRows().filter((_, index) => index !== 100); // drop 09:15 + 100 minutes = 10:55
  const report = validator.validate(project(rows));

  assert.equal(report.status, DatasetHealthStatus.INCOMPLETE);
  assert.equal(report.canonicalRowCount, 374);
  assert.equal(report.missingMinuteCount, 1);
  const missing = report.issues.find((issue) => issue.reason === DatasetHealthIssueReason.MISSING_CANONICAL_MINUTE);
  assert.ok(missing);
  assert.equal(missing!.candleTime!.toISOString(), new Date(`${TRADING_DATE}T10:55:00+05:30`).toISOString());
});

test('a duplicate minute is INVALID, with the duplicate timestamp identified', () => {
  const rows = normalSessionSourceRows();
  const duplicateOfFirst = sourceRow(9999, rows[0].candleTime.toISOString());
  rows.push(duplicateOfFirst); // 376 source rows: minute 09:15 appears twice, 15:29 is still last -> all 376 land in-window

  const report = validator.validate(project(rows));

  assert.equal(report.status, DatasetHealthStatus.INVALID);
  assert.equal(report.duplicateTimestampCount, 2);
  const duplicates = report.issues.filter((issue) => issue.reason === DatasetHealthIssueReason.DUPLICATE_TIMESTAMP);
  assert.equal(duplicates.length, 2);
  assert.equal(duplicates[0].candleTime!.toISOString(), rows[0].candleTime.toISOString());
});

test('OHLC relationship violations are each reported as INVALID_OHLC and roll up to INVALID', () => {
  const highBelowOpenClose = normalSessionSourceRows(new Map([[0, { open: 100, close: 105, high: 102, low: 95 }]]));
  const lowAboveOpenClose = normalSessionSourceRows(new Map([[0, { open: 100, close: 105, high: 110, low: 101 }]]));
  const highBelowLow = normalSessionSourceRows(new Map([[0, { open: 100, close: 100, high: 90, low: 95 }]]));

  for (const rows of [highBelowOpenClose, lowAboveOpenClose, highBelowLow]) {
    const report = validator.validate(project(rows));
    assert.equal(report.status, DatasetHealthStatus.INVALID);
    assert.equal(report.invalidOhlcCount, 1);
    assert.ok(report.issues.some((issue) => issue.reason === DatasetHealthIssueReason.INVALID_OHLC));
  }
});

test('zero volume and zero open interest are valid when the session is otherwise structurally healthy', () => {
  const rows = normalSessionSourceRows(new Map([[0, { volume: 0n, openInterest: 0n }]]));
  const report = validator.validate(project(rows, HistoricalAssetType.NIFTY_OPTION));

  assert.equal(report.status, DatasetHealthStatus.HEALTHY);
  assert.equal(report.issues.length, 0);
});

test('absent (null) open interest is supported and does not produce an issue', () => {
  const rows = normalSessionSourceRows(new Map([[0, { openInterest: null }]]));
  const report = validator.validate(project(rows, HistoricalAssetType.NIFTY_OPTION));

  assert.equal(report.status, DatasetHealthStatus.HEALTHY);
});

test('a cross-session row is excluded by the projector with typed evidence, never silently dropped', () => {
  const rows = [...normalSessionSourceRows(), sourceRow(9999, '2026-08-18T09:15:00+05:30')];
  const projection = project(rows);
  const report = validator.validate(projection);

  assert.equal(report.status, DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS);
  assert.equal(report.excludedRowCount, 1);
});

test('cross-session contamination injected directly into canonical rows (bypassing the projector) is fail-closed INVALID', () => {
  const acceptedRows: CanonicalHistoricalCandle[] = normalSessionSourceRows().map((row) => ({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    candleTime: row.candleTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    openInterest: row.openInterest,
  }));
  acceptedRows[0] = { ...acceptedRows[0], candleTime: new Date('2026-08-18T09:15:00+05:30') };

  const handRolledProjection: CanonicalSessionProjectionResult = {
    outcome: CanonicalSessionProjectionOutcome.NORMAL_SESSION_PROJECTED,
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    tradingDate: TRADING_DATE,
    sourceRowCount: 375,
    acceptedRows,
    excludedRows: [],
    sourceOrderAnomalies: [],
  };

  const report = validator.validate(handRolledProjection);
  assert.equal(report.status, DatasetHealthStatus.INVALID);
  assert.ok(report.issues.some((issue) => issue.reason === DatasetHealthIssueReason.CROSS_SESSION_CONTAMINATION));
});

test('an undeclared special session is reported SPECIAL_SESSION_EXCLUDED, never mistaken for an incomplete normal session', () => {
  const rows = normalSessionSourceRows().slice(0, 50);
  const projection = projector.project({
    ...projectionRequest(rows),
    sessionDeclaration: CanonicalSessionDeclaration.UNDECLARED_SPECIAL_SESSION,
  });
  const report = validator.validate(projection);

  assert.equal(report.status, DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED);
  assert.notEqual(report.status, DatasetHealthStatus.INCOMPLETE);
});

test('the validator does not mutate the projection or its rows', () => {
  const projection = Object.freeze(project(normalSessionSourceRows()));
  const originalFirstTime = projection.acceptedRows[0].candleTime.getTime();

  assert.doesNotThrow(() => validator.validate(projection));
  assert.equal(projection.acceptedRows[0].candleTime.getTime(), originalFirstTime);
});

test('issues are returned in deterministic ascending candleTime order', () => {
  const rows = normalSessionSourceRows().filter((_, index) => index !== 10 && index !== 200);
  const report = validator.validate(project(rows));

  const times = report.issues.map((issue) => issue.candleTime!.getTime());
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
});

test('a blank instrumentKey is METADATA_INCOMPLETE, not run through row validation', () => {
  const projection = project(normalSessionSourceRows());
  const report = validator.validate({ ...projection, instrumentKey: '' });

  assert.equal(report.status, DatasetHealthStatus.METADATA_INCOMPLETE);
});

test('zero source rows is PROVIDER_UNAVAILABLE, distinct from an incomplete session', () => {
  const projection = project([]);
  const report = validator.validate(projection);

  assert.equal(report.status, DatasetHealthStatus.PROVIDER_UNAVAILABLE);
  assert.notEqual(report.status, DatasetHealthStatus.INCOMPLETE);
});

test('BLOCKER 1 regression: 375 otherwise-perfect rows with one adjacent raw swap is fail-closed INVALID, never HEALTHY', () => {
  const rows = normalSessionSourceRows();
  const swappedRaw = [...rows];
  [swappedRaw[1], swappedRaw[2]] = [swappedRaw[2], swappedRaw[1]];

  const projection = project(swappedRaw);
  // acceptedRows is still the fully sorted canonical 375-row session -- the
  // pre-fix bug relied on exactly this to mask the anomaly as HEALTHY.
  assert.equal(projection.acceptedRows.length, 375);
  assert.equal(projection.excludedRows.length, 0);
  assert.equal(projection.sourceOrderAnomalies.length, 1);

  const report = validator.validate(projection);

  assert.equal(report.status, DatasetHealthStatus.INVALID);
  assert.notEqual(report.status, DatasetHealthStatus.HEALTHY);
  assert.ok(report.issues.some((issue) => issue.reason === DatasetHealthIssueReason.NON_MONOTONIC_ORDER));
});

// ============================================================================
// B-F2-CAL-2: calendar-declared (special-session) expected-minute sets
// ============================================================================

function calendarRow(sourceIndex: number, minuteOfDay: number): HistoricalSourceCandleRow {
  const dayStart = new Date(`${TRADING_DATE}T00:00:00+05:30`).getTime();
  return sourceRow(sourceIndex, new Date(dayStart + minuteOfDay * 60_000).toISOString());
}

function projectCalendar(sourceRows: readonly HistoricalSourceCandleRow[], windows: readonly { windowIndex: number; openMinuteIst: number; closeMinuteIst: number }[]): CanonicalSessionProjectionResult {
  return projector.project({
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: INSTRUMENT_KEY,
    tradingDate: TRADING_DATE,
    sessionDeclaration: CanonicalSessionDeclaration.CALENDAR_DECLARED_SESSION,
    sessionWindows: windows,
    sourceRows,
  });
}

test('CAL-2: a multi-window special session with exactly its 105 expected minutes present is HEALTHY, with expectedRowCount 105 (never the fixed 375 default)', () => {
  const windows = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const expectedMinutes = [
    ...Array.from({ length: 45 }, (_, i) => 555 + i),
    ...Array.from({ length: 60 }, (_, i) => 690 + i),
  ];
  const rows = expectedMinutes.map((minute, index) => calendarRow(index, minute));

  const projection = projectCalendar(rows, windows);
  const report = validator.validate(projection, expectedMinutes);

  assert.equal(report.status, DatasetHealthStatus.HEALTHY);
  assert.equal(report.canonicalRowCount, 105);
  assert.equal(report.expectedRowCount, 105);
  assert.equal(report.missingMinuteCount, 0);
});

test('CAL-2: a special session missing exactly one of ITS OWN expected minutes is INCOMPLETE against the 105-minute set, never scored as "270 minutes missing" against the fixed 375 default', () => {
  const windows = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const expectedMinutes = [
    ...Array.from({ length: 45 }, (_, i) => 555 + i),
    ...Array.from({ length: 60 }, (_, i) => 690 + i),
  ];
  const rows = expectedMinutes.filter((minute) => minute !== 700).map((minute, index) => calendarRow(index, minute));

  const projection = projectCalendar(rows, windows);
  const report = validator.validate(projection, expectedMinutes);

  assert.equal(report.status, DatasetHealthStatus.INCOMPLETE);
  assert.equal(report.canonicalRowCount, 104);
  assert.equal(report.expectedRowCount, 105);
  assert.equal(report.missingMinuteCount, 1);
  const missing = report.issues.find((issue) => issue.reason === DatasetHealthIssueReason.MISSING_CANONICAL_MINUTE);
  assert.ok(missing);
  assert.equal(missing!.candleTime!.toISOString(), new Date(`${TRADING_DATE}T11:40:00+05:30`).toISOString()); // minute 700 = 11:40 IST
});

test('CAL-2: omitting expectedMinutesIst preserves the exact pre-CAL-2 default (09:15-15:29/375) -- backward compatible for every existing caller', () => {
  const report = validator.validate(project(normalSessionSourceRows()));
  assert.equal(report.expectedRowCount, 375);
  assert.equal(report.status, DatasetHealthStatus.HEALTHY);
});

test('BLOCKER 1 regression: the INVALID result for a swapped raw source is deterministic across repeated validation calls', () => {
  const rows = normalSessionSourceRows();
  const swappedRaw = [...rows];
  [swappedRaw[1], swappedRaw[2]] = [swappedRaw[2], swappedRaw[1]];
  const projection = project(swappedRaw);

  const first = validator.validate(projection);
  const second = validator.validate(projection);

  assert.equal(first.status, DatasetHealthStatus.INVALID);
  assert.equal(second.status, DatasetHealthStatus.INVALID);
  assert.deepEqual(
    first.issues.map((issue) => [issue.reason, issue.candleTime?.toISOString()]),
    second.issues.map((issue) => [issue.reason, issue.candleTime?.toISOString()])
  );
});
