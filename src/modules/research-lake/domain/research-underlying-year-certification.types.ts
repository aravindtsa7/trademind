import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { contentAddressedJsonRelativePath, ContentAddressedJsonStoreResult, readContentAddressedJson, storeContentAddressedJson } from './content-addressed-json-store';
import { assertNoDuplicateStorageSessionEntries, ParquetCompressionCodec, ParquetWriterFormat } from './parquet-storage.types';
import { ManifestDatasetKind } from './dataset-manifest.types';
import { SessionWindow } from './exchange-calendar.types';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from './resampled-candle.types';
import { RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES } from './research-underlying-resampling-manifest.types';

/**
 * B-M8B: ONE compact, content-addressed certification artifact proving --
 * with a real, checkable per-session audit trail, never a "summary-only
 * certificate that could be produced after checking one session and
 * fabricating totals" -- that every certified trading date's 1-minute
 * research rows AND all three (2m/3m/5m) resampled targets were actually
 * read back through the verified B-M7.2/B-M7.3 boundaries and reproduce
 * their recorded identity, AND that verified physical canonical Parquet
 * storage exists for the exact real-canonical date set (task: "Do NOT
 * implement a certification that reports UNMATERIALIZED and still marks
 * 2022 COMPLETE").
 */
export const RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION = 1;
export const RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION = 1;

export const RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_ROOT = 'artifacts/research-lake';
export const RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_SUBDIR = 'research-underlying-certifications';

export interface ResearchUnderlyingYearCertificationIdentity {
  readonly instrumentKey: string;
  readonly sourceTimeframe: string;
  readonly year: number;
}

/** Stable calendar-certification identity/reference (task: "calendar certification identity/reference") -- the exact per-date list is already fully represented (and content-addressed) by `sessions[]` itself; this is the aggregate fact that list is checked against. */
export interface CertificationCalendarReference {
  readonly expectedSessionCount: number;
}

/** Stable identity/semantics-version material projected from the B-F5 canonical `DatasetManifest` artifact -- never the manifest's own `generatedAt`/session payload (task: "canonical manifest: datasetId, datasetChecksum, manifest schema/canonicalization/health semantics versions as material"). */
export interface CertificationCanonicalManifestReference {
  readonly datasetId: string;
  readonly datasetChecksum: string;
  readonly manifestSchemaVersion: number;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
}

/** One physically-verified canonical Parquet session's STABLE identity facts only -- never the B-F6 descriptor's own volatile `generatedAt` (task: "DO NOT include volatile Parquet descriptor.generatedAt in certification identity"). */
export interface CertificationPhysicalStorageSessionEntry {
  readonly tradingDate: string;
  readonly sessionContentChecksum: string;
  readonly canonicalRowCount: number;
  readonly physicalFileChecksum: string;
}

/**
 * STABLE physical-storage identity projected from the B-F6
 * `ParquetDatasetStorageDescriptor` -- EVERY stable identity field of the
 * descriptor (B-M8-HIGH-01 fix: an earlier revision bound only
 * `storageSchemaVersion`/`datasetChecksum`, silently letting `datasetId`,
 * `datasetKind`, `writerFormat`, `writerLibrary`, `writerLibraryVersion`,
 * and `compressionCodec` drift undetected) plus sorted stable per-session
 * physical facts. The ONLY B-F6 descriptor field intentionally excluded is
 * `generatedAt`: it is volatile wall-clock metadata (task: "If B-F6
 * descriptor is regenerated later with identical files but a new
 * generatedAt, the B-M8 certification semantic checksum should remain
 * identical"). Every other descriptor field is material -- if the
 * descriptor type ever gains a new stable field, it must be added here
 * too; there is no partial-field allowlist that can silently omit one.
 */
export interface CertificationPhysicalStorageReference {
  readonly storageSchemaVersion: number;
  readonly datasetId: string;
  readonly datasetChecksum: string;
  readonly datasetKind: ManifestDatasetKind;
  readonly writerFormat: ParquetWriterFormat;
  readonly writerLibrary: string;
  readonly writerLibraryVersion: string;
  readonly compressionCodec: ParquetCompressionCodec;
  readonly sessions: readonly CertificationPhysicalStorageSessionEntry[];
}

