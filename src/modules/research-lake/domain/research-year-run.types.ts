import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';

/**
 * Envelope/schema version for `ResearchYearRunPlan`/`ResearchYearRunRecord`
 * JSON shapes themselves. Deliberately NOT part of `planSemanticIdentity` --
 * mirrors `MANIFEST_SCHEMA_VERSION`'s role for `DatasetManifest` (B-F5).
 */
export const RESEARCH_YEAR_RUN_SCHEMA_VERSION = 1;

/**
 * Semantic version of B-F8's OWN plan-construction rules (stage set, stage
 * order, trading-date derivation, contract ordering). Part of
 * `planSemanticIdentity` for the same reason `CANONICALIZATION_SEMANTICS_VERSION`
 * is part of a B-F5 checksum: a future change to these rules must never
 * silently compare equal to a plan produced under the old rules.
 */
export const RESEARCH_YEAR_RUN_SEMANTICS_VERSION = 1;

export enum ResearchYearRunScope {
  UNDERLYING = 'UNDERLYING',
  OPTIONS = 'OPTIONS',
  ALL = 'ALL',
}

/**
 * Fixed B-F8 stage taxonomy. `OPTION_CATALOG_ACQUISITION` always precedes
 * `OPTION_CANDLE_ACQUISITION` (task section 6: catalog before candles);
 * `*_MATERIALIZATION` (B-F5 manifest + B-F6 Parquet + B-F7 resample) always
 * follows its corresponding acquisition stage.
 */
export enum ResearchYearRunStageKind {
  UNDERLYING_ACQUISITION = 'UNDERLYING_ACQUISITION',
  UNDERLYING_MATERIALIZATION = 'UNDERLYING_MATERIALIZATION',
  OPTION_CATALOG_ACQUISITION = 'OPTION_CATALOG_ACQUISITION',
  OPTION_CANDLE_ACQUISITION = 'OPTION_CANDLE_ACQUISITION',
  OPTION_MATERIALIZATION = 'OPTION_MATERIALIZATION',
}

/** Fixed, never input/provider/filesystem-derived stage order (task section 4/9.H). */
export const RESEARCH_YEAR_RUN_STAGE_ORDER: readonly ResearchYearRunStageKind[] = [
  ResearchYearRunStageKind.UNDERLYING_ACQUISITION,
  ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION,
  ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION,
  ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION,
  ResearchYearRunStageKind.OPTION_MATERIALIZATION,
];

export enum ResearchYearRunStageStatus {
  /** Plan-only: this stage has not executed yet (dry-run, or not yet reached this run). */
  PLANNED = 'PLANNED',
  /** This stage's stage kind is not applicable to the requested `scope`. */
  SKIPPED_NOT_IN_SCOPE = 'SKIPPED_NOT_IN_SCOPE',
  /** In scope, but a required upstream capability is missing (task section 7) -- never silently worked around. */
  BLOCKED = 'BLOCKED',
  /** Every required work item in this stage succeeded and was verified. */
  COMPLETED = 'COMPLETED',
  /** At least one required work item failed at the session/provider level (recoverable), but the stage otherwise executed. */
  INCOMPLETE = 'INCOMPLETE',
  /** An invariant/identity/checksum violation was detected -- fails closed (task section 14). */
  FAILED = 'FAILED',
}

export enum ResearchYearRunOutcome {
  COMPLETE = 'COMPLETE',
  INCOMPLETE = 'INCOMPLETE',
  FAILED = 'FAILED',
}

/**
 * Stable, deterministic reason code for why an in-scope plan stage is
 * `blocked`. Deliberately separate from the free-text `blockedReason`
 * diagnostic (task correction section 2): an exception's `.message` can
 * legitimately vary run-to-run for a SEMANTICALLY IDENTICAL block condition
 * (timestamps, OS paths, provider diagnostic detail) -- hashing that text
 * into `planSemanticIdentity` would make two otherwise-identical requests
 * produce different identities purely because of diagnostic wording. Only
 * this stable code is ever part of plan identity; `blockedReason` is
 * observability-only.
 */
