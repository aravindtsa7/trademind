import { canonicalManifestJson } from '../domain/dataset-manifest-canonical-json';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { ResearchSessionSourceSelection } from '../domain/research-session-source-selection';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { ResearchResampledCandle, ResearchResampleSessionDescriptor } from '../domain/research-underlying-resampled-candle.types';
import {
  collectResearchUnderlyingAssemblySelfConsistencyViolations,
  ResearchUnderlyingAssemblyIntegrityError,
  ResearchUnderlyingDatasetAssemblyV1,
} from '../domain/research-underlying-assembly.types';
import { ResearchUnderlyingResamplingManifestV1 } from '../domain/research-underlying-resampling-manifest.types';
import ResearchUnderlying1mSessionReaderService from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResamplerService from './research-underlying-resampler.service';
import { SessionRowsResolver, SessionResampler } from './research-underlying-resampling-manifest-builder.service';

export interface ResearchUnderlyingResampledSessionReaderServiceDependencies {
  readonly sessionRowsResolver?: SessionRowsResolver;
  readonly sessionResampler?: SessionResampler;
}

export interface ReadResampledSessionRequest {
  readonly manifest: ResearchUnderlyingResamplingManifestV1;
  /** The exact B-M7.2 assembly `manifest.sourceAssemblyChecksum` was built from -- caller-supplied (never re-read from disk here by manifest identifier alone) so a caller that already holds/verified the assembly never pays a second read/verify cost. NEVER trusted merely because it arrived as an argument -- see `ResearchUnderlyingAssemblyIntegrityError`/`ResearchUnderlyingResampledSessionSourceAssemblyBindingError` below (B-M7.3-HIGH-01). */
  readonly sourceAssembly: ResearchUnderlyingDatasetAssemblyV1;
  readonly tradingDate: string;
  readonly targetTimeframe: ResampleTargetTimeframe;
}

export interface ReadResampledSessionResult {
  readonly candles: readonly ResearchResampledCandle[];
  readonly descriptor: ResearchResampleSessionDescriptor;
}

export class ResearchUnderlyingResampledSessionNotFoundError extends Error {
  constructor(tradingDate: string, targetTimeframe: ResampleTargetTimeframe) {
    super(`ResearchUnderlyingResampledSessionReaderService: no recorded B-M7.3 descriptor for tradingDate '${tradingDate}' / target '${targetTimeframe}' in the supplied manifest.`);
    this.name = 'ResearchUnderlyingResampledSessionNotFoundError';
  }
}

/**
 * B-M7.3-HIGH-01: thrown when the caller-supplied `sourceAssembly`'s
 * self-declared `assemblyContentChecksum` does not agree with either the
 * B-M7.3 `manifest`'s own `sourceAssemblyChecksum` declaration or the
 * looked-up descriptor's own `sourceAssemblyChecksum` field. This is the
 * core Terra HIGH-01 fix: without this check, a caller could supply ANY
 * `ResearchUnderlyingDatasetAssemblyV1` object (e.g. one cloned with
 * `assemblyContentChecksum` overwritten to 64 zeroes) and the reader would
 * still happily resolve rows and return candles against it.
 */
export class ResearchUnderlyingResampledSessionSourceAssemblyBindingError extends Error {
  constructor(reason: string) {
    super(`ResearchUnderlyingResampledSessionReaderService: source-assembly identity binding failed -- ${reason}. Refusing to resolve rows against an unbound/mismatched B-M7.2 source assembly.`);
    this.name = 'ResearchUnderlyingResampledSessionSourceAssemblyBindingError';
  }
}

/**
 * B-M7.3-HIGH-01: thrown when the recorded B-M7.3 descriptor does not
 * correspond to the EXACT B-M7.2 selected session for the requested
 * `tradingDate` in the supplied (already self-consistency-verified)
 * `sourceAssembly` -- a missing/UNAVAILABLE selection, a
 * `sourcePrecedenceTier` mismatch, or a `sourceContentChecksum` mismatch
 * against the selection's own `canonicalContentChecksum` (tier 1/2) or
 * `derivedContentChecksum` (tier 3). Never trusted merely because the
 * B-M7.3 manifest itself has a self-consistent checksum -- this proves the
 * descriptor still corresponds to the exact supplied B-M7.2 source
 * selection, not just to itself.
 */
