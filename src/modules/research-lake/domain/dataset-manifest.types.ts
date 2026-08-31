import { HistoricalOptionType } from './historical-asset.types';
import { DatasetHealthIssue, DatasetHealthStatus } from './dataset-health.types';
import { OptionCandleObservationState } from './historical-option-candle-observation.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { CalendarSessionWindowsByDate, SessionWindow } from './exchange-calendar.types';

/**
 * The two Historical Research Lake dataset kinds B-F5 covers (task section
 * 17: "Support BOTH research streams already closed"). Provider-neutral
 * naming, matching the repo-native `HistoricalAssetType` split
 * (`NIFTY_INDEX` / `NIFTY_OPTION`) rather than inventing new terminology.
 */
export enum ManifestDatasetKind {
  UNDERLYING_1M = 'UNDERLYING_1M',
  EXPIRED_OPTION_1M = 'EXPIRED_OPTION_1M',
}

/**
 * Envelope/shape version for the manifest JSON structure itself (field
 * names/nesting). Deliberately NOT part of any content checksum -- it
 * describes how the manifest is written, not what the underlying data means.
 * Bump only when `DatasetManifest`/`SessionManifest`'s own field shape
 * changes in a way a consumer must know about.
 *
 * Bumped 1 -> 2 for B-F2C: `SourceAcquisitionEvidence` gained `provider`
 * and `evidenceSemanticChecksum` fields (both observability material,
 * never part of `contentChecksum`/`datasetChecksum` -- see that interface's
 * doc). Existing schema-version-1 manifest artifacts remain fully readable;
 * this bump exists so a consumer inspecting `manifestSchemaVersion` can
 * tell whether `sourceAcquisitionEvidence.provider`/`.evidenceSemanticChecksum`
 * are even expected to be present.
 *
 * Bumped 2 -> 3 for B-F5 CALENDAR FIX: `SessionManifest` gained
 * `calendarSessionWindows` (also observability material, never part of
 * `contentChecksum`/`datasetChecksum`) -- the exact calendar-declared
 * session windows a session's health was computed against, so
 * `DatasetManifestService.verifyManifest` can recompute the identical
 * health determination later without a live calendar lookup. `[]` for any
 * session whose health used the legacy fixed 375-row default.
 */
export const MANIFEST_SCHEMA_VERSION = 3;

/**
 * Semantic version of `CanonicalSessionProjectorService`'s session-boundary/
 * exclusion rules, as understood by B-F5. Part of the content checksum
 * (task section 6/14): if a future change to that service's session-window
 * or exclusion semantics would change what "canonical" means for the same
 * raw input, this constant MUST be bumped so existing manifests do not
 * silently compare equal to manifests produced under the new semantics.
 * B-F5 introduces this as the smallest stable version constant rather than
 * hashing projector source files (task section 6).
 */
export const CANONICALIZATION_SEMANTICS_VERSION = 1;

/**
 * Semantic version of `DatasetHealthValidatorService`'s status-classification
 * rules and `resolveOptionCandleObservationState`'s mapping, as understood by
 * B-F5. Part of the content checksum for the same reason as
 * `CANONICALIZATION_SEMANTICS_VERSION` above -- bump when a future change to
 * either would change what "healthy"/"complete" means for the same canonical
 * rows.
 */
export const HEALTH_SEMANTICS_VERSION = 1;

/** One canonical candle's stable research semantics, normalized to deterministic strings for hashing. Never contains a `number`/`bigint` directly -- see `dataset-manifest-canonical-json.ts` doc for why. */
export interface ManifestCandleContent {
  readonly candleTime: string; // ISO 8601 UTC (Date#toISOString())
  readonly open: string; // exact decimal string as persisted -- never a lossy `number` round-trip
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string; // bigint#toString()
  readonly openInterest: string | null; // bigint#toString(), or null -- explicitly distinct from a missing field
}

export interface UnderlyingSessionIdentity {
  readonly datasetKind: ManifestDatasetKind.UNDERLYING_1M;
  readonly provider: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
}

export interface OptionSessionIdentity {
  readonly datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M;
  readonly provider: HistoricalProviderId;
  /** The provider-native contract identity persisted as `HistoricalOptionCandle.instrumentKey` (see `historical-option-candle-lake.repository.ts`). Never `tradingSymbol` -- that field is always `null` (unproven, see `historical-option-contract-catalog.types.ts`). */
  readonly providerContractId: string;
  readonly optionType: HistoricalOptionType;
  readonly strikePrice: string; // exact decimal string, matches ManifestCandleContent convention
  readonly expiry: string; // ISO 8601 UTC
  readonly timeframe: string;
  readonly tradingDate: string;
}