/** One (session, target) pair's certified research-resampling facts -- deliberately carries counts/checksum only, never candle payloads. */
export interface CertifiedSessionTargetRecord {
  readonly target: ResampleTargetTimeframe;
  readonly researchDerivedContentChecksum: string;
  readonly outputCandleCount: number;
  readonly structuralTrailingRowCount: number;
  readonly candlesContainingImputation: number;
  /** `true` only if EVERY returned candle for this (session, target) independently satisfied `availableAt === MAX(constituents[*].availableAt)` -- the B-M8 generic no-lookahead audit (task: "Do not merely assume B-M7.3 reader already did it"), never merely copied from the B-M7.3 descriptor. */
  readonly noLookaheadVerified: boolean;
}

/**
 * One trading date's full certification record -- the real, checkable
 * per-session audit trail (task: "Avoid a summary-only certificate...
 * Preferred: store a compact sorted per-session certification record for
 * all 248 dates"). `oneMinuteVerificationChecksum` is a SHA-256 digest
 * computed over every certified 1m row's `candleTime`/`availableAt`/
 * provenance-kind for this date (sorted, deterministic) -- compact in the
 * stored artifact (one 64-hex-char string) while still cryptographically
 * proving the 1m certification actually walked every row, rather than
 * merely re-stating already-recorded counts.
 */
export interface CertifiedSessionRecord {
  readonly tradingDate: string;
  readonly calendarSessionWindows: readonly SessionWindow[];
  readonly sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier;
  readonly sourceContentChecksum: string;
  readonly sourceRowCount: number;
  readonly realCanonicalRowCount: number;
  readonly derivedObservedRowCount: number;
  readonly derivedImputedRowCount: number;
  readonly oneMinuteVerificationChecksum: string;
  /** Exactly `RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.length` entries, one per target, no duplicate/missing target. */
  readonly targets: readonly CertifiedSessionTargetRecord[];
}

export interface March7NoLookaheadProofEntry {
  readonly target: ResampleTargetTimeframe;
  /** `"HH:mm"` IST, e.g. `"10:21"`. Presentation-only, never the sole timestamp representation (mirrors `formatMinuteOfDayIst`'s own convention). */
  readonly bucketStartIst: string;
  readonly expectedAvailableAtIst: string;
  readonly verified: boolean;
}

/**
 * The exact, LOCKED March-7 no-lookahead evidence (task: "Certify exact: 2m
 * 10:21-10:22 -> 10:26, 2m 10:23-10:24 -> 10:26, 3m 10:21-10:23 -> 10:26, 3m
 * 10:24-10:26 -> 10:27, 5m 10:20-10:24 -> 10:26 IST"). `imputedMinutesIst`
 * is deliberately explicit (never re-derived from guessed clock arithmetic
 * -- task: "inspect actual provenance") -- the CORRECTED set is
 * `["10:22","10:23","10:24"]`, with 10:21 the LEFT real anchor and 10:25 the
 * RIGHT real anchor.
 */
export interface March7NoLookaheadProof {
  readonly tradingDate: string;
  readonly imputedMinutesIst: readonly string[];
  readonly leftRealAnchorIst: string;
  readonly rightRealAnchorIst: string;
  /** Exactly 5 entries: 2m x2, 3m x2, 5m x1. */
  readonly entries: readonly March7NoLookaheadProofEntry[];
}

export interface CertificationTargetSummary {
  readonly sessionCount: number;
  readonly completeSessionCount: number;
  readonly totalOutputCandles: number;
  readonly totalStructuralTrailingRows: number;
  readonly totalCandlesContainingImputation: number;
}

