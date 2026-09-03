import { COMPLETE_CANONICAL_HEALTH_STATUSES } from '../domain/research-session-source-selection';
import { DatasetHealthStatus } from '../domain/dataset-health.types';
import { DatasetManifest } from '../domain/dataset-manifest.types';
import { SessionWindow } from '../domain/exchange-calendar.types';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { readResearchUnderlyingDatasetAssembly, RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT, ResearchUnderlyingDatasetAssemblyV1 } from '../domain/research-underlying-assembly.types';
import {
  CANONICAL_DATASET_MANIFEST_ARTIFACT_ROOT,
  CanonicalDatasetManifestStoreResult,
  storeCanonicalDatasetManifestArtifact,
} from '../domain/canonical-dataset-manifest-artifact-store';
import { ParquetExportRunResult, ParquetSessionExportStatus, ParquetVerificationRunResult } from '../domain/parquet-storage.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import DatasetManifestService from './dataset-manifest.service';
import ManifestCalendarSessionResolverService from './manifest-calendar-session-resolver.service';
import ResearchLakeParquetExportService, { DEFAULT_PARQUET_OUTPUT_ROOT } from './research-lake-parquet-export.service';
import ResearchLakeParquetVerifyService from './research-lake-parquet-verify.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from './nifty-underlying-identity';

export type CalendarSessionsResolver = Pick<ManifestCalendarSessionResolverService, 'resolveRequestedSessions'>;
export type UnderlyingManifestGenerator = Pick<DatasetManifestService, 'generateUnderlyingManifest'>;
export type ParquetExporter = Pick<ResearchLakeParquetExportService, 'exportDataset'>;
export type ParquetVerifier = Pick<ResearchLakeParquetVerifyService, 'verifyStorageDescriptor'>;

export interface NiftyUnderlyingCanonicalStorageMaterializerServiceDependencies {
  readonly calendarSessionsResolver?: CalendarSessionsResolver;
  readonly manifestService?: UnderlyingManifestGenerator;
  readonly parquetExportService?: ParquetExporter;
  readonly parquetVerifyService?: ParquetVerifier;
  readonly sourceAssemblyRoot?: string;
  readonly manifestArtifactRoot?: string;
  readonly parquetOutputRoot?: string;
  readonly provider?: HistoricalProviderId;
  readonly instrumentKey?: string;
  readonly timeframe?: string;
  readonly gitRevision?: string | null;
}

export interface MaterializeCanonicalStorageRequest {
  readonly year: number;
  /** The locked/expected canonical `DatasetManifest.datasetChecksum` -- REQUIRED, never inferred. A reconstructed manifest whose checksum differs fails closed before any write (task: "If checksum differs: FAIL CLOSED. Do not 'fix' the DB to make the checksum match"). */
  readonly expectedCanonicalDatasetChecksum: string;
  /** The trusted B-M7.2 assembly checksum to preflight the reconstructed manifest against -- REQUIRED, never re-selected. */
  readonly sourceAssemblyChecksum: string;
}

export interface MaterializeCanonicalStorageResult {
  readonly canonicalManifest: DatasetManifest;
  readonly manifestArtifact: CanonicalDatasetManifestStoreResult;
  readonly exportResult: ParquetExportRunResult;
  readonly verifyResult: ParquetVerificationRunResult;
  readonly sourceAssembly: ResearchUnderlyingDatasetAssemblyV1;
}

export class CanonicalManifestChecksumMismatchError extends Error {
  constructor(recomputed: string, expected: string) {
    super(`NiftyUnderlyingCanonicalStorageMaterializerService: the reconstructed canonical DatasetManifest's datasetChecksum '${recomputed}' does not equal the expected locked checksum '${expected}'. Refusing to write a manifest artifact or export Parquet against unverified canonical identity -- this is never "fixed" by mutating the database.`);
    this.name = 'CanonicalManifestChecksumMismatchError';
  }
}

/** Fails closed for exactly one B-M7.2-selected date whose current canonical reconstruction no longer matches what B-M7.2 originally observed (task: "Preflight every canonical session"). */
export class CanonicalStoragePreflightError extends Error {
  constructor(
    readonly tradingDate: string,
    reason: string
  ) {
    super(`NiftyUnderlyingCanonicalStorageMaterializerService: preflight failed for tradingDate '${tradingDate}' -- ${reason}. Refusing to persist a manifest artifact or export Parquet before every B-M7.2-selected date's current canonical state is re-verified.`);
    this.name = 'CanonicalStoragePreflightError';
  }
}

export class CanonicalStorageExportShapeError extends Error {
  constructor(reason: string) {
    super(`NiftyUnderlyingCanonicalStorageMaterializerService: Parquet export produced an unexpected physical storage shape -- ${reason}.`);
    this.name = 'CanonicalStorageExportShapeError';
  }
}

