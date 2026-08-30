import assert from 'node:assert/strict';
import test from 'node:test';
import { ExchangeCalendarOpsMode, ExchangeCalendarOpsModeError, parseExchangeCalendarOpsMode } from './exchange-calendar-ops-mode.util';

test('undefined defaults to VALIDATE', () => {
  assert.equal(parseExchangeCalendarOpsMode(undefined), ExchangeCalendarOpsMode.VALIDATE);
});

test('blank/whitespace-only defaults to VALIDATE', () => {
  assert.equal(parseExchangeCalendarOpsMode(''), ExchangeCalendarOpsMode.VALIDATE);
  assert.equal(parseExchangeCalendarOpsMode('   '), ExchangeCalendarOpsMode.VALIDATE);
});

test('every real mode name is accepted exactly', () => {
  assert.equal(parseExchangeCalendarOpsMode('VALIDATE'), ExchangeCalendarOpsMode.VALIDATE);
  assert.equal(parseExchangeCalendarOpsMode('IMPORT_DRAFT'), ExchangeCalendarOpsMode.IMPORT_DRAFT);
  assert.equal(parseExchangeCalendarOpsMode('CERTIFY'), ExchangeCalendarOpsMode.CERTIFY);
  assert.equal(parseExchangeCalendarOpsMode('VERIFY'), ExchangeCalendarOpsMode.VERIFY);
});

test('a near-miss typo of a real mode is rejected, never silently defaulted to VALIDATE or coerced', () => {
  assert.throws(() => parseExchangeCalendarOpsMode('IMPORT_DRFAT'), ExchangeCalendarOpsModeError);
  assert.throws(() => parseExchangeCalendarOpsMode('import_draft'), ExchangeCalendarOpsModeError); // case-sensitive, not fuzzy
  assert.throws(() => parseExchangeCalendarOpsMode('CERTIFYY'), ExchangeCalendarOpsModeError);
});

test('an unrelated garbage value is rejected', () => {
  assert.throws(() => parseExchangeCalendarOpsMode('DELETE_EVERYTHING'), ExchangeCalendarOpsModeError);
});
