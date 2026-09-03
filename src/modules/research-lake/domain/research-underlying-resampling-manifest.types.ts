import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { contentAddressedJsonRelativePath, ContentAddressedJsonStoreResult, readContentAddressedJson, storeContentAddressedJson } from './content-addressed-json-store';
import { ResampleTargetTimeframe } from './resampled-candle.types';
import { ResearchResampleSessionDescriptor } from './research-underlying-resampled-candle.types';

/**
 * B-M7.3: the compact, content-addressed YEAR-LEVEL manifest that records
 * -- but never embeds -- every certified 2022 session's three (2m/3m/5m)
 * research-resampling descriptors (task: "Do NOT persist 744 giant
 * per-session JSON candle payload files... Create ONE compact
 * content-addressed year-level resampling manifest"). Mirrors B-M7.2's
 * `ResearchUnderlyingDatasetAssemblyV1` shape/discipline exactly: no
 * `generatedAt`/UUID/machine path, `summary` fully re-derivable from
 * `sessions` + `sourceSessionCounts` and independently re-verified on every
 * read (HIGH-05 pattern).
 */
export const RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION = 1;

export const RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_ROOT = 'artifacts/research-lake';
export const RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_SUBDIR = 'research-underlying-resampling-manifests';

/** Exactly the three B-M7.3 target timeframes, in this fixed canonical order (task: "Supported target timeframes EXACTLY: 2m, 3m, 5m"). Never reordered, never extended. */
export const RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES: readonly ResampleTargetTimeframe[] = Object.freeze([
  ResampleTargetTimeframe.TWO_MINUTE,
  ResampleTargetTimeframe.THREE_MINUTE,
  ResampleTargetTimeframe.FIVE_MINUTE,
]);

export interface ResearchUnderlyingResamplingManifestIdentity {
  readonly instrumentKey: string;
  readonly sourceTimeframe: string;
  readonly year: number;
}

/**
 * The source B-M7.2 assembly's own `expectedSessions`/`unavailableSessions`
 * facts (`ResearchUnderlyingDatasetAssemblySessionCounts`), copied verbatim
 * at build time. DELIBERATELY part of the checksummed IDENTITY MATERIAL
 * (never `summary`-only): unlike the assembly's own `sessions` array (which
 * includes an entry for every certified date, UNAVAILABLE ones included),
 * THIS manifest's `sessions` array only ever contains RESOLVED (resampled)
 * dates -- so `expectedSessions`/`unavailableSessions` can never be
 * re-derived purely from `sessions.length` the way the assembly's own counts
 * can. Hashing them here (rather than leaving them only in the
 * re-derivable-but-unverifiable `summary`) is what lets read-time
 * verification actually catch a tampered value, instead of trivially
 * parroting back whatever a corrupted `summary` field already claims.
 */
export interface ResearchUnderlyingResamplingManifestSourceSessionCounts {
  readonly expectedSessions: number;
  readonly unavailableSessions: number;
}

/** Exactly one entry per B-M7.2 research-ready trading date, carrying its three (2m/3m/5m) descriptors -- keyed by `ResampleTargetTimeframe` so `canonicalManifestJson`'s deterministic key-sort orders them without any extra array-sort logic. */
export interface ResearchUnderlyingResamplingManifestSessionEntry {
  readonly tradingDate: string;
  readonly targets: Readonly<Record<ResampleTargetTimeframe, ResearchResampleSessionDescriptor>>;
}

export interface ResearchUnderlyingResamplingManifestTargetSummary {
  readonly sessionCount: number;
  readonly completeSessionCount: number;
  readonly totalOutputCandles: number;
  readonly totalStructuralTrailingRows: number;
  readonly totalCandlesContainingImputation: number;
}

