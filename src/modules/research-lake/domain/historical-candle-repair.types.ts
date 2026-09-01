import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';

/**
 * B-F8: typed outcome of one canonical-session gap-repair ATTEMPT. Kept
 * deliberately distinct from `HistoricalCandleSessionPersistenceOutcome`
 * (the B-F2C candle-persistence vocabulary) -- a repair attempt can fail
 * for reasons persistence itself never models (no repair provider
 * configured at all, a primary session that is structurally INVALID rather
 * than merely missing minutes).
 */
export enum HistoricalCandleRepairOutcome {
  /** No repair provider was configured, OR the primary retrieval turned out not to need repair (already HEALTHY/NORMALIZED_WITH_EXCLUSIONS on this attempt). Zero repair-provider calls were made. */
  REPAIR_NOT_ATTEMPTED = 'REPAIR_NOT_ATTEMPTED',
  /** The primary session is structurally INVALID (duplicate/misaligned/out-of-order/invalid-OHLC content) rather than merely missing minutes -- gap repair does not apply to this failure mode. Zero repair-provider calls were made. */
  REPAIR_UNAVAILABLE = 'REPAIR_UNAVAILABLE',
  /** The repair provider was called but at least one authoritative missing canonical minute remained unresolved (zero repair rows for it). Fails closed; nothing persisted. */
  REPAIR_INCOMPLETE = 'REPAIR_INCOMPLETE',
  /** The repair provider returned more than one candidate for a single missing minute, or a repair row disagreed in content with an already-accepted primary minute at the same timestamp. Fails closed; nothing persisted; durable conflict evidence recorded on this same row. */
  REPAIR_CONFLICT = 'REPAIR_CONFLICT',
  /** Every authoritative missing canonical minute was resolved by exactly one non-conflicting repair row, the combined primary+repair session revalidated HEALTHY, and the complete session was persisted atomically. */
  REPAIR_ACCEPTED = 'REPAIR_ACCEPTED',
}

/**
 * B-F8 durable composite-provenance semantic checksum (task invariant G).
 * Deliberately excludes every opaque identifier (`primarySessionId`,
 * `primaryRetrievalId`, `repairRetrievalId`, `resultingSessionId`) for the
 * SAME reason `computeEvidenceSemanticChecksum` excludes `id`/`retrievalId`/
 * timestamps: two repair attempts over semantically identical primary +
 * repair provider content must produce the IDENTICAL checksum despite
 * different underlying retrieval UUIDs across separate runs.
 */
export const REPAIR_EVIDENCE_SEMANTIC_CHECKSUM_VERSION = 1;

export interface RepairEvidenceSemanticChecksumInput {
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly repairProviderId: HistoricalProviderId;
  readonly expectedMinuteCount: number;
  readonly primaryAcceptedRowCount: number;
  readonly missingMinuteCount: number;
  readonly repairAcceptedMinuteCount: number;
  readonly corroboratedOverlapCount: number;
  readonly conflictingOverlapCount: number;
  readonly outcome: HistoricalCandleRepairOutcome;
  readonly missingMinutesChecksum: string;
}

export function computeRepairEvidenceSemanticChecksum(input: RepairEvidenceSemanticChecksumInput): string {
  return sha256Hex(canonicalManifestJson({ version: REPAIR_EVIDENCE_SEMANTIC_CHECKSUM_VERSION, ...input }));
}

/**
 * Deterministic content-addressed checksum over an ordered set of
 * authoritative missing canonical minute timestamps -- lets two repair
 * attempts (or a repair attempt and a manual audit) prove they targeted the
 * exact same minute set without comparing the full array. Sorted before
 * hashing so input order never perturbs it (mirrors every other checksum
 * helper in this domain, e.g. `computeCanonicalCandleSetChecksum`).
 */
export function computeMissingMinutesChecksum(missingTimestamps: readonly Date[]): string {
  const sorted = [...missingTimestamps].map((t) => t.toISOString()).sort();
  return sha256Hex(canonicalManifestJson({ version: 1, missingMinutes: sorted }));
}

/**
 * B-F8 CORRECTION (post-Terra-review blocker 1): typed role for one durable
 * `HistoricalCandleRepairContribution` row -- exactly which fact about ONE
 * canonical timestamp this row records for one repair attempt. Deliberately
 * does NOT include a role for "still missing" or "primary-retained" -- see
 * `HistoricalCandleRepairContribution`'s schema doc for why those are
 * reconstructed rather than stored.
 */
export enum HistoricalCandleRepairContributionRole {
  /** This canonical timestamp was authoritatively missing from the primary session and exactly one non-conflicting repair-provider row filled it. */
  REPAIR_FILLED_MISSING = 'REPAIR_FILLED_MISSING',
  /** This canonical timestamp was already primary-accepted; the repair provider also returned a row here with IDENTICAL content -- independent corroboration, never used to fill or replace anything. */
  CORROBORATED_OVERLAP = 'CORROBORATED_OVERLAP',
  /** This canonical timestamp was already primary-accepted; the repair provider returned a row here with DIFFERENT content -- the whole attempt fails closed (see `HistoricalCandleRepairOutcome.REPAIR_CONFLICT`). */
  CONFLICTING_OVERLAP = 'CONFLICTING_OVERLAP',
}

/**
 * B-F8 CORRECTION (post-Terra-review blocker 5): semantic version of the
 * gap-repair RESOLUTION POLICY itself -- the missing-minute derivation rule
 * (calendar-authoritative expected minutes minus primary-accepted), the
 * one-candidate-per-missing-minute resolution rule, the corroboration/
 * conflict overlap rule, and the final whole-session revalidation rule (see
 * `NiftyUnderlyingGapRepairService.repairSession`). Deliberately independent
 * of `REPAIR_EVIDENCE_SEMANTIC_CHECKSUM_VERSION` (that governs the evidence
 * ROW's own checksum-format identity, not the repair POLICY that produced
 * its content) and of `CANONICALIZATION_SEMANTICS_VERSION`/
 * `HEALTH_SEMANTICS_VERSION` (those govern candle canonicalization/health,
 * untouched by this policy). Bump this if the resolution algorithm itself
 * ever changes (e.g. a future policy that tolerates >1 repair candidate via
 * a tie-break rule, or changes what counts as a conflicting overlap).
 */
export const REPAIR_POLICY_VERSION = 1;
