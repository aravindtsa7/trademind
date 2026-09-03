import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import logger from '../core/logger/logger';
import { istMinuteOfDay } from '../modules/research-lake/domain';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { DerivedResearchSessionRowV1, ResearchRowProvenanceKind } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID } from '../modules/research-lake/domain/nifty-index-gap-imputation-authorization';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import NiftyIndexGapImputationService, { NiftyIndexGapImputationError, NiftyIndexGapImputationResult } from '../modules/research-lake/services/nifty-index-gap-imputation.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';

dotenv.config();
logger.silent = true;

/**
 * Operator-only runner for the already-accepted B-M7.1 gap-imputation
 * service (`NiftyIndexGapImputationService`, unmodified by this file). This
 * script is DELIBERATELY not generic: every capture fact below (date,
 * instrument, timeframe, provider, gap, authorization) is a locked constant,
 * never an argv flag or a second env var -- a future authorized gap requires
 * a SEPARATE, deliberately-added runner, exactly like the accepted service's
 * own single-allowlist-entry authorization module.
 *
 * The ONLY env var this script ever reads is `CONFIRMATION_ENV_VAR`, and only
 * to compare it by EXACT string equality against `REQUIRED_CONFIRMATION_VALUE`
 * -- see `runMarch7ImputationCapture`. No date/instrument/provider override
 * exists through argv or environment.
 *
 * This file does not re-implement any of the accepted service's
 * qualification/re-observation/authorization/interpolation/persistence
 * logic -- it calls `buildImputedSession({ tradingDate: LOCKED_TRADING_DATE })`
 * exactly once, then independently re-asserts the locked 375/372/3
 * operator-facing facts against the RETURNED result only.
 *
 * Manual execution later (PowerShell), never run by this task itself:
 *   $env:RESEARCH_MARCH7_IMPUTATION_CAPTURE_CONFIRMATION = 'CAPTURE_AUTHORIZED_2022_03_07'
 *   npm run research:nifty-march7-imputation:capture
 */

export const CONFIRMATION_ENV_VAR = 'RESEARCH_MARCH7_IMPUTATION_CAPTURE_CONFIRMATION';
export const REQUIRED_CONFIRMATION_VALUE = 'CAPTURE_AUTHORIZED_2022_03_07';

const LOCKED_TRADING_DATE = '2022-03-07';
const EXPECTED_MINUTE_COUNT = 375;
const EXPECTED_OBSERVED_ROW_COUNT = 372;
const EXPECTED_IMPUTED_ROW_COUNT = 3;
const EXPECTED_MISSING_MINUTES_IST: readonly number[] = [622, 623, 624]; // 10:22, 10:23, 10:24 IST
const EXPECTED_MISSING_MINUTES_IST_LABEL = '10:22,10:23,10:24';
const EXPECTED_IMPUTED_AVAILABLE_AT_MINUTE_IST = 626; // 10:26 IST
const EXPECTED_AUTHORIZATION_ID = NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID;

export interface RunMarch7ImputationCaptureOptions {
  /** Value read from `process.env[CONFIRMATION_ENV_VAR]`. Compared by exact string equality only -- never trimmed/normalized/case-folded. */
  readonly confirmation: string | undefined;
  /** Constructs the service to call. NEVER invoked unless `confirmation` already passed the exact-match check below. */
  readonly buildService: () => NiftyIndexGapImputationService;
  readonly output: (line: string) => void;
  readonly errorOutput: (line: string) => void;
}

/**
 * Returns `true` only on a fully-validated success, `false` on any
 * rejection/failure. Never throws -- every failure mode (interlock, typed
 * service error, unexpected error, postcondition violation) is caught and
 * reported through `errorOutput`, so a caller sets `process.exitCode` from
 * the boolean alone. Calls `buildImputedSession` at most once, and never
 * retries it.
 */
