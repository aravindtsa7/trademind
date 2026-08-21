import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HISTORICAL_CANDLE_SYNC_LOG_ERROR_MESSAGE_MAX_LENGTH,
  normalizeSyncLogErrorMessage,
} from './historical-candle.repository';

// The exact 192-character message from the real 2026-08-21 incident (one
// character over VARCHAR(191)).
const REAL_INCIDENT_MESSAGE =
  'Historical candle session for 2026-08-21 remains incomplete after ' +
  'reconciliation fetch and persistence (rowCount=283, expected 375 ' +
  'complete/contiguous/minute-aligned rows for 09:15-15:29 IST).';

test('the real 2026-08-21 incident message is exactly 192 characters (one over the VARCHAR(191) limit)', () => {
  assert.equal(REAL_INCIDENT_MESSAGE.length, 192);
});

test('a too-long errorMessage is truncated to fit exactly within the 191-character column', () => {
  const result = normalizeSyncLogErrorMessage({ errorMessage: REAL_INCIDENT_MESSAGE });
  assert.ok(result.errorMessage);
  assert.equal(result.errorMessage!.length, HISTORICAL_CANDLE_SYNC_LOG_ERROR_MESSAGE_MAX_LENGTH);
});

test('truncation preserves the original message as a strict prefix, plus a trailing truncation marker', () => {
  const result = normalizeSyncLogErrorMessage({ errorMessage: REAL_INCIDENT_MESSAGE });
  const body = result.errorMessage!.slice(0, -1);
  assert.equal(REAL_INCIDENT_MESSAGE.startsWith(body), true);
  assert.equal(result.errorMessage!.endsWith('…'), true);
});

test('a short errorMessage is stored unchanged', () => {
  const result = normalizeSyncLogErrorMessage({ errorMessage: 'short failure', status: 'FAILED' });
  assert.equal(result.errorMessage, 'short failure');
  assert.equal(result.status, 'FAILED');
});

test('a message exactly at the 191-character limit is stored unchanged (no off-by-one truncation)', () => {
  const exact = 'x'.repeat(HISTORICAL_CANDLE_SYNC_LOG_ERROR_MESSAGE_MAX_LENGTH);
  const result = normalizeSyncLogErrorMessage({ errorMessage: exact });
  assert.equal(result.errorMessage, exact);
  assert.equal(result.errorMessage!.length, 191);
});

test('a message one character over the limit (192) is truncated', () => {
  const overByOne = 'x'.repeat(192);
  const result = normalizeSyncLogErrorMessage({ errorMessage: overByOne });
  assert.equal(result.errorMessage!.length, 191);
  assert.equal(result.errorMessage, `${'x'.repeat(190)}…`);
});

test('undefined errorMessage passes through untouched (does not introduce the key)', () => {
  const input: { status: string; errorMessage?: string } = { status: 'COMPLETED' };
  const result = normalizeSyncLogErrorMessage(input);
  assert.equal('errorMessage' in result, false);
});

test('null errorMessage passes through unchanged', () => {
  const result = normalizeSyncLogErrorMessage({ errorMessage: null });
  assert.equal(result.errorMessage, null);
});

test('a non-string errorMessage shape (e.g. a Prisma scalar-update-operator object) passes through untouched', () => {
  const operatorShape = { set: 'x'.repeat(500) };
  const result = normalizeSyncLogErrorMessage({ errorMessage: operatorShape });
  assert.equal(result.errorMessage, operatorShape);
});

test('a surrogate pair sitting exactly on the truncation boundary is never split', () => {
  // U+1F600 (a 2-code-unit astral character) placed so a naive slice(0, 190) would cut it in half.
  const astral = '\u{1F600}';
  const message = 'x'.repeat(189) + astral + 'y'.repeat(20); // astral pair spans indices 189-190
  const result = normalizeSyncLogErrorMessage({ errorMessage: message });
  const body = result.errorMessage!.slice(0, -1);
  // The lone trailing code unit must not be an unpaired high surrogate.
  const lastCode = body.charCodeAt(body.length - 1);
  assert.equal(lastCode >= 0xd800 && lastCode <= 0xdbff, false);
});