export type SessionContentIdentity = UnderlyingSessionIdentity | OptionSessionIdentity;

/**
 * B-F5 CALENDAR FIX (task invariant A/C): explicit, calendar-authoritative
 * session windows for requested manifest sessions, keyed by `tradingDate`.
 * Supplied by a calendar-aware caller (see
 * `ManifestCalendarSessionResolverService` / `research-dataset-manifest-generate.ts`)
 * so a certified SPECIAL_SESSION date's health is scored against its REAL
 * session windows -- never Monday-Friday arithmetic, never the fixed
 * 09:15-15:29 375-row regular-session default. A date with no entry here
 * falls back to that fixed default, which is provably identical to the
 * certified calendar's own REGULAR_SESSION window (see
 * `regularSessionWindow()`) -- so an ordinary weekday request behaves
 * identically whether or not its entry is present, and no pre-existing
 * caller/test that only ever requests ordinary weekday sessions needs to
 * change.
 *
 * Type alias only (kept so existing manifest-domain call sites/tests keep
 * this name) -- the canonical, domain-neutral definition is
 * `CalendarSessionWindowsByDate` in `exchange-calendar.types.ts`, since this
 * same shape is now also consumed by `GrowwOptionCandleAcquisitionService`
 * (option acquisition) and `ResearchYearRunnerService` (year-runner manifest
 * generation), not just manifest generation.
 */
export type ManifestCalendarSessionWindowsByDate = CalendarSessionWindowsByDate;

/** Exactly the content that determines a session's `contentChecksum` -- IDENTITY MATERIAL only (task section 4). Never persisted verbatim in a `SessionManifest` artifact (task section 12: "no huge raw candle payload duplication"); used transiently to compute the checksum. */
export interface SessionContentPayload {
  readonly identity: SessionContentIdentity;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  /** Sorted ascending by `candleTime` before hashing -- see `sortManifestCandles`. */
  readonly candles: readonly ManifestCandleContent[];
}

export function sortManifestCandles(candles: readonly ManifestCandleContent[]): ManifestCandleContent[] {
  return [...candles].sort((left, right) => (left.candleTime < right.candleTime ? -1 : left.candleTime > right.candleTime ? 1 : 0));
}

export function computeSessionContentChecksum(payload: SessionContentPayload): string {
  const sorted: SessionContentPayload = { ...payload, candles: sortManifestCandles(payload.candles) };
  return sha256Hex(canonicalManifestJson(sorted));
}

/** Stable, comparable string key for one session's IDENTITY MATERIAL (excluding candle content) -- used for duplicate-session detection and deterministic sort tie-breaking. Two sessions with the same key describe the same logical session (same instrument/contract identity + trading date). */
export function sessionIdentityKey(identity: SessionContentIdentity): string {
  return canonicalManifestJson(identity);
}

/**
 * Fails closed if two or more entries in `identities` describe the same
 * logical session (task section 16.M / section 5: "no duplicate logical
 * session identity"). Never silently deduplicates or picks one.
 */
export function assertNoDuplicateSessionIdentities(identities: readonly SessionContentIdentity[]): void {
  const seen = new Map<string, string>();
  for (const identity of identities) {
    const key = sessionIdentityKey(identity);
    const existingTradingDate = seen.get(key);
    if (existingTradingDate !== undefined) {
      throw new Error(`Duplicate logical session identity for tradingDate ${identity.tradingDate}: this exact instrument/contract + trading date was already included in this dataset manifest request.`);
    }
    seen.set(key, identity.tradingDate);
  }
}

/** One dataset-level checksum input: exactly the content that determines whether two sessions are the "same" session for dataset-identity purposes. */
export interface DatasetSessionChecksumInput {
  readonly identity: SessionContentIdentity;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  readonly contentChecksum: string;
}

/**
 * Content-addressed dataset checksum: SHA-256 over the sessions' identity +
 * semantics-version + content-checksum, sorted deterministically by trading
 * date (task section 5: "same sessions presented in different input order
 * -> same dataset ID"). Never includes `generatedAt`/row-count/health-status
 * observability fields -- those change without the underlying content
 * changing (task section 1) and must never perturb the checksum.
 */
