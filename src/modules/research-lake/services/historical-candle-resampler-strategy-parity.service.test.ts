import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import AdaptiveMarketRegimeService from '../../adaptive-intraday/services/adaptive-market-regime.service';
import { Candle } from '../../indicators/types';
import { prepareCrossSessionIndicatorWarmup } from '../../../tests/helpers/cross-session-indicator-warmup';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  HEALTH_SEMANTICS_VERSION,
  ManifestDatasetKind,
  SessionContentIdentity,
  UnderlyingSessionIdentity,
  computeSessionContentChecksum,
} from '../domain/dataset-manifest.types';
import { toManifestCandleContent } from '../domain/canonical-candle-parquet-codec';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import HistoricalCandleResamplerService, { ResampleSessionRequest } from './historical-candle-resampler.service';
import { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';

const resampler = new HistoricalCandleResamplerService();
const aggregator = new CandleTimeframeAggregatorService();
const TRADING_DATE = '2026-08-03';

function sessionStartMs(): number {
  return new Date(`${TRADING_DATE}T09:15:00+05:30`).getTime();
}

function candleFixture(): Candle[] {
  return Array.from({ length: 375 }, (_, index) => {
    const price = 100 + index;
    return {
      timestamp: new Date(sessionStartMs() + index * 60_000),
      open: price,
      high: price + 2,
      low: price - 1,
      close: price + 1,
      volume: 10 + index,
    };
  });
}

function resamplerRows(): PersistedManifestCandleRow[] {
  return Array.from({ length: 375 }, (_, index) => {
    const price = 100 + index;
    return {
      candleTime: new Date(sessionStartMs() + index * 60_000),
      open: new Prisma.Decimal(price),
      high: new Prisma.Decimal(price + 2),
      low: new Prisma.Decimal(price - 1),
      close: new Prisma.Decimal(price + 1),
      volume: BigInt(10 + index),
      openInterest: null,
    };
  });
}

function identity(): UnderlyingSessionIdentity {
  return {
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    provider: HistoricalProviderId.UPSTOX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: TRADING_DATE,
  };
}

function computeB5Checksum(rows: readonly PersistedManifestCandleRow[], ident: SessionContentIdentity): string {
  return computeSessionContentChecksum({
    identity: ident,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    candles: rows.map(toManifestCandleContent),
  });
}

function b7Request(timeframe: ResampleTargetTimeframe): ResampleSessionRequest {
  const rows = resamplerRows();
  const ident = identity();
  return {
    targetTimeframe: timeframe,
    tradingDate: TRADING_DATE,
    sourceDatasetKind: ManifestDatasetKind.UNDERLYING_1M,
    sourceSessionIdentity: ident,
    sourceSessionContentChecksum: computeB5Checksum(rows, ident),
    sourceRows: rows,
  };
}

function assertCandleParity(live: readonly Candle[], derived: ReturnType<HistoricalCandleResamplerService['resampleSession']>['candles']): void {
  assert.equal(live.length, derived.length);
  live.forEach((liveCandle, index) => {
    const derivedCandle = derived[index];
    assert.equal(liveCandle.timestamp.getTime(), derivedCandle.bucketStart.getTime());
    assert.equal(liveCandle.open, Number(derivedCandle.open.toString()));
    assert.equal(liveCandle.high, Number(derivedCandle.high.toString()));
    assert.equal(liveCandle.low, Number(derivedCandle.low.toString()));
    assert.equal(liveCandle.close, Number(derivedCandle.close.toString()));
    assert.equal(liveCandle.volume, Number(derivedCandle.volume));
  });
}

// (AP) V2 5m first/last bucket parity
test('(AP) V2 5m parity: CandleTimeframeAggregatorService(\'5m\') matches B-F7 5m bucket-for-bucket', () => {
  const live = aggregator.aggregate(candleFixture(), '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' });
  const derived = resampler.resampleSession(b7Request(ResampleTargetTimeframe.FIVE_MINUTE)).candles;
  assert.equal(live.length, 75);
  assertCandleParity(live, derived);
  assert.equal(live[0].timestamp.toISOString(), derived[0].bucketStart.toISOString());
  assert.equal(live[live.length - 1].timestamp.toISOString(), derived[derived.length - 1].bucketStart.toISOString());
});

// (AQ) V4 3m first/last bucket parity
test('(AQ) V4 3m parity: CandleTimeframeAggregatorService(\'3m\') matches B-F7 3m bucket-for-bucket', () => {
  const live = aggregator.aggregate(candleFixture(), '3m');
  const derived = resampler.resampleSession(b7Request(ResampleTargetTimeframe.THREE_MINUTE)).candles;
  assert.equal(live.length, 125);
  assertCandleParity(live, derived);
  assert.equal(live[0].timestamp.toISOString(), derived[0].bucketStart.toISOString());
  assert.equal(live[live.length - 1].timestamp.toISOString(), derived[derived.length - 1].bucketStart.toISOString());
});

// (AR) V8 2m first/last complete bucket parity using actual runtime path
test('(AR) V8 2m parity: the actual runtime prepareCrossSessionIndicatorWarmup path matches B-F7 2m bucket-for-bucket, including the excluded 15:29 tail', () => {
  const prepared = prepareCrossSessionIndicatorWarmup(
    [{ date: TRADING_DATE, candles: candleFixture() }],
    new CandleTimeframeAggregatorService(),
    new IndicatorEngineService(),
    new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: .05, highVolatilityThreshold: .1, lowVolatilityThreshold: .05 }),
  );
  const live = prepared[0].frames[2].candles;
  const derived = resampler.resampleSession(b7Request(ResampleTargetTimeframe.TWO_MINUTE)).candles;
  assert.equal(live.length, 187);
  assertCandleParity(live, derived);
  assert.equal(live[0].timestamp.toISOString(), derived[0].bucketStart.toISOString());
  assert.equal(live[live.length - 1].timestamp.toISOString(), derived[derived.length - 1].bucketStart.toISOString());
  // Neither side ever turns the lone trailing 15:29 minute into a 2m candle.
  const trailingMinuteStart = new Date(sessionStartMs() + 374 * 60_000).getTime();
  assert.ok(!live.some((c) => c.timestamp.getTime() === trailingMinuteStart));
  assert.ok(!derived.some((c) => c.bucketStart.getTime() === trailingMinuteStart));
});