export class ResearchUnderlyingResampledSessionSourceSelectionMismatchError extends Error {
  constructor(tradingDate: string, reason: string) {
    super(`ResearchUnderlyingResampledSessionReaderService: tradingDate '${tradingDate}' -- ${reason}. Refusing to resolve rows for a descriptor that does not correspond to the exact supplied B-M7.2 selected session.`);
    this.name = 'ResearchUnderlyingResampledSessionSourceSelectionMismatchError';
  }
}

export class ResearchUnderlyingResampledSessionVerificationError extends Error {
  constructor(tradingDate: string, targetTimeframe: ResampleTargetTimeframe, recorded: string, recomputed: string) {
    super(
      `ResearchUnderlyingResampledSessionReaderService: re-derived researchDerivedContentChecksum '${recomputed}' for tradingDate '${tradingDate}' / target '${targetTimeframe}' does not match the manifest's recorded checksum '${recorded}' -- refusing to return unverified/drifted candles.`
    );
    this.name = 'ResearchUnderlyingResampledSessionVerificationError';
  }
}

/**
 * B-M7.3-HIGH-02 CORRECTION: thrown when the recomputed descriptor differs
 * from the manifest's recorded descriptor in ANY top-level field -- proven
 * via FULL, EXHAUSTIVE structural equality (see `descriptorsStructurallyEqual`
 * below), never a manually-maintained partial field list. The prior
 * implementation (`MATERIAL_DESCRIPTOR_FIELDS`, a hand-picked array of
 * `keyof ResearchResampleSessionDescriptor`) omitted
 * `researchResamplingSemanticsVersion` -- Terra's adversarial probe changed
 * ONLY that field (1 -> 999) while leaving `researchDerivedContentChecksum`
 * untouched, and the reader still accepted it. A hand-maintained list can
 * ALWAYS silently omit a future field the same way; full structural equality
 * cannot, because it is derived from the actual object's own keys at
 * comparison time, not from a list a developer must remember to update.
 *
 * `researchDerivedContentChecksum` itself is still checked FIRST, separately,
 * via `ResearchUnderlyingResampledSessionVerificationError` (unchanged, more
 * specific error for the case where the underlying CANDLE content itself
 * diverged). This check runs strictly after that one passes, so it is
 * reached only when the checksum already matches but some other field --
 * `researchResamplingSemanticsVersion`, `outputCandleCount`,
 * `candlesContainingImputation`, `status`, or any other current or future
 * descriptor field -- still disagrees.
 */
export class ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError extends Error {
  constructor(tradingDate: string, targetTimeframe: ResampleTargetTimeframe, reason: string) {
    super(
      `ResearchUnderlyingResampledSessionReaderService: recomputed descriptor for tradingDate '${tradingDate}' / target '${targetTimeframe}' materially disagrees with the manifest's recorded descriptor -- ${reason}. The candle checksum matched, but this field did not; refusing to return a result whose recorded descriptor cannot be trusted.`
    );
    this.name = 'ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError';
  }
}

/**
 * Full, exhaustive structural equality over EVERY top-level field of
 * `ResearchResampleSessionDescriptor` (task: "prefer full deterministic
 * descriptor equality rather than maintaining a manually incomplete field
 * list"). Every field on this type is a plain, deterministic, JSON-safe
 * value -- number, string, a numeric/string enum, or a nested plain
 * array/object of such (`sessionWindows: readonly SessionWindow[]`) -- there
 * is no `Date`/`bigint`/`Prisma.Decimal` and, deliberately, no
 * `generatedAt`/random-UUID/machine-path field anywhere on this type (see
 * `ResearchResampleSessionDescriptor`'s own doc: it carries no candle
 * payload, only stable identity/count/status material). Reuses the SAME
 * `canonicalManifestJson` primitive every other Research Lake checksum/
 * comparison in this codebase uses -- never a competing canonicalizer --
 * which is REQUIRED here (not merely convenient): a naive per-field `!==`
 * loop would silently misclassify `sessionWindows` as "always different"
 * (two structurally-identical arrays are never the same JS reference), so a
 * shallow comparison cannot safely cover every field the way this function
 * does. Field order in either object never matters -- `canonicalManifestJson`
 * sorts object keys deterministically.
 */
