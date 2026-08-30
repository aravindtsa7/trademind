import assert from 'node:assert/strict';
import test from 'node:test';
import {
  determineExchangeCalendarOpsCertifyExitCode,
  determineExchangeCalendarOpsImportDraftExitCode,
  determineExchangeCalendarOpsValidateExitCode,
  determineExchangeCalendarOpsVerifyExitCode,
} from './exchange-calendar-ops-exit-policy.util';
import { ExchangeCalendarOpsValidateResult, ExchangeCalendarOpsImportDraftResult, ExchangeCalendarOpsCertifyResult, ExchangeCalendarOpsVerifyResult } from './exchange-calendar-ops-runner.service';

test('VALIDATE exits 0 when allValid, non-zero otherwise', () => {
  const ok: ExchangeCalendarOpsValidateResult = { requestedYear: 'ALL', fixturesConsidered: 0, valid: [], invalid: [], allValid: true };
  const bad: ExchangeCalendarOpsValidateResult = { ...ok, allValid: false };
  assert.equal(determineExchangeCalendarOpsValidateExitCode(ok), 0);
  assert.equal(determineExchangeCalendarOpsValidateExitCode(bad), 1);
});

test('IMPORT_DRAFT exits 0 only for IMPORTED', () => {
  const imported: ExchangeCalendarOpsImportDraftResult = { outcome: 'IMPORTED', kind: 'CREATED', coverageId: 'x', sourceBundleChecksum: 'a'.repeat(64) };
  const noFixture: ExchangeCalendarOpsImportDraftResult = { outcome: 'NO_FIXTURE_REGISTERED', calendarYear: 2022 };
  const invalid: ExchangeCalendarOpsImportDraftResult = { outcome: 'INVALID_FIXTURE', calendarYear: 2022, errorCode: 'X', message: 'm' };
  const schemaGap: ExchangeCalendarOpsImportDraftResult = { outcome: 'CALENDAR_SCHEMA_NOT_DEPLOYED', calendarYear: 2022 };
  assert.equal(determineExchangeCalendarOpsImportDraftExitCode(imported), 0);
  assert.equal(determineExchangeCalendarOpsImportDraftExitCode(noFixture), 1);
  assert.equal(determineExchangeCalendarOpsImportDraftExitCode(invalid), 1);
  assert.equal(determineExchangeCalendarOpsImportDraftExitCode(schemaGap), 1);
});

test('CERTIFY exits 0 only for ACTIVATED_OR_NOOP', () => {
  const activated: ExchangeCalendarOpsCertifyResult = { outcome: 'ACTIVATED_OR_NOOP', kind: 'ACTIVATED', coverageId: 'x', deprecatedCoverageId: null };
  const notFound: ExchangeCalendarOpsCertifyResult = { outcome: 'DRAFT_NOT_FOUND', calendarYear: 2024, version: 1 };
  const schemaGap: ExchangeCalendarOpsCertifyResult = { outcome: 'CALENDAR_SCHEMA_NOT_DEPLOYED', calendarYear: 2024, version: 1 };
  assert.equal(determineExchangeCalendarOpsCertifyExitCode(activated), 0);
  assert.equal(determineExchangeCalendarOpsCertifyExitCode(notFound), 1);
  assert.equal(determineExchangeCalendarOpsCertifyExitCode(schemaGap), 1);
});

test('VERIFY exits 0 only when every probe passed', () => {
  const allPass: ExchangeCalendarOpsVerifyResult = { probes: [], allPassed: true };
  const somePass: ExchangeCalendarOpsVerifyResult = { probes: [], allPassed: false };
  assert.equal(determineExchangeCalendarOpsVerifyExitCode(allPass), 0);
  assert.equal(determineExchangeCalendarOpsVerifyExitCode(somePass), 1);
});