export interface ResearchUnderlyingResamplingManifestSummary {
  readonly expectedSessions: number;
  readonly resolvedSessions: number;
  readonly unavailableSessions: number;
  readonly byTarget: Readonly<Record<ResampleTargetTimeframe, ResearchUnderlyingResamplingManifestTargetSummary>>;
}

/**
 * HIGH-06-style discipline (matches `ResearchUnderlyingDatasetAssemblyV1`'s
 * own doc): NO wall-clock/run-varying field at all -- not even one excluded
 * from the checksum. `summary` is the one exception, fully derivable from
 * `sessions` + `sourceSessionCounts` (both checksummed) and independently
 * re-verified on every read.
 */
export interface ResearchUnderlyingResamplingManifestV1 {
  readonly schemaVersion: number;
  readonly resamplingSemanticsVersion: number;
  readonly sourceAssemblyChecksum: string;
  readonly identity: ResearchUnderlyingResamplingManifestIdentity;
  readonly targetTimeframes: readonly ResampleTargetTimeframe[];
  readonly sourceSessionCounts: ResearchUnderlyingResamplingManifestSourceSessionCounts;
  /** Ascending by `tradingDate` -- deterministic, never DB/filesystem/input-array enumeration order. */
  readonly sessions: readonly ResearchUnderlyingResamplingManifestSessionEntry[];
  readonly summary: ResearchUnderlyingResamplingManifestSummary;
  readonly manifestContentChecksum: string;
}

/** Exactly the content that determines `manifestContentChecksum` -- IDENTITY MATERIAL only. `summary` (fully derivable from `sessions` + `sourceSessionCounts`, re-verified on every read) is the one field deliberately excluded, mirroring `ResearchUnderlyingDatasetAssemblyContentPayload`'s own split. */
export type ResearchUnderlyingResamplingManifestContentPayload = Pick<
  ResearchUnderlyingResamplingManifestV1,
  'schemaVersion' | 'resamplingSemanticsVersion' | 'sourceAssemblyChecksum' | 'identity' | 'targetTimeframes' | 'sourceSessionCounts' | 'sessions'
>;

export function sortResamplingManifestSessions(sessions: readonly ResearchUnderlyingResamplingManifestSessionEntry[]): ResearchUnderlyingResamplingManifestSessionEntry[] {
  return [...sessions].sort((left, right) => (left.tradingDate < right.tradingDate ? -1 : left.tradingDate > right.tradingDate ? 1 : 0));
}

/** Fails closed on two or more entries for the same logical trading date (task item 43) -- never silently deduplicates or picks one, mirroring `assertNoDuplicateTradingDateSelections`. */
export function assertNoDuplicateResamplingManifestDates(sessions: readonly ResearchUnderlyingResamplingManifestSessionEntry[]): void {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.tradingDate)) {
      throw new Error(`B-M7.3 resampling manifest: duplicate trading-date entry for '${session.tradingDate}' -- refusing to silently deduplicate.`);
    }
    seen.add(session.tradingDate);
  }
}

/** Content-addressed manifest checksum (task item 44/48): same content + input array order/wall-clock/machine-path independence discipline as `computeResearchUnderlyingAssemblyChecksum`. `sessions` is sorted before hashing so caller-supplied ordering never perturbs identity. */
export function computeResearchUnderlyingResamplingManifestChecksum(payload: ResearchUnderlyingResamplingManifestContentPayload): string {
  const sorted: ResearchUnderlyingResamplingManifestContentPayload = { ...payload, sessions: sortResamplingManifestSessions(payload.sessions) };
  return sha256Hex(canonicalManifestJson(sorted));
}