function descriptorsStructurallyEqual(recorded: ResearchResampleSessionDescriptor, recomputed: ResearchResampleSessionDescriptor): boolean {
  return canonicalManifestJson(recorded) === canonicalManifestJson(recomputed);
}

/** Best-effort, human-readable per-field diff for the error message only -- NEVER the actual pass/fail gate (`descriptorsStructurallyEqual` above is). Derived from `Object.keys(recorded)` (the object's own actual keys at runtime), so this diagnostic itself can never silently exclude a field the way a hand-maintained list could -- it only ever affects the error TEXT, not whether the mismatch is detected. */
function describeDescriptorMismatch(recorded: ResearchResampleSessionDescriptor, recomputed: ResearchResampleSessionDescriptor): string {
  const fields = Object.keys(recorded) as (keyof ResearchResampleSessionDescriptor)[];
  const differences: string[] = [];
  for (const field of fields) {
    const recordedValue = canonicalManifestJson(recorded[field]);
    const recomputedValue = canonicalManifestJson(recomputed[field]);
    if (recordedValue !== recomputedValue) {
      differences.push(`'${field}': recorded=${recordedValue} recomputed=${recomputedValue}`);
    }
  }
  return differences.length > 0 ? differences.join('; ') : 'the full recorded descriptor JSON differs from the recomputed descriptor JSON';
}

