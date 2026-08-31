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

test('computeSourceRowsSemanticChecksum: never includes anything beyond the row fields -- no retrieval ID/timestamp/secret leaks into the digest input by construction (same rows -> same digest across repeated calls at different wall-clock times)', async () => {
  const rows = [row(0, '2024-01-19T03:45:00.000Z')];
  const first = computeSourceRowsSemanticChecksum(rows);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = computeSourceRowsSemanticChecksum(rows);
  assert.equal(first, second);
});