export class CanonicalStorageVerificationError extends Error {
  constructor(reason: string) {
    super(`NiftyUnderlyingCanonicalStorageMaterializerService: final Parquet verification did not pass -- ${reason}.`);
    this.name = 'CanonicalStorageVerificationError';
  }
}

function windowsEqual(left: readonly SessionWindow[], right: readonly SessionWindow[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.windowIndex - b.windowIndex);
  const sortedRight = [...right].sort((a, b) => a.windowIndex - b.windowIndex);
  return sortedLeft.every((window, index) => window.windowIndex === sortedRight[index].windowIndex && window.openMinuteIst === sortedRight[index].openMinuteIst && window.closeMinuteIst === sortedRight[index].closeMinuteIst);
}

/**
 * B-M8A: reconstructs the exact canonical `DatasetManifest` for one year
 * entirely from certified calendar truth + currently-persisted
 * `HistoricalCandle` rows (task: "Use ManifestCalendarSessionResolverService
 * + DatasetManifestService... Reconstruct the full 2022 NIFTY canonical
 * DatasetManifest from certified NSE/EQUITY calendar + current
 * HistoricalCandle persisted truth"), validates it against a locked expected
 * checksum, preflights it against the trusted B-M7.2 assembly's own
 * per-date selections, and ONLY THEN persists the canonical manifest
 * artifact and exports/verifies canonical Parquet for the real-canonical
 * (tier 1/2) sessions.
 *
 * Zero provider calls (only certified-calendar and `HistoricalCandle`
 * DB reads -- both already-established read-only B-F5 paths). Zero
 * canonical DB writes. Never invokes `ResearchYearRunnerService` (that
 * service is acquisition/materialization-capable and out of scope for this
 * read-mostly storage-materialization boundary).
 */
export default class NiftyUnderlyingCanonicalStorageMaterializerService {
  private readonly calendarSessionsResolver: CalendarSessionsResolver;
  private readonly manifestService: UnderlyingManifestGenerator;
  private readonly parquetExportService: ParquetExporter;
  private readonly parquetVerifyService: ParquetVerifier;
  private readonly sourceAssemblyRoot: string;
  private readonly manifestArtifactRoot: string;
  private readonly parquetOutputRoot: string;
  private readonly provider: HistoricalProviderId;
  private readonly instrumentKey: string;
  private readonly timeframe: string;
  private readonly gitRevision: string | null;

  constructor(dependencies: NiftyUnderlyingCanonicalStorageMaterializerServiceDependencies = {}) {
    this.calendarSessionsResolver = dependencies.calendarSessionsResolver ?? new ManifestCalendarSessionResolverService();
    this.manifestService = dependencies.manifestService ?? new DatasetManifestService();
    this.parquetExportService = dependencies.parquetExportService ?? new ResearchLakeParquetExportService();
    this.parquetVerifyService = dependencies.parquetVerifyService ?? new ResearchLakeParquetVerifyService();
    this.sourceAssemblyRoot = dependencies.sourceAssemblyRoot ?? RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT;
    this.manifestArtifactRoot = dependencies.manifestArtifactRoot ?? CANONICAL_DATASET_MANIFEST_ARTIFACT_ROOT;
    this.parquetOutputRoot = dependencies.parquetOutputRoot ?? DEFAULT_PARQUET_OUTPUT_ROOT;
    this.provider = dependencies.provider ?? HistoricalProviderId.UPSTOX;
    this.instrumentKey = dependencies.instrumentKey ?? NIFTY_INDEX_INSTRUMENT_KEY;
    this.timeframe = dependencies.timeframe ?? NIFTY_UNDERLYING_TIMEFRAME;
    this.gitRevision = dependencies.gitRevision ?? null;
  }

