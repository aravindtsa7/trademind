import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import NiftyUnderlyingGapRepairService, { NiftyGapRepairResult } from '../modules/research-lake/services/nifty-underlying-gap-repair.service';
import { HistoricalDataProvider } from '../modules/research-lake/interfaces/historical-data-provider.interface';
import { HistoricalCandleRepairOutcome } from '../modules/research-lake/domain';
import GrowwHistoricalClient from '../modules/research-lake/providers/groww/groww-historical-client';
import GrowwUnderlyingHistoricalDataProviderService from '../modules/research-lake/providers/groww/groww-underlying-historical-data-provider.service';
import GrowwUnderlyingGapRepairProviderService, {
  assertExpectedMissingMinuteWithinRegularSession,
  parseExpectedMissingMinuteUtc,
} from '../modules/research-lake/providers/groww/groww-underlying-gap-repair-provider.service';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-underlying-gap-repair-result.json`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The only `RESEARCH_REPAIR_PROVIDER` value this operational entrypoint currently supports. */
const SUPPORTED_REPAIR_PROVIDERS = ['GROWW'] as const;

/**
 * B-M10: the ONE place this OPERATIONAL entrypoint may ever obtain a repair
 * provider. Takes the already-required, already-trimmed `RESEARCH_REPAIR_PROVIDER`
 * value, plus (for `'GROWW'`) the already-parsed-and-validated single
 * authorized missing-minute timestamp, as explicit arguments (never reads
 * `process.env` itself) so it stays a pure, directly-testable seam -- `run()`
 * below owns requiring/parsing/validating both before this is ever called.
 *
 * Throws (never returns `undefined`) on an unsupported provider name or a
 * missing `expectedMissingMinuteUtc` for `'GROWW'`, BEFORE any provider call
 * / DB mutation / artifact write. For `'GROWW'`, constructs the real
 * `GrowwUnderlyingHistoricalDataProviderService` wired to a real
 * `GrowwHistoricalClient` -- that client's OWN constructor reads
 * `GROWW_ACCESS_TOKEN` and throws synchronously if it is missing/blank (see
 * `groww-historical-client.ts`), so a missing Groww credential also fails
 * here, before any provider call, without this function duplicating that
 * credential check itself -- then wraps it in the B-M10 targeted-correction
 * `GrowwUnderlyingGapRepairProviderService`, which narrows the adapter's
 * truthful full-session response down to exactly the one operator-authorized
 * missing timestamp before `NiftyUnderlyingGapRepairService` (reused
 * completely unchanged) ever sees it.
 *
 * This function MUST NEVER return a deterministic, fixture-driven, or otherwise
 * test-only adapter -- that boundary is enforced structurally (this file imports
 * no such adapter at all, verified by a source-text regression test; see the
 * SEPARATE, isolated-test-DB-only, manual verification entrypoint script one
 * directory over for controlled fixture-driven verification) -- and it must never
 * construct `UpstoxHistoricalDataProviderService` (or any primary-only adapter) as
 * a repair/secondary provider.
 */
export function resolveProductionRepairProvider(providerName: string, expectedMissingMinuteUtc: Date | undefined): HistoricalDataProvider {
  if (providerName === 'GROWW') {
    if (!expectedMissingMinuteUtc) {
      throw new Error('RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC is required for the GROWW repair provider.');
    }
    const delegate = new GrowwUnderlyingHistoricalDataProviderService(new GrowwHistoricalClient());
    return new GrowwUnderlyingGapRepairProviderService(delegate, expectedMissingMinuteUtc);
  }
  throw new Error(`Unsupported RESEARCH_REPAIR_PROVIDER '${providerName}'. Supported providers: ${SUPPORTED_REPAIR_PROVIDERS.join(', ')}.`);
}

/**
 * B-M10 Part 5: whether a `repairSession` result is allowed to overwrite the
 * canonical `ARTIFACT_PATH`. Only a verified `REPAIR_ACCEPTED` outcome may --
 * `REPAIR_NOT_ATTEMPTED` / `REPAIR_UNAVAILABLE` / `REPAIR_INCOMPLETE` /
 * `REPAIR_CONFLICT` must never touch the existing artifact (a prior accepted
 * repair's evidence must not be clobbered by a later rejected/unattempted run).
 * A standalone, directly-testable pure function rather than inline logic in
 * `run()`, so this exact invariant is provable for every outcome without
 * needing to execute `run()`'s I/O.
 */
export function shouldPersistRepairArtifact(outcome: HistoricalCandleRepairOutcome): boolean {
  return outcome === HistoricalCandleRepairOutcome.REPAIR_ACCEPTED;
}

/**
 * Research-only B-M10 entrypoint. Never wired into `server.ts`, any live
 * startup path, `research:year`, or any existing acquisition CLI script --
 * gap repair is a wholly separate, deliberately-invoked, DATE-SCOPED
 * operation. Single trading date only -- there is no from/to date-range
 * input anywhere in this file. Single missing-minute only -- no ranges, no
 * wildcards, no implicit default; the operator must name the exact
 * authorized candidate timestamp.
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_REPAIR_PROVIDER = 'GROWW'
 *   $env:RESEARCH_REPAIR_TRADING_DATE = '2024-12-12'
 *   $env:RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC = '2024-12-12T04:12:00.000Z'
 *   npm run research:nifty-gap-repair
 *
 * SAFETY: `RESEARCH_REPAIR_PROVIDER`, `RESEARCH_REPAIR_TRADING_DATE`, and (for
 * `GROWW`) `RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC` are all REQUIRED --
 * this script never silently falls back to an implicit/undefined provider,
 * an implicit missing-minute candidate, or to `REPAIR_NOT_ATTEMPTED` because
 * configuration was merely absent. A missing/unsupported provider name, a
 * missing/malformed trading date, a missing/malformed/misaligned/wrong-date/
 * out-of-session missing-minute timestamp, or a missing Groww credential all
 * fail closed with a non-zero exit code BEFORE any provider call, any
 * `HistoricalCandle` mutation, or any artifact write. The operator-supplied
 * missing-minute candidate is NEVER trusted by itself: `NiftyUnderlyingGapRepairService`
 * (reused completely unchanged) remains the authoritative independent layer --
 * if the primary re-fetch turns out already complete, missing a different
 * minute, or missing more than one minute, the merged session still fails
 * `DatasetHealthValidatorService` and nothing is persisted. The canonical
 * repair-result artifact is only ever written for a verified `REPAIR_ACCEPTED`
 * outcome (see `shouldPersistRepairArtifact`) -- every other outcome leaves
 * whatever artifact already exists on disk untouched, including the durable
 * `HistoricalCandleRepairEvidence` row from any prior `REPAIR_CONFLICT`/
 * `REPAIR_INCOMPLETE` attempt, which this script never deletes or rewrites
 * (evidence is append-only; a later accepted attempt creates a NEW row).
 */
async function run(): Promise<void> {
  const tradingDate = process.env.RESEARCH_REPAIR_TRADING_DATE?.trim();
  if (!tradingDate) {
    throw new Error('RESEARCH_REPAIR_TRADING_DATE is required (YYYY-MM-DD). This script never defaults to a range or to "today" -- gap repair is always date-scoped and explicit.');
  }
  if (!DATE_PATTERN.test(tradingDate)) {
    throw new Error(`RESEARCH_REPAIR_TRADING_DATE must be YYYY-MM-DD; received '${tradingDate}'.`);
  }

  const providerName = process.env.RESEARCH_REPAIR_PROVIDER?.trim();
  if (!providerName) {
    throw new Error(
      `RESEARCH_REPAIR_PROVIDER is required (supported: ${SUPPORTED_REPAIR_PROVIDERS.join(', ')}). This operator never silently falls back to an implicit/undefined repair provider -- provider selection must always be explicit.`
    );
  }

  // Required for GROWW, validated (format, minute-alignment, trading-date match, certified regular
  // session window) BEFORE any provider call / DB mutation / artifact write. Exactly ONE timestamp --
  // no range, no wildcard, no hardcoded fallback.
  let expectedMissingMinuteUtc: Date | undefined;
  if (providerName === 'GROWW') {
    const rawExpectedMissingMinute = process.env.RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC?.trim();
    if (!rawExpectedMissingMinute) {
      throw new Error(
        'RESEARCH_REPAIR_EXPECTED_MISSING_MINUTE_UTC is required when RESEARCH_REPAIR_PROVIDER=GROWW (e.g. 2024-12-12T04:12:00.000Z). This operator never infers or defaults the authorized missing-minute candidate.'
      );
    }
    expectedMissingMinuteUtc = parseExpectedMissingMinuteUtc(rawExpectedMissingMinute);
    assertExpectedMissingMinuteWithinRegularSession(expectedMissingMinuteUtc, tradingDate);
  }

  // Throws BEFORE any provider call / DB mutation / artifact write on an unsupported
  // provider name or a missing Groww credential (GrowwHistoricalClient's own gate).
  const repairProvider = resolveProductionRepairProvider(providerName, expectedMissingMinuteUtc);

  console.log(
    JSON.stringify({
      event: 'research:nifty-gap-repair starting',
      tradingDate,
      repairProvider: providerName,
      expectedMissingMinuteUtc: expectedMissingMinuteUtc ? expectedMissingMinuteUtc.toISOString() : null,
    })
  );

  const service = new NiftyUnderlyingGapRepairService({ repairProvider });
  const result: NiftyGapRepairResult = await service.repairSession({ tradingDate });

  const persistArtifact = shouldPersistRepairArtifact(result.outcome);
  if (persistArtifact) {
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...result, artifact: persistArtifact ? ARTIFACT_PATH : null }, null, 2));

  if (result.outcome !== HistoricalCandleRepairOutcome.REPAIR_ACCEPTED && result.outcome !== HistoricalCandleRepairOutcome.REPAIR_NOT_ATTEMPTED) {
    process.exitCode = 1;
  }
}

// Only auto-executes when run directly (`tsx research-nifty-underlying-gap-repair.ts` / `npm run
// research:nifty-gap-repair`) -- never when imported, e.g. by the CLI-safety regression test that
// imports `resolveProductionRepairProvider` from this module without wanting `run()` to fire.
if (require.main === module) {
  run().catch((error) => {
    console.error('B-M10 NIFTY underlying gap repair failed.', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
