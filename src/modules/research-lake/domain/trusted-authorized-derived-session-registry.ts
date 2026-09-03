import { ContentAddressedJsonStoreError } from './content-addressed-json-store';
import {
  computeDerivedImputedSessionChecksum,
  DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
  derivedImputedResearchSessionRelativePath,
  DerivedImputedResearchSessionV1,
  readDerivedImputedResearchSession,
  ResearchRowProvenanceKind,
  ResearchSessionSourcePrecedenceTier,
} from './derived-imputed-research-session.types';
import { NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID } from './nifty-index-gap-imputation-authorization';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../services/nifty-underlying-identity';

/**
 * B-M7.2: the ONE explicit, runtime-immutable allowlist of derived research
 * artifacts this milestone may ever treat as an authorized tier-3 overlay
 * candidate. Deliberately NOT a filesystem scan of `derived-imputed-sessions/`
 * (task: "do NOT accept every file in derived-imputed-sessions", "do NOT
 * infer authorization from filename alone") -- a derived artifact for any
 * date/gap not listed here can never make a session research-ready, no
 * matter how structurally valid its own JSON looks.
 *
 * Binds the accepted B-M7.1 authorization identity
 * (`NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID`, imported from the accepted
 * authorization module -- never re-declared) to the EXACT content-addressed
 * artifact the real, independently-reviewed March-7 capture actually
 * produced and committed. The authorization module itself only proves WHICH
 * gap may ever be imputed; it says nothing about WHICH resulting checksum a
 * real capture happened to produce, since that is a fact about one specific
 * captured artifact, not about the authorization rule -- hence this small,
 * separate, explicit registry (task: "may be pinned in a small explicit
 * trusted registry ONLY if necessary to bind this captured artifact to the
 * production assembly").
 *
 * `lookupTrustedAuthorizedDerivedSession` independently RE-VERIFIES every
 * one of these pinned facts against the artifact's own parsed content on
 * every read (content-addressed self-verification) -- this registry is
 * never trusted alone as proof of anything; it only says WHERE to look and
 * WHAT to expect.
 */
export interface TrustedDerivedSessionRegistryEntry {
  readonly authorizationId: string;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  readonly derivedContentChecksum: string;
  readonly sourceSnapshotChecksum: string;
  readonly expectedTotalRowCount: number;
  readonly expectedRealRowCount: number;
  readonly expectedImputedRowCount: number;
}

const TRUSTED_AUTHORIZED_DERIVED_SESSION_REGISTRY: readonly TrustedDerivedSessionRegistryEntry[] = Object.freeze([
  Object.freeze({
    authorizationId: NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID,
    instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
    timeframe: NIFTY_UNDERLYING_TIMEFRAME,
    tradingDate: '2022-03-07',
    derivedContentChecksum: '088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf',
    sourceSnapshotChecksum: 'ed869ef97d6c34d38249c820e36bb01ba4a5e5a7331262ff7c31c83969dea0c1',
    expectedTotalRowCount: 375,
    expectedRealRowCount: 372,
    expectedImputedRowCount: 3,
  }),
]);

export function findTrustedAuthorizedDerivedSessionEntry(instrumentKey: string, timeframe: string, tradingDate: string): TrustedDerivedSessionRegistryEntry | null {
  return TRUSTED_AUTHORIZED_DERIVED_SESSION_REGISTRY.find((entry) => entry.instrumentKey === instrumentKey && entry.timeframe === timeframe && entry.tradingDate === tradingDate) ?? null;
}

export type TrustedDerivedSessionLookupOutcome =
  | { readonly kind: 'NOT_AUTHORIZED' }
  | { readonly kind: 'NOT_YET_CAPTURED'; readonly entry: TrustedDerivedSessionRegistryEntry }
  | { readonly kind: 'AVAILABLE'; readonly entry: TrustedDerivedSessionRegistryEntry; readonly session: DerivedImputedResearchSessionV1; readonly relativePath: string };

/** Thrown when a registry-pinned artifact EXISTS on disk but fails ANY integrity check -- see `lookupTrustedAuthorizedDerivedSession`'s doc for why this must never be downgraded to an ordinary UNAVAILABLE selection. */
export class TrustedDerivedSessionIntegrityError extends Error {
  constructor(
    readonly entry: TrustedDerivedSessionRegistryEntry,
    readonly violations: readonly string[]
  ) {
    super(
      `B-M7.2: the trusted authorized derived artifact for ${entry.instrumentKey}/${entry.timeframe}/${entry.tradingDate} (authorizationId=${entry.authorizationId}, pinned checksum=${entry.derivedContentChecksum}) exists on disk but FAILED integrity verification: ${violations.join('; ')}. Failing the whole assembly closed rather than silently treating a corrupted trusted artifact as merely unavailable.`
    );
    this.name = 'TrustedDerivedSessionIntegrityError';
  }
}

