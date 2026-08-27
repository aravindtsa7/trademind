import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalOptionType } from './historical-asset.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  ManifestCandleContent,
  ManifestDatasetKind,
  OptionSessionIdentity,
  SessionContentPayload,
  UnderlyingSessionIdentity,
  assertNoDuplicateSessionIdentities,
  computeDatasetChecksum,
  computeSessionContentChecksum,
  deriveDatasetId,
  sessionIdentityKey,
} from './dataset-manifest.types';

function underlyingIdentity(overrides: Partial<UnderlyingSessionIdentity> = {}): UnderlyingSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: '2022-01-03',
    ...overrides,
  };
}

function candle(overrides: Partial<ManifestCandleContent> = {}): ManifestCandleContent {
  return {
    candleTime: '2022-01-03T03:45:00.000Z',
    open: '100.00',
    high: '101.00',
    low: '99.00',
    close: '100.50',
    volume: '1000',
    openInterest: null,
    ...overrides,
  };
}

function payload(overrides: Partial<SessionContentPayload> = {}): SessionContentPayload {
  return {
    identity: underlyingIdentity(),
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    candles: [candle()],
    ...overrides,
  };
}

test('(A) identical content -> identical session checksum', () => {
  assert.equal(computeSessionContentChecksum(payload()), computeSessionContentChecksum(payload()));
});

test('(B) candle input order does not affect the session checksum (sorted internally by candleTime)', () => {
  const c1 = candle({ candleTime: '2022-01-03T03:45:00.000Z' });
  const c2 = candle({ candleTime: '2022-01-03T03:46:00.000Z' });
  const forward = computeSessionContentChecksum(payload({ candles: [c1, c2] }));
  const reversed = computeSessionContentChecksum(payload({ candles: [c2, c1] }));
  assert.equal(forward, reversed);
});

test('(C) a changed candle timestamp changes the checksum', () => {
  const base = computeSessionContentChecksum(payload());
  const mutated = computeSessionContentChecksum(payload({ candles: [candle({ candleTime: '2022-01-03T03:46:00.000Z' })] }));
  assert.notEqual(base, mutated);
});

test('(D) a changed OHLC field changes the checksum', () => {
  const base = computeSessionContentChecksum(payload());
  const mutated = computeSessionContentChecksum(payload({ candles: [candle({ close: '999.99' })] }));
  assert.notEqual(base, mutated);
});

test('(E) a changed volume changes the checksum', () => {
  const base = computeSessionContentChecksum(payload());
  const mutated = computeSessionContentChecksum(payload({ candles: [candle({ volume: '1001' })] }));
  assert.notEqual(base, mutated);
});

test('(F)/(G) option openInterest change and null-vs-zero distinctness change the checksum', () => {
  const withNull = computeSessionContentChecksum(payload({ candles: [candle({ openInterest: null })] }));
  const withZero = computeSessionContentChecksum(payload({ candles: [candle({ openInterest: '0' })] }));
  const withNonZero = computeSessionContentChecksum(payload({ candles: [candle({ openInterest: '500' })] }));
  assert.notEqual(withNull, withZero);
  assert.notEqual(withZero, withNonZero);
});

test('identity change (e.g. a different trading date) changes the checksum', () => {
  const base = computeSessionContentChecksum(payload());
  const mutated = computeSessionContentChecksum(payload({ identity: underlyingIdentity({ tradingDate: '2022-01-04' }) }));
  assert.notEqual(base, mutated);
});

test('a canonicalizationVersion/healthSemanticsVersion bump changes the checksum even for identical candle content', () => {
  const base = computeSessionContentChecksum(payload());
  const bumpedCanonicalization = computeSessionContentChecksum(payload({ canonicalizationVersion: 2 }));
  const bumpedHealth = computeSessionContentChecksum(payload({ healthSemanticsVersion: 2 }));
  assert.notEqual(base, bumpedCanonicalization);
  assert.notEqual(base, bumpedHealth);
});