export function computeDatasetChecksum(sessions: readonly DatasetSessionChecksumInput[]): string {
  const sorted = [...sessions].sort((left, right) => (left.identity.tradingDate < right.identity.tradingDate ? -1 : left.identity.tradingDate > right.identity.tradingDate ? 1 : 0));
  return sha256Hex(canonicalManifestJson(sorted));
}

/** Human-readable, content-addressed dataset version identity (task section 5/6: "derive it from the cryptographic hash rather than random generation"). Never a random UUID. */
export function deriveDatasetId(datasetKind: ManifestDatasetKind, datasetChecksum: string): string {
  return `${datasetKind}_${datasetChecksum.slice(0, 16)}`;
}

/**
 * Whether original-provider-acquisition evidence (raw row count, excluded-row
 * count, source-order-anomaly count, the acquisition-time
 * `DatasetHealthStatus`) is actually available to this manifest, or is
 * structurally unknown because it was never recovered.
 *
 * B-F5 CORRECTION (post-review): B-F2/B-F4 never persist excluded rows or
 * source-order-anomaly evidence -- only the ACCEPTED canonical rows survive
 * into `HistoricalCandle`/`HistoricalOptionCandle`. A manifest reconstructed
 * purely from the persisted store therefore can NEVER prove what the
 * original raw provider delivery looked like (whether it had pre/post-market
 * rows, duplicates, or out-of-order timestamps that were already excluded
 * before persistence). `UNAVAILABLE_FROM_PERSISTED_STORE` was, until B-F2C,
 * the only value B-F5 ever produced -- there was deliberately no path that
 * fabricated a `HEALTHY`/zero-exclusion source acquisition record.
 *
 * B-F2C introduces `AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE`: exactly the
 * `AVAILABLE_FROM_ACQUISITION_ARTIFACT`-shaped value this file's original
 * comment anticipated, now that `NiftyUnderlyingAcquisitionService` writes a
 * durable `HistoricalDataRetrievalSession` evidence row (B-F2C) BEFORE
 * persistence for every session it genuinely retrieves from a provider.
 * `DatasetManifestService` looks this evidence up (never fabricates it) and
 * falls back to `UNAVAILABLE_FROM_PERSISTED_STORE` whenever no such
 * evidence exists -- a legacy, pre-B-F2C session (or a resumed session
 * B-F2C's acquisition path skipped without calling a provider, per
 * invariant 12) never becomes `AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE`.
 */
export enum SourceAcquisitionEvidenceAvailability {
  UNAVAILABLE_FROM_PERSISTED_STORE = 'UNAVAILABLE_FROM_PERSISTED_STORE',
  AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE = 'AVAILABLE_FROM_DURABLE_RETRIEVAL_EVIDENCE',
}

/**
 * Original-provider-acquisition evidence for one session, kept structurally
 * separate from `persistedCanonicalHealthStatus` (task correction: "persisted
 * canonical health != source acquisition health"). Every field here is
 * `null` (never `0`/`HEALTHY` by assumption) whenever `availability` is
 * `UNAVAILABLE_FROM_PERSISTED_STORE` -- an unknown exclusion count must never
 * be presented as a proven zero, and an unknown source health must never be
 * presented as a proven `HEALTHY`.
 */
export interface SourceAcquisitionEvidence {
  readonly availability: SourceAcquisitionEvidenceAvailability;
  /** Raw provider row count at ORIGINAL acquisition time. `null` means unknown, never a proven count. */
  readonly providerRowCount: number | null;
  /** Rows excluded (pre/post-market, cross-session, etc.) at ORIGINAL acquisition time. `null` means unknown/unrecoverable, NEVER `0` -- a `0` here would falsely assert "proven exclusion-free". */
  readonly excludedRowCount: number | null;
  /** Raw-delivery-order anomalies observed at ORIGINAL acquisition time. `null` means unknown/unrecoverable, NEVER `0` -- excluded rows and delivery-order evidence are not persisted by B-F2/B-F4, so a reconstructed manifest cannot prove the original provider response was clean. */
  readonly sourceOrderAnomalyCount: number | null;
  /** The `DatasetHealthStatus` DatasetHealthValidatorService computed at ORIGINAL acquisition time (over the true raw projection, including any exclusions). `null` means unknown -- NEVER fabricated as `HEALTHY`/`NORMALIZED_WITH_EXCLUSIONS` merely because the persisted canonical content happens to look healthy. */
  readonly sourceHealthStatus: DatasetHealthStatus | null;
  /** B-F2C: the true historical-data-provider identity from durable retrieval evidence (see invariant 4 -- never `HistoricalCandle.source`, which is not authoritative provenance). `null` when `availability` is `UNAVAILABLE_FROM_PERSISTED_STORE`. */
  readonly provider: HistoricalProviderId | null;
  /**
   * B-F2C: the stable, deterministic `HistoricalDataRetrievalSession.
   * evidenceSemanticChecksum` this evidence was read from. VERY IMPORTANT
   * (invariant 13): this is a SEMANTIC content checksum, never a random
   * retrieval-attempt UUID or a wall-clock `retrievedAt` -- two identical
   * retrievals of the same provider content produce the identical value
   * here. `null` when `availability` is `UNAVAILABLE_FROM_PERSISTED_STORE`.
   * This field itself is observability material (like the rest of
   * `SourceAcquisitionEvidence`) and is never part of `contentChecksum`/
   * `datasetChecksum`.
   */
  readonly evidenceSemanticChecksum: string | null;
}

