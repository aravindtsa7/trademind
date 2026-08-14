# Strategy comparison and Monday shadow decision

## Executive summary

**Decision: `NO_NEW_SHADOW`.** The evidence does not support adding a Monday shadow strategy. V9 PE is the strongest recorded non-rejected historical pocket; V8 CE is the strongest bullish-only pocket and has the cleanest estimated V2/V4 independence. Both remain selected historical pockets with unacceptable multiple-testing risk and no forward execution record. V10 is structurally rejected, V11 has no outcomes and excessive phase-1 frequency, V12 has no collected forward sessions, and BANKNIFTY BN_V1 was rejected after validation instability.

The operating posture for Monday is unchanged: frozen V2 remains paper-only, frozen V4 remains shadow-only, and V12 should collect market-depth data only. No strategy is promoted automatically.

## Comparison table

| Candidate | Direction / source / timeframe | Evidence | Net expectancy @ 0.20 / 0.40 / 0.60 / 0.80 / 1.00 | Chronology / overfit / holdout | Classification |
|---|---|---:|---|---|---|
| V8 bullish reclaim | CE; NIFTY PDH/OR/swing reclaim; 2m/3m | 80 sessions; selected pocket 63 settled / 0.79 trades-session | +1.43 / +1.23 / +1.03 / +0.83 / +0.63% | First half -0.68%, second +3.19%; PBO 1.0; high overfit; final holdout untouched | WEAK / CONTINUE_RESEARCH |
| V9 volatility expansion | BOTH; compression-to-expansion plus option confirmation; 2m/3m + 5m context | 80 sessions; PE pocket 43 settled / 0.58 trades-session | +1.57 / +1.37 / +1.17 / +0.97 / +0.77% | PE train/validation both positive but only 43 trades; DSR 0 and PBO 0.5; final holdout untouched | WEAK / CONTINUE_RESEARCH |
| V10 lead-lag | BOTH; BANK NIFTY impulse then NIFTY confirmation; 1m/2m/3m | 80 signal-only sessions; no outcomes | Not evaluated | Mean measured lead 0.60m; 75.7% same-bar; phase-1 hypothesis not supported; final holdout untouched | REJECT |
| V11 IV/skew | BOTH; causal wing-IV skew/risk reversal; 1m surface | 80 signal-only sessions; no outcomes | Not evaluated | All 288 CE and PE config-directions exceed 2 signals/session; median around 10; final holdout untouched | INSUFFICIENT_DATA |
| V12 order flow | Confirmation-only; live depth/imbalance/spread; raw + 5s/15s/30s/60s | No collected forward sessions | Not evaluated | Forward data required; no signal design or outcome evidence | INSUFFICIENT_DATA |
| BANKNIFTY BN_V1 retest | BOTH; OR breakout/retest; 1m/2m/3m | 75 sessions; selected combined pocket 40 settled | +0.99 / +0.79 / +0.59 / +0.39 / +0.19% | TRAIN +1.12% to VALIDATION -0.09%; 69,984 evaluations; legacy contaminated | REJECT |

All figures are percentages per settled option trade under the respective artifact's flat round-trip cost assumptions. “Not evaluated” is deliberately not treated as neutral or favorable evidence.

## Candidate evidence

### V8 NIFTY bullish reclaim

The selected OR30 CE pocket has a positive median (+6%), target rate (57.1%) above stop rate (38.1%), 73.2% profitable days, a 32% maximum drawdown, and five consecutive losses at worst. It is genuinely bullish and estimated to have no exact or +/-5-minute overlap with V2/V4 in its stored comparison.

That is not enough for shadow: March was -1.92% net at 0.40%, the first half was -0.68%, July has only three settled trades, and walk-forward validations contained only one trade/signal per fold. The 4,608-config × 9-policy search yields DSR near zero at realistic trial counts and PBO=1.0. The historical CE result is worth preserving as research, not deploying.

### V9 NIFTY volatility expansion confirmation

V9 PE is the best recorded historical pocket: 43 settled trades, +1.37% net at 0.40%, +1.17% at 0.60%, positive median (+6%), 55.8% target versus 30.2% stop, 19% maximum drawdown, and three consecutive losses. TRAIN (+1.36%) and VALIDATION (+1.39%) are both positive; both reported rolling validation folds are positive. Its CE companion also has positive cost-stressed outcomes, but only 40 settled trades and a negative April.

This remains a `WEAK / CONTINUE_RESEARCH` candidate rather than a shadow candidate. The result was selected from 960 configurations and 8,640 policy evaluations; its DSR is zero at all reported trial-count sensitivities, simplified PBO is 0.5, and no forward bid/ask evidence exists. Exact V2/V4 overlap is unavailable, so independence cannot be claimed.

