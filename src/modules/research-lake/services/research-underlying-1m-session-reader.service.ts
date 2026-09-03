import { istTradingDayUtcBounds } from '../domain/ist-session-clock';
import { computeDerivedImputedSessionChecksum, readDerivedImputedResearchSession, ResearchRowProvenance, ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { ManifestDatasetKind } from '../domain/dataset-manifest.types';
import { RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT } from '../domain/research-underlying-assembly.types';
import { COMPLETE_CANONICAL_HEALTH_STATUSES, CompositeRepairedCanonicalSessionSourceSelection, RealCanonicalSessionSourceSelection, ResearchSessionSourceSelection } from '../domain/research-session-source-selection';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import DatasetSessionManifestBuilderService from './dataset-session-manifest-builder.service';

const MINUTE_MS = 60_000;

export enum ResolvedResearchRowSourceKind {
  REAL_CANONICAL = 'REAL_CANONICAL',
  DERIVED = 'DERIVED',
}

/** A row read straight from persisted `HistoricalCandle` content -- carries NO imputation-shaped fields at all (task: "real canonical selected reader exposes no false imputation provenance"). */
export interface ResolvedRealCanonicalRowProvenance {
  readonly sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL;
}

/** A row read from the trusted B-M7.1 derived artifact -- `derivedRowProvenance` is that artifact's OWN OBSERVED/IMPUTED provenance, preserved verbatim, never re-derived or normalized here. */
export interface ResolvedDerivedRowProvenance {
  readonly sourceKind: ResolvedResearchRowSourceKind.DERIVED;
  readonly derivedRowProvenance: ResearchRowProvenance;
}

export type ResolvedResearchRowProvenance = ResolvedRealCanonicalRowProvenance | ResolvedDerivedRowProvenance;

export interface ResolvedResearchSessionRow {
  readonly candleTime: string; // ISO 8601 UTC
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly openInterest: string | null;
  readonly availableAt: string; // ISO 8601 UTC
  readonly provenance: ResolvedResearchRowProvenance;
}

export type ResolveResearchSessionRowsOutcome = { readonly kind: 'RESOLVED'; readonly rows: readonly ResolvedResearchSessionRow[] } | { readonly kind: 'UNAVAILABLE' };

export type HistoricalCandleRangeReader = Pick<HistoricalCandleRepository, 'findRange'>;
export type UnderlyingSessionManifestBuilder = Pick<DatasetSessionManifestBuilderService, 'buildUnderlyingSession'>;

export interface ResearchUnderlying1mSessionReaderServiceDependencies {
  readonly historicalCandleRepository?: HistoricalCandleRangeReader;
  /** Duck-typed seam over `DatasetSessionManifestBuilderService` -- reused so canonical-content re-verification NEVER implements a competing checksum/health algorithm (task: "Do NOT implement a competing checksum algorithm"). */
  readonly sessionManifestBuilder?: UnderlyingSessionManifestBuilder;
  readonly derivedArtifactRoot?: string;
}

/** Thrown when the CURRENT persisted canonical content for a selected tradingDate no longer matches what the B-M7.2 assembly actually selected -- see `resolveRealCanonicalRows`'s own doc. */
export class ResearchCanonicalContentDriftError extends Error {
  constructor(
    readonly tradingDate: string,
    readonly reason: string
  ) {
    super(`ResearchUnderlying1mSessionReaderService: canonical content for tradingDate '${tradingDate}' no longer matches the assembly's selected content -- ${reason}. Refusing to resolve rows from drifted/changed canonical content.`);
    this.name = 'ResearchCanonicalContentDriftError';
  }
}

/**
 * B-M7.2 read/resolution boundary (task: "Provide a clean read boundary
 * from B-M7.2 so a future consumer can resolve: tradingDate -> selected
 * research source -> ordered 1-minute rows with availableAt/provenance
 * semantics"). Deliberately does NOT implement any 2m/3m/5m resampling --
 * that is B-M7.3's job. A future consumer never needs to inspect artifact
 * filenames/paths itself: it passes in the EXACT `ResearchSessionSourceSelection`
 * `NiftyUnderlyingResearchAssemblyService` already selected for one trading
 * date, and receives back ordered rows with explicit source provenance.
 *
 * BLOCKER-03 CORRECTION: for `REAL_CANONICAL`/`COMPOSITE_REPAIRED_CANONICAL`
 * selections, rows are read fresh from the persisted canonical store (never
 * embedded in the assembly artifact itself -- task: "no duplicate candle
 * payload") and then INDEPENDENTLY RE-VERIFIED against exactly what the
 * assembly selected, via the SAME `DatasetSessionManifestBuilderService`
 * used everywhere else in this codebase to build a `SessionManifest`: the
 * current rows are rebuilt into a fresh session, and its `contentChecksum`
 * must match `selection.canonicalContentChecksum` EXACTLY, and its
 * `persistedCanonicalHealthStatus` must still be complete
 * (`COMPLETE_CANONICAL_HEALTH_STATUSES`). Any drift (a changed price, a
 * missing/added minute, a duplicate timestamp, a now-incomplete session)
 * throws `ResearchCanonicalContentDriftError` -- FAIL CLOSED, never silently
 * returning whatever currently happens to be in the DB. `availableAt` is
 * synthesized as `candleTime + 1 minute`, the SAME completed-candle
 * convention `HistoricalCandleResamplerService`/B-M7.1's own OBSERVED rows
 * already use -- never any imputation-shaped provenance.
 *
 * For `AUTHORIZED_DERIVED_IMPUTED` selections: rows are re-read from the
 * SAME trusted, content-addressed B-M7.1 artifact (re-verified against its
 * own checksum on every read, never trusted merely because the assembly
 * step validated it once) and returned EXACTLY as B-M7.1 produced them --
 * `availableAt`/provenance (including the 3 imputed rows' 10:26 IST
 * `availableAt`) are NEVER normalized/reset here (task: "critical
 * no-lookahead contract").
 */
export default class ResearchUnderlying1mSessionReaderService {
  private readonly historicalCandleRepository: HistoricalCandleRangeReader;
  private readonly sessionManifestBuilder: UnderlyingSessionManifestBuilder;
  private readonly derivedArtifactRoot: string;

  constructor(dependencies: ResearchUnderlying1mSessionReaderServiceDependencies = {}) {
    this.historicalCandleRepository = dependencies.historicalCandleRepository ?? new HistoricalCandleRepository();
    this.sessionManifestBuilder = dependencies.sessionManifestBuilder ?? new DatasetSessionManifestBuilderService();
    this.derivedArtifactRoot = dependencies.derivedArtifactRoot ?? RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT;
  }

  async resolveSessionRows(instrumentKey: string, timeframe: string, selection: ResearchSessionSourceSelection): Promise<ResolveResearchSessionRowsOutcome> {
    switch (selection.precedenceTier) {
      case ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION:
      case ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION:
        return { kind: 'RESOLVED', rows: await this.resolveRealCanonicalRows(instrumentKey, timeframe, selection) };
      case ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION:
        return { kind: 'RESOLVED', rows: this.resolveDerivedRows(selection.derivedContentChecksum) };
      case ResearchSessionSourcePrecedenceTier.UNAVAILABLE:
        return { kind: 'UNAVAILABLE' };
      default: {
        const exhaustive: never = selection;
        throw new Error(`Unhandled ResearchSessionSourceSelection: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async resolveRealCanonicalRows(
    instrumentKey: string,
    timeframe: string,
    selection: RealCanonicalSessionSourceSelection | CompositeRepairedCanonicalSessionSourceSelection
  ): Promise<ResolvedResearchSessionRow[]> {
    const identity = selection.identity;
    if (identity.datasetKind !== ManifestDatasetKind.UNDERLYING_1M) {
      throw new ResearchCanonicalContentDriftError(selection.tradingDate, `selection.identity.datasetKind is '${identity.datasetKind}', but this reader only supports UNDERLYING_1M canonical selections`);
    }
    if (identity.instrumentKey !== instrumentKey || identity.timeframe !== timeframe) {
      throw new ResearchCanonicalContentDriftError(
        selection.tradingDate,
        `requested instrument/timeframe '${instrumentKey}'/'${timeframe}' does not match the selection's own identity '${identity.instrumentKey}'/'${identity.timeframe}'`
      );
    }
    const provider = identity.provider;

    const { start, end } = istTradingDayUtcBounds(selection.tradingDate);
    const rows = await this.historicalCandleRepository.findRange(instrumentKey, timeframe, start, end);

    // Rebuilds a fresh SessionManifest from the CURRENT persisted rows via the
    // exact same, unmodified builder every other manifest-generation path in
    // this codebase uses -- never a competing checksum/health algorithm.
    const rebuilt = this.sessionManifestBuilder.buildUnderlyingSession({
      provider,
      instrumentKey,
      timeframe,
      tradingDate: selection.tradingDate,
      rows,
      sessionWindows: selection.calendarSessionWindows,
    });

    if (rebuilt.contentChecksum !== selection.canonicalContentChecksum) {
      throw new ResearchCanonicalContentDriftError(
        selection.tradingDate,
        `recomputed canonical content checksum '${rebuilt.contentChecksum}' no longer matches the selected checksum '${selection.canonicalContentChecksum}' (current row count ${rebuilt.canonicalRowCount}, selected row count ${selection.canonicalRowCount})`
      );
    }
    if (!COMPLETE_CANONICAL_HEALTH_STATUSES.has(rebuilt.persistedCanonicalHealthStatus)) {
      throw new ResearchCanonicalContentDriftError(selection.tradingDate, `the current persisted canonical content no longer represents a complete accepted session (recomputed health status '${rebuilt.persistedCanonicalHealthStatus}')`);
    }

    const sorted = [...rows].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
    return sorted.map((row) => ({
      candleTime: row.candleTime.toISOString(),
      open: row.open.toString(),
      high: row.high.toString(),
      low: row.low.toString(),
      close: row.close.toString(),
      volume: row.volume.toString(),
      openInterest: row.openInterest === null ? null : row.openInterest.toString(),
      availableAt: new Date(row.candleTime.getTime() + MINUTE_MS).toISOString(),
      provenance: { sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL },
    }));
  }

  private resolveDerivedRows(derivedContentChecksum: string): ResolvedResearchSessionRow[] {
    const session = readDerivedImputedResearchSession(this.derivedArtifactRoot, derivedContentChecksum);
    const { derivedContentChecksum: actualChecksum, ...payload } = session;
    const recomputed = computeDerivedImputedSessionChecksum(payload);
    if (recomputed !== derivedContentChecksum || actualChecksum !== derivedContentChecksum) {
      throw new Error(
        `ResearchUnderlying1mSessionReaderService: the derived artifact at checksum '${derivedContentChecksum}' no longer re-hashes to its own content-addressed identity -- refusing to resolve rows from possibly-corrupted content.`
      );
    }
    return session.rows.map((row) => ({
      candleTime: row.candleTime,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      openInterest: row.openInterest,
      availableAt: row.availableAt,
      provenance: { sourceKind: ResolvedResearchRowSourceKind.DERIVED, derivedRowProvenance: row.provenance },
    }));
  }
}
