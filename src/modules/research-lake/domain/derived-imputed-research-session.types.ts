import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { contentAddressedJsonRelativePath, ContentAddressedJsonStoreResult, readContentAddressedJson, storeContentAddressedJson } from './content-addressed-json-store';

/**
 * B-M7.1 task section 10: the derived, research-only, 375-row 1-minute
 * session assembled from an `ObservedIncompleteSessionSnapshotV1` (372 real
 * rows) plus exactly 3 explicitly-authorized imputed rows (task section 6/7).
 *
 * Combined semantic version covering: row assembly rules (exact expected-
 * minute coverage, provenance classification), availability/no-lookahead
 * semantics (task section 9), and which fields participate in
 * `derivedContentChecksum`. Independent of
 * `LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION` (that governs the
 * INTERPOLATION FORMULA itself, reused here as one input) and of
 * `NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_VERSION` (that governs WHICH gap
 * is authorized, not how a derived session is assembled/hashed once
 * authorized).
 */
export const DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION = 1;
export const IMPUTATION_SEMANTICS_VERSION = 1;

export const DERIVED_IMPUTED_RESEARCH_SESSION_STORAGE_ROOT = 'artifacts/research-lake';
export const DERIVED_IMPUTED_RESEARCH_SESSION_STORAGE_SUBDIR = 'derived-imputed-sessions';

export enum ResearchRowProvenanceKind {
  OBSERVED = 'OBSERVED',
  IMPUTED = 'IMPUTED',
}

/** Truthful, explicit reason a row was imputed -- never left as a bare boolean. Only value defined so far (task section 8); a future authorized gap may need its own distinct reason rather than silently reusing this one. */
export enum ImputationReason {
  INDEX_BROADCAST_DATA_GAP = 'INDEX_BROADCAST_DATA_GAP',
}

export type ImputationAnchorField = 'CLOSE' | 'OPEN';

/**
 * Provenance for one boundary anchor used by an imputed row -- ties the
 * synthetic value back to the exact REAL candle and field it was derived
 * from, plus that real candle's own content-identity checksum (via
 * `computeCandleContentChecksum`), never merely a price number floating
 * with no traceable source.
 */
export interface ImputationAnchorProvenance {
  readonly candleTime: string; // ISO 8601 UTC
  readonly field: ImputationAnchorField;
  readonly contentChecksum: string;
}

export interface ObservedRowProvenance {
  readonly kind: ResearchRowProvenanceKind.OBSERVED;
  /** Links this row back to the exact qualified `ObservedIncompleteSessionSnapshotV1` it was read from. */
  readonly sourceSnapshotChecksum: string;
}

/**
 * Provenance for one IMPUTED row (task section 8). Deliberately carries NO
 * `provider` field claiming Upstox/NSE/Groww supplied this value -- the only
 * provider-shaped facts here (`leftAnchor`/`rightAnchor`) describe the REAL
 * anchor candles' identity, never the synthetic value's own origin.
 */
export interface ImputedRowProvenance {
  readonly kind: ResearchRowProvenanceKind.IMPUTED;
  readonly method: string;
  readonly policyVersion: number;
  readonly authorizationId: string;
  readonly reason: ImputationReason;
  readonly leftAnchor: ImputationAnchorProvenance;
  readonly rightAnchor: ImputationAnchorProvenance;
  readonly sourceSnapshotChecksum: string;
}

export type ResearchRowProvenance = ObservedRowProvenance | ImputedRowProvenance;

export interface DerivedResearchSessionRowV1 {
  readonly candleTime: string; // ISO 8601 UTC, open-time convention (matches every other candle timestamp in this Research Lake)
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly openInterest: string | null;
  /**
   * The earliest instant this row may be treated as decided/available to a
   * research or replay consumer (task section 9). For an OBSERVED row this
   * is `candleTime + 1 minute` (the SAME "1 minute after this row's own
   * completion" convention `HistoricalCandleResamplerService` already uses
   * for `ResampledCandle.availableAt`). For an IMPUTED row this is instead
   * the instant the REAL right-anchor candle is known complete -- see
   * `NiftyIndexGapImputationService` for the exact derivation.
   */
  readonly availableAt: string; // ISO 8601 UTC
  readonly provenance: ResearchRowProvenance;
}