export enum ResearchYearRunPlanBlockedCode {
  /** No `RequiredOptionSessionSource` is configured/resolvable (task section 7) -- the only blocked condition B-F8 currently produces. */
  REQUIRED_OPTION_SESSION_SOURCE_UNAVAILABLE = 'REQUIRED_OPTION_SESSION_SOURCE_UNAVAILABLE',
}

/** Caller-facing B-F8 year/date-range run request. */
export interface ResearchYearRunRequest {
  readonly year: number;
  /** Must belong to `year` when supplied (task section 3). */
  readonly fromDate?: string;
  /** Must belong to `year` and be >= `fromDate` when supplied. Required (no implicit "today") for the current calendar year (task section 3/18). */
  readonly toDate?: string;
  readonly scope: ResearchYearRunScope;
  /** True dry-run/plan-only: zero provider/repository/storage/checkpoint side effects (task section 16). */
  readonly dryRun?: boolean;
}

export interface ResolvedResearchYearRunRange {
  readonly year: number;
  readonly fromDate: string;
  readonly toDate: string;
}

/**
 * One NIFTY option contract this year run must acquire candles for, plus
 * the exact trading dates required for it. `providerContractId` is the
 * SAME Groww symbol identity `GrowwOptionCandleAcquisitionService` and
 * `HistoricalOptionCandleLakeRepository` already key on -- B-F8 never
 * invents a parallel identity scheme.
 */
export interface RequiredOptionSession {
  readonly providerContractId: string;
  /** Non-empty, deduplicated; sorted by the plan builder before it becomes part of plan identity (task section 9.J). */
  readonly tradingDates: readonly string[];
}

/**
 * Injectable source of "the existing B-F3/B-F4 strategy-universe definition"
 * (task section 7). B-F8 NEVER derives ATM/moneyness/expiry-selection rules
 * itself -- it only ever consumes whatever an already-existing, already-
 * authoritative source of required option sessions supplies. When no such
 * source is wired in, `UnavailableRequiredOptionSessionSource` is used,
 * which fails closed with a typed, descriptive error rather than silently
 * downloading a full option chain or inventing a selection rule.
 */
export interface RequiredOptionSessionSource {
  resolve(range: ResolvedResearchYearRunRange): Promise<readonly RequiredOptionSession[]>;
}

/**
 * One B-F8 plan stage entry. A discriminated shape keyed by `stageKind`;
 * every field is either wholly absent (stage kind does not use it) or
 * populated -- never a stage-specific implicit convention encoded only in
 * comments.
 */
export interface ResearchYearRunPlanStage {
  readonly stageKind: ResearchYearRunStageKind;
  readonly inScope: boolean;
  /**
   * Deterministic ascending Mon-Fri CANDIDATE dates within `[fromDate,
   * toDate]` -- present only for `UNDERLYING_ACQUISITION`/
   * `UNDERLYING_MATERIALIZATION`. Deliberately named "candidate", not
   * "trading": these are acquisition candidates only, never yet certified
   * as actual completed trading sessions (task correction section 3/3A) --
   * a genuine NSE holiday is a legitimate, expected member of this list,
   * and B-F8 never invents a holiday calendar to filter it out here. Never
   * filtered by provider/DB state (that is a RUN-time concern, not a
   * PLAN-time one).
   */
  readonly underlyingCandidateDates: readonly string[] | null;
  /** Present only for `OPTION_CANDLE_ACQUISITION`/`OPTION_MATERIALIZATION`, and only when a `RequiredOptionSessionSource` was configured and resolved successfully. Sorted deterministically (expiry ascending, strike ascending, CE before PE, providerContractId tie-break) regardless of source order (task section 9.J). */
  readonly requiredOptionSessions: readonly RequiredOptionSession[] | null;
  /** True when this in-scope stage cannot proceed because a required upstream capability is missing (task section 7) -- e.g. no `RequiredOptionSessionSource` configured. Always `false` when `inScope` is `false`. */
  readonly blocked: boolean;
  /** Stable, part of `planSemanticIdentity`. `null` iff `blocked` is `false`. */
  readonly blockedCode: ResearchYearRunPlanBlockedCode | null;
  /** Free-text diagnostic ONLY -- deliberately excluded from `planSemanticIdentity` (task correction section 2); may vary run-to-run for an identical `blockedCode`. */
  readonly blockedReason: string | null;
}

