import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalOptionType } from './historical-asset.types';
import {
  HistoricalContractState,
  HistoricalOptionContractIdentity,
  resolveHistoricalContractState,
} from './historical-option-identity.types';

function completeIdentity(overrides: Partial<HistoricalOptionContractIdentity> = {}): HistoricalOptionContractIdentity {
  return {
    instrumentKey: 'NSE_FO|12345',
    tradingSymbol: 'NIFTY26AUG26000CE',
    underlyingKey: 'NSE_INDEX|Nifty 50',
    expiry: new Date('2026-08-27T00:00:00+05:30'),
    strikePrice: 26000,
    optionType: HistoricalOptionType.CE,
    lotSize: 75,
    tickSize: 0.05,
    ...overrides,
  };
}

test('a fully known identity with no evidence resolves to CATALOG_KNOWN (known, not proven tradable)', () => {
  const state = resolveHistoricalContractState(completeIdentity());
  assert.equal(state, HistoricalContractState.CATALOG_KNOWN);
});

test('a missing lotSize resolves to METADATA_INCOMPLETE, never a fallback value', () => {
  const state = resolveHistoricalContractState(completeIdentity({ lotSize: null }));
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});

test('each required identity field, when missing, independently resolves to METADATA_INCOMPLETE', () => {
  const missingFieldCases: Partial<HistoricalOptionContractIdentity>[] = [
    { tickSize: null },
    { expiry: null },
    { strikePrice: null },
    { optionType: null },
    { instrumentKey: '' },
    { tradingSymbol: '' },
    { underlyingKey: '' },
  ];

  for (const overrides of missingFieldCases) {
    const state = resolveHistoricalContractState(completeIdentity(overrides));
    assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE, `expected METADATA_INCOMPLETE for ${JSON.stringify(overrides)}`);
  }
});

test('METADATA_INCOMPLETE takes priority over trading evidence: incomplete metadata is never reported as tradable', () => {
  const state = resolveHistoricalContractState(completeIdentity({ lotSize: null }), {
    hasObservedTradingCandle: true,
    hasCompleteCanonicalSessionCoverage: true,
  });
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});

test('observed trading evidence upgrades a complete identity to OBSERVED_TRADING', () => {
  const state = resolveHistoricalContractState(completeIdentity(), {
    hasObservedTradingCandle: true,
    hasCompleteCanonicalSessionCoverage: false,
  });
  assert.equal(state, HistoricalContractState.OBSERVED_TRADING);
});

test('complete canonical session coverage evidence resolves to SESSION_COVERED', () => {
  const state = resolveHistoricalContractState(completeIdentity(), {
    hasObservedTradingCandle: true,
    hasCompleteCanonicalSessionCoverage: true,
  });
  assert.equal(state, HistoricalContractState.SESSION_COVERED);
});

test('BLOCKER 2 regression: a structurally-present but semantically-invalid required field is METADATA_INCOMPLETE, never CATALOG_KNOWN', () => {
  const invalidValueCases: Partial<HistoricalOptionContractIdentity>[] = [
    { lotSize: 0 },
    { lotSize: -75 },
    { lotSize: 75.5 },
    { tickSize: 0 },
    { tickSize: -0.05 },
    { tickSize: NaN },
    { tickSize: Infinity },
    { strikePrice: 0 },
    { strikePrice: -26000 },
    { strikePrice: NaN },
    { strikePrice: Infinity },
    { expiry: new Date('not-a-real-date') },
  ];

  for (const overrides of invalidValueCases) {
    const state = resolveHistoricalContractState(completeIdentity(overrides));
    assert.equal(
      state,
      HistoricalContractState.METADATA_INCOMPLETE,
      `expected METADATA_INCOMPLETE for ${JSON.stringify(overrides)}, got ${state}`
    );
  }
});

test('BLOCKER 2 regression: a fully valid complete identity still resolves to CATALOG_KNOWN', () => {
  const state = resolveHistoricalContractState(completeIdentity());
  assert.equal(state, HistoricalContractState.CATALOG_KNOWN);
});

test('BLOCKER 2 regression: an invalid (not merely missing) required value stays METADATA_INCOMPLETE even under strong trading evidence', () => {
  const state = resolveHistoricalContractState(completeIdentity({ lotSize: -75, strikePrice: 0 }), {
    hasObservedTradingCandle: true,
    hasCompleteCanonicalSessionCoverage: true,
  });
  assert.equal(state, HistoricalContractState.METADATA_INCOMPLETE);
});