/**
 * B-M7.1 task section 11: precedence tier a caller assembling a full year of
 * research sessions should use to pick between candidate representations of
 * one trading date. This milestone implements ONLY tier 3 (this module) --
 * it never outranks a real healthy or composite-repaired canonical session,
 * and a future year-assembly component MUST check for tiers 1/2 first.
 */
export enum ResearchSessionSourcePrecedenceTier {
  HEALTHY_REAL_CANONICAL_SESSION = 1,
  ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION = 2,
  AUTHORIZED_DERIVED_IMPUTED_SESSION = 3,
  UNAVAILABLE = 4,
}

export interface DerivedImputedSessionIdentity {
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
}

export interface DerivedImputedResearchSessionV1 {
  readonly schemaVersion: number;
  readonly imputationSemanticsVersion: number;
  readonly identity: DerivedImputedSessionIdentity;
  readonly authorizationId: string;
  /** The REAL provider that supplied the underlying snapshot's 372 observed rows -- describes the SNAPSHOT's origin, never asserted as the origin of the 3 imputed rows (see `ImputedRowProvenance`'s own doc). */
  readonly sourceSnapshotProviderId: string;
  readonly sourceSnapshotChecksum: string;
  /** Exactly `realRowCount + imputedRowCount` entries, unique ascending `candleTime`, zero missing expected minutes. */
  readonly rows: readonly DerivedResearchSessionRowV1[];
  readonly realRowCount: number;
  readonly imputedRowCount: number;
  readonly precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION;
  readonly derivedContentChecksum: string;
}

export type DerivedImputedResearchSessionContentPayload = Omit<DerivedImputedResearchSessionV1, 'derivedContentChecksum'>;

/**
 * Content-addressed derived checksum (task section 10): SHA-256 over every
 * semantic fact that distinguishes materially different derived datasets --
 * `sourceSnapshotChecksum`, authorization identity, imputation method/
 * version (both folded into each imputed row's own `provenance`), every
 * row's OHLCV/OI + `candleTime` + `availableAt` + provenance classification
 * (including anchor content-identity), and `precedenceTier`. Rows are NOT
 * re-sorted here (unlike `computeSessionContentChecksum`'s
 * `sortManifestCandles`) -- `rows` is already required to be the unique,
 * ascending, gap-free expected-minute sequence by construction (task section
 * 10), and preserving the caller's given order lets a genuine ordering
 * defect (e.g. an accidentally duplicated/misplaced row) still change the
 * checksum rather than being silently sorted away.
 */
export function computeDerivedImputedSessionChecksum(payload: DerivedImputedResearchSessionContentPayload): string {
  return sha256Hex(canonicalManifestJson(payload));
}

export function buildDerivedImputedResearchSession(payload: DerivedImputedResearchSessionContentPayload): DerivedImputedResearchSessionV1 {
  return { ...payload, derivedContentChecksum: computeDerivedImputedSessionChecksum(payload) };
}

export function derivedImputedResearchSessionRelativePath(derivedContentChecksum: string): string {
  return contentAddressedJsonRelativePath(DERIVED_IMPUTED_RESEARCH_SESSION_STORAGE_SUBDIR, derivedContentChecksum);
}

export function storeDerivedImputedResearchSession(root: string, session: DerivedImputedResearchSessionV1): ContentAddressedJsonStoreResult {
  return storeContentAddressedJson(
    root,
    DERIVED_IMPUTED_RESEARCH_SESSION_STORAGE_SUBDIR,
    session.derivedContentChecksum,
    session,
    (parsed) => computeDerivedImputedSessionChecksum(stripDerivedChecksum(parsed))
  );
}

export function readDerivedImputedResearchSession(root: string, derivedContentChecksum: string): DerivedImputedResearchSessionV1 {
  return readContentAddressedJson<DerivedImputedResearchSessionV1>(root, DERIVED_IMPUTED_RESEARCH_SESSION_STORAGE_SUBDIR, derivedContentChecksum);
}

function stripDerivedChecksum(session: DerivedImputedResearchSessionV1): DerivedImputedResearchSessionContentPayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it from `payload`
  const { derivedContentChecksum, ...payload } = session;
  return payload;
}
