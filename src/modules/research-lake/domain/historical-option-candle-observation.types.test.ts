import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasObservedTrading,
  isCompleteSessionCoverage,
  OptionCandleObservationState,
  resolveOptionCandleObservationState,
  toHistoricalContractStateEvidence,
} from './historical-option-candle-observation.types';
import { DatasetHealthReport, DatasetHealthStatus } from './dataset-health.types';
import { HistoricalAssetType } from './historical-asset.types';

function report(status: DatasetHealthStatus): DatasetHealthReport {
  return {
    status,
    assetType: HistoricalAssetType.NIFTY_OPTION,
    instrumentKey: 'NSE-NIFTY-06Jan22-17200-PE',
    tradingDate: '2022-01-03',
    sourceRowCount: 0,
    canonicalRowCount: 0,
    expectedRowCount: 375,
    excludedRowCount: 0,
    exclusions: [],
    duplicateTimestampCount: 0,
    missingMinuteCount: 0,
    invalidOhlcCount: 0,
    issues: [],
  };
}

test('(M) PROVIDER_UNAVAILABLE (zero source rows from a successful fetch) resolves to NO_OBSERVED_TRADING, never treated as a provider failure', () => {
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.PROVIDER_UNAVAILABLE)), OptionCandleObservationState.NO_OBSERVED_TRADING);
});

test('(K) HEALTHY (exact 375-row session) resolves to COMPLETE_SESSION', () => {
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.HEALTHY)), OptionCandleObservationState.COMPLETE_SESSION);
});

test('NORMALIZED_WITH_EXCLUSIONS (pre/post-market rows excluded but 375 canonical rows remain) still resolves to COMPLETE_SESSION', () => {
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.NORMALIZED_WITH_EXCLUSIONS)), OptionCandleObservationState.COMPLETE_SESSION);
});

test('(L) INCOMPLETE (some but not all 375 minutes observed) resolves to PARTIAL_OBSERVED_SESSION, never COMPLETE_SESSION', () => {
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.INCOMPLETE)), OptionCandleObservationState.PARTIAL_OBSERVED_SESSION);
});

test('(N) INVALID (structural issue: duplicate/out-of-order/bad OHLC) resolves to INVALID, fails closed', () => {
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.INVALID)), OptionCandleObservationState.INVALID);
});

test('unreachable-in-practice statuses (METADATA_INCOMPLETE / SPECIAL_SESSION_EXCLUDED) fold defensively into INVALID rather than being silently dropped', () => {
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.METADATA_INCOMPLETE)), OptionCandleObservationState.INVALID);
  assert.equal(resolveOptionCandleObservationState(report(DatasetHealthStatus.SPECIAL_SESSION_EXCLUDED)), OptionCandleObservationState.INVALID);
});

test('hasObservedTrading is true for COMPLETE_SESSION and PARTIAL_OBSERVED_SESSION only', () => {
  assert.equal(hasObservedTrading(OptionCandleObservationState.COMPLETE_SESSION), true);
  assert.equal(hasObservedTrading(OptionCandleObservationState.PARTIAL_OBSERVED_SESSION), true);
  assert.equal(hasObservedTrading(OptionCandleObservationState.NO_OBSERVED_TRADING), false);
  assert.equal(hasObservedTrading(OptionCandleObservationState.INVALID), false);
  assert.equal(hasObservedTrading(OptionCandleObservationState.PROVIDER_UNAVAILABLE), false);
});

test('isCompleteSessionCoverage is true for COMPLETE_SESSION only', () => {
  assert.equal(isCompleteSessionCoverage(OptionCandleObservationState.COMPLETE_SESSION), true);
  assert.equal(isCompleteSessionCoverage(OptionCandleObservationState.PARTIAL_OBSERVED_SESSION), false);
  assert.equal(isCompleteSessionCoverage(OptionCandleObservationState.NO_OBSERVED_TRADING), false);
});

test('toHistoricalContractStateEvidence bridges truthfully into the existing HistoricalContractStateEvidence shape', () => {
  assert.deepEqual(toHistoricalContractStateEvidence(OptionCandleObservationState.NO_OBSERVED_TRADING), {
    hasObservedTradingCandle: false,
    hasCompleteCanonicalSessionCoverage: false,
  });
  assert.deepEqual(toHistoricalContractStateEvidence(OptionCandleObservationState.PARTIAL_OBSERVED_SESSION), {
    hasObservedTradingCandle: true,
    hasCompleteCanonicalSessionCoverage: false,
  });
  assert.deepEqual(toHistoricalContractStateEvidence(OptionCandleObservationState.COMPLETE_SESSION), {
    hasObservedTradingCandle: true,
    hasCompleteCanonicalSessionCoverage: true,
  });
});
