import { Prisma } from '@prisma/client';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { SessionWindow } from './exchange-calendar.types';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from './resampled-candle.types';
import { ResolvedResearchRowProvenance } from '../services/research-underlying-1m-session-reader.service';

/**
 * B-M7.3: semantic versioning for the RESEARCH-LAYER provenance-aware
 * resampler -- deliberately SEPARATE from B-F7's `RESAMPLING_SCHEMA_VERSION`/
 * `RESAMPLING_SEMANTICS_VERSION` (`resampled-candle.types.ts`). B-F7's own
 * versions are NEVER bumped by this milestone (task: "leave
 * HistoricalCandleResamplerService public behavior unchanged... DO NOT bump
 * or change RESAMPLING_SEMANTICS_VERSION"). `ResampleTargetTimeframe` /
 * `resampleBucketMinutes` ARE reused as-is from B-F7 (task section 23: only
 * 2m/3m/5m, never an arbitrary N) -- reusing that existing, already fail-
 * closed enum/function is NOT a semantics change, it is the one central
 * "supported target timeframe" definition B-M7.3 also needs.
 */
export const RESEARCH_UNDERLYING_RESAMPLING_SCHEMA_VERSION = 1;
export const RESEARCH_UNDERLYING_RESAMPLING_SEMANTICS_VERSION = 1;

/**
 * Research-layer candle quality classification (task: "explicit research
 * quality/provenance classification"). Deliberately distinguishes a bucket
 * built entirely from B-M7.1 OBSERVED rows (tier 3, no imputation involved)
 * from one that also contains at least one AUTHORIZED IMPUTED constituent --
 * never collapsing DERIVED_OBSERVED into REAL_CANONICAL, and never labeling
 * an observed row inside a derived tier-3 session as ordinary tier-1/2
 * canonical data.
 */
export enum ResearchCandleQuality {
  /** Every constituent 1m row came from a B-M7.2 tier 1/2 REAL_CANONICAL source. */
  REAL_CANONICAL_ONLY = 'REAL_CANONICAL_ONLY',
  /** Source session is tier 3 (AUTHORIZED_DERIVED_IMPUTED_SESSION), and every constituent in this bucket is a B-M7.1 OBSERVED row -- no imputation touched this specific bucket. */
  DERIVED_OBSERVED_ONLY = 'DERIVED_OBSERVED_ONLY',
  /** At least one constituent in this bucket is a B-M7.1 IMPUTED row. */
  CONTAINS_AUTHORIZED_IMPUTATION = 'CONTAINS_AUTHORIZED_IMPUTATION',
}

/**
 * One constituent 1m row's auditable lineage inside a resampled candle (task:
 * "auditable proof of which source minutes formed the candle, which
 * constituent controlled availability, whether any constituent was imputed,
 * and the B-M7.1 imputation authorization/reason/anchor provenance when
 * applicable"). Deliberately carries NO OHLCV value of its own -- the source
 * content checksum already binds every constituent's exact market values
 * (task: "Do NOT duplicate constituent OHLCV values inside lineage"); this
 * entry exists purely to bind `candleTime` + `availableAt` + the EXACT
 * `ResolvedResearchRowProvenance` (including, for an IMPUTED row, the full
 * B-M7.1 `ImputedRowProvenance` -- method/policyVersion/authorizationId/
 * reason/leftAnchor/rightAnchor -- preserved verbatim, never summarized away).
 */
export interface ResearchCandleConstituentLineageEntry {
  readonly candleTime: string; // ISO 8601 UTC
  readonly availableAt: string; // ISO 8601 UTC
  readonly provenance: ResolvedResearchRowProvenance;
}

/**
 * One B-M7.3 provenance-aware research candle. Deliberately a SEPARATE type
 * from B-F7's `ResampledCandle` (`resampled-candle.types.ts`) -- never
 * reinterprets that canonical contract to mean something new (task: "Do NOT
 * change the existing canonical ResampledCandle contract"). `availableAt` is
 * the CRITICAL no-lookahead field: `MAX(every constituent's own availableAt)`
 * -- NEVER `bucketEnd + 1 minute` unless that happens to be the max naturally
 * (see `ResearchUnderlyingResamplerService.aggregateBucket`). OHLC are exact
 * `Prisma.Decimal`, volume is exact `bigint`, `openInterest` is the FINAL
 * constituent's own value (never summed/averaged/forward-filled) -- identical
 * aggregation formulas to B-F7, just applied over research-resolved rows.
 */
export interface ResearchResampledCandle {
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly availableAt: Date;
  readonly open: Prisma.Decimal;
  readonly high: Prisma.Decimal;
  readonly low: Prisma.Decimal;
  readonly close: Prisma.Decimal;
  readonly volume: bigint;
  readonly openInterest: bigint | null;
  readonly quality: ResearchCandleQuality;
  /** Ascending by `candleTime`, exactly `targetTimeframeMinutes` entries (task: "a small constituent-lineage array, max 2/3/5 entries"). */
  readonly constituents: readonly ResearchCandleConstituentLineageEntry[];
}

/** Hashable, string-normalized form of `ResearchResampledCandle` -- the SAME decimal/bigint-to-string normalization convention `resampledCandleToManifestContent`/`ManifestCandleContent` already use, so `canonicalManifestJson` never has to special-case this shape. */
export interface ResearchResampledCandleContent {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly availableAt: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly openInterest: string | null;
  readonly quality: ResearchCandleQuality;
  readonly constituents: readonly ResearchCandleConstituentLineageEntry[];
}