export async function runMarch7ImputationCapture(options: RunMarch7ImputationCaptureOptions): Promise<boolean> {
  const { confirmation, buildService, output, errorOutput } = options;

  if (confirmation !== REQUIRED_CONFIRMATION_VALUE) {
    errorOutput(
      [
        '[MARCH7_IMPUTATION_CAPTURE]',
        'status=REJECTED',
        'reason=OPERATOR_CONFIRMATION_INTERLOCK_NOT_SATISFIED',
        `Set ${CONFIRMATION_ENV_VAR}=${REQUIRED_CONFIRMATION_VALUE} exactly (no other value -- including undefined, empty, whitespace, or case variants) to run the real March-7 capture.`,
        'No database read, provider call, or research-lake service was constructed.',
      ].join('\n')
    );
    return false;
  }

  const service = buildService();

  let result: NiftyIndexGapImputationResult;
  try {
    result = await service.buildImputedSession({ tradingDate: LOCKED_TRADING_DATE });
  } catch (error) {
    if (error instanceof NiftyIndexGapImputationError) {
      errorOutput(['[MARCH7_IMPUTATION_CAPTURE]', 'status=FAILED', `code=${error.code}`, `message=${error.message}`].join('\n'));
      return false;
    }
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    errorOutput(['[MARCH7_IMPUTATION_CAPTURE]', 'status=FAILED', 'code=UNEXPECTED_ERROR', `name=${name}`, `message=${message}`].join('\n'));
    return false;
  }

  const violations = validateLockedPostconditions(result);
  if (violations.length > 0) {
    errorOutput(
      ['[MARCH7_IMPUTATION_CAPTURE]', 'status=FAILED', 'code=POSTCONDITION_VIOLATION', ...violations.map((violation) => `violation=${violation.code}: ${violation.detail}`)].join('\n')
    );
    return false;
  }

  output(formatSuccessOutput(result));
  return true;
}

interface PostconditionViolation {
  readonly code: string;
  readonly detail: string;
}

function isNonEmptyString(value: string): boolean {
  return typeof value === 'string' && value.length > 0;
}