### V10 NIFTY/BANKNIFTY lead-lag

The causal alignment checks are clean, but the economic premise was not supported: average measured lead time is only 0.596 minutes and 75.7% of signals occur on the same completed bar. The highest-frequency configuration emits 57.7 signals/session. No option outcome evaluation was performed. This is a structural `REJECT`, not an incomplete candidate awaiting promotion.

### V11 IV/skew risk reversal

The surface data and causality controls are strong: 29,832 cached feature rows, prepared symmetric wings, and zero reported future-data, mixed-expiry, duplicate, cooldown, or re-arm violations. Yet phase 1 produced 2.8–39.5 signals/session for every configuration-direction, with a median near 10. That is a pathological density for this intended event/episode family. There are no trade outcomes, execution estimates, or validation returns. It is `INSUFFICIENT_DATA`, and it should not proceed toward runtime design.

### V12 order flow

V12 is a collector, not a strategy. It has no clean forward session manifest, no frozen signal rules, and no outcomes. Its contribution Monday is collection only, with the hardened websocket/data-quality path. Classification is `INSUFFICIENT_FORWARD_DATA` / `INSUFFICIENT_DATA`.

### BANKNIFTY BN_V1 opening-range retest

Option preparation is credible (99 research-eligible sessions; 590 complete and four usable-sparse option sessions; five metadata-unavailable dates excluded), and the best selected pocket survives flat 1.00% cost. But its validation reverses from +1.12% net at 0.40% in TRAIN to -0.09% in VALIDATION. The research evaluates 69,984 policies, has DSR=0 under reported sensitivity, PBO=0.5, and uses a legacy-contaminated final segment. CE and PE do not establish a stable combined portfolio. Classification: `REJECT`.

## Portfolio-gap analysis

| Coverage | Current evidence |
|---|---|
| TREND_DOWN / PE | V2 paper and V4 shadow cover it. V9 PE is potentially distinct through volatility/premium confirmation, but is not approved. |
| TREND_UP / CE | V8 supplies the only completed bullish-only study. Its result is selected and chronologically unstable. |
| SIDEWAYS | No reviewed candidate provides validated sideways coverage. |
| Volatility expansion | V9 offers the best historical evidence, but not enough selection-adjusted or forward evidence. |
| Cross-index lead/lag | V10 rejected the lead premise. |
| IV/skew | V11 is data-ready but has no outcome evidence and excessive signal density. |
| Order flow | V12 is the most independent future source, but has no forward observations yet. |

## Monday recommendation

### `NO_NEW_SHADOW`

No candidate clears the project’s research-to-shadow expectations: cost-adjusted positivity alone is not sufficient. V8 and V9 lack a sufficiently large, unselected, execution-aware evidence set; V9's multiple-testing diagnostics explicitly fail. The protected final holdout remains unused and must not be consumed merely to justify a Monday deployment.

Monday should therefore run only:

- frozen `V2_TREND_DOWN_PE` in paper mode;
- frozen `V4_NIFTY_MOMENTUM_PE_SHADOW` in orderless shadow mode; and
- V12 market-depth collection, with no V12 signals.

No shadow implementation plan is supplied because no candidate is recommended. If a candidate later clears a predeclared gate, its plan must freeze the existing strategy ID/parameters, completed-candle semantics, exact option selection, target/stop/hold, cooldown, strict freshness/backfill, bid/ask capture, append-only forward journal, deterministic fingerprint, no broker orders, and a minimum forward sample before paper review.

## Direct answers

1. **Currently strongest:** V9 PE volatility expansion/premium-breakout pocket, historically only.
2. **Strongest CE/bullish evidence:** V8 CE OR30 reclaim pocket, historically only.
3. **Most independent of V2/V4:** V8 CE, with the available artifact estimating zero exact and zero +/-5-minute overlaps.
4. **Best cost robustness:** V9 PE, positive through 1.00% flat cost in the selected pocket.
5. **Honestly ready for Monday shadow mode:** No.

## Limitations

- Historical flat costs are not substitutes for observed bid/ask execution, queue position, and disconnect/gap quality.
- V8/V9 protected final holdouts were not accessed, so there is no final-period confirmation—not positive evidence.
- DSR/PBO are diagnostic approximations, not a claim of statistical certainty.
- Exact V2/V4 overlap is not available for V9; no overlap was inferred.
- No conclusion is drawn from V11/V12 in the absence of option-outcome or forward-data evidence.