test('(H) volatile fields are structurally impossible to include -- SessionContentPayload has no createdAt/updatedAt/generatedAt field at all', () => {
  const keys = Object.keys(payload());
  assert.deepEqual(keys.sort(), ['candles', 'canonicalizationVersion', 'healthSemanticsVersion', 'identity']);
});

function optionIdentity(overrides: Partial<OptionSessionIdentity> = {}): OptionSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M,
    provider: HistoricalProviderId.GROWW,
    providerContractId: 'NSE-NIFTY-06Jan22-17200-PE',
    optionType: HistoricalOptionType.PE,
    strikePrice: '17200',
    expiry: '2022-01-06T00:00:00.000Z',
    timeframe: '1minute',
    tradingDate: '2022-01-03',
    ...overrides,
  };
}

test('(J) dataset checksum is independent of session input order', () => {
  const sessionA = { identity: underlyingIdentity({ tradingDate: '2022-01-03' }), canonicalizationVersion: 1, healthSemanticsVersion: 1, contentChecksum: 'aaa' };
  const sessionB = { identity: underlyingIdentity({ tradingDate: '2022-01-04' }), canonicalizationVersion: 1, healthSemanticsVersion: 1, contentChecksum: 'bbb' };
  assert.equal(computeDatasetChecksum([sessionA, sessionB]), computeDatasetChecksum([sessionB, sessionA]));
});

test('(K)/(L) adding or removing a session changes the dataset checksum', () => {
  const sessionA = { identity: underlyingIdentity({ tradingDate: '2022-01-03' }), canonicalizationVersion: 1, healthSemanticsVersion: 1, contentChecksum: 'aaa' };
  const sessionB = { identity: underlyingIdentity({ tradingDate: '2022-01-04' }), canonicalizationVersion: 1, healthSemanticsVersion: 1, contentChecksum: 'bbb' };
  const withBoth = computeDatasetChecksum([sessionA, sessionB]);
  const withOnlyA = computeDatasetChecksum([sessionA]);
  assert.notEqual(withBoth, withOnlyA);
});

test('a session content-checksum mutation changes the dataset checksum', () => {
  const sessionA = { identity: underlyingIdentity({ tradingDate: '2022-01-03' }), canonicalizationVersion: 1, healthSemanticsVersion: 1, contentChecksum: 'aaa' };
  const mutated = { ...sessionA, contentChecksum: 'zzz' };
  assert.notEqual(computeDatasetChecksum([sessionA]), computeDatasetChecksum([mutated]));
});

test('(M) duplicate logical session identity is rejected, not silently deduplicated', () => {
  const identity = underlyingIdentity({ tradingDate: '2022-01-03' });
  assert.throws(() => assertNoDuplicateSessionIdentities([identity, { ...identity }]), /Duplicate logical session identity/);
});

test('distinct sessions (different trading date or different contract) never falsely flagged as duplicates', () => {
  assert.doesNotThrow(() => assertNoDuplicateSessionIdentities([underlyingIdentity({ tradingDate: '2022-01-03' }), underlyingIdentity({ tradingDate: '2022-01-04' })]));
  assert.doesNotThrow(() => assertNoDuplicateSessionIdentities([optionIdentity({ tradingDate: '2022-01-03' }), optionIdentity({ tradingDate: '2022-01-03', providerContractId: 'NSE-NIFTY-06Jan22-17300-PE' })]));
});

test('sessionIdentityKey is a pure function of identity content, independent of object identity', () => {
  assert.equal(sessionIdentityKey(underlyingIdentity()), sessionIdentityKey(underlyingIdentity()));
  assert.notEqual(sessionIdentityKey(underlyingIdentity()), sessionIdentityKey(underlyingIdentity({ tradingDate: '2022-01-04' })));
});

test('deriveDatasetId is content-addressed (derived from the checksum), never random, and is stable/human-readable', () => {
  const checksum = 'a'.repeat(64);
  const id = deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, checksum);
  assert.equal(id, `UNDERLYING_1M_${'a'.repeat(16)}`);
  assert.equal(deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, checksum), id); // deterministic, not random
});