function arraysEqual(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function imputedRowCarriesNoProviderField(row: DerivedResearchSessionRowV1): boolean {
  return !JSON.stringify(row).includes('"provider"');
}

/**
 * Independently re-derives the operator-facing 375/372/3 facts from the
 * RETURNED result only -- never re-runs any qualification/re-observation/
 * authorization/interpolation logic itself (that already happened, exactly
 * once, inside `NiftyIndexGapImputationService.buildImputedSession`).
 */
function validateLockedPostconditions(result: NiftyIndexGapImputationResult): PostconditionViolation[] {
  const imputedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED);
  const observedRows = result.derivedSession.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.OBSERVED);
  const imputedMinutesIst = imputedRows.map((row) => istMinuteOfDay(new Date(row.candleTime))).sort((left, right) => left - right);
  const imputedAvailableAtMinutesIst = imputedRows.map((row) => istMinuteOfDay(new Date(row.availableAt)));

  const checks: (PostconditionViolation & { readonly ok: boolean })[] = [
    { code: 'TRADING_DATE', ok: result.tradingDate === LOCKED_TRADING_DATE, detail: `tradingDate='${result.tradingDate}', expected '${LOCKED_TRADING_DATE}'` },

    {
      code: 'SNAPSHOT_PROVIDER',
      ok: result.observedSnapshot.identity.providerId === HistoricalProviderId.UPSTOX,
      detail: `observedSnapshot.identity.providerId='${result.observedSnapshot.identity.providerId}', expected '${HistoricalProviderId.UPSTOX}'`,
    },
    {
      code: 'SNAPSHOT_INSTRUMENT',
      ok: result.observedSnapshot.identity.instrumentKey === NIFTY_INDEX_INSTRUMENT_KEY,
      detail: `observedSnapshot.identity.instrumentKey='${result.observedSnapshot.identity.instrumentKey}', expected '${NIFTY_INDEX_INSTRUMENT_KEY}'`,
    },
    {
      code: 'SNAPSHOT_TIMEFRAME',
      ok: result.observedSnapshot.identity.timeframe === NIFTY_UNDERLYING_TIMEFRAME,
      detail: `observedSnapshot.identity.timeframe='${result.observedSnapshot.identity.timeframe}', expected '${NIFTY_UNDERLYING_TIMEFRAME}'`,
    },
    {
      code: 'SNAPSHOT_TRADING_DATE',
      ok: result.observedSnapshot.identity.tradingDate === LOCKED_TRADING_DATE,
      detail: `observedSnapshot.identity.tradingDate='${result.observedSnapshot.identity.tradingDate}', expected '${LOCKED_TRADING_DATE}'`,
    },
    {
      code: 'SNAPSHOT_EXPECTED_MINUTE_COUNT',
      ok: result.observedSnapshot.expectedMinuteCount === EXPECTED_MINUTE_COUNT,
      detail: `observedSnapshot.expectedMinuteCount=${result.observedSnapshot.expectedMinuteCount}, expected ${EXPECTED_MINUTE_COUNT}`,
    },
    {
      code: 'SNAPSHOT_OBSERVED_ROW_COUNT',
      ok: result.observedSnapshot.observedRowCount === EXPECTED_OBSERVED_ROW_COUNT,
      detail: `observedSnapshot.observedRowCount=${result.observedSnapshot.observedRowCount}, expected ${EXPECTED_OBSERVED_ROW_COUNT}`,
    },
    {
      code: 'SNAPSHOT_MISSING_MINUTES',
      ok: arraysEqual(result.observedSnapshot.missingExpectedMinutesIst, EXPECTED_MISSING_MINUTES_IST),
      detail: `observedSnapshot.missingExpectedMinutesIst=[${result.observedSnapshot.missingExpectedMinutesIst.join(',')}], expected [${EXPECTED_MISSING_MINUTES_IST.join(',')}]`,
    },
    {
      code: 'SNAPSHOT_SOURCE_ROWS_CHECKSUM_PRESENT',
      ok: isNonEmptyString(result.observedSnapshot.sourceRowsSemanticChecksum),
      detail: 'observedSnapshot.sourceRowsSemanticChecksum must be a non-empty string',
    },
    {
      code: 'SNAPSHOT_DURABLE_EVIDENCE_CHECKSUM_PRESENT',
      ok: isNonEmptyString(result.observedSnapshot.durableHistoricalEvidenceSemanticChecksum),
      detail: 'observedSnapshot.durableHistoricalEvidenceSemanticChecksum must be a non-empty string',
    },
    {
      code: 'SNAPSHOT_CONTENT_CHECKSUM_PRESENT',
      ok: isNonEmptyString(result.observedSnapshot.snapshotContentChecksum),
      detail: 'observedSnapshot.snapshotContentChecksum must be a non-empty string',
    },

    {
      code: 'DERIVED_ROW_COUNT',
      ok: result.derivedSession.rows.length === EXPECTED_MINUTE_COUNT,
      detail: `derivedSession.rows.length=${result.derivedSession.rows.length}, expected ${EXPECTED_MINUTE_COUNT}`,
    },
    {
      code: 'DERIVED_REAL_ROW_COUNT',
      ok: result.derivedSession.realRowCount === EXPECTED_OBSERVED_ROW_COUNT,
      detail: `derivedSession.realRowCount=${result.derivedSession.realRowCount}, expected ${EXPECTED_OBSERVED_ROW_COUNT}`,
    },
    {
      code: 'DERIVED_IMPUTED_ROW_COUNT',
      ok: result.derivedSession.imputedRowCount === EXPECTED_IMPUTED_ROW_COUNT,
      detail: `derivedSession.imputedRowCount=${result.derivedSession.imputedRowCount}, expected ${EXPECTED_IMPUTED_ROW_COUNT}`,
    },
    {
      code: 'DERIVED_AUTHORIZATION_ID',
      ok: result.derivedSession.authorizationId === EXPECTED_AUTHORIZATION_ID,
      detail: `derivedSession.authorizationId='${result.derivedSession.authorizationId}', expected '${EXPECTED_AUTHORIZATION_ID}'`,
    },
    {
      code: 'DERIVED_SOURCE_SNAPSHOT_CHECKSUM_LINKAGE',
      ok: result.derivedSession.sourceSnapshotChecksum === result.observedSnapshot.snapshotContentChecksum,
      detail: `derivedSession.sourceSnapshotChecksum='${result.derivedSession.sourceSnapshotChecksum}' must equal observedSnapshot.snapshotContentChecksum='${result.observedSnapshot.snapshotContentChecksum}'`,
    },
    {
      code: 'DERIVED_IMPUTED_ROW_TALLY',
      ok: imputedRows.length === EXPECTED_IMPUTED_ROW_COUNT,
      detail: `${imputedRows.length} row(s) carry IMPUTED provenance, expected ${EXPECTED_IMPUTED_ROW_COUNT}`,
    },
    {
      code: 'DERIVED_OBSERVED_ROW_TALLY',
      ok: observedRows.length === EXPECTED_OBSERVED_ROW_COUNT,
      detail: `${observedRows.length} row(s) carry OBSERVED provenance, expected ${EXPECTED_OBSERVED_ROW_COUNT}`,
    },
    {
      code: 'DERIVED_IMPUTED_MINUTES',
      ok: arraysEqual(imputedMinutesIst, EXPECTED_MISSING_MINUTES_IST),
      detail: `IMPUTED row candleTime minute(s) IST=[${imputedMinutesIst.join(',')}], expected [${EXPECTED_MISSING_MINUTES_IST.join(',')}]`,
    },
    {
      code: 'DERIVED_IMPUTED_NO_PROVIDER_ATTRIBUTION',
      ok: imputedRows.every(imputedRowCarriesNoProviderField),
      detail: 'an IMPUTED row must never carry a "provider" field',
    },
    {
      code: 'DERIVED_IMPUTED_AVAILABLE_AT',
      ok: imputedAvailableAtMinutesIst.length === EXPECTED_IMPUTED_ROW_COUNT && imputedAvailableAtMinutesIst.every((minute) => minute === EXPECTED_IMPUTED_AVAILABLE_AT_MINUTE_IST),
      detail: `IMPUTED row availableAt minute(s) IST=[${imputedAvailableAtMinutesIst.join(',')}], expected all=${EXPECTED_IMPUTED_AVAILABLE_AT_MINUTE_IST}`,
    },
    {
      code: 'DERIVED_CONTENT_CHECKSUM_PRESENT',
      ok: isNonEmptyString(result.derivedSession.derivedContentChecksum),
      detail: 'derivedSession.derivedContentChecksum must be a non-empty string',
    },

    { code: 'OBSERVED_SNAPSHOT_STORAGE_PRESENT', ok: result.observedSnapshotStorage !== null, detail: 'observedSnapshotStorage must not be null' },
    { code: 'DERIVED_SESSION_STORAGE_PRESENT', ok: result.derivedSessionStorage !== null, detail: 'derivedSessionStorage must not be null' },
    {
      code: 'OBSERVED_SNAPSHOT_ARTIFACT_FILE_EXISTS',
      ok: result.observedSnapshotStorage === null || existsSync(result.observedSnapshotStorage.absolutePath),
      detail: `no file exists at observedSnapshotStorage.absolutePath='${result.observedSnapshotStorage?.absolutePath}'`,
    },
    {
      code: 'DERIVED_SESSION_ARTIFACT_FILE_EXISTS',
      ok: result.derivedSessionStorage === null || existsSync(result.derivedSessionStorage.absolutePath),
      detail: `no file exists at derivedSessionStorage.absolutePath='${result.derivedSessionStorage?.absolutePath}'`,
    },
  ];

  return checks.filter((check) => !check.ok).map(({ code, detail }) => ({ code, detail }));
}

