import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import DatasetSessionManifestBuilderService, { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { OptionCandleObservationState } from '../domain/historical-option-candle-observation.types';
import { HistoricalOptionType } from '../domain/historical-asset.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestCandleContent,
  ManifestDatasetKind,
  SourceAcquisitionEvidenceAvailability,
  UnderlyingSessionIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { SessionWindow } from '../domain/exchange-calendar.types';

const TRADING_DATE = '2026-08-17';
const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

function row(candleTime: Date, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  return {
    candleTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(100.5),
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

/** Full healthy 375-row 09:15-15:29 IST session. */
function normalSessionRows(overridesByMinuteIndex: Map<number, Partial<PersistedManifestCandleRow>> = new Map()): PersistedManifestCandleRow[] {
  const start = new Date(`${TRADING_DATE}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => row(new Date(start + index * 60_000), overridesByMinuteIndex.get(index) ?? {}));
}

const builder = new DatasetSessionManifestBuilderService();

test('(A) identical underlying rows -> identical session checksum', () => {
  const first = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  const second = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(first.contentChecksum, second.contentChecksum);
  assert.equal(first.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
});

test('(B) input row order does not affect the session checksum', () => {
  const rows = normalSessionRows();
  const forward = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  const reversed = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: [...rows].reverse() });
  assert.equal(forward.contentChecksum, reversed.contentChecksum);
});

test('(C) one candle timestamp changed -> different checksum', () => {
  const base = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  const rows = normalSessionRows();
  rows[10] = { ...rows[10], candleTime: new Date(rows[10].candleTime.getTime() + 500) };
  const mutated = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  assert.notEqual(base.contentChecksum, mutated.contentChecksum);
});

test('(D) one OHLC field changed -> different checksum', () => {
  const base = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  const rows = normalSessionRows(new Map([[10, { close: new Prisma.Decimal(999.99) }]]));
  const mutated = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  assert.notEqual(base.contentChecksum, mutated.contentChecksum);
});

test('(E) volume changed -> different checksum', () => {
  const base = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  const rows = normalSessionRows(new Map([[10, { volume: 2_000n }]]));
  const mutated = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  assert.notEqual(base.contentChecksum, mutated.contentChecksum);
});

test('(H) volatile DB fields (createdAt/updatedAt/id) cannot influence the checksum -- the builder only reads candleTime/OHLC/volume/openInterest', () => {
  const rows = normalSessionRows();
  const withVolatileFields = rows.map((r) => ({ ...r, id: 'some-uuid', createdAt: new Date('2020-01-01'), updatedAt: new Date('2099-01-01'), source: 'REST' }));
  const base = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  const withExtras = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: withVolatileFields });
  assert.equal(base.contentChecksum, withExtras.contentChecksum);
});

test('(N) a structurally invalid session (duplicate timestamp) is reported INVALID, never silently certified healthy -- but its checksum is still stable/reproducible', () => {
  const rows = normalSessionRows();
  rows[1] = { ...rows[1], candleTime: rows[0].candleTime }; // duplicate timestamp
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.INVALID);
  const manifestAgain = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  assert.equal(manifest.contentChecksum, manifestAgain.contentChecksum); // checksum proves CONTENT IDENTITY, not DATA QUALITY
});

test('(O) a session missing one canonical minute remains explicitly INCOMPLETE, never upgraded to HEALTHY', () => {
  const rows = normalSessionRows().slice(1); // drop the 09:15 row -> missing one canonical minute
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.INCOMPLETE);
});

test('(Q) source acquisition evidence is explicitly unavailable (not fabricated as zero/HEALTHY) when reconstructing from the persisted store alone', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE);
  assert.equal(manifest.sourceAcquisitionEvidence.providerRowCount, null);
  assert.equal(manifest.sourceAcquisitionEvidence.excludedRowCount, null);
  assert.equal(manifest.sourceAcquisitionEvidence.sourceOrderAnomalyCount, null);
  assert.equal(manifest.sourceAcquisitionEvidence.sourceHealthStatus, null);
});

// ---- Root-defect correction regression tests (independent review) --------
// "Persisted canonical health != source acquisition health": a manifest
// reconstructed purely from the persisted store can prove the health of the
// PERSISTED CANONICAL CONTENT, but can never prove the original PROVIDER
// acquisition had no exclusions or source-order anomalies (B-F2/B-F4 never
// persist that evidence).

test('(REVIEW-A) 375 persisted canonical rows may truthfully be classified persisted-canonical HEALTHY', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
});

test('(REVIEW-B) that same HEALTHY persisted-canonical result is NEVER reported as source-acquisition HEALTHY -- source evidence stays unavailable', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.notEqual(manifest.sourceAcquisitionEvidence.sourceHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(manifest.sourceAcquisitionEvidence.sourceHealthStatus, null); // unknown, never fabricated as HEALTHY
});

test('(REVIEW-C) providerRowCount is unavailable, never asserted as 375 by assumption from the persisted row count', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.canonicalRowCount, 375);
  assert.equal(manifest.sourceAcquisitionEvidence.providerRowCount, null);
  assert.notEqual(manifest.sourceAcquisitionEvidence.providerRowCount, manifest.canonicalRowCount);
});

test('(REVIEW-D) excludedRowCount is unavailable, never fabricated as zero', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.sourceAcquisitionEvidence.excludedRowCount, null);
  assert.notStrictEqual(manifest.sourceAcquisitionEvidence.excludedRowCount, 0); // unknown must never collapse to a proven zero
});

test('(REVIEW-E) source-order anomaly evidence is unavailable, never asserted as zero', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.sourceAcquisitionEvidence.sourceOrderAnomalyCount, null);
  assert.notStrictEqual(manifest.sourceAcquisitionEvidence.sourceOrderAnomalyCount, 0);
});

test('(REVIEW-F) a reconstructed manifest cannot claim the original source was exclusion-free -- availability stays UNAVAILABLE_FROM_PERSISTED_STORE even for a perfectly healthy persisted session', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(manifest.sourceAcquisitionEvidence.availability, SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE);
});

test('(REVIEW-M) content checksum formula is untouched by the source-acquisition-evidence correction -- it still depends only on identity/candles/version constants, never on health status or source-evidence representation', () => {
  const rows = normalSessionRows();
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  const identity: UnderlyingSessionIdentity = { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE };
  const candles: ManifestCandleContent[] = rows.map((r) => ({ candleTime: r.candleTime.toISOString(), open: r.open.toString(), high: r.high.toString(), low: r.low.toString(), close: r.close.toString(), volume: r.volume.toString(), openInterest: r.openInterest === null ? null : r.openInterest.toString() }));
  const independentlyComputed = computeSessionContentChecksum({ identity, canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION, healthSemanticsVersion: HEALTH_SEMANTICS_VERSION, candles });
  assert.equal(manifest.contentChecksum, independentlyComputed);
});

// ---- Options ---------------------------------------------------------------

const OPTION_CONTRACT_ID = 'NSE-NIFTY-06Jan22-17200-PE';

function optionSession(rows: PersistedManifestCandleRow[]) {
  return builder.buildOptionSession({
    provider: HistoricalProviderId.GROWW,
    providerContractId: OPTION_CONTRACT_ID,
    optionType: HistoricalOptionType.PE,
    strikePrice: 17200,
    expiry: new Date('2022-01-06T00:00:00+05:30'),
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
    rows,
  });
}

test('(F) option openInterest change -> different checksum', () => {
  const base = optionSession([row(new Date(`${TRADING_DATE}T09:15:00+05:30`), { openInterest: 500n })]);
  const mutated = optionSession([row(new Date(`${TRADING_DATE}T09:15:00+05:30`), { openInterest: 600n })]);
  assert.notEqual(base.contentChecksum, mutated.contentChecksum);
});

test('(G) option openInterest null is stored/hashed distinctly from openInterest zero', () => {
  const withNull = optionSession([row(new Date(`${TRADING_DATE}T09:15:00+05:30`), { openInterest: null })]);
  const withZero = optionSession([row(new Date(`${TRADING_DATE}T09:15:00+05:30`), { openInterest: 0n })]);
  assert.notEqual(withNull.contentChecksum, withZero.contentChecksum);
  assert.equal(withNull.rowsWithNullOi, 1);
  assert.equal(withNull.rowsWithOi, 0);
  assert.equal(withZero.rowsWithOi, 1);
  assert.equal(withZero.rowsWithNullOi, 0);
});

test('(P) a partial option session is PARTIAL_OBSERVED_SESSION, never promoted to COMPLETE_SESSION merely because a checksum exists', () => {
  const rows = normalSessionRows().slice(1); // one missing canonical minute
  const manifest = optionSession(rows);
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.INCOMPLETE);
  assert.equal(manifest.optionObservationState, OptionCandleObservationState.PARTIAL_OBSERVED_SESSION);
  assert.notEqual(manifest.optionObservationState, OptionCandleObservationState.COMPLETE_SESSION);
});

test('a complete option session is COMPLETE_SESSION', () => {
  const manifest = optionSession(normalSessionRows());
  assert.equal(manifest.optionObservationState, OptionCandleObservationState.COMPLETE_SESSION);
});

test('optionObservationState is null for UNDERLYING_1M sessions', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  assert.equal(manifest.optionObservationState, null);
  assert.equal(manifest.rowsWithOi, null);
  assert.equal(manifest.rowsWithNullOi, null);
});

// ---- B-F5 CALENDAR FIX: calendar-declared sessionWindows -------------------

const REDUCED_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 1005, closeMinuteIst: 1065 }; // 60-minute special session

function rowsForWindow(window: SessionWindow): PersistedManifestCandleRow[] {
  const start = new Date(`${TRADING_DATE}T00:00:00+05:30`).getTime();
  const rows: PersistedManifestCandleRow[] = [];
  for (let minute = window.openMinuteIst; minute < window.closeMinuteIst; minute += 1) rows.push(row(new Date(start + minute * 60_000)));
  return rows;
}

test('with no sessionWindows supplied, a 60-row special session is scored against the legacy fixed 375-row default and reported INCOMPLETE', () => {
  const manifest = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: rowsForWindow(REDUCED_WINDOW) });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.INCOMPLETE);
  assert.deepEqual(manifest.calendarSessionWindows, []);
});

test('with calendar-declared sessionWindows supplied, the SAME 60 rows are HEALTHY -- scored against the real window, not the fixed default', () => {
  const manifest = builder.buildUnderlyingSession({
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: INSTRUMENT_KEY,
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
    rows: rowsForWindow(REDUCED_WINDOW),
    sessionWindows: [REDUCED_WINDOW],
  });
  assert.equal(manifest.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(manifest.canonicalRowCount, 60);
  assert.deepEqual(manifest.calendarSessionWindows, [REDUCED_WINDOW]);
});

test('sessionWindows never perturbs contentChecksum -- it is observability material (health), never identity material', () => {
  const rows = rowsForWindow(REDUCED_WINDOW);
  const withoutWindows = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows });
  const withWindows = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows, sessionWindows: [REDUCED_WINDOW] });
  assert.equal(withoutWindows.contentChecksum, withWindows.contentChecksum);
  assert.notEqual(withoutWindows.persistedCanonicalHealthStatus, withWindows.persistedCanonicalHealthStatus);
});

test('an ordinary REGULAR_SESSION 375-row session is HEALTHY whether or not the calendar-derived regular window is explicitly supplied', () => {
  const REGULAR_WINDOW: SessionWindow = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 };
  const withoutWindows = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows() });
  const withWindows = builder.buildUnderlyingSession({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: TRADING_DATE, rows: normalSessionRows(), sessionWindows: [REGULAR_WINDOW] });
  assert.equal(withoutWindows.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(withWindows.persistedCanonicalHealthStatus, DatasetHealthStatus.HEALTHY);
  assert.equal(withoutWindows.contentChecksum, withWindows.contentChecksum);
});
