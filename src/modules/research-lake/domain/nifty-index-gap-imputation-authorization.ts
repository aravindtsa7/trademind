import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../services/nifty-underlying-identity';

/**
 * B-M7.1 task section 6: synthetic interpolation is explicitly NOT a generic
 * Research Lake feature. This is a single, frozen, EXPLICIT allowlist entry
 * -- never a generic rule ("if <= 3 minutes missing => interpolate" is
 * exactly what this module must NEVER become). Every request that does not
 * match this exact tuple (instrument + timeframe + tradingDate + the exact
 * missing-minute set) fails closed via `assertNiftyIndexGapImputationAuthorized`.
 * A future date/instrument/gap requires a SEPARATE, deliberately-added
 * allowlist entry -- this module intentionally has no mechanism to infer or
 * generalize authorization from this one entry.
 *
 * B-M7.1-BLOCKER-01 CORRECTION (post-Terra-review): `Object.freeze()` on the
 * outer descriptor object is SHALLOW -- it freezes the descriptor's own
 * property bindings (you cannot reassign `authorization.missingMinutesIst`
 * to a different array), but does NOT freeze the array object that property
 * points to. Terra demonstrated that `NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST.
 * push(999)` (or `.splice`/index-assignment) mutated the SAME array instance
 * referenced by `NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst`,
 * silently altering the effective production authorization at runtime --
 * TypeScript's `readonly` is compile-time-only and provides zero runtime
 * protection against this.
 *
 * The fix has two independent, defense-in-depth layers (never rely on either
 * alone):
 *  1. `CANONICAL_MISSING_MINUTES_IST` is a MODULE-PRIVATE (never exported)
 *     array, itself `Object.freeze()`-d, and `assertNiftyIndexGapImputationAuthorized`
 *     reads ONLY this private value -- never `authorization.missingMinutesIst`
 *     or any other exported reference. Even if every exported frozen copy
 *     were somehow bypassed, the assertion still cannot observe a mutated
 *     value, because it never looks at anything reachable from outside this
 *     module.
 *  2. Every exported representation (the standalone
 *     `NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST` constant, and the
 *     `missingMinutesIst` field on `NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION`)
 *     is ALSO independently `Object.freeze()`-d. Because ES modules always
 *     execute in strict mode, `Object.freeze` is not merely advisory here:
 *     `push`/`splice`/`array[i] = x` on a frozen array THROWS a `TypeError`
 *     at the mutation site rather than silently no-op-ing or succeeding --
 *     genuine runtime-safe JavaScript behavior, not a TypeScript-only
 *     annotation.
 */
export const NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID = 'NIFTY_2022_03_07_INDEX_GAP_V1';
export const LINEAR_BOUNDARY_INTERPOLATION_METHOD = 'LINEAR_BOUNDARY_INTERPOLATION';

/**
 * Semantic version of THIS authorization's own identity contract (which
 * instrument/timeframe/date/missing-minute-set/anchor-minutes it locks in).
 * Independent of `LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION`
 * (`nifty-index-linear-boundary-interpolation.ts`), which governs the
 * INTERPOLATION FORMULA/rounding policy, not which gap is authorized.
 */
export const NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_VERSION = 1;

const MINUTES_PER_HOUR = 60;

/** MODULE-PRIVATE canonical facts. Never exported directly -- `assertNiftyIndexGapImputationAuthorized` reads ONLY these, never a value reachable/mutable from outside this module (B-M7.1-BLOCKER-01). */
const CANONICAL_LEFT_ANCHOR_MINUTE_IST = 10 * MINUTES_PER_HOUR + 21; // 10:21 IST
const CANONICAL_MISSING_MINUTES_IST: readonly number[] = Object.freeze([10 * MINUTES_PER_HOUR + 22, 10 * MINUTES_PER_HOUR + 23, 10 * MINUTES_PER_HOUR + 24]); // 10:22, 10:23, 10:24 IST
const CANONICAL_RIGHT_ANCHOR_MINUTE_IST = 10 * MINUTES_PER_HOUR + 25; // 10:25 IST

/** 10:21 IST -- required real left anchor candle (never itself imputed). A plain number is already runtime-immutable (primitives cannot be mutated); exported for read-only convenience/tests. */
export const NIFTY_2022_03_07_INDEX_GAP_LEFT_ANCHOR_MINUTE_IST = CANONICAL_LEFT_ANCHOR_MINUTE_IST;
/** 10:22, 10:23, 10:24 IST -- the exact, and only, authorized missing-minute set. A runtime-frozen COPY of the private canonical array (never the same object identity as `CANONICAL_MISSING_MINUTES_IST`) -- mutating this exported array throws (strict mode) and, even if it somehow did not, could never affect `CANONICAL_MISSING_MINUTES_IST` or the assertion below. */
export const NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST: readonly number[] = Object.freeze([...CANONICAL_MISSING_MINUTES_IST]);
/** 10:25 IST -- required real right anchor candle (never itself imputed). */
export const NIFTY_2022_03_07_INDEX_GAP_RIGHT_ANCHOR_MINUTE_IST = CANONICAL_RIGHT_ANCHOR_MINUTE_IST;