/** The `SourceAcquisitionEvidence` value used whenever no durable B-F2C retrieval evidence exists for a session (every value B-F5 produced before B-F2C, and every legacy/resumed session after it). Exported as a single frozen constant so every caller shares the identical "unknown" representation rather than each re-deriving its own all-null object. */
export const UNAVAILABLE_SOURCE_ACQUISITION_EVIDENCE: SourceAcquisitionEvidence = Object.freeze({
  availability: SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE,
  providerRowCount: null,
  excludedRowCount: null,
  sourceOrderAnomalyCount: null,
  sourceHealthStatus: null,
  provider: null,
  evidenceSemanticChecksum: null,
});

/**
 * Session-level manifest as actually persisted in a `DatasetManifest`
 * artifact. Splits IDENTITY MATERIAL (`identity`, `canonicalizationVersion`,
 * `healthSemanticsVersion`, `contentChecksum` -- everything the checksum is
 * computed over) from OBSERVABILITY MATERIAL (everything else): a volatile
 * statistic may appear here without being part of the content identity hash
 * (task section 4). `contentChecksum` proves CONTENT IDENTITY, never DATA
 * QUALITY.
 *
 * B-F5 CORRECTION (post-review): `persistedCanonicalHealthStatus` and
 * `optionObservationState` describe ONLY the persisted canonical candle rows
 * this manifest actually read -- they are computed by feeding those rows
 * into the EXISTING, unmodified `DatasetHealthValidatorService` /
 * `resolveOptionCandleObservationState` via a synthetic projection
 * (`excludedRows = []`, `sourceOrderAnomalies = []`, because that evidence is
 * not persisted). They MUST NOT be read as proof of original PROVIDER
 * acquisition health -- a session whose original raw delivery contained
 * pre/post-market rows, duplicates, or out-of-order timestamps that were
 * already excluded before persistence can still show
 * `persistedCanonicalHealthStatus: HEALTHY` here, truthfully, for the
 * content that survived. `sourceAcquisitionEvidence` is the explicit,
 * structurally-separate place that evidence would live if it were ever
 * available -- today it is always `UNAVAILABLE_FROM_PERSISTED_STORE`.
 */
export interface SessionManifest {
  // ---- IDENTITY MATERIAL (hashed into contentChecksum) ----
  readonly identity: SessionContentIdentity;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  readonly contentChecksum: string;