/**
 * B-M7.2 fail-closed lookup + independent re-verification for one trading
 * date's ALLOWLISTED derived artifact (see the registry doc above). Exactly
 * three outcomes:
 *  - `NOT_AUTHORIZED`: no registry entry exists for this exact
 *    instrument/timeframe/tradingDate -- a derived artifact for this date,
 *    however well-formed, was never in scope to begin with.
 *  - `NOT_YET_CAPTURED`: a registry entry exists, but no file exists yet at
 *    its pinned content-addressed path -- the ordinary, expected state
 *    before an operator has run the real B-M7.1 capture. Callers treat this
 *    as UNAVAILABLE for that one session; the assembly still completes.
 *  - `AVAILABLE`: the artifact exists AND every pinned/locked fact below was
 *    independently re-verified against its own parsed content.
 * Anything else -- unparseable JSON, a recomputed checksum mismatch, or ANY
 * field mismatch against the registry's pinned facts -- throws
 * `TrustedDerivedSessionIntegrityError`, which callers must NEVER downgrade
 * to `NOT_YET_CAPTURED`/`UNAVAILABLE`: a trusted artifact that exists but
 * fails integrity is a hard stop for the entire assembly (task: "A trusted
 * authorized source that exists but fails integrity should make assembly
 * FAIL, not silently become ordinary unavailable data").
 *
 * Never regenerates/repairs the derived artifact itself -- purely a
 * READ-side trust boundary.
 */
export function lookupTrustedAuthorizedDerivedSession(root: string, instrumentKey: string, timeframe: string, tradingDate: string): TrustedDerivedSessionLookupOutcome {
  const entry = findTrustedAuthorizedDerivedSessionEntry(instrumentKey, timeframe, tradingDate);
  if (!entry) return { kind: 'NOT_AUTHORIZED' };

  let session: DerivedImputedResearchSessionV1;
  try {
    session = readDerivedImputedResearchSession(root, entry.derivedContentChecksum);
  } catch (error) {
    if (error instanceof ContentAddressedJsonStoreError && error.code === 'CONTENT_NOT_FOUND') {
      return { kind: 'NOT_YET_CAPTURED', entry };
    }
    throw new TrustedDerivedSessionIntegrityError(entry, [`failed to read/parse the trusted artifact: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const violations = validateTrustedDerivedSession(entry, session);
  if (violations.length > 0) {
    throw new TrustedDerivedSessionIntegrityError(entry, violations);
  }

  return { kind: 'AVAILABLE', entry, session, relativePath: derivedImputedResearchSessionRelativePath(entry.derivedContentChecksum) };
}

function validateTrustedDerivedSession(entry: TrustedDerivedSessionRegistryEntry, session: DerivedImputedResearchSessionV1): string[] {
  const violations: string[] = [];
  const { derivedContentChecksum, ...payload } = session;
  const recomputed = computeDerivedImputedSessionChecksum(payload);
  if (recomputed !== entry.derivedContentChecksum) {
    violations.push(`recomputed derivedContentChecksum '${recomputed}' does not match the pinned/self-declared checksum '${entry.derivedContentChecksum}'`);
  }
  if (derivedContentChecksum !== entry.derivedContentChecksum) {
    violations.push(`session.derivedContentChecksum '${derivedContentChecksum}' does not match the pinned checksum '${entry.derivedContentChecksum}'`);
  }
  if (session.schemaVersion !== DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION) {
    violations.push(`schemaVersion ${session.schemaVersion} is not the supported ${DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION}`);
  }
  if (session.identity.instrumentKey !== entry.instrumentKey) violations.push(`identity.instrumentKey '${session.identity.instrumentKey}' !== '${entry.instrumentKey}'`);
  if (session.identity.timeframe !== entry.timeframe) violations.push(`identity.timeframe '${session.identity.timeframe}' !== '${entry.timeframe}'`);
  if (session.identity.tradingDate !== entry.tradingDate) violations.push(`identity.tradingDate '${session.identity.tradingDate}' !== '${entry.tradingDate}'`);
  if (session.authorizationId !== entry.authorizationId) violations.push(`authorizationId '${session.authorizationId}' !== '${entry.authorizationId}'`);
  if (session.precedenceTier !== ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) {
    violations.push(`precedenceTier ${String(session.precedenceTier)} !== AUTHORIZED_DERIVED_IMPUTED_SESSION`);
  }
  if (session.rows.length !== entry.expectedTotalRowCount) violations.push(`rows.length ${session.rows.length} !== expected ${entry.expectedTotalRowCount}`);
  if (session.realRowCount !== entry.expectedRealRowCount) violations.push(`realRowCount ${session.realRowCount} !== expected ${entry.expectedRealRowCount}`);
  if (session.imputedRowCount !== entry.expectedImputedRowCount) violations.push(`imputedRowCount ${session.imputedRowCount} !== expected ${entry.expectedImputedRowCount}`);
  if (session.sourceSnapshotChecksum !== entry.sourceSnapshotChecksum) violations.push(`sourceSnapshotChecksum '${session.sourceSnapshotChecksum}' !== pinned '${entry.sourceSnapshotChecksum}'`);

  const candleTimes = session.rows.map((row) => row.candleTime);
  if (new Set(candleTimes).size !== candleTimes.length) violations.push('duplicate candleTime value(s) among rows');

  const observedRowCount = session.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.OBSERVED).length;
  const imputedRowCount = session.rows.filter((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED).length;
  if (observedRowCount !== session.realRowCount) violations.push(`actual OBSERVED row count ${observedRowCount} !== declared realRowCount ${session.realRowCount}`);
  if (imputedRowCount !== session.imputedRowCount) violations.push(`actual IMPUTED row count ${imputedRowCount} !== declared imputedRowCount ${session.imputedRowCount}`);

  return violations;
}