  async materialize(request: MaterializeCanonicalStorageRequest): Promise<MaterializeCanonicalStorageResult> {
    if (!Number.isInteger(request.year) || request.year < 2000) {
      throw new Error(`NiftyUnderlyingCanonicalStorageMaterializerService requires an integer year >= 2000; received '${String(request.year)}'.`);
    }
    const fromDate = `${request.year}-01-01`;
    const toDate = `${request.year}-12-31`;

    // ---- 1/2. certified calendar. ----
    const { tradingDates, calendarSessionWindows } = await this.calendarSessionsResolver.resolveRequestedSessions({ fromDate, toDate });

    // ---- 3. reconstruct canonical DatasetManifest IN MEMORY (zero writes so far). ----
    const canonicalManifest = await this.manifestService.generateUnderlyingManifest({
      provider: this.provider,
      instrumentKey: this.instrumentKey,
      timeframe: this.timeframe,
      tradingDates,
      calendarSessionWindows,
      gitRevision: this.gitRevision,
    });

    // ---- 4. exact locked canonical checksum validation -- fail closed BEFORE any write. ----
    if (canonicalManifest.datasetChecksum !== request.expectedCanonicalDatasetChecksum) {
      throw new CanonicalManifestChecksumMismatchError(canonicalManifest.datasetChecksum, request.expectedCanonicalDatasetChecksum);
    }

    const sourceAssembly = readResearchUnderlyingDatasetAssembly(this.sourceAssemblyRoot, request.sourceAssemblyChecksum);
    if (sourceAssembly.canonicalManifest.datasetChecksum !== request.expectedCanonicalDatasetChecksum) {
      throw new Error(
        `NiftyUnderlyingCanonicalStorageMaterializerService: the trusted B-M7.2 assembly's canonicalManifest.datasetChecksum '${sourceAssembly.canonicalManifest.datasetChecksum}' does not equal the expected locked canonical checksum '${request.expectedCanonicalDatasetChecksum}' -- refusing to preflight against a mismatched assembly.`
      );
    }
    if (sourceAssembly.identity.instrumentKey !== this.instrumentKey || sourceAssembly.identity.timeframe !== this.timeframe || sourceAssembly.identity.year !== request.year) {
      throw new Error('NiftyUnderlyingCanonicalStorageMaterializerService: the trusted B-M7.2 assembly identity (instrument/timeframe/year) does not match this materialization request.');
    }

    // ---- 5. preflight every B-M7.2-selected session's CURRENT canonical state. ----
    this.preflight(canonicalManifest, sourceAssembly);

    // ---- 6. persist/reuse the exact canonical manifest artifact -- ONLY NOW, after 4/5 passed. ----
    const manifestArtifact = storeCanonicalDatasetManifestArtifact(this.manifestArtifactRoot, canonicalManifest);

    // ---- 7. export canonical Parquet (March-7/any zero-persisted-row PROVIDER_UNAVAILABLE tier-3 date is excluded automatically by B-F6's own default health policy -- allowIncompleteSessions is never set). ----
    const exportResult = await this.parquetExportService.exportDataset({ manifest: canonicalManifest, outputRoot: this.parquetOutputRoot });

    // ---- 8/9. require exactly the real-canonical (tier 1/2) date set was written/reused -- no more, no less. ----
    this.assertExportShape(exportResult, sourceAssembly);

    // ---- 10/11. physical + logical verify. ----
    if (!exportResult.descriptor) {
      throw new CanonicalStorageExportShapeError('no Parquet storage descriptor was produced by the export run -- cannot verify physical storage.');
    }
    const verifyResult = await this.parquetVerifyService.verifyStorageDescriptor({ descriptor: exportResult.descriptor, manifest: canonicalManifest, storageRoot: this.parquetOutputRoot });
    if (!verifyResult.verified) {
      throw new CanonicalStorageVerificationError(`verified=false, mismatchedTradingDates=[${verifyResult.mismatchedTradingDates.join(',')}], datasetLinkageMatches=${verifyResult.datasetLinkageMatches}`);
    }

    return { canonicalManifest, manifestArtifact, exportResult, verifyResult, sourceAssembly };
  }