export interface NiftyIndexGapImputationAuthorization {
  readonly authorizationId: string;
  readonly authorizationVersion: number;
  readonly method: string;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  /** Ascending minute-of-day (IST) values. Runtime-frozen -- see module doc. */
  readonly missingMinutesIst: readonly number[];
  readonly leftAnchorMinuteIst: number;
  readonly rightAnchorMinuteIst: number;
}

/**
 * The ONE allowlisted authorization this module currently defines (task
 * section 6). `Object.freeze()`-d at the outer level (no property can be
 * reassigned/added/removed) AND its own `missingMinutesIst` field is a
 * SEPARATE frozen array (own `Object.freeze([...])` copy, not merely
 * `CANONICAL_MISSING_MINUTES_IST` re-exported by reference) -- so
 * `Object.isFrozen(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION)` AND
 * `Object.isFrozen(NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION.missingMinutesIst)`
 * are both `true` (B-M7.1-BLOCKER-01 requirement).
 */
export const NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION: NiftyIndexGapImputationAuthorization = Object.freeze({
  authorizationId: NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID,
  authorizationVersion: NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_VERSION,
  method: LINEAR_BOUNDARY_INTERPOLATION_METHOD,
  instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
  timeframe: NIFTY_UNDERLYING_TIMEFRAME,
  tradingDate: '2022-03-07',
  missingMinutesIst: Object.freeze([...CANONICAL_MISSING_MINUTES_IST]),
  leftAnchorMinuteIst: CANONICAL_LEFT_ANCHOR_MINUTE_IST,
  rightAnchorMinuteIst: CANONICAL_RIGHT_ANCHOR_MINUTE_IST,
});

export class NiftyIndexGapImputationNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NiftyIndexGapImputationNotAuthorizedError';
  }
}

export interface NiftyIndexGapImputationAuthorizationRequest {
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
  /** The exact missing-minute set a caller is about to synthesize candles for -- any order accepted, compared as a set. */
  readonly missingMinutesIst: readonly number[];
}

/**
 * Fails closed unless `request` is an EXACT match for the canonical
 * NIFTY_2022_03_07_INDEX_GAP_V1 facts (task section 6: "Every other
 * date/instrument/timeframe/gap must fail closed unless separately
 * authorized in a future change"). Never partial-matches (e.g. a subset of
 * the missing-minute set), never falls back to a size/threshold heuristic.
 *
 * B-M7.1-BLOCKER-01: compares `instrumentKey`/`timeframe`/`tradingDate`
 * against `NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION` (safe: these are
 * immutable string primitives, not mutable references), but the
 * missing-minute-set comparison reads ONLY the MODULE-PRIVATE
 * `CANONICAL_MISSING_MINUTES_IST` -- never `authorization.missingMinutesIst`
 * or the exported `NIFTY_2022_03_07_INDEX_GAP_MISSING_MINUTES_IST` constant.
 * This is deliberate defense-in-depth beyond the freezing above: even a
 * hypothetical future refactor that stopped freezing the exported copies
 * could not silently widen what this assertion actually enforces.
 */
export function assertNiftyIndexGapImputationAuthorized(request: NiftyIndexGapImputationAuthorizationRequest): void {
  const authorization = NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION;

  if (request.instrumentKey !== authorization.instrumentKey) {
    throw new NiftyIndexGapImputationNotAuthorizedError(
      `No gap-imputation authorization exists for instrumentKey '${request.instrumentKey}'; only '${authorization.instrumentKey}' is authorized (${authorization.authorizationId}).`
    );
  }
  if (request.timeframe !== authorization.timeframe) {
    throw new NiftyIndexGapImputationNotAuthorizedError(
      `No gap-imputation authorization exists for timeframe '${request.timeframe}'; only '${authorization.timeframe}' is authorized (${authorization.authorizationId}).`
    );
  }
  if (request.tradingDate !== authorization.tradingDate) {
    throw new NiftyIndexGapImputationNotAuthorizedError(
      `No gap-imputation authorization exists for tradingDate '${request.tradingDate}'; only '${authorization.tradingDate}' is authorized (${authorization.authorizationId}).`
    );
  }

  const requestedSet = [...new Set(request.missingMinutesIst)].sort((left, right) => left - right);
  const authorizedSet = [...CANONICAL_MISSING_MINUTES_IST]; // private canonical value, never the exported/public reference (B-M7.1-BLOCKER-01)
  const matchesExactly = requestedSet.length === authorizedSet.length && requestedSet.every((minute, index) => minute === authorizedSet[index]);
  if (!matchesExactly) {
    throw new NiftyIndexGapImputationNotAuthorizedError(
      `The requested missing-minute set [${requestedSet.join(', ')}] does not exactly match the authorized set [${authorizedSet.join(', ')}] for ${authorization.authorizationId}. Gap-imputation authorization never partial-matches or generalizes.`
    );
  }
}