export interface ResearchYearRunPlan {
  readonly schemaVersion: number;
  readonly semanticsVersion: number;
  readonly year: number;
  readonly fromDate: string;
  readonly toDate: string;
  readonly scope: ResearchYearRunScope;
  /**
   * Content-addressed identity of this plan's SEMANTIC content: schema/
   * semantics versions, year/range/scope, and every stage's deterministic
   * content (task section 4: stable for identical inputs; never influenced
   * by wall-clock time). Two runs with identical `ResearchYearRunRequest`
   * inputs (and, for OPTIONS/ALL, an identically-resolving
   * `RequiredOptionSessionSource`) always produce the same
   * `planSemanticIdentity` (task section 9.F/AK).
   */
  readonly planSemanticIdentity: string;
  readonly stages: readonly ResearchYearRunPlanStage[];
}

/**
 * Exactly the content `planSemanticIdentity` is computed over --
 * deliberately excludes any `generatedAt`/timestamp field (task section
 * 4/9.G) AND deliberately excludes `blockedReason` (task correction section
 * 2): only the stable `blockedCode` is identity material; free-text
 * diagnostics are never hashed.
 */
export interface ResearchYearRunPlanIdentityPayload {
  readonly schemaVersion: number;
  readonly semanticsVersion: number;
  readonly year: number;
  readonly fromDate: string;
  readonly toDate: string;
  readonly scope: ResearchYearRunScope;
  readonly stages: readonly {
    readonly stageKind: ResearchYearRunStageKind;
    readonly inScope: boolean;
    readonly underlyingCandidateDates: readonly string[] | null;
    readonly requiredOptionSessions: readonly RequiredOptionSession[] | null;
    readonly blocked: boolean;
    readonly blockedCode: ResearchYearRunPlanBlockedCode | null;
  }[];
}

export function computeResearchYearRunPlanSemanticIdentity(payload: ResearchYearRunPlanIdentityPayload): string {
  return sha256Hex(canonicalManifestJson(payload));
}

/** One B-F7 derived-timeframe outcome recorded for one materialized session. */
export interface ResearchYearRunResampleOutcome {
  readonly targetTimeframe: string;
  readonly status: string;
  readonly derivedBucketCount: number;
  readonly derivedContentChecksum: string;
}

/** One session's outcome within a `*_MATERIALIZATION` stage. */
export interface ResearchYearRunMaterializationSessionOutcome {
  readonly tradingDate: string;
  readonly datasetId: string;
  readonly datasetChecksum: string;
  readonly sessionContentChecksum: string;
  readonly persistedCanonicalHealthStatus: string;
  readonly parquetStatus: string;
  readonly resamples: readonly ResearchYearRunResampleOutcome[];
}

/** One instrument's (underlying, or one option contract) materialization outcome. */
export interface ResearchYearRunMaterializationInstrumentOutcome {
  readonly instrumentDescriptor: string;
  readonly datasetId: string | null;
  readonly datasetChecksum: string | null;
  readonly sessions: readonly ResearchYearRunMaterializationSessionOutcome[];
  readonly skippedRevalidated: boolean;
}