function targetSummaryFor(sessions: readonly ResearchUnderlyingResamplingManifestSessionEntry[], target: ResampleTargetTimeframe): ResearchUnderlyingResamplingManifestTargetSummary {
  let completeSessionCount = 0;
  let totalOutputCandles = 0;
  let totalStructuralTrailingRows = 0;
  let totalCandlesContainingImputation = 0;
  for (const session of sessions) {
    const descriptor = session.targets[target];
    if (!descriptor) continue;
    completeSessionCount += 1;
    totalOutputCandles += descriptor.outputCandleCount;
    totalStructuralTrailingRows += descriptor.structuralTrailingRowCount;
    totalCandlesContainingImputation += descriptor.candlesContainingImputation;
  }
  return { sessionCount: sessions.length, completeSessionCount, totalOutputCandles, totalStructuralTrailingRows, totalCandlesContainingImputation };
}

/**
 * The ONE pure summary-derivation function (task: "Use one pure summary
 * derivation function"), used both when BUILDING a manifest and when READING
 * one back -- `summary` can therefore never silently drift from the actual
 * `sessions`/`sourceSessionCounts` between the two (HIGH-05 pattern).
 * `sourceSessionCounts` is passed in explicitly (never re-derived from
 * `sessions` itself, which structurally cannot recover it -- see that
 * field's own doc) so a caller re-verifying a stored manifest supplies the
 * ALREADY CHECKSUM-VERIFIED `sourceSessionCounts` field, never the
 * observability-only `summary` field being verified.
 */
export function deriveResearchUnderlyingResamplingManifestSummary(
  sessions: readonly ResearchUnderlyingResamplingManifestSessionEntry[],
  sourceSessionCounts: ResearchUnderlyingResamplingManifestSourceSessionCounts
): ResearchUnderlyingResamplingManifestSummary {
  const byTarget = {} as Record<ResampleTargetTimeframe, ResearchUnderlyingResamplingManifestTargetSummary>;
  for (const target of RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES) byTarget[target] = targetSummaryFor(sessions, target);
  return { expectedSessions: sourceSessionCounts.expectedSessions, resolvedSessions: sessions.length, unavailableSessions: sourceSessionCounts.unavailableSessions, byTarget };
}