export interface CertificationSummary {
  readonly expectedSessions: number;
  readonly verifiedSessions: number;
  readonly realCanonicalSessions: number;
  readonly compositeRepairedSessions: number;
  readonly authorizedDerivedSessions: number;
  readonly unavailableSessions: number;
  readonly total1mRows: number;
  readonly byTarget: Readonly<Record<ResampleTargetTimeframe, CertificationTargetSummary>>;
}

/**
 * HIGH-06-style discipline (matches every other B-M7.x content-addressed
 * artifact in this codebase): NO wall-clock/run-varying field at all.
 * `summary` is the one exception, fully derivable from `sessions` +
 * `calendar.expectedSessionCount` and independently re-verified on every
 * read.
 */
export interface ResearchUnderlyingYearCertificationV1 {
  readonly schemaVersion: number;
  readonly certificationSemanticsVersion: number;
  readonly identity: ResearchUnderlyingYearCertificationIdentity;
  readonly calendar: CertificationCalendarReference;
  readonly canonicalManifest: CertificationCanonicalManifestReference;
  readonly physicalStorage: CertificationPhysicalStorageReference;
  readonly derivedSnapshotChecksum: string;
  readonly derivedSessionChecksum: string;
  readonly sourceAssemblyChecksum: string;
  readonly resamplingManifestChecksum: string;
  /** Ascending by `tradingDate` -- deterministic, never DB/filesystem/input-array enumeration order. */
  readonly sessions: readonly CertifiedSessionRecord[];
  readonly march7Proof: March7NoLookaheadProof;
  readonly summary: CertificationSummary;
  readonly certificationContentChecksum: string;
}

/** Exactly the content that determines `certificationContentChecksum` -- IDENTITY MATERIAL only. `summary` is the one field deliberately excluded (fully derivable from `sessions` + `calendar`, re-verified on every read). */
export type ResearchUnderlyingYearCertificationContentPayload = Omit<ResearchUnderlyingYearCertificationV1, 'summary' | 'certificationContentChecksum'>;

export function sortCertifiedSessions(sessions: readonly CertifiedSessionRecord[]): CertifiedSessionRecord[] {
  return [...sessions].sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : left.tradingDate > right.tradingDate ? 1 : 0));
}

export function assertNoDuplicateCertifiedSessionDates(sessions: readonly CertifiedSessionRecord[]): void {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.tradingDate)) {
      throw new Error(`B-M8B year certification: duplicate trading-date certification record for '${session.tradingDate}' -- refusing to silently deduplicate.`);
    }
    seen.add(session.tradingDate);
  }
}

/** Fails closed unless a session's `targets` is EXACTLY the 3 required timeframes, each exactly once -- no missing target, no duplicate, no extra. */
export function assertExactTargetSet(tradingDate: string, targets: readonly CertifiedSessionTargetRecord[]): void {
  if (targets.length !== RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.length) {
    throw new Error(`B-M8B year certification: tradingDate '${tradingDate}' has ${targets.length} target record(s), expected exactly ${RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES.length}.`);
  }
  const seen = new Set<ResampleTargetTimeframe>();
  for (const target of targets) {
    if (seen.has(target.target)) {
      throw new Error(`B-M8B year certification: tradingDate '${tradingDate}' has a duplicate target record for '${target.target}'.`);
    }
    seen.add(target.target);
  }
  for (const required of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
    if (!seen.has(required)) {
      throw new Error(`B-M8B year certification: tradingDate '${tradingDate}' is missing a target record for '${required}'.`);
    }
  }
}

/** Content-addressed certification checksum. `sessions` is sorted before hashing so caller-supplied ordering never perturbs identity; every session's own target array order is preserved as given by the builder (see `buildResearchUnderlyingYearCertification`, which itself always constructs targets in the fixed canonical order). */
export function computeResearchUnderlyingYearCertificationChecksum(payload: ResearchUnderlyingYearCertificationContentPayload): string {
  const sorted: ResearchUnderlyingYearCertificationContentPayload = { ...payload, sessions: sortCertifiedSessions(payload.sessions) };
  return sha256Hex(canonicalManifestJson(sorted));
}

