import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getHistoricalOptionChargeRateConfig,
  HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS,
} from '../modules/options/config/historical-option-charge-rates.config';

test('selects the pre-April configuration for a March 2026 trade', () => {
  const configuration = getHistoricalOptionChargeRateConfig(new Date('2026-03-15T09:15:00+05:30'));

  assert.equal(configuration.id, 'nse-equity-options-2026-03-01-to-2026-03-31');
  assert.equal(configuration.stt.rate.value, 0.1);
});

test('selects the post-April configuration on April 1, 2026', () => {
  const configuration = getHistoricalOptionChargeRateConfig(new Date('2026-04-01T09:15:00+05:30'));

  assert.equal(configuration.id, 'nse-equity-options-from-2026-04-01');
  assert.equal(configuration.stt.rate.value, 0.15);
});

test('selects the post-April configuration for an August 2026 trade', () => {
  const configuration = getHistoricalOptionChargeRateConfig(new Date('2026-08-05T09:15:00+05:30'));

  assert.equal(configuration.id, 'nse-equity-options-from-2026-04-01');
});

test('handles the March 31 and April 1 configuration boundaries', () => {
  const marchBoundary = getHistoricalOptionChargeRateConfig(new Date('2026-03-31T15:29:00+05:30'));
  const aprilBoundary = getHistoricalOptionChargeRateConfig(new Date('2026-04-01T00:00:00+05:30'));

  assert.equal(marchBoundary.effectiveTo, '2026-03-31');
  assert.equal(aprilBoundary.effectiveFrom, '2026-04-01');
});

test('rejects dates outside the supported configuration range', () => {
  assert.throws(
    () => getHistoricalOptionChargeRateConfig(new Date('2026-02-28T09:15:00+05:30')),
    /No supported historical option charge-rate configuration/
  );
});

test('returns an immutable configuration without mutating future selections', () => {
  const configuration = getHistoricalOptionChargeRateConfig(new Date('2026-04-01T09:15:00+05:30'));

  assert.throws(() => {
    configuration.stt.rate.value = 99;
  }, TypeError);
  assert.equal(
    getHistoricalOptionChargeRateConfig(new Date('2026-04-01T09:15:00+05:30')).stt.rate.value,
    0.15
  );
});

test('defines separate Standard and Plus brokerage-plan examples', () => {
  assert.equal(HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD.brokeragePerExecutedOrder, 20);
  assert.equal(HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.PLUS.brokeragePerExecutedOrder, 30);
  assert.equal(HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD.numberOfOrders, 2);
  assert.equal(HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.PLUS.numberOfOrders, 2);
});

test('keeps brokerage plans immutable', () => {
  assert.throws(() => {
    HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD.brokeragePerExecutedOrder = 99;
  }, TypeError);
  assert.equal(HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD.brokeragePerExecutedOrder, 20);
});
