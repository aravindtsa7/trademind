import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrowwSymbol, GrowwSymbolKind, GrowwSymbolParseFailureReason } from './groww-contract-symbol-parser';
import { HistoricalOptionType } from '../../domain/historical-asset.types';

const EXPECTED = { exchange: 'NSE', underlyingSymbol: 'NIFTY' };

test('a valid NIFTY CE symbol parses all proven fields exactly', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02Jan25-28500-CE', EXPECTED);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.kind, GrowwSymbolKind.OPTION);
  const option = result.value as Extract<typeof result.value, { kind: GrowwSymbolKind.OPTION }>;
  assert.equal(option.rawSymbol, 'NSE-NIFTY-02Jan25-28500-CE');
  assert.equal(option.exchange, 'NSE');
  assert.equal(option.underlyingSymbol, 'NIFTY');
  assert.equal(option.strikePrice, 28500);
  assert.equal(option.optionType, HistoricalOptionType.CE);
  assert.equal(option.expiry.toISOString(), new Date('2025-01-02T00:00:00+05:30').toISOString());
});

test('a valid NIFTY PE symbol parses correctly', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02Jan25-28150-PE', EXPECTED);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const option = result.value as Extract<typeof result.value, { kind: GrowwSymbolKind.OPTION }>;
  assert.equal(option.strikePrice, 28150);
  assert.equal(option.optionType, HistoricalOptionType.PE);
});

test('a future symbol (4 segments, FUT) is explicitly classified as FUTURE, never coerced into an option', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-30Jan25-FUT', EXPECTED);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.kind, GrowwSymbolKind.FUTURE);
  assert.equal('strikePrice' in result.value, false);
  assert.equal('optionType' in result.value, false);
});

test('a 5-segment symbol with a non-numeric strike is rejected with MALFORMED_STRIKE', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02Jan25-ABCDE-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.MALFORMED_STRIKE);
});

test('a zero or negative strike is rejected with MALFORMED_STRIKE', () => {
  const zero = parseGrowwSymbol('NSE-NIFTY-02Jan25-0-CE', EXPECTED);
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.equal(zero.failure.reason, GrowwSymbolParseFailureReason.MALFORMED_STRIKE);
});

test('a malformed expiry segment is rejected with MALFORMED_EXPIRY', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-99Xyz99-28500-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.MALFORMED_EXPIRY);
});

test('a calendar-invalid expiry (e.g. Feb 30) is rejected with MALFORMED_EXPIRY, not silently rolled over', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-30Feb25-28500-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.MALFORMED_EXPIRY);
});

test('wrong-case month abbreviation is rejected (exact grammar, not case-insensitive guessing)', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02JAN25-28500-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.MALFORMED_EXPIRY);
});

test('a symbol for the wrong underlying is rejected with WRONG_UNDERLYING', () => {
  const result = parseGrowwSymbol('NSE-BANKNIFTY-02Jan25-28500-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.WRONG_UNDERLYING);
});

test('a symbol for the wrong exchange is rejected with WRONG_EXCHANGE', () => {
  const result = parseGrowwSymbol('BSE-NIFTY-02Jan25-28500-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.WRONG_EXCHANGE);
});

test('an unknown instrument-type suffix is rejected with UNKNOWN_INSTRUMENT_TYPE', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02Jan25-28500-XX', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.UNKNOWN_INSTRUMENT_TYPE);
});

test('too few segments is rejected with INVALID_SEGMENT_COUNT', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02Jan25', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.INVALID_SEGMENT_COUNT);
});

test('too many segments is rejected with INVALID_SEGMENT_COUNT', () => {
  const result = parseGrowwSymbol('NSE-NIFTY-02Jan25-28500-CE-EXTRA', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.INVALID_SEGMENT_COUNT);
});

test('an empty segment (double hyphen) is rejected with EMPTY_SEGMENT', () => {
  const result = parseGrowwSymbol('NSE-NIFTY--28500-CE', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.EMPTY_SEGMENT);
});

test('an empty string symbol is rejected with EMPTY_SYMBOL', () => {
  const result = parseGrowwSymbol('', EXPECTED);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.reason, GrowwSymbolParseFailureReason.EMPTY_SYMBOL);
});

test('deterministic: parsing the same symbol twice yields identical proven fields', () => {
  const first = parseGrowwSymbol('NSE-NIFTY-02Jan25-28500-CE', EXPECTED);
  const second = parseGrowwSymbol('NSE-NIFTY-02Jan25-28500-CE', EXPECTED);
  assert.deepEqual(
    first.ok ? { ...first.value, expiry: first.value.expiry.toISOString() } : first,
    second.ok ? { ...second.value, expiry: second.value.expiry.toISOString() } : second
  );
});
