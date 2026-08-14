export type EuropeanOptionType = 'CE' | 'PE';

export interface ImpliedVolatilityInput {
  optionType: EuropeanOptionType;
  spot: number;
  strike: number;
  premium: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield?: number;
}
export interface ImpliedVolatilityResult {
  impliedVolatility: number | null;
  converged: boolean;
  iterations: number;
  failureReason?: 'INVALID_INPUT' | 'EXPIRED' | 'ARBITRAGE_BOUND' | 'NON_CONVERGENT';
}

/** Deterministic European Black-Scholes model with continuous dividend yield. */
export function blackScholesPrice(input: Omit<ImpliedVolatilityInput, 'premium'> & { volatility: number }): number {
  const { optionType, spot, strike, timeToExpiryYears: time, riskFreeRate: rate, volatility } = input; const dividend = input.dividendYield ?? 0;
  if (![spot, strike, time, rate, volatility, dividend].every(Number.isFinite) || spot <= 0 || strike <= 0 || time <= 0 || volatility < 0) return Number.NaN;
  if (volatility === 0) return intrinsic(optionType, spot * Math.exp(-dividend * time), strike * Math.exp(-rate * time));
  const root = volatility * Math.sqrt(time); const d1 = (Math.log(spot / strike) + (rate - dividend + volatility * volatility / 2) * time) / root; const d2 = d1 - root;
  return optionType === 'CE' ? spot * Math.exp(-dividend * time) * normalCdf(d1) - strike * Math.exp(-rate * time) * normalCdf(d2) : strike * Math.exp(-rate * time) * normalCdf(-d2) - spot * Math.exp(-dividend * time) * normalCdf(-d1);
}

/** Bounded bisection solver: no fabricated IVs for invalid or unresolvable prices. */
export function solveEuropeanImpliedVolatility(input: ImpliedVolatilityInput): ImpliedVolatilityResult {
  const values = [input.spot, input.strike, input.premium, input.timeToExpiryYears, input.riskFreeRate, input.dividendYield ?? 0];
  if (!values.every(Number.isFinite) || input.spot <= 0 || input.strike <= 0 || input.premium <= 0) return fail('INVALID_INPUT');
  if (input.timeToExpiryYears <= 0) return fail('EXPIRED');
  const bounds = noArbitrageBounds(input); const tolerance = 1e-8;
  if (input.premium < bounds.lower - tolerance || input.premium > bounds.upper + tolerance) return fail('ARBITRAGE_BOUND');
  let low = 1e-8; let high = 10; let lowPrice = blackScholesPrice({ ...input, volatility: low }); let highPrice = blackScholesPrice({ ...input, volatility: high });
  if (!Number.isFinite(lowPrice) || !Number.isFinite(highPrice) || input.premium < lowPrice - tolerance || input.premium > highPrice + tolerance) return fail('ARBITRAGE_BOUND');
  for (let iteration = 1; iteration <= 120; iteration += 1) {
    const middle = (low + high) / 2; const price = blackScholesPrice({ ...input, volatility: middle });
    if (!Number.isFinite(price)) return { impliedVolatility: null, converged: false, iterations: iteration, failureReason: 'NON_CONVERGENT' };
    if (Math.abs(price - input.premium) <= tolerance) return { impliedVolatility: middle, converged: true, iterations: iteration };
    if (price < input.premium) { low = middle; lowPrice = price; } else { high = middle; highPrice = price; }
    if (high - low <= 1e-8) return { impliedVolatility: (high + low) / 2, converged: true, iterations: iteration };
  }
  void lowPrice; void highPrice; return fail('NON_CONVERGENT', 120);
}

export function noArbitrageBounds(input: Pick<ImpliedVolatilityInput, 'optionType' | 'spot' | 'strike' | 'timeToExpiryYears' | 'riskFreeRate' | 'dividendYield'>): { lower: number; upper: number } {
  const dividend = input.dividendYield ?? 0; const discountedSpot = input.spot * Math.exp(-dividend * input.timeToExpiryYears); const discountedStrike = input.strike * Math.exp(-input.riskFreeRate * input.timeToExpiryYears);
  return input.optionType === 'CE' ? { lower: Math.max(0, discountedSpot - discountedStrike), upper: discountedSpot } : { lower: Math.max(0, discountedStrike - discountedSpot), upper: discountedStrike };
}

function intrinsic(type: EuropeanOptionType, discountedSpot: number, discountedStrike: number): number { return type === 'CE' ? Math.max(0, discountedSpot - discountedStrike) : Math.max(0, discountedStrike - discountedSpot); }
function fail(reason: NonNullable<ImpliedVolatilityResult['failureReason']>, iterations = 0): ImpliedVolatilityResult { return { impliedVolatility: null, converged: false, iterations, failureReason: reason }; }
function normalCdf(value: number): number { return .5 * (1 + erf(value / Math.sqrt(2))); }
function erf(value: number): number { const sign = value < 0 ? -1 : 1; const x = Math.abs(value); const t = 1 / (1 + .3275911 * x); return sign * (1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x))); }