export function researchResampledCandleToContent(candle: ResearchResampledCandle): ResearchResampledCandleContent {
  return {
    bucketStart: candle.bucketStart.toISOString(),
    bucketEnd: candle.bucketEnd.toISOString(),
    availableAt: candle.availableAt.toISOString(),
    open: candle.open.toString(),
    high: candle.high.toString(),
    low: candle.low.toString(),
    close: candle.close.toString(),
    volume: candle.volume.toString(),
    openInterest: candle.openInterest === null ? null : candle.openInterest.toString(),
    quality: candle.quality,
    constituents: candle.constituents,
  };
}

export function sortResearchResampledCandleContents(candles: readonly ResearchResampledCandleContent[]): ResearchResampledCandleContent[] {
  return [...candles].sort((left, right) => (left.bucketStart < right.bucketStart ? -1 : left.bucketStart > right.bucketStart ? 1 : 0));
}

/** Only value B-M7.3 ever produces -- a session with any missing expected minute FAILS CLOSED (throws) rather than ever being represented as an incomplete-but-returned research session (unlike B-F7's `ResampleSessionStatus.INCOMPLETE_SOURCE_SESSION`, which B-M7.3 deliberately has no equivalent of -- see `ResearchUnderlyingResamplerService`'s own doc). Kept as an explicit enum (rather than a bare literal) for parity with B-F7's status field and to leave room for a future, deliberately-added status value without a shape change. */
export enum ResearchResampleSessionStatus {
  COMPLETE_RESEARCH_SESSION = 'COMPLETE_RESEARCH_SESSION',
}

/**
 * Small, read-only per-session-per-target B-M7.3 descriptor (task: "Create a
 * deterministic per-session per-target descriptor"). Never carries candle
 * payloads in the YEAR MANIFEST that embeds this shape (see
 * `research-underlying-resampling-manifest.types.ts`) -- candles themselves
 * are re-derived on demand via `ResearchUnderlyingResampledSessionReaderService`.
 */
export interface ResearchResampleSessionDescriptor {
  readonly researchResamplingSchemaVersion: number;
  readonly researchResamplingSemanticsVersion: number;
  readonly sourceAssemblyChecksum: string;
  readonly tradingDate: string;
  readonly sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier;
  readonly sourceContentChecksum: string;
  readonly targetTimeframe: ResampleTargetTimeframe;
  readonly sessionWindows: readonly SessionWindow[];
  readonly sourceRowCount: number;
  readonly expectedSourceMinuteCount: number;
  readonly outputCandleCount: number;
  /** Source rows that fall in a declared window's legitimate trailing remainder (task: "structural trailing remainder is NOT missing data") -- never fabricated as a candle, never bridged. */
  readonly structuralTrailingRowCount: number;
  /** Always `0` in a returned descriptor -- any nonzero count fails closed BEFORE a descriptor is ever built (see `ResearchUnderlyingResamplerService.resampleSession`). Kept as an explicit field (rather than omitted) so a manifest reader can assert it, matching the task's descriptor field list exactly. */
  readonly missingSourceMinuteCount: number;
  readonly realCanonicalConstituentRowCount: number;
  readonly derivedObservedConstituentRowCount: number;
  readonly derivedImputedConstituentRowCount: number;
  readonly candlesContainingImputation: number;
  readonly researchDerivedContentChecksum: string;
  readonly status: ResearchResampleSessionStatus;
}

/** Exactly the content that determines a research session's `researchDerivedContentChecksum` -- IDENTITY MATERIAL only, mirroring B-F7's `DerivedSessionIdentity`/`DerivedContentPayload` split but with research-layer identity fields (task: "sourceAssemblyChecksum / tradingDate / sourcePrecedenceTier / sourceContentChecksum / targetTimeframe / researchResamplingSemanticsVersion / sessionWindows"). */
export interface ResearchDerivedIdentity {
  readonly sourceAssemblyChecksum: string;
  readonly tradingDate: string;
  readonly sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier;
  readonly sourceContentChecksum: string;
  readonly targetTimeframe: ResampleTargetTimeframe;
  readonly researchResamplingSemanticsVersion: number;
  readonly sessionWindows: readonly SessionWindow[];
}

export interface ResearchDerivedContentPayload {
  readonly identity: ResearchDerivedIdentity;
  /** Sorted ascending by `bucketStart` before hashing -- see `computeResearchDerivedContentChecksum`. */
  readonly candles: readonly ResearchResampledCandleContent[];
}

/**
 * B-M7.3's OWN content-addressed checksum -- deliberately NOT B-F7's
 * `computeDerivedContentChecksum` (task: "Do NOT use B-F7
 * computeDerivedContentChecksum unchanged because its identity assumes
 * canonical source-session semantics and its candle hash intentionally does
 * not include delayed availableAt/provenance"). Every output candle's
 * `availableAt`, `quality` classification, and full constituent lineage
 * (including B-M7.1 imputation authorization/reason/anchor provenance) are
 * hashed -- so changing ONLY `availableAt`, or ONLY provenance/imputation
 * lineage, with identical OHLCV, MUST change this checksum. `sessionWindows`
 * and `sourceAssemblyChecksum` are also identity material -- a different
 * calendar declaration or a different upstream B-M7.2 selection can never
 * silently collide with this checksum. Reuses the SAME `canonicalManifestJson`/
 * `sha256Hex` primitive every other Research Lake checksum uses -- never a
 * competing canonicalizer. No `generatedAt`/UUID/machine path ever enters
 * this payload.
 */
export function computeResearchDerivedContentChecksum(payload: ResearchDerivedContentPayload): string {
  const sorted: ResearchDerivedContentPayload = { ...payload, candles: sortResearchResampledCandleContents(payload.candles) };
  return sha256Hex(canonicalManifestJson(sorted));
}
