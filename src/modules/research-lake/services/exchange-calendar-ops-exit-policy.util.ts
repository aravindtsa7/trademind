import {
  ExchangeCalendarOpsCertifyResult,
  ExchangeCalendarOpsImportDraftResult,
  ExchangeCalendarOpsValidateResult,
  ExchangeCalendarOpsVerifyResult,
} from './exchange-calendar-ops-runner.service';

/**
 * B-F7A-FIXTURES-1 CLI exit-code policy, one small pure function per mode
 * -- mirrors the existing `determineResearchYearRunCliExitCode` /
 * `determineNiftyIngestionPlanCliExitCode` convention. Each function is
 * fail-closed: any non-success outcome (including a schema-not-deployed
 * classification, a missing DRAFT, or an unregistered fixture) exits
 * non-zero rather than defaulting to success.
 */
export function determineExchangeCalendarOpsValidateExitCode(result: ExchangeCalendarOpsValidateResult): 0 | 1 {
  return result.allValid ? 0 : 1;
}

export function determineExchangeCalendarOpsImportDraftExitCode(result: ExchangeCalendarOpsImportDraftResult): 0 | 1 {
  return result.outcome === 'IMPORTED' ? 0 : 1;
}

export function determineExchangeCalendarOpsCertifyExitCode(result: ExchangeCalendarOpsCertifyResult): 0 | 1 {
  return result.outcome === 'ACTIVATED_OR_NOOP' ? 0 : 1;
}

export function determineExchangeCalendarOpsVerifyExitCode(result: ExchangeCalendarOpsVerifyResult): 0 | 1 {
  return result.allPassed ? 0 : 1;
}
