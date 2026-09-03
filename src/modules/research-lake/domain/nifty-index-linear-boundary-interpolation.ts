import { Prisma } from '@prisma/client';

/**
 * B-M7.1 task section 7 (LOCKED): continuous boundary interpolation between
 * a REAL left-anchor CLOSE and a REAL right-anchor OPEN, for the exact
 * 3-candle gap `NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION` authorizes.
 * Deliberately NOT the earlier naive 25%/50%/75% flat-candle approach.
 *
 * Given A = left anchor CLOSE, B = right anchor OPEN, D = B - A:
 *   candle 1: open = A,           close = A + (1/3)D
 *   candle 2: open = A + (1/3)D,  close = A + (2/3)D
 *   candle 3: open = A + (2/3)D,  close = B
 * high = max(open, close), low = min(open, close) for every candle.
 *
 * PRECISION POLICY (task section 7, POLICY VERSION UNCHANGED at 1 -- this is
 * an enforcement correction, not a mathematical semantics change): NIFTY
 * underlying index prices are canonically represented to 2 decimal places
 * throughout this Research Lake (see `historical-candle-content-identity.test.ts`
 * -- every fixture OHLC value is a whole or 2-decimal-place quantity, and
 * `HistoricalCandleResearchPersistenceService` persists OHLC via
 * `new Prisma.Decimal(value).toFixed()` with no further rounding applied
 * upstream). A 1/3 fraction of an arbitrary 2-decimal-place delta does not
 * terminate in 2 decimal places (e.g. delta 0.01 -> 0.00333...), so an
 * EXPLICIT, versioned, deterministic rounding rule is required to map the
 * exact 1/3 and 2/3 INTERIOR SYNTHETIC boundary prices back into that same
 * 2-decimal-place representation. `Prisma.Decimal#toDecimalPlaces(dp, rm)` is
 * used with an EXPLICIT rounding mode argument (never the ambient global
 * `Decimal.set` configuration) so the result can never depend on
 * process-wide decimal.js configuration a caller or a different module
 * happened to set -- eliminating any environment-dependent Decimal
 * serialization.
 *
 * B-M7.1-BLOCKER-02 CORRECTION (post-Terra-review): the 2dp/ROUND_HALF_UP
 * rule above governs ONLY the INTERIOR SYNTHETIC boundaries this module
 * itself invents -- it must NEVER be silently applied to the REAL anchor
 * prices (`leftAnchorClose`/`rightAnchorOpen`), which are genuine provider
 * data that may legitimately carry more precision than this imputation
 * policy's 2dp synthetic-price contract. Terra found the previous version
 * unconditionally rounded the anchors too, which would have silently
 * MODIFIED a real observed candle value merely because this policy's own
 * output scale is 2dp. `assertSupportedAnchorPrecision` now proves each
 * anchor is ALREADY exactly representable at 2dp (rounds a COPY via the
 * same explicit HALF_UP rule, then compares by VALUE -- via `Decimal#equals`,
 * never a string/format comparison, so equivalent representations like
 * '23950.10' and '23950.1' are correctly treated as identical) before any
 * arithmetic runs; a real anchor that is NOT already exactly representable
 * (e.g. '23950.123') throws `NiftyIndexAnchorPrecisionError` and interpolation
 * never proceeds. The validated ORIGINAL anchor `Decimal` (never a rounded
 * copy) is what feeds the formula, so `candle1.open` and `candle3.close`
 * are provably byte-for-byte the real anchors, never a reconstructed/
 * renormalized value.
 *
 * CONTINUITY (task section 7): the 1/3 and 2/3 INTERIOR boundary prices are
 * each rounded EXACTLY ONCE and the SAME rounded `Prisma.Decimal` value is
 * reused as both one candle's `close` and the next candle's `open` -- never
 * independently recomputed/re-rounded on each side, which could otherwise
 * silently break byte-for-byte continuity. This guarantees, by construction:
 *   candle1.close === candle2.open, candle2.close === candle3.open,
 *   candle1.open === the validated real left anchor exactly,
 *   candle3.close === the validated real right anchor exactly.
 */
export const LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES = 2;
export const LINEAR_BOUNDARY_INTERPOLATION_ROUNDING_MODE = 'ROUND_HALF_UP';

/** Bump if the formula, the decimal-places count, or the rounding mode ever changes -- part of imputed-row provenance and the derived-session checksum (task section 7: "checksum-visible through policy/version"). UNCHANGED at 1 by this correction: enforcing the already-stated 2dp contract on real anchors is not a change to the contract's mathematical semantics. */
export const LINEAR_BOUNDARY_INTERPOLATION_POLICY_VERSION = 1;

export type NiftyIndexAnchorPrecisionErrorCode = 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION' | 'UNSUPPORTED_RIGHT_ANCHOR_PRICE_PRECISION';

/** B-M7.1-BLOCKER-02: thrown instead of silently normalizing a real anchor that carries more precision than the supported 2dp policy scale (or that is not a finite decimal value at all). */
export class NiftyIndexAnchorPrecisionError extends Error {
  constructor(readonly code: NiftyIndexAnchorPrecisionErrorCode, message: string) {
    super(message);
    this.name = 'NiftyIndexAnchorPrecisionError';
  }
}