  // ---- OBSERVABILITY MATERIAL (never hashed) ----
  readonly canonicalRowCount: number;
  /**
   * Health of the PERSISTED CANONICAL CONTENT only (task correction). Computed
   * purely from the rows this manifest read out of the DB -- never a claim
   * about what the original provider response looked like before
   * acquisition-time exclusions were applied. See `sourceAcquisitionEvidence`
   * for that separate, explicitly-unavailable concept.
   */
  readonly persistedCanonicalHealthStatus: DatasetHealthStatus;
  /**
   * Content-derived evidence for `EXPIRED_OPTION_1M` only (`null` for
   * `UNDERLYING_1M`), computed from persisted canonical option rows alone
   * (B-F4 point-in-time semantics preserved). Proves only what the persisted
   * candle content shows for this session -- it does NOT prove provider raw
   * source cleanliness, the absence of excluded rows, the absence of
   * source-order anomalies, or tradability before the first observed candle
   * (see `historical-option-candle-observation.types.ts`).
   */
  readonly optionObservationState: OptionCandleObservationState | null;
  /** Structural findings over the PERSISTED CANONICAL CONTENT only (same scope as `persistedCanonicalHealthStatus`). */
  readonly issues: readonly DatasetHealthIssue[];
  /** Only meaningful for `EXPIRED_OPTION_1M`; `null` for `UNDERLYING_1M`. */
  readonly rowsWithOi: number | null;
  readonly rowsWithNullOi: number | null;
  /** Original-provider-acquisition evidence, kept structurally separate from `persistedCanonicalHealthStatus` -- see `SourceAcquisitionEvidence` doc. Always `UNAVAILABLE_FROM_PERSISTED_STORE` in every manifest B-F5 can currently produce. */
  readonly sourceAcquisitionEvidence: SourceAcquisitionEvidence;
  /**
   * B-F5 CALENDAR FIX: the exact calendar-declared session windows this
   * session's `persistedCanonicalHealthStatus`/`issues`/`optionObservationState`
   * were computed against, when a calendar-aware caller supplied them at
   * generation time (`calendarSessionWindows` on the generate request). `[]`
   * when no calendar declaration was supplied for this date -- the legacy
   * fixed 09:15-15:29 375-row regular-session default was used instead (see
   * `DatasetSessionManifestBuilderService`). Recorded (not re-derived) so
   * `DatasetManifestService.verifyManifest` reproduces the IDENTICAL health
   * determination later without a live calendar lookup -- B-F5 never calls a
   * provider or a calendar service during verify (task section 9/15). Never
   * hashed into `contentChecksum`/`datasetChecksum`, exactly like
   * `persistedCanonicalHealthStatus` itself.
   */
  readonly calendarSessionWindows: readonly SessionWindow[];
}

export interface DatasetProvenance {
  readonly provider: HistoricalProviderId;
  readonly datasetKind: ManifestDatasetKind;
  /** Human-readable instrument/contract descriptor (instrumentKey or providerContractId) -- not itself identity material (the per-session `identity` field is authoritative for that). */
  readonly instrumentDescriptor: string;
  readonly requestedFromDate: string;
  readonly requestedToDate: string;
  /** B-F5 manifest generation always reconstructs from already-persisted rows -- it never calls a provider live (task section 9/15). */
  readonly acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION';
  /** Optional, best-effort, safely-available provenance -- never the sole dataset identity (task section 6). */
  readonly gitRevision: string | null;
}

/** Rollup counts over `sessions[].persistedCanonicalHealthStatus` only -- describes persisted canonical content, never source-acquisition health (see `SessionManifest` doc). */
export interface DatasetManifestSessionCounts {
  readonly requested: number;
  readonly included: number;
  readonly healthy: number;
  readonly incomplete: number;
  readonly invalid: number;
  readonly byPersistedCanonicalHealthStatus: Readonly<Record<DatasetHealthStatus, number>>;
}

export interface DatasetManifest {
  readonly manifestSchemaVersion: number;
  readonly datasetKind: ManifestDatasetKind;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  readonly datasetChecksum: string;
  readonly datasetId: string;
  readonly provenance: DatasetProvenance;
  /** Observability only -- never part of `datasetChecksum` (task section 1/14: "generatedAt changes -> dataset identity unchanged"). */
  readonly generatedAt: string;
  readonly sessions: readonly SessionManifest[];
  readonly sessionCounts: DatasetManifestSessionCounts;
}

export interface SessionVerificationResult {
  readonly tradingDate: string;
  readonly matches: boolean;
  readonly originalContentChecksum: string;
  /** `null` when the session could no longer be reconstructed at all (e.g. zero rows now persisted where the manifest recorded rows). */
  readonly recomputedContentChecksum: string | null;
  readonly originalCanonicalRowCount: number;
  readonly recomputedCanonicalRowCount: number | null;
  /** Persisted-canonical-content health only (never source-acquisition health) -- see `SessionManifest.persistedCanonicalHealthStatus` doc. */
  readonly originalPersistedCanonicalHealthStatus: DatasetHealthStatus;
  /** `null` when the session could no longer be reconstructed at all. Recomputed fresh from the CURRENT persisted store -- verify never synthesizes a source-acquisition health value, since B-F5 never has that evidence to synthesize from. */
  readonly recomputedPersistedCanonicalHealthStatus: DatasetHealthStatus | null;
}

export interface DatasetManifestVerificationResult {
  readonly verified: boolean;
  readonly datasetKind: ManifestDatasetKind;
  readonly datasetId: string;
  readonly originalDatasetChecksum: string;
  readonly recomputedDatasetChecksum: string;
  readonly datasetChecksumMatches: boolean;
  readonly sessionResults: readonly SessionVerificationResult[];
  readonly mismatchedTradingDates: readonly string[];
}