export interface ResearchYearRunStageResult {
  readonly stageKind: ResearchYearRunStageKind;
  readonly status: ResearchYearRunStageStatus;
  readonly detail: string | null;
  /** Present only for `*_ACQUISITION` stages that actually executed this run. */
  readonly acquisitionSummary: Record<string, unknown> | null;
  /** Present only for `*_MATERIALIZATION` stages that actually executed this run. */
  readonly materialization: readonly ResearchYearRunMaterializationInstrumentOutcome[] | null;
}

export interface ResearchYearRunRecord {
  readonly schemaVersion: number;
  readonly semanticsVersion: number;
  readonly plan: ResearchYearRunPlan;
  readonly outcome: ResearchYearRunOutcome;
  readonly stages: readonly ResearchYearRunStageResult[];
  /** Observability only -- never part of any identity/checksum comparison (task section 11). */
  readonly startedAt: string;
  readonly completedAt: string | null;
}

const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deterministic ascending Mon-Fri calendar-weekday candidate trading dates
 * within `[fromDate, toDate]` inclusive. Independently implemented (matches
 * the established repo convention of duplicating this exact two-line helper
 * per research-lake entrypoint, e.g. `research-nifty-option-candle-acquisition.ts`,
 * rather than cross-importing) -- never a holiday calendar (task section 15):
 * genuine non-trading weekdays are classified downstream by the EXISTING
 * B-F2/B-F4 `UNRESOLVED_NO_DATA`/`NO_OBSERVED_TRADING` buckets, never guessed
 * here.
 */
export function deterministicWeekdayTradingDates(fromDate: string, toDate: string): string[] {
  if (!TRADING_DATE_PATTERN.test(fromDate) || Number.isNaN(new Date(`${fromDate}T00:00:00Z`).getTime())) {
    throw new Error(`deterministicWeekdayTradingDates requires a valid YYYY-MM-DD fromDate; received '${fromDate}'.`);
  }
  if (!TRADING_DATE_PATTERN.test(toDate) || Number.isNaN(new Date(`${toDate}T00:00:00Z`).getTime())) {
    throw new Error(`deterministicWeekdayTradingDates requires a valid YYYY-MM-DD toDate; received '${toDate}'.`);
  }
  if (fromDate > toDate) {
    throw new Error(`deterministicWeekdayTradingDates requires fromDate (${fromDate}) <= toDate (${toDate}).`);
  }
  const dates: string[] = [];
  for (let cursor = new Date(`${fromDate}T00:00:00Z`); cursor <= new Date(`${toDate}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Deterministic sort for `RequiredOptionSession[]`, independent of whatever
 * order a `RequiredOptionSessionSource` supplied them in (task section
 * 9.J). Sorts by the PARSED contract identity (expiry ascending, strike
 * ascending, CE before PE, providerContractId tie-break) -- never by the raw
 * `providerContractId` string, whose `DDMonYY` expiry segment does not sort
 * chronologically as plain text (e.g. '06Jan22' > '13Feb22' lexically).
 */
export function sortRequiredOptionSessions(
  sessions: readonly RequiredOptionSession[],
  parseIdentity: (providerContractId: string) => { readonly expiry: Date; readonly strikePrice: number; readonly optionType: string }
): RequiredOptionSession[] {
  return [...sessions].sort((left, right) => {
    const leftIdentity = parseIdentity(left.providerContractId);
    const rightIdentity = parseIdentity(right.providerContractId);
    const expiryDiff = leftIdentity.expiry.getTime() - rightIdentity.expiry.getTime();
    if (expiryDiff !== 0) return expiryDiff;
    const strikeDiff = leftIdentity.strikePrice - rightIdentity.strikePrice;
    if (strikeDiff !== 0) return strikeDiff;
    const optionTypeDiff = leftIdentity.optionType.localeCompare(rightIdentity.optionType);
    if (optionTypeDiff !== 0) return optionTypeDiff;
    return left.providerContractId.localeCompare(right.providerContractId);
  });
}