/** Fails closed for a tier-4 (UNAVAILABLE) selected source -- never resampleable (mirrors `ResearchUnderlyingResamplerUnresampleableTierError`'s own tier-4 rejection, at the read-verification boundary instead of the resampler boundary). */
function expectedSourceContentChecksumFor(selection: Exclude<ResearchSessionSourceSelection, { precedenceTier: ResearchSessionSourcePrecedenceTier.UNAVAILABLE }>): string {
  switch (selection.precedenceTier) {
    case ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION:
    case ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION:
      return selection.canonicalContentChecksum;
    case ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION:
      return selection.derivedContentChecksum;
    default: {
      const exhaustive: never = selection;
      throw new Error(`Unhandled ResearchSessionSourceSelection: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * B-M7.3: the typed, VERIFIED future-consumer read boundary (task: "future
 * research/replay consume the exact B-M7.3 dataset identity"). Never scans
 * artifact directories, never re-runs source precedence, never falls back to
 * current unverified rows.
 *
 * B-M7.3-HIGH-01 CORRECTION: the boundary now strongly binds the recorded
 * descriptor to BOTH the supplied B-M7.2 `sourceAssembly` object's own
 * verified identity AND its exact selected session for `tradingDate`,
 * BEFORE any 1m row resolution is ever attempted:
 *
 *  1. find the recorded descriptor for `tradingDate`/`targetTimeframe` in
 *     the supplied `manifest` -- exactly one match required (no fallback,
 *     no silent first-match on an ambiguous/duplicate manifest), and its
 *     own `tradingDate`/`targetTimeframe` fields must agree with what was
 *     requested.
 *  2. verify the supplied `sourceAssembly` object's OWN semantic
 *     self-consistency (`collectResearchUnderlyingAssemblySelfConsistencyViolations`
 *     -- the SAME B-M7.2 integrity semantics `readResearchUnderlyingDatasetAssembly`
 *     already enforces, reused rather than reimplemented) -- never merely
 *     trusting its self-declared `assemblyContentChecksum` field.
 *  3. verify `manifest.sourceAssemblyChecksum === sourceAssembly.assemblyContentChecksum`.
 *  4. verify `descriptor.sourceAssemblyChecksum === sourceAssembly.assemblyContentChecksum`.
 *     (and, transitively/defensively, `manifest.sourceAssemblyChecksum === descriptor.sourceAssemblyChecksum`.)
 *  5. locate the EXACT B-M7.2 selected session for `tradingDate` in the
 *     now-trusted `sourceAssembly.sessions` -- never a fresh selection, never
 *     tier 4 (UNAVAILABLE).
 *  6. verify `descriptor.sourcePrecedenceTier === selectedSession.precedenceTier`.
 *  7. derive the expected B-M7.2 source content checksum from the selected
 *     session's own tier (tier 1/2 -> `canonicalContentChecksum`, tier 3 ->
 *     `derivedContentChecksum`).
 *  8. verify `descriptor.sourceContentChecksum` equals that expected value.
 *  9. ONLY NOW resolve exact 1m rows via `ResearchUnderlying1mSessionReaderService`.
 * 10. run the provenance-aware B-M7.3 resampler.
 * 11. recompute `researchDerivedContentChecksum` and require EXACT equality
 *     with the recorded descriptor's own checksum, AND (B-M7.3-HIGH-02)
 *     require the ENTIRE recomputed descriptor to be structurally identical
 *     to the recorded one -- full, exhaustive equality over every top-level
 *     field, never a manually-maintained partial field list (see
 *     `descriptorsStructurallyEqual`'s own doc for why a hand-picked list
 *     previously omitted `researchResamplingSemanticsVersion`).
 * 12. return the exact resampled candles ONLY after every check above
 *     passes.
 */
export default class ResearchUnderlyingResampledSessionReaderService {
  private readonly sessionRowsResolver: SessionRowsResolver;
  private readonly sessionResampler: SessionResampler;

  constructor(dependencies: ResearchUnderlyingResampledSessionReaderServiceDependencies = {}) {
    this.sessionRowsResolver = dependencies.sessionRowsResolver ?? new ResearchUnderlying1mSessionReaderService();
    this.sessionResampler = dependencies.sessionResampler ?? new ResearchUnderlyingResamplerService();
  }

  async readResampledSession(request: ReadResampledSessionRequest): Promise<ReadResampledSessionResult> {
    const { manifest, sourceAssembly, tradingDate, targetTimeframe } = request;

    // ---- 1. locate the recorded descriptor -- exact date/target match only, no fallback, ambiguity fails closed. ----
    const matchingSessionEntries = manifest.sessions.filter((session) => session.tradingDate === tradingDate);
    if (matchingSessionEntries.length > 1) {
      throw new ResearchUnderlyingResampledSessionNotFoundError(tradingDate, targetTimeframe);
    }
    const descriptor = matchingSessionEntries[0]?.targets[targetTimeframe];
    if (!descriptor || descriptor.tradingDate !== tradingDate || descriptor.targetTimeframe !== targetTimeframe) {
      throw new ResearchUnderlyingResampledSessionNotFoundError(tradingDate, targetTimeframe);
    }

    // ---- 2. the supplied source assembly OBJECT must be internally self-consistent -- never trusted merely because it arrived as an argument. ----
    const assemblyViolations = collectResearchUnderlyingAssemblySelfConsistencyViolations(sourceAssembly);
    if (assemblyViolations.length > 0) {
      throw new ResearchUnderlyingAssemblyIntegrityError(sourceAssembly.assemblyContentChecksum, assemblyViolations);
    }

    // ---- 3/4. bind manifest <-> sourceAssembly <-> descriptor identity -- BEFORE any row resolution. ----
    if (manifest.sourceAssemblyChecksum !== sourceAssembly.assemblyContentChecksum) {
      throw new ResearchUnderlyingResampledSessionSourceAssemblyBindingError(
        `manifest.sourceAssemblyChecksum '${manifest.sourceAssemblyChecksum}' !== supplied sourceAssembly.assemblyContentChecksum '${sourceAssembly.assemblyContentChecksum}'`
      );
    }
    if (descriptor.sourceAssemblyChecksum !== sourceAssembly.assemblyContentChecksum) {
      throw new ResearchUnderlyingResampledSessionSourceAssemblyBindingError(
        `descriptor.sourceAssemblyChecksum '${descriptor.sourceAssemblyChecksum}' !== supplied sourceAssembly.assemblyContentChecksum '${sourceAssembly.assemblyContentChecksum}'`
      );
    }
    if (manifest.sourceAssemblyChecksum !== descriptor.sourceAssemblyChecksum) {
      throw new ResearchUnderlyingResampledSessionSourceAssemblyBindingError(
        `manifest.sourceAssemblyChecksum '${manifest.sourceAssemblyChecksum}' !== descriptor.sourceAssemblyChecksum '${descriptor.sourceAssemblyChecksum}'`
      );
    }

    // ---- 5. locate the exact B-M7.2 selected session -- never a fresh selection, never tier 4. ----
    const selection = sourceAssembly.sessions.find((session) => session.tradingDate === tradingDate);
    if (!selection || selection.precedenceTier === ResearchSessionSourcePrecedenceTier.UNAVAILABLE) {
      throw new ResearchUnderlyingResampledSessionSourceSelectionMismatchError(tradingDate, 'no resampleable (non-UNAVAILABLE) B-M7.2 selection exists for this tradingDate in the supplied source assembly');
    }

    // ---- 6/7/8. the descriptor must correspond to THIS exact selection, not merely to itself. ----
    if (descriptor.sourcePrecedenceTier !== selection.precedenceTier) {
      throw new ResearchUnderlyingResampledSessionSourceSelectionMismatchError(
        tradingDate,
        `descriptor.sourcePrecedenceTier '${String(descriptor.sourcePrecedenceTier)}' !== selected B-M7.2 session precedenceTier '${String(selection.precedenceTier)}'`
      );
    }
    const expectedSourceContentChecksum = expectedSourceContentChecksumFor(selection);
    if (descriptor.sourceContentChecksum !== expectedSourceContentChecksum) {
      throw new ResearchUnderlyingResampledSessionSourceSelectionMismatchError(
        tradingDate,
        `descriptor.sourceContentChecksum '${descriptor.sourceContentChecksum}' !== the selected B-M7.2 session's expected source content checksum '${expectedSourceContentChecksum}'`
      );
    }

    // ---- 9. ONLY NOW resolve 1m rows. ----
    const resolved = await this.sessionRowsResolver.resolveSessionRows(sourceAssembly.identity.instrumentKey, sourceAssembly.identity.timeframe, selection);
    if (resolved.kind !== 'RESOLVED') {
      throw new Error(`ResearchUnderlyingResampledSessionReaderService: the B-M7.2 1m reader returned UNAVAILABLE for tradingDate '${tradingDate}'.`);
    }

    // ---- 10. re-run the resampler. ----
    const { candles, descriptor: recomputedDescriptor } = this.sessionResampler.resampleSession({
      sourceAssemblyChecksum: descriptor.sourceAssemblyChecksum,
      tradingDate,
      sourcePrecedenceTier: descriptor.sourcePrecedenceTier,
      sourceContentChecksum: descriptor.sourceContentChecksum,
      targetTimeframe,
      sessionWindows: descriptor.sessionWindows,
      sourceRows: resolved.rows,
    });

    // ---- 11. verify checksum AND the ENTIRE descriptor, exhaustively. ----
    if (recomputedDescriptor.researchDerivedContentChecksum !== descriptor.researchDerivedContentChecksum) {
      throw new ResearchUnderlyingResampledSessionVerificationError(tradingDate, targetTimeframe, descriptor.researchDerivedContentChecksum, recomputedDescriptor.researchDerivedContentChecksum);
    }
    if (!descriptorsStructurallyEqual(descriptor, recomputedDescriptor)) {
      throw new ResearchUnderlyingResampledSessionDescriptorMaterialMismatchError(tradingDate, targetTimeframe, describeDescriptorMismatch(descriptor, recomputedDescriptor));
    }

    // ---- 12. return candles. ----
    return { candles, descriptor: recomputedDescriptor };
  }
}