  /**
   * Task: "For every tier1 B-M7.2 session: current canonical rows must
   * still reproduce B-M7.2 canonicalContentChecksum; exact calendar windows
   * must match; complete health must remain true. For March7 [any tier3
   * date]: currently-PERSISTED canonical content must remain zero rows /
   * PROVIDER_UNAVAILABLE (never INCOMPLETE -- see the B-M8-HIGH-03 note on
   * the tier-3 branch below), B-M7.2 must still select authorized derived
   * tier3." Fails closed on the FIRST violation found -- never partially
   * preflights and proceeds.
   */
  private preflight(canonicalManifest: DatasetManifest, sourceAssembly: ResearchUnderlyingDatasetAssemblyV1): void {
    const sessionsByDate = new Map(canonicalManifest.sessions.map((session) => [session.identity.tradingDate, session]));

    for (const selection of sourceAssembly.sessions) {
      const session = sessionsByDate.get(selection.tradingDate);
      if (!session) {
        throw new CanonicalStoragePreflightError(selection.tradingDate, 'no session exists in the reconstructed canonical manifest for this B-M7.2-selected date');
      }

      switch (selection.precedenceTier) {
        case ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION:
        case ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION: {
          if (session.contentChecksum !== selection.canonicalContentChecksum) {
            throw new CanonicalStoragePreflightError(selection.tradingDate, `current canonical contentChecksum '${session.contentChecksum}' no longer reproduces the B-M7.2-selected canonicalContentChecksum '${selection.canonicalContentChecksum}' -- canonical content has drifted since B-M7.2 assembly`);
          }
          if (!windowsEqual(session.calendarSessionWindows, selection.calendarSessionWindows)) {
            throw new CanonicalStoragePreflightError(selection.tradingDate, 'current certified calendar session windows no longer match the windows B-M7.2 pinned for this date');
          }
          if (!COMPLETE_CANONICAL_HEALTH_STATUSES.has(session.persistedCanonicalHealthStatus)) {
            throw new CanonicalStoragePreflightError(selection.tradingDate, `persistedCanonicalHealthStatus '${session.persistedCanonicalHealthStatus}' is no longer a complete/healthy status`);
          }
          break;
        }
        case ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION: {
          // B-M8-HIGH-03 fix: PERSISTED canonical content (HistoricalCandle rows currently in the DB for
          // this date) is intentionally EMPTY for an authorized-derived tier-3 date -- that is a fact about
          // what is currently PERSISTED, never a claim about the ORIGINAL provider acquisition (which the
          // trusted B-M7.2 authorized-derived selection separately tracks via sourceSnapshotChecksum/
          // realRowCount/imputedRowCount). Under the existing, UNMODIFIED DatasetHealthValidatorService rule
          // (`sourceRowCount === 0` -> PROVIDER_UNAVAILABLE), a zero-persisted-row session can NEVER be
          // INCOMPLETE -- INCOMPLETE requires sourceRowCount > 0 with at least one missing minute. Requiring
          // INCOMPLETE here was the root cause of the real B_M8A_2022_CANONICAL_STORAGE_MATERIALIZATION
          // preflight failure; the correct, currently-valid zero-row semantic is PROVIDER_UNAVAILABLE. If a
          // future B-F5 semantics-version change alters this rule, this comparison must fail closed (as it
          // already does for any other unexpected status) rather than silently widen.
          if (session.canonicalRowCount !== 0) {
            throw new CanonicalStoragePreflightError(selection.tradingDate, `expected 0 currently-PERSISTED canonical rows for an authorized-derived (tier 3) date, got ${session.canonicalRowCount} -- this date must never be exported as canonical Parquet`);
          }
          if (session.persistedCanonicalHealthStatus !== DatasetHealthStatus.PROVIDER_UNAVAILABLE) {
            throw new CanonicalStoragePreflightError(
              selection.tradingDate,
              `expected persistedCanonicalHealthStatus PROVIDER_UNAVAILABLE (the existing B-F5 DatasetHealthValidatorService's zero-persisted-row semantic -- this describes currently-PERSISTED canonical content, not original provider acquisition) for an authorized-derived (tier 3) date, got '${session.persistedCanonicalHealthStatus}' -- this date must never be exported as canonical Parquet`
            );
          }
          break;
        }
        case ResearchSessionSourcePrecedenceTier.UNAVAILABLE:
          // No canonical-content assertion is defined for a tier-4 date -- its
          // presence in the reconstructed manifest (checked above) is sufficient;
          // it is structurally excluded from real-canonical export by health policy either way.
          break;
        default: {
          const exhaustive: never = selection;
          throw new Error(`Unhandled ResearchSessionSourceSelection: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }

  /** Proves the exported/reused physical set is EXACTLY the B-M7.2 real-canonical (tier 1/2) date set -- no missing real date, no orphan date (task: "No orphan additional dates", "missing descriptor real date fails final acceptance"). */
  private assertExportShape(exportResult: ParquetExportRunResult, sourceAssembly: ResearchUnderlyingDatasetAssemblyV1): void {
    const realCanonicalDates = new Set(
      sourceAssembly.sessions
        .filter((session) => session.precedenceTier === ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION || session.precedenceTier === ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION)
        .map((session) => session.tradingDate)
    );

    const storedDates = new Set(exportResult.sessions.filter((session) => session.status === ParquetSessionExportStatus.WRITTEN || session.status === ParquetSessionExportStatus.SKIPPED_VERIFIED).map((session) => session.tradingDate));

    const missing = [...realCanonicalDates].filter((date) => !storedDates.has(date));
    if (missing.length > 0) {
      throw new CanonicalStorageExportShapeError(`missing real-canonical export session(s) for date(s): ${missing.join(', ')}`);
    }
    const orphans = [...storedDates].filter((date) => !realCanonicalDates.has(date));
    if (orphans.length > 0) {
      throw new CanonicalStorageExportShapeError(`orphan exported session(s) for date(s) not in the B-M7.2 real-canonical set: ${orphans.join(', ')}`);
    }
    if (storedDates.size !== realCanonicalDates.size) {
      throw new CanonicalStorageExportShapeError(`exported real-canonical session count ${storedDates.size} does not equal the expected B-M7.2 real-canonical count ${realCanonicalDates.size}`);
    }
  }
}
