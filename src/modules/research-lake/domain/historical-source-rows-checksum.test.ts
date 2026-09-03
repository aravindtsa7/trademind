import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalSourceCandleRow } from './canonical-historical-candle';
import { computeSourceRowsSemanticChecksum } from './historical-source-rows-checksum';

function row(sourceIndex: number, isoTime: string, overrides: Partial<HistoricalSourceCandleRow> = {}): HistoricalSourceCandleRow {
  return {
    sourceIndex,
    candleTime: new Date(isoTime),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

test('computeSourceRowsSemanticChecksum: identical rows in the identical order produce the identical checksum', () => {
  const rows = [row(0, '2024-01-19T03:45:00.000Z'), row(1, '2024-01-19T03:46:00.000Z')];
  assert.equal(computeSourceRowsSemanticChecksum(rows), computeSourceRowsSemanticChecksum([...rows]));
});

test('computeSourceRowsSemanticChecksum: is truthfully named -- never claims to hash raw HTTP bytes; it is a pure function over HistoricalSourceCandleRow[]', () => {
  // Documentation-as-test: the function signature itself only accepts HistoricalSourceCandleRow[], never a Buffer/string HTTP body.
  const rows = [row(0, '2024-01-19T03:45:00.000Z')];
  const checksum = computeSourceRowsSemanticChecksum(rows);
  assert.equal(typeof checksum, 'string');
  assert.equal(checksum.length, 64); // sha256 hex digest length
});

test('computeSourceRowsSemanticChecksum: a REORDERED but otherwise-identical row set produces a DIFFERENT checksum -- provider delivery order is semantic content', () => {
  const a = row(0, '2024-01-19T03:45:00.000Z');
  const b = row(1, '2024-01-19T03:46:00.000Z');
  assert.notEqual(computeSourceRowsSemanticChecksum([a, b]), computeSourceRowsSemanticChecksum([b, a]));
});

test('computeSourceRowsSemanticChecksum: a single differing OHLC value changes the checksum', () => {
  const rows = [row(0, '2024-01-19T03:45:00.000Z')];
  const drifted = [row(0, '2024-01-19T03:45:00.000Z', { close: 200 })];
  assert.notEqual(computeSourceRowsSemanticChecksum(rows), computeSourceRowsSemanticChecksum(drifted));
});

test('computeSourceRowsSemanticChecksum: a volume difference changes the checksum', () => {
  const rows = [row(0, '2024-01-19T03:45:00.000Z')];
  const drifted = [row(0, '2024-01-19T03:45:00.000Z', { volume: 2_000n })];
  assert.notEqual(computeSourceRowsSemanticChecksum(rows), computeSourceRowsSemanticChecksum(drifted));
});

test('computeSourceRowsSemanticChecksum: openInterest null vs a value changes the checksum', () => {
  const rows = [row(0, '2024-01-19T03:45:00.000Z', { openInterest: null })];
  const drifted = [row(0, '2024-01-19T03:45:00.000Z', { openInterest: 42n })];
  assert.notEqual(computeSourceRowsSemanticChecksum(rows), computeSourceRowsSemanticChecksum(drifted));
});

test('computeSourceRowsSemanticChecksum: an empty row set (zero provider rows) is stable and deterministic', () => {
  assert.equal(computeSourceRowsSemanticChecksum([]), computeSourceRowsSemanticChecksum([]));
});

// ============================================================================
// B-M7.1 CORRECTION regression: WHY request-scope matters. `sourceIndex` is
// the row's position within the CALLER-SUPPLIED source array for one
// provider request -- `UpstoxHistoricalDataProviderService` numbers it
// 0..N-1 across the WHOLE requested range, and `NiftyUnderlyingAcquisitionService`
// groups the result into per-trading-date sessions WITHOUT renumbering it.
// So the identical candle content, observed via two DIFFERENTLY-SCOPED
// requests (e.g. a 2022-03-01..2022-03-31 monthly chunk vs. an exact
// 2022-03-07..2022-03-07 request), lands at a DIFFERENT sourceIndex in each
// -- and therefore produces a DIFFERENT checksum, even though neither
// necessarily reflects drifted OHLC data. This is intentional
// (SOURCE_ROWS_CHECKSUM_VERSION=1 also detects source-ORDER anomalies), so
// this test documents/locks the behavior rather than proposing to change it.
// ============================================================================

test('computeSourceRowsSemanticChecksum: identical candle content at a DIFFERENT sourceIndex (as happens when the same row is embedded at a different position within a differently-scoped parent request) produces a DIFFERENT checksum -- monthly-chunk and exact-day evidence for the same trading date are NOT directly checksum-comparable', () => {
  // The exact same candle, but observed as the 0th row of an exact single-date
  // request (sourceIndex=0) vs. e.g. the 6th row of a monthly chunk that also
  // covered several days before it (sourceIndex=6) -- OHLC/volume/openInterest
  // and candleTime are byte-for-byte identical in both.
  const exactDayRequestRow = row(0, '2022-03-07T04:00:00.000Z', { open: 17024.1, high: 17024.6, low: 17023.6, close: 17024.3, volume: 500n });
  const monthlyChunkRow = row(6, '2022-03-07T04:00:00.000Z', { open: 17024.1, high: 17024.6, low: 17023.6, close: 17024.3, volume: 500n });
  assert.notEqual(computeSourceRowsSemanticChecksum([exactDayRequestRow]), computeSourceRowsSemanticChecksum([monthlyChunkRow]));
});

test('computeSourceRowsSemanticChecksum: never includes anything beyond the row fields -- no retrieval ID/timestamp/secret leaks into the digest input by construction (same rows -> same digest across repeated calls at different wall-clock times)', async () => {
  const rows = [row(0, '2024-01-19T03:45:00.000Z')];
  const first = computeSourceRowsSemanticChecksum(rows);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = computeSourceRowsSemanticChecksum(rows);
  assert.equal(first, second);
});
