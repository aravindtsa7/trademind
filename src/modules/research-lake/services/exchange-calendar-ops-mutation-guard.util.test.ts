import assert from 'node:assert/strict';
import test from 'node:test';
import { ExchangeCalendarOpsMode } from './exchange-calendar-ops-mode.util';
import {
  ExchangeCalendarOpsMutationRefusedError,
  ExchangeCalendarOpsTargetRefusedError,
  assertLocalDevDatabaseTarget,
  assertMutationApplyOptIn,
} from './exchange-calendar-ops-mutation-guard.util';

test('VALIDATE never requires apply opt-in, regardless of the flag value', () => {
  assert.doesNotThrow(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.VALIDATE, undefined));
  assert.doesNotThrow(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.VALIDATE, 'false'));
});

test('VERIFY never requires apply opt-in', () => {
  assert.doesNotThrow(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.VERIFY, undefined));
});

test('IMPORT_DRAFT without RESEARCH_CALENDAR_APPLY=true is refused', () => {
  assert.throws(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.IMPORT_DRAFT, undefined), ExchangeCalendarOpsMutationRefusedError);
  assert.throws(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.IMPORT_DRAFT, ''), ExchangeCalendarOpsMutationRefusedError);
  assert.throws(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.IMPORT_DRAFT, 'TRUE'), ExchangeCalendarOpsMutationRefusedError);
  assert.throws(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.IMPORT_DRAFT, '1'), ExchangeCalendarOpsMutationRefusedError);
  assert.throws(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.IMPORT_DRAFT, 'yes'), ExchangeCalendarOpsMutationRefusedError);
});

test('CERTIFY without RESEARCH_CALENDAR_APPLY=true is refused', () => {
  assert.throws(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.CERTIFY, undefined), ExchangeCalendarOpsMutationRefusedError);
});

test('IMPORT_DRAFT/CERTIFY with the exact string true proceed', () => {
  assert.doesNotThrow(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.IMPORT_DRAFT, 'true'));
  assert.doesNotThrow(() => assertMutationApplyOptIn(ExchangeCalendarOpsMode.CERTIFY, 'true'));
});

test('localhost target is eligible for mutation', () => {
  assert.doesNotThrow(() => assertLocalDevDatabaseTarget('mysql://root:secret@localhost:3306/trademind'));
});

test('127.0.0.1 and ::1 targets are eligible for mutation', () => {
  assert.doesNotThrow(() => assertLocalDevDatabaseTarget('mysql://root:secret@127.0.0.1:3306/trademind'));
  assert.doesNotThrow(() => assertLocalDevDatabaseTarget('mysql://root:secret@[::1]:3306/trademind'));
});

test('a remote-looking host is rejected', () => {
  assert.throws(() => assertLocalDevDatabaseTarget('mysql://root:secret@remote.example.com:3306/trademind'), ExchangeCalendarOpsTargetRefusedError);
});

test('a production-looking host is rejected -- no denylist keyword needed, allowlist rejects it by default', () => {
  assert.throws(() => assertLocalDevDatabaseTarget('mysql://root:secret@trademind-prod.internal:3306/trademind'), ExchangeCalendarOpsTargetRefusedError);
  assert.throws(() => assertLocalDevDatabaseTarget('mysql://root:secret@db.production.example.com:3306/trademind'), ExchangeCalendarOpsTargetRefusedError);
});

test('a missing DATABASE_URL is rejected', () => {
  assert.throws(() => assertLocalDevDatabaseTarget(undefined), ExchangeCalendarOpsTargetRefusedError);
  assert.throws(() => assertLocalDevDatabaseTarget(''), ExchangeCalendarOpsTargetRefusedError);
});

test('an unparseable DATABASE_URL is rejected', () => {
  assert.throws(() => assertLocalDevDatabaseTarget('not a url at all'), ExchangeCalendarOpsTargetRefusedError);
});

test('no password or full connection string ever appears in a thrown error message', () => {
  const secretPassword = 'sUpEr-SeCrEt-p4ssW0rd';
  try {
    assertLocalDevDatabaseTarget(`mysql://root:${secretPassword}@remote.example.com:3306/trademind`);
    assert.fail('expected assertLocalDevDatabaseTarget to throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message.includes(secretPassword), false, 'error message must never include the password');
    assert.equal(message.includes('root:'), false, 'error message must never include the username:password segment');
    assert.ok(message.includes('remote.example.com'), 'error message should still name the rejected (non-secret) hostname');
  }
});

test('a missing DATABASE_URL error message never claims a hostname was inspected', () => {
  try {
    assertLocalDevDatabaseTarget(undefined);
    assert.fail('expected assertLocalDevDatabaseTarget to throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(/missing/i.test(message));
  }
});