function describeStorage(storage: ContentAddressedJsonStoreResult | null): string {
  if (!storage) return 'NONE';
  return `${storage.relativePath} (wasNewlyWritten=${storage.wasNewlyWritten})`;
}

function formatSuccessOutput(result: NiftyIndexGapImputationResult): string {
  return [
    '[MARCH7_IMPUTATION_CAPTURE]',
    'status=SUCCESS',
    `tradingDate=${result.tradingDate}`,
    `provider=${result.observedSnapshot.identity.providerId}`,
    `expectedRows=${result.observedSnapshot.expectedMinuteCount}`,
    `observedRows=${result.observedSnapshot.observedRowCount}`,
    `imputedRows=${result.derivedSession.imputedRowCount}`,
    `missingMinutesIst=${EXPECTED_MISSING_MINUTES_IST_LABEL}`,
    `sourceRowsSemanticChecksum=${result.observedSnapshot.sourceRowsSemanticChecksum}`,
    `observedSnapshotChecksum=${result.observedSnapshot.snapshotContentChecksum}`,
    `derivedContentChecksum=${result.derivedSession.derivedContentChecksum}`,
    `observedArtifact=${describeStorage(result.observedSnapshotStorage)}`,
    `derivedArtifact=${describeStorage(result.derivedSessionStorage)}`,
    'canonicalWrites=NONE_BY_DESIGN',
  ].join('\n');
}

async function main(): Promise<void> {
  const success = await runMarch7ImputationCapture({
    confirmation: process.env[CONFIRMATION_ENV_VAR],
    // Persistence is explicitly requested here (rather than relying on the
    // service's own default) so this operational call site never silently
    // depends on that default staying `true`.
    buildService: () => new NiftyIndexGapImputationService({ persistArtifactsToDisk: true }),
    output: (line) => console.log(line),
    errorOutput: (line) => console.error(line),
  });
  process.exitCode = success ? 0 : 1;
}

// Only auto-executes when run directly (`tsx research-nifty-march7-imputation-capture.ts` /
// `npm run research:nifty-march7-imputation:capture`) -- never when imported, e.g. by this
// script's own unit tests, which import `runMarch7ImputationCapture` without wanting `main()` to fire.
if (require.main === module) {
  main().catch((error) => {
    console.error('[MARCH7_IMPUTATION_CAPTURE] status=FAILED code=RUNNER_CRASH', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
