import { Candle, CandleTimeframeAggregationOptions, IncompleteBucketHandling } from '../types';

const oneMinuteMs = 60_000;
const marketSessionStartMinute = 9 * 60 + 15;
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const timeframeMinutes: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '60m': 60,
};

interface MarketTime {
  marketDate: string;
  minuteOfDay: number;
}

interface CandleBucket {
  marketDate: string;
  startMinute: number;
  candles: Candle[];
}

export default class CandleTimeframeAggregatorService {
  aggregate(
    candles: readonly Candle[],
    timeframe: string,
    options: CandleTimeframeAggregationOptions = {}
  ): Candle[] {
    const bucketSize = this.getBucketSize(timeframe);
    const sortedCandles = [...candles].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
    );

    this.validateCandleValues(sortedCandles);

    if (bucketSize === 1) {
      return sortedCandles;
    }

    const buckets = this.createSessionAnchoredBuckets(sortedCandles, bucketSize);
    return this.aggregateBuckets(buckets, bucketSize, timeframe, options);
  }

  private getBucketSize(timeframe: string): number {
    const bucketSize = timeframeMinutes[timeframe];
    if (!bucketSize) {
      throw new Error(`Unsupported candle timeframe: ${timeframe}`);
    }

    return bucketSize;
  }

  private validateCandleValues(candles: Candle[]): void {
    candles.forEach((candle) => {
      if (
        Number.isNaN(candle.timestamp.getTime()) ||
        candle.timestamp.getTime() % oneMinuteMs !== 0 ||
        !Number.isFinite(candle.open) ||
        !Number.isFinite(candle.high) ||
        !Number.isFinite(candle.low) ||
        !Number.isFinite(candle.close) ||
        !Number.isFinite(candle.volume) ||
        (candle.openInterest !== undefined && !Number.isFinite(candle.openInterest))
      ) {
        throw new Error('Candle aggregation received an invalid one-minute candle.');
      }
    });
  }

  private createSessionAnchoredBuckets(candles: Candle[], bucketSize: number): CandleBucket[] {
    const buckets = new Map<string, CandleBucket>();

    candles.forEach((candle) => {
      const marketTime = this.getMarketTime(candle.timestamp);
      if (marketTime.minuteOfDay < marketSessionStartMinute) {
        throw new Error('Candle aggregation only supports timestamps at or after 09:15 IST.');
      }

      const startMinute =
        marketSessionStartMinute +
        Math.floor((marketTime.minuteOfDay - marketSessionStartMinute) / bucketSize) * bucketSize;
      const key = `${marketTime.marketDate}:${startMinute}`;
      const bucket = buckets.get(key) ?? {
        marketDate: marketTime.marketDate,
        startMinute,
        candles: [],
      };

      bucket.candles.push(candle);
      buckets.set(key, bucket);
    });

    return Array.from(buckets.values());
  }

  private aggregateBuckets(
    buckets: CandleBucket[],
    bucketSize: number,
    timeframe: string,
    options: CandleTimeframeAggregationOptions
  ): Candle[] {
    const bucketsByDate = new Map<string, CandleBucket[]>();
    buckets.forEach((bucket) => {
      const dailyBuckets = bucketsByDate.get(bucket.marketDate) ?? [];
      dailyBuckets.push(bucket);
      bucketsByDate.set(bucket.marketDate, dailyBuckets);
    });

    const aggregatedCandles: Candle[] = [];
    bucketsByDate.forEach((dailyBuckets) => {
      dailyBuckets.forEach((bucket, index) => {
        const isLeadingBucket = index === 0;
        const isTrailingBucket = index === dailyBuckets.length - 1;

        this.validateBucketContinuity(bucket.candles);

        if (!this.isCompleteBucket(bucket, bucketSize)) {
          if (this.shouldDiscardBucket(bucket, bucketSize, isLeadingBucket, isTrailingBucket, options)) {
            return;
          }

          throw new Error(this.getIncompleteBucketMessage(bucket, bucketSize, timeframe, isLeadingBucket, isTrailingBucket));
        }

        aggregatedCandles.push(this.aggregateBucket(bucket.candles));
      });
    });

    return aggregatedCandles;
  }

  private isCompleteBucket(bucket: CandleBucket, bucketSize: number): boolean {
    const firstMinute = this.getMarketTime(bucket.candles[0].timestamp).minuteOfDay;
    const lastMinute = this.getMarketTime(bucket.candles[bucket.candles.length - 1].timestamp).minuteOfDay;

    return (
      bucket.candles.length === bucketSize &&
      firstMinute === bucket.startMinute &&
      lastMinute === bucket.startMinute + bucketSize - 1
    );
  }

  private shouldDiscardBucket(
    bucket: CandleBucket,
    bucketSize: number,
    isLeadingBucket: boolean,
    isTrailingBucket: boolean,
    options: CandleTimeframeAggregationOptions
  ): boolean {
    const firstMinute = this.getMarketTime(bucket.candles[0].timestamp).minuteOfDay;
    const lastMinute = this.getMarketTime(bucket.candles[bucket.candles.length - 1].timestamp).minuteOfDay;
    const hasIncompleteLeadingEdge = firstMinute !== bucket.startMinute;
    const hasIncompleteTrailingEdge = lastMinute !== bucket.startMinute + bucketSize - 1;

    if ((hasIncompleteLeadingEdge && !isLeadingBucket) || (hasIncompleteTrailingEdge && !isTrailingBucket)) {
      return false;
    }

    return (
      (!hasIncompleteLeadingEdge || options.incompleteLeadingBucket === 'discard') &&
      (!hasIncompleteTrailingEdge || options.incompleteTrailingBucket === 'discard')
    );
  }

  private getIncompleteBucketMessage(
    bucket: CandleBucket,
    bucketSize: number,
    timeframe: string,
    isLeadingBucket: boolean,
    isTrailingBucket: boolean
  ): string {
    const firstMinute = this.getMarketTime(bucket.candles[0].timestamp).minuteOfDay;
    const lastMinute = this.getMarketTime(bucket.candles[bucket.candles.length - 1].timestamp).minuteOfDay;
    const hasIncompleteLeadingEdge = firstMinute !== bucket.startMinute;
    const hasIncompleteTrailingEdge = lastMinute !== bucket.startMinute + bucketSize - 1;

    if (hasIncompleteLeadingEdge && isLeadingBucket) {
      return `Incomplete leading ${timeframe} candle bucket for ${bucket.marketDate}.`;
    }

    if (hasIncompleteTrailingEdge && isTrailingBucket) {
      return `Incomplete trailing ${timeframe} candle bucket for ${bucket.marketDate}.`;
    }

    return `Incomplete ${timeframe} candle bucket for ${bucket.marketDate}.`;
  }

  private validateBucketContinuity(candles: Candle[]): void {
    candles.forEach((candle, index) => {
      if (index > 0 && candle.timestamp.getTime() - candles[index - 1].timestamp.getTime() !== oneMinuteMs) {
        throw new Error('Candle aggregation requires contiguous one-minute candles within a bucket.');
      }
    });
  }

  private getMarketTime(timestamp: Date): MarketTime {
    const values = Object.fromEntries(
      marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])
    );

    return {
      marketDate: `${values.year}-${values.month}-${values.day}`,
      minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
    };
  }

  private aggregateBucket(candles: Candle[]): Candle {
    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];

    return {
      timestamp: firstCandle.timestamp,
      open: firstCandle.open,
      high: Math.max(...candles.map((candle) => candle.high)),
      low: Math.min(...candles.map((candle) => candle.low)),
      close: lastCandle.close,
      volume: candles.reduce((total, candle) => total + candle.volume, 0),
      openInterest: lastCandle.openInterest,
    };
  }
}
