# TradeMind research validation methodology

## Split policy

The 104 chronological NIFTY sessions are divided into TRAIN (60), EMBARGO_1 (3), VALIDATION (20), EMBARGO_2 (3), and FINAL_HOLDOUT (18). Embargo sessions are excluded from outcome selection.

## Holdout protection

Normal modes are TRAIN_ONLY, VALIDATION_ONLY, TRAIN_VALIDATION_ONLY, and FULL_DIAGNOSTIC_ONLY. FINAL_HOLDOUT_ONCE requires RESEARCH_FINAL_HOLDOUT_AUTHORIZED=true and is intended to be consumed once. A final holdout already inspected by an earlier research effort is labeled LEGACY_CONTAMINATED_HOLDOUT.

## Walk-forward

The default rolling fold uses 50 training sessions, a two-session embargo, 10 validation sessions, and a ten-session step. Expanding windows are supported. Configuration selection occurs only on the training window; validation receives only the bounded top-K.

## Purging

Outcomes whose entry or resolution date crosses a split boundary are purged. Cooldown, open-position, and strategy state are reset at split boundaries unless a strategy explicitly documents a prior-session warm-up requirement. Indicator warm-up may use prior training data, but never future validation bars.

## Multiple testing

The framework provides a Deflated Sharpe Ratio approximation and a simplified chronological CPCV/PBO diagnostic. Both require session-by-configuration returns and are reported as diagnostics, not guarantees of statistical significance.

## Promotion

Promotion gates are configurable defaults and return ELIGIBLE_FOR_MANUAL_REVIEW or NOT_ELIGIBLE. No gate automatically approves live trading.

## Legacy versus future

V2, V4, V5, V6, and V7 were researched on the full 104-session history. Their final holdout is therefore not pristine. Future V8+ development must use TRAIN, accept/reject on VALIDATION, and consume FINAL_HOLDOUT only once. A failed holdout cannot be tuned and retested against that same holdout.
