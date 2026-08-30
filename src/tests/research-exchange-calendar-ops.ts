import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import { assertLocalDevDatabaseTarget, assertMutationApplyOptIn } from '../modules/research-lake/services/exchange-calendar-ops-mutation-guard.util';
import {
  determineExchangeCalendarOpsCertifyExitCode,
  determineExchangeCalendarOpsImportDraftExitCode,
  determineExchangeCalendarOpsValidateExitCode,
  determineExchangeCalendarOpsVerifyExitCode,
} from '../modules/research-lake/services/exchange-calendar-ops-exit-policy.util';
import { ExchangeCalendarOpsMode, parseExchangeCalendarOpsMode } from '../modules/research-lake/services/exchange-calendar-ops-mode.util';
import ExchangeCalendarOpsRunnerService from '../modules/research-lake/services/exchange-calendar-ops-runner.service';

dotenv.config();
logger.silent = true;

/**
 * B-F7A-FIXTURES-1 safe operator runner for the authoritative NSE/EQUITY
 * calendar (task section 23). Never wired into `server.ts` or any live
 * startup path.
 *
 * Modes (RESEARCH_CALENDAR_MODE, default VALIDATE -- task section 24):
 *   VALIDATE      read-only, pure. RESEARCH_CALENDAR_YEAR optional
 *                 (unset validates every registered fixture).
 *   IMPORT_DRAFT  mutating. Requires RESEARCH_CALENDAR_YEAR AND
 *                 RESEARCH_CALENDAR_APPLY=true.
 *   CERTIFY       mutating. Requires RESEARCH_CALENDAR_YEAR AND
 *                 RESEARCH_CALENDAR_VERSION AND RESEARCH_CALENDAR_APPLY=true.
 *   VERIFY        read-only. Runs the fixed NSE/EQUITY probe set
 *                 (task section 31) against the live resolver.
 *
 * Every mutating mode additionally requires the configured DATABASE_URL to
 * resolve to a local-development hostname (task section 27) -- there is no
 * override. This script never calls `prisma migrate deploy` itself (task
 * section 28); a missing calendar schema surfaces as an explicit
 * CALENDAR_SCHEMA_NOT_DEPLOYED outcome, never as a false UNCERTIFIED.
 *
 * Usage (PowerShell):
 *   npm run research:calendar:ops                                  (VALIDATE, all registered fixtures)
 *   $env:RESEARCH_CALENDAR_YEAR = '2024'; npm run research:calendar:ops   (VALIDATE, one year)
 *   $env:RESEARCH_CALENDAR_MODE = 'VERIFY'; npm run research:calendar:ops
 */
async function run(): Promise<void> {
  const mode = parseExchangeCalendarOpsMode(process.env.RESEARCH_CALENDAR_MODE);
  assertMutationApplyOptIn(mode, process.env.RESEARCH_CALENDAR_APPLY);

  const runner = new ExchangeCalendarOpsRunnerService();

  if (mode === ExchangeCalendarOpsMode.VALIDATE) {
    const yearRaw = process.env.RESEARCH_CALENDAR_YEAR?.trim();
    const selection = yearRaw ? assertValidYear(yearRaw) : 'ALL';
    const result = await runner.runValidate(selection);
    console.log(JSON.stringify({ event: 'research:calendar:ops VALIDATE', result }, null, 2));
    process.exitCode = determineExchangeCalendarOpsValidateExitCode(result);
    return;
  }

  if (mode === ExchangeCalendarOpsMode.IMPORT_DRAFT) {
    assertLocalDevDatabaseTarget(process.env.DATABASE_URL);
    const year = assertValidYear(requireEnv('RESEARCH_CALENDAR_YEAR'));
    const result = await runner.runImportDraft(year);
    console.log(JSON.stringify({ event: 'research:calendar:ops IMPORT_DRAFT', calendarYear: year, result }, null, 2));
    process.exitCode = determineExchangeCalendarOpsImportDraftExitCode(result);
    return;
  }

  if (mode === ExchangeCalendarOpsMode.CERTIFY) {
    assertLocalDevDatabaseTarget(process.env.DATABASE_URL);
    const year = assertValidYear(requireEnv('RESEARCH_CALENDAR_YEAR'));
    const version = assertValidVersion(requireEnv('RESEARCH_CALENDAR_VERSION'));
    const result = await runner.runCertify(year, version);
    console.log(JSON.stringify({ event: 'research:calendar:ops CERTIFY', calendarYear: year, version, result }, null, 2));
    process.exitCode = determineExchangeCalendarOpsCertifyExitCode(result);
    return;
  }

  // ExchangeCalendarOpsMode.VERIFY
  const result = await runner.runVerify();
  console.log(JSON.stringify({ event: 'research:calendar:ops VERIFY', result }, null, 2));
  process.exitCode = determineExchangeCalendarOpsVerifyExitCode(result);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this RESEARCH_CALENDAR_MODE.`);
  return value;
}

function assertValidYear(raw: string): number {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 1) throw new Error(`RESEARCH_CALENDAR_YEAR must be a positive integer; received '${raw}'.`);
  return year;
}

function assertValidVersion(raw: string): number {
  const version = Number(raw);
  if (!Number.isInteger(version) || version <= 0) throw new Error(`RESEARCH_CALENDAR_VERSION must be a positive integer; received '${raw}'.`);
  return version;
}

run().catch((error) => {
  console.error('research:calendar:ops failed.', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