function summariesEqual(left: ResearchUnderlyingResamplingManifestSummary, right: ResearchUnderlyingResamplingManifestSummary): boolean {
  if (left.expectedSessions !== right.expectedSessions || left.resolvedSessions !== right.resolvedSessions || left.unavailableSessions !== right.unavailableSessions) return false;
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

export interface BuildResearchUnderlyingResamplingManifestInput {
  readonly schemaVersion: number;
  readonly resamplingSemanticsVersion: number;
  readonly sourceAssemblyChecksum: string;
  readonly identity: ResearchUnderlyingResamplingManifestIdentity;
  readonly targetTimeframes: readonly ResampleTargetTimeframe[];
  readonly sourceSessionCounts: ResearchUnderlyingResamplingManifestSourceSessionCounts;
  readonly sessions: readonly ResearchUnderlyingResamplingManifestSessionEntry[];
}

export function buildResearchUnderlyingResamplingManifest(input: BuildResearchUnderlyingResamplingManifestInput): ResearchUnderlyingResamplingManifestV1 {
  assertNoDuplicateResamplingManifestDates(input.sessions);
  const sessions = sortResamplingManifestSessions(input.sessions);
  const payload: ResearchUnderlyingResamplingManifestContentPayload = {
    schemaVersion: input.schemaVersion,
    resamplingSemanticsVersion: input.resamplingSemanticsVersion,
    sourceAssemblyChecksum: input.sourceAssemblyChecksum,
    identity: input.identity,
    targetTimeframes: input.targetTimeframes,
    sourceSessionCounts: input.sourceSessionCounts,
    sessions,
  };
  const manifestContentChecksum = computeResearchUnderlyingResamplingManifestChecksum(payload);
  return { ...payload, summary: deriveResearchUnderlyingResamplingManifestSummary(sessions, input.sourceSessionCounts), manifestContentChecksum };
}

export function researchUnderlyingResamplingManifestRelativePath(manifestContentChecksum: string): string {
  return contentAddressedJsonRelativePath(RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_SUBDIR, manifestContentChecksum);
}

/** Idempotent: an existing manifest at the same checksum-derived path is verified, never blindly overwritten (matches `storeResearchUnderlyingDatasetAssembly`'s own contract -- task item 46/47). */
export function storeResearchUnderlyingResamplingManifest(root: string, manifest: ResearchUnderlyingResamplingManifestV1): ContentAddressedJsonStoreResult {
  return storeContentAddressedJson(
    root,
    RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_SUBDIR,
    manifest.manifestContentChecksum,
    manifest,
    (parsed) => computeResearchUnderlyingResamplingManifestChecksum(stripManifestChecksum(parsed))
  );
}

export class ResearchUnderlyingResamplingManifestIntegrityError extends Error {
  constructor(
    readonly manifestContentChecksum: string,
    readonly violations: readonly string[]
  ) {
    super(
      `B-M7.3 resampling manifest at checksum '${manifestContentChecksum}' failed read-time integrity verification: ${violations.join('; ')}. Refusing to trust a stored artifact whose fields no longer match its own recomputed content.`
    );
    this.name = 'ResearchUnderlyingResamplingManifestIntegrityError';
  }
}

/**
 * Mirrors `readResearchUnderlyingDatasetAssembly`'s HIGH-05 read-time
 * re-verification exactly: schema version, full re-hash of identity material
 * (`sourceSessionCounts` included) against the requested content-addressed
 * checksum, no duplicate trading dates, and a freshly re-derived `summary` --
 * using the ALREADY CHECKSUM-VERIFIED `parsed.sourceSessionCounts` as input,
 * never the observability-only `parsed.summary` itself -- matching the
 * stored `summary` field-for-field. Any mismatch throws -- never silently
 * normalized/overwritten.
 */
export function readResearchUnderlyingResamplingManifest(root: string, manifestContentChecksum: string): ResearchUnderlyingResamplingManifestV1 {
  const parsed = readContentAddressedJson<ResearchUnderlyingResamplingManifestV1>(root, RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_STORAGE_SUBDIR, manifestContentChecksum);
  const violations: string[] = [];

  if (parsed.schemaVersion !== RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION) {
    violations.push(`schemaVersion ${parsed.schemaVersion} is not the supported ${RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION}`);
  }

  const recomputedChecksum = computeResearchUnderlyingResamplingManifestChecksum(stripManifestChecksum(parsed));
  if (recomputedChecksum !== manifestContentChecksum || parsed.manifestContentChecksum !== manifestContentChecksum) {
    violations.push(`recomputed manifestContentChecksum '${recomputedChecksum}' (self-declared '${parsed.manifestContentChecksum}') does not match the requested content-addressed checksum '${manifestContentChecksum}'`);
  }

  try {
    assertNoDuplicateResamplingManifestDates(parsed.sessions);
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }

  const recomputedSummary = deriveResearchUnderlyingResamplingManifestSummary(parsed.sessions, parsed.sourceSessionCounts);
  if (!summariesEqual(recomputedSummary, parsed.summary)) {
    violations.push(`stored summary ${JSON.stringify(parsed.summary)} does not match recomputed summary ${JSON.stringify(recomputedSummary)}`);
  }

  if (violations.length > 0) {
    throw new ResearchUnderlyingResamplingManifestIntegrityError(manifestContentChecksum, violations);
  }

  return parsed;
}

function stripManifestChecksum(manifest: ResearchUnderlyingResamplingManifestV1): ResearchUnderlyingResamplingManifestContentPayload {
  return {
    schemaVersion: manifest.schemaVersion,
    resamplingSemanticsVersion: manifest.resamplingSemanticsVersion,
    sourceAssemblyChecksum: manifest.sourceAssemblyChecksum,
    identity: manifest.identity,
    targetTimeframes: manifest.targetTimeframes,
    sourceSessionCounts: manifest.sourceSessionCounts,
    sessions: manifest.sessions,
  };
}