export interface LinearBoundaryInterpolationInput {
  readonly leftAnchorClose: Prisma.Decimal.Value;
  readonly rightAnchorOpen: Prisma.Decimal.Value;
}

export interface InterpolatedOhlc {
  readonly open: Prisma.Decimal;
  readonly high: Prisma.Decimal;
  readonly low: Prisma.Decimal;
  readonly close: Prisma.Decimal;
}

export interface LinearBoundaryInterpolationResult {
  /** Exactly 3 candles, in chronological order (the middle minute of the 3-candle gap, i.e. candles[0] immediately follows the left anchor and candles[2] immediately precedes the right anchor). */
  readonly candles: readonly [InterpolatedOhlc, InterpolatedOhlc, InterpolatedOhlc];
}

/** Rounds ONLY for computing INTERIOR synthetic boundaries -- never applied to a real anchor without first proving (`assertSupportedAnchorPrecision`) that rounding is a no-op for it. */
function roundInteriorBoundary(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * B-M7.1-BLOCKER-02: proves `value` is a finite decimal ALREADY exactly
 * representable at the supported `LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES`
 * scale under the frozen `ROUND_HALF_UP` rule -- by rounding a COPY and
 * comparing it to the original via `Decimal#equals` (value equality, immune
 * to scientific-notation/formatting differences and to trailing-zero
 * variants like '23950.10' vs '23950.1', which are the SAME value and both
 * correctly pass). `value` itself is never mutated or replaced -- callers
 * keep using the ORIGINAL `value` for the actual formula, so a validated
 * anchor is never silently reconstructed from a rounded copy.
 *
 * `Prisma.Decimal` can construct a non-finite value (`NaN`/`Infinity`)
 * WITHOUT throwing (confirmed: `new Prisma.Decimal(NaN).isFinite() === false`
 * with no exception) -- so finiteness is checked explicitly here, exactly
 * like `historical-candle-content-identity.ts`'s `canonicalDecimalString`
 * already does for the same reason, before any rounding/comparison is
 * attempted.
 */
function assertSupportedAnchorPrecision(value: Prisma.Decimal, side: 'LEFT' | 'RIGHT'): void {
  const code: NiftyIndexAnchorPrecisionErrorCode = side === 'LEFT' ? 'UNSUPPORTED_LEFT_ANCHOR_PRICE_PRECISION' : 'UNSUPPORTED_RIGHT_ANCHOR_PRICE_PRECISION';
  const label = side === 'LEFT' ? 'left anchor (10:21 IST close)' : 'right anchor (10:25 IST open)';

  if (!value.isFinite()) {
    throw new NiftyIndexAnchorPrecisionError(code, `The ${label} is not a finite decimal value (got '${value.toString()}'); gap imputation fails closed rather than interpolating from an invalid anchor.`);
  }

  const normalized = value.toDecimalPlaces(LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
  if (!normalized.equals(value)) {
    throw new NiftyIndexAnchorPrecisionError(
      code,
      `The ${label} value '${value.toFixed()}' carries more precision than the supported ${LINEAR_BOUNDARY_INTERPOLATION_PRICE_DECIMAL_PLACES}-decimal-place policy (rounding it would silently produce '${normalized.toFixed()}'); failing closed rather than normalizing a real provider anchor. A real anchor must already be exactly representable at the supported scale.`
    );
  }
}

function ohlcFromOpenClose(open: Prisma.Decimal, close: Prisma.Decimal): InterpolatedOhlc {
  const high = open.greaterThanOrEqualTo(close) ? open : close;
  const low = open.lessThanOrEqualTo(close) ? open : close;
  return { open, high, low, close };
}

/**
 * Pure, deterministic. Never touches JS floating-point arithmetic on the
 * price path -- every operation is a `Prisma.Decimal` (decimal.js) method.
 * Throws `NiftyIndexAnchorPrecisionError` (never silently normalizes) if
 * either real anchor carries unsupported precision -- see module doc.
 */
export function computeLinearBoundaryInterpolation(input: LinearBoundaryInterpolationInput): LinearBoundaryInterpolationResult {
  const anchorA = new Prisma.Decimal(input.leftAnchorClose);
  assertSupportedAnchorPrecision(anchorA, 'LEFT');
  const anchorB = new Prisma.Decimal(input.rightAnchorOpen);
  assertSupportedAnchorPrecision(anchorB, 'RIGHT');

  // `anchorA`/`anchorB` are used DIRECTLY (never re-rounded) -- `assertSupportedAnchorPrecision` already proved rounding would be a no-op for both, so candle1.open/candle3.close below are provably the exact real anchors, never a reconstructed value.
  const delta = anchorB.minus(anchorA);

  const oneThirdBoundary = roundInteriorBoundary(anchorA.plus(delta.dividedBy(3)));
  const twoThirdsBoundary = roundInteriorBoundary(anchorA.plus(delta.times(2).dividedBy(3)));

  const first = ohlcFromOpenClose(anchorA, oneThirdBoundary);
  const second = ohlcFromOpenClose(oneThirdBoundary, twoThirdsBoundary);
  const third = ohlcFromOpenClose(twoThirdsBoundary, anchorB);

  return { candles: [first, second, third] };
}