function targetSummaryFor(sessions: readonly CertifiedSessionRecord[], target: ResampleTargetTimeframe): CertificationTargetSummary {
  let completeSessionCount = 0;
  let totalOutputCandles = 0;
  let totalStructuralTrailingRows = 0;
  let totalCandlesContainingImputation = 0;
  for (const session of sessions) {
    const record = session.targets.find((entry) => entry.target === target);
    if (!record) continue;
    completeSessionCount += 1;
    totalOutputCandles += record.outputCandleCount;
    totalStructuralTrailingRows += record.structuralTrailingRowCount;
    totalCandlesContainingImputation += record.candlesContainingImputation;
  }
  return { sessionCount: sessions.length, completeSessionCount, totalOutputCandles, totalStructuralTrailingRows, totalCandlesContainingImputation };
}

/** The ONE pure summary-derivation function (task: "Use ONE pure derivation function"), used both when BUILDING a certification and when READING one back -- `summary` can never silently drift from `sessions` between the two. */
export function deriveResearchUnderlyingYearCertificationSummary(sessions: readonly CertifiedSessionRecord[], expectedSessionCount: number): CertificationSummary {
  const byTarget = {} as Record<ResampleTargetTimeframe, CertificationTargetSummary>;
  for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) byTarget[target] = targetSummaryFor(sessions, target);

  let realCanonicalSessions = 0;
  let compositeRepairedSessions = 0;
  let authorizedDerivedSessions = 0;
  let unavailableSessions = 0;
  let total1mRows = 0;
  for (const session of sessions) {
    total1mRows += session.sourceRowCount;
    switch (session.sourcePrecedenceTier) {
      case ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION:
        realCanonicalSessions += 1;
        break;
      case ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION:
        compositeRepairedSessions += 1;
        break;
      case ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION:
        authorizedDerivedSessions += 1;
        break;
      case ResearchSessionSourcePrecedenceTier.UNAVAILABLE:
        unavailableSessions += 1;
        break;
      default: {
        const exhaustive: never = session.sourcePrecedenceTier;
        throw new Error(`Unhandled sourcePrecedenceTier: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return { expectedSessions: expectedSessionCount, verifiedSessions: sessions.length, realCanonicalSessions, compositeRepairedSessions, authorizedDerivedSessions, unavailableSessions, total1mRows, byTarget };
}

function summariesEqual(left: CertificationSummary, right: CertificationSummary): boolean {
  if (
    left.expectedSessions !== right.expectedSessions ||
    left.verifiedSessions !== right.verifiedSessions ||
    left.realCanonicalSessions !== right.realCanonicalSessions ||
    left.compositeRepairedSessions !== right.compositeRepairedSessions ||
    left.authorizedDerivedSessions !== right.authorizedDerivedSessions ||
    left.unavailableSessions !== right.unavailableSessions ||
    left.total1mRows !== right.total1mRows
  ) {
    return false;
  }
  for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) {
    const a = left.byTarget[target];
    const b = right.byTarget[target];
    if (!a || !b) return false;
    if (a.sessionCount !== b.sessionCount || a.completeSessionCount !== b.completeSessionCount) return false;
    if (a.totalOutputCandles !== b.totalOutputCandles || a.totalStructuralTrailingRows !== b.totalStructuralTrailingRows) return false;
    if (a.totalCandlesContainingImputation !== b.totalCandlesContainingImputation) return false;
  }
  return true;
}

export interface BuildResearchUnderlyingYearCertificationInput {
  readonly schemaVersion: number;
  readonly certificationSemanticsVersion: number;
  readonly identity: ResearchUnderlyingYearCertificationIdentity;
  readonly calendar: CertificationCalendarReference;
  readonly canonicalManifest: CertificationCanonicalManifestReference;
  readonly physicalStorage: CertificationPhysicalStorageReference;
  readonly derivedSnapshotChecksum: string;
  readonly derivedSessionChecksum: string;
  readonly sourceAssemblyChecksum: string;
  readonly resamplingManifestChecksum: string;
  readonly sessions: readonly CertifiedSessionRecord[];
  readonly march7Proof: March7NoLookaheadProof;
}

export function buildResearchUnderlyingYearCertification(input: BuildResearchUnderlyingYearCertificationInput): ResearchUnderlyingYearCertificationV1 {
  assertNoDuplicateCertifiedSessionDates(input.sessions);
  for (const session of input.sessions) assertExactTargetSet(session.tradingDate, session.targets);
  assertNoDuplicateStorageSessionEntries(input.physicalStorage.sessions);
  assertValidMarch7Proof(input.march7Proof);

  const sessions = sortCertifiedSessions(input.sessions);
  const payload: ResearchUnderlyingYearCertificationContentPayload = {
    schemaVersion: input.schemaVersion,
    certificationSemanticsVersion: input.certificationSemanticsVersion,
    identity: input.identity,
    calendar: input.calendar,
    canonicalManifest: input.canonicalManifest,
    physicalStorage: input.physicalStorage,
    derivedSnapshotChecksum: input.derivedSnapshotChecksum,
    derivedSessionChecksum: input.derivedSessionChecksum,
    sourceAssemblyChecksum: input.sourceAssemblyChecksum,
    resamplingManifestChecksum: input.resamplingManifestChecksum,
    sessions,
    march7Proof: input.march7Proof,
  };
  const certificationContentChecksum = computeResearchUnderlyingYearCertificationChecksum(payload);
  return { ...payload, summary: deriveResearchUnderlyingYearCertificationSummary(sessions, input.calendar.expectedSessionCount), certificationContentChecksum };
}

export function researchUnderlyingYearCertificationRelativePath(certificationContentChecksum: string): string {
  return contentAddressedJsonRelativePath(RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_SUBDIR, certificationContentChecksum);
}

export function storeResearchUnderlyingYearCertification(root: string, certification: ResearchUnderlyingYearCertificationV1): ContentAddressedJsonStoreResult {
  return storeContentAddressedJson(
    root,
    RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_SUBDIR,
    certification.certificationContentChecksum,
    certification,
    (parsed) => computeResearchUnderlyingYearCertificationChecksum(stripCertificationChecksum(parsed))
  );
}

export class ResearchUnderlyingYearCertificationIntegrityError extends Error {
  constructor(
    readonly certificationContentChecksum: string,
    readonly violations: readonly string[]
  ) {
    super(
      `B-M8B year certification at checksum '${certificationContentChecksum}' failed read-time integrity verification: ${violations.join('; ')}. Refusing to trust a stored artifact whose fields no longer match its own recomputed content.`
    );
    this.name = 'ResearchUnderlyingYearCertificationIntegrityError';
  }
}

/**
 * The COMPLETE locked expected March-7 no-lookahead proof semantics for
 * certification schema/semantics V1 (B-M8-HIGH-02 fix). Task: "define the
 * complete locked expected March7 proof semantics ... in one deterministic
 * structure." Every field of `March7NoLookaheadProof` -- including every
 * entry's `target`/`bucketStartIst`/`expectedAvailableAtIst`/`verified` --
 * is represented here; `validateMarch7Proof` below compares a candidate's
 * FULL normalized structure against this object, not a hand-picked subset
 * of fields, so no material field (target, bucket identity, availableAt,
 * verified flag) can be silently omitted from validation the way
 * `researchResamplingSemanticsVersion` was omitted in B-M7.3-HIGH-02. A
 * future certification semantics version that legitimately changes this
 * evidence (e.g. a different derived date, or additional buckets) must
 * define its own locked expected structure and bump
 * `RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION` -- this
 * constant is intentionally exact-2022-March-7-specific for V1.
 */
const LOCKED_MARCH_7_NO_LOOKAHEAD_PROOF: March7NoLookaheadProof = {
  tradingDate: '2022-03-07',
  imputedMinutesIst: ['10:22', '10:23', '10:24'],
  leftRealAnchorIst: '10:21',
  rightRealAnchorIst: '10:25',
  entries: [
    { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:21', expectedAvailableAtIst: '10:26', verified: true },
    { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:23', expectedAvailableAtIst: '10:26', verified: true },
    { target: ResampleTargetTimeframe.THREE_MINUTE, bucketStartIst: '10:21', expectedAvailableAtIst: '10:26', verified: true },
    { target: ResampleTargetTimeframe.THREE_MINUTE, bucketStartIst: '10:24', expectedAvailableAtIst: '10:27', verified: true },
    { target: ResampleTargetTimeframe.FIVE_MINUTE, bucketStartIst: '10:20', expectedAvailableAtIst: '10:26', verified: true },
  ],
};

/** Deterministic semantic identity for one proof entry -- used both to sort entries into a canonical order and to detect duplicate semantic entries, independent of array-insertion order. */
function march7ProofEntrySemanticKey(entry: March7NoLookaheadProofEntry): string {
  return `${entry.target}|${entry.bucketStartIst}`;
}

/** Fails closed (returns violation messages) if two or more entries share the same `(target, bucketStartIst)` semantic identity -- catches a "duplicate one proof entry while omitting another, total count still 5" adversarial candidate BEFORE structural comparison would otherwise just report a generic mismatch. */
function findDuplicateMarch7ProofEntryViolations(entries: readonly March7NoLookaheadProofEntry[]): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const entry of entries) {
    const key = march7ProofEntrySemanticKey(entry);
    if (seen.has(key)) {
      violations.push(`march7Proof.entries contains a duplicate semantic entry for target='${entry.target}' bucketStartIst='${entry.bucketStartIst}'`);
    }
    seen.add(key);
  }
  return violations;
}

function normalizeMarch7Proof(proof: March7NoLookaheadProof): March7NoLookaheadProof {
  const sortedEntries = [...proof.entries].sort((left, right) => {
    const leftKey = march7ProofEntrySemanticKey(left);
    const rightKey = march7ProofEntrySemanticKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { ...proof, entries: sortedEntries };
}

/**
 * ONE authoritative, structurally-exhaustive semantic validator for the
 * ENTIRE stored March-7 no-lookahead proof (B-M8-HIGH-02 fix). Replaces a
 * prior hand-maintained partial check (entry count + imputed-minute set +
 * anchors only) that let a self-consistent-but-semantically-FALSE proof --
 * wrong target timeframe, wrong bucket, wrong `expectedAvailableAtIst`
 * (e.g. the critical 3m 10:24-10:26 bucket reporting 10:26 instead of the
 * true 10:27), `verified=false`, a duplicate-entry-while-omitting-another
 * swap, or a wrong `tradingDate` -- be content-addressed and accepted. No
 * manual per-field allowlist: entries are first checked for duplicate
 * semantic identity, then the FULL normalized proof (every top-level field
 * AND every entry's every field) is compared against
 * `LOCKED_MARCH_7_NO_LOOKAHEAD_PROOF` via the same `canonicalManifestJson`
 * structural-equality primitive the rest of this artifact's identity
 * already relies on -- so a future proof field can never be silently
 * omitted from validation.
 */
function validateMarch7Proof(proof: March7NoLookaheadProof): string[] {
  const duplicateViolations = findDuplicateMarch7ProofEntryViolations(proof.entries);
  if (duplicateViolations.length > 0) {
    return duplicateViolations;
  }
  const actualCanonicalJson = canonicalManifestJson(normalizeMarch7Proof(proof));
  const expectedCanonicalJson = canonicalManifestJson(normalizeMarch7Proof(LOCKED_MARCH_7_NO_LOOKAHEAD_PROOF));
  if (actualCanonicalJson !== expectedCanonicalJson) {
    return [`march7Proof does not exactly match the locked expected March-7 no-lookahead proof semantics: actual=${actualCanonicalJson}, expected=${expectedCanonicalJson}`];
  }
  return [];
}

/** Construction-boundary guard (B-M8-HIGH-02 fix, task: "protect BOTH buildResearchUnderlyingYearCertification... BEFORE a semantically false candidate can be treated as valid, AND readResearchUnderlyingYearCertification... AFTER loading"). Throws immediately -- a semantically false March-7 proof can never even be assembled into a certification candidate, let alone checksummed and persisted. */
export function assertValidMarch7Proof(proof: March7NoLookaheadProof): void {
  const violations = validateMarch7Proof(proof);
  if (violations.length > 0) {
    throw new Error(`B-M8B year certification: march7Proof failed semantic validation at construction time: ${violations.join('; ')}. Refusing to build a certification candidate around a semantically false no-lookahead proof.`);
  }
}

/**
 * Read-time integrity re-verification, mirroring `readResearchUnderlyingDatasetAssembly`/
 * `readResearchUnderlyingResamplingManifest`'s HIGH-05 pattern exactly:
 * schema/semantics version, full re-hash against the requested
 * content-addressed checksum, no duplicate session dates, exact
 * per-session target set, a freshly re-derived `summary` matching the
 * stored one field-for-field, no duplicate physical-storage entries, and a
 * structurally well-formed March-7 no-lookahead proof. Any mismatch throws
 * -- never silently normalized/overwritten.
 */
export function readResearchUnderlyingYearCertification(root: string, certificationContentChecksum: string): ResearchUnderlyingYearCertificationV1 {
  const parsed = readContentAddressedJson<ResearchUnderlyingYearCertificationV1>(root, RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_SUBDIR, certificationContentChecksum);
  const violations: string[] = [];

  if (parsed.schemaVersion !== RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION) {
    violations.push(`schemaVersion ${parsed.schemaVersion} is not the supported ${RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION}`);
  }
  if (parsed.certificationSemanticsVersion !== RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION) {
    violations.push(`certificationSemanticsVersion ${parsed.certificationSemanticsVersion} is not the supported ${RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION}`);
  }

  const recomputedChecksum = computeResearchUnderlyingYearCertificationChecksum(stripCertificationChecksum(parsed));
  if (recomputedChecksum !== certificationContentChecksum || parsed.certificationContentChecksum !== certificationContentChecksum) {
    violations.push(`recomputed certificationContentChecksum '${recomputedChecksum}' (self-declared '${parsed.certificationContentChecksum}') does not match the requested content-addressed checksum '${certificationContentChecksum}'`);
  }

  try {
    assertNoDuplicateCertifiedSessionDates(parsed.sessions);
    for (const session of parsed.sessions) assertExactTargetSet(session.tradingDate, session.targets);
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }

  try {
    assertNoDuplicateStorageSessionEntries(parsed.physicalStorage.sessions);
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }

  const recomputedSummary = deriveResearchUnderlyingYearCertificationSummary(parsed.sessions, parsed.calendar.expectedSessionCount);
  if (!summariesEqual(recomputedSummary, parsed.summary)) {
    violations.push(`stored summary ${JSON.stringify(parsed.summary)} does not match recomputed summary ${JSON.stringify(recomputedSummary)}`);
  }

  violations.push(...validateMarch7Proof(parsed.march7Proof));

  if (violations.length > 0) {
    throw new ResearchUnderlyingYearCertificationIntegrityError(certificationContentChecksum, violations);
  }

  return parsed;
}

function stripCertificationChecksum(certification: ResearchUnderlyingYearCertificationV1): ResearchUnderlyingYearCertificationContentPayload {
  return {
    schemaVersion: certification.schemaVersion,
    certificationSemanticsVersion: certification.certificationSemanticsVersion,
    identity: certification.identity,
    calendar: certification.calendar,
    canonicalManifest: certification.canonicalManifest,
    physicalStorage: certification.physicalStorage,
    derivedSnapshotChecksum: certification.derivedSnapshotChecksum,
    derivedSessionChecksum: certification.derivedSessionChecksum,
    sourceAssemblyChecksum: certification.sourceAssemblyChecksum,
    resamplingManifestChecksum: certification.resamplingManifestChecksum,
    sessions: certification.sessions,
    march7Proof: certification.march7Proof,
  };
}
