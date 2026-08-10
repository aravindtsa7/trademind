import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import { Candle } from '../../indicators/types';
import {
  HistoricalCandleWarmupRecord,
  minimumLivePaperStrategyCandles,
  paperStrategyWarmupInstrumentKey,
  paperStrategyWarmupTimeframe,
  PaperStrategyWarmupOptions,
  PaperStrategyWarmupRepository,
  PaperStrategyWarmupResult,
  PaperStrategyWarmupTarget,
  preferredLivePaperStrategyCandles,
} from '../dto/paper-strategy-warmup.dto';

const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinuteExclusive = 15 * 60 + 30;

interface CandleAggregator {
  aggregate(candles: readonly Candle[], timeframe: string, options?: {
    incompleteLeadingBucket?: 'discard';
    incompleteTrailingBucket?: 'discard';
  }): Candle[];
}

/**
 * Seeds the live strategy with completed, locally stored market history. It
 * neither evaluates the historical candles nor calls the paper orchestrator.
 */
export default class PaperStrategyWarmupService {
  constructor(
    private readonly repository: PaperStrategyWarmupRepository,
    private readonly strategyAdapter: PaperStrategyWarmupTarget,
    private readonly aggregator: CandleAggregator = new CandleTimeframeAggregatorService()
  ) {}

  async warmUp(options: PaperStrategyWarmupOptions = {}): Promise<PaperStrategyWarmupResult> {
    const { minimumFiveMinuteCandles, preferredFiveMinuteCandles } = this.resolveOptions(options);
    const records = await this.repository.findByInstrumentAndTimeframe(
      paperStrategyWarmupInstrumentKey,
      paperStrategyWarmupTimeframe
    );
    const oneMinuteCandles = this.toChronologicalSessionCandles(records);
    const completedFiveMinuteCandles = this.aggregator.aggregate(oneMinuteCandles, '5m', {
      incompleteLeadingBucket: 'discard',
      incompleteTrailingBucket: 'discard',
    });

    if (completedFiveMinuteCandles.length < minimumFiveMinuteCandles) {
      throw new Error(
        `Insufficient completed NIFTY 5-minute candle history for live paper-strategy warm-up: ${completedFiveMinuteCandles.length}/${minimumFiveMinuteCandles}.`
      );
    }

    const seededCandles = completedFiveMinuteCandles.slice(-preferredFiveMinuteCandles);
    this.strategyAdapter.seedHistoricalCandles(seededCandles);
    const first = seededCandles[0];
    const last = seededCandles[seededCandles.length - 1];

    return {
      instrumentKey: paperStrategyWarmupInstrumentKey,
      requestedMinimumCandles: minimumFiveMinuteCandles,
      oneMinuteCandlesLoaded: oneMinuteCandles.length,
      fiveMinuteCandlesProduced: seededCandles.length,
      firstFiveMinuteTimestamp: new Date(first.timestamp.getTime()),
      lastFiveMinuteTimestamp: new Date(last.timestamp.getTime()),
      warmupReady: this.strategyAdapter.isWarmupReady(),
    };
  }

  private resolveOptions(options: PaperStrategyWarmupOptions): Required<PaperStrategyWarmupOptions> {
    const minimumFiveMinuteCandles = options.minimumFiveMinuteCandles ?? minimumLivePaperStrategyCandles;
    const preferredFiveMinuteCandles = options.preferredFiveMinuteCandles ?? preferredLivePaperStrategyCandles;
    if (!Number.isInteger(minimumFiveMinuteCandles) || minimumFiveMinuteCandles < minimumLivePaperStrategyCandles) {
      throw new Error(`minimumFiveMinuteCandles must be an integer of at least ${minimumLivePaperStrategyCandles}.`);
    }
    if (!Number.isInteger(preferredFiveMinuteCandles) || preferredFiveMinuteCandles < minimumFiveMinuteCandles) {
      throw new Error('preferredFiveMinuteCandles must be an integer greater than or equal to minimumFiveMinuteCandles.');
    }
    return { minimumFiveMinuteCandles, preferredFiveMinuteCandles };
  }

  private toChronologicalSessionCandles(records: readonly HistoricalCandleWarmupRecord[]): Candle[] {
    const timestamps = new Set<number>();
    return records
      .map((record) => this.toCandle(record))
      .filter((candle) => this.isWithinMarketSession(candle.timestamp))
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .map((candle) => {
        const timestamp = candle.timestamp.getTime();
        if (timestamps.has(timestamp)) {
          throw new Error(`Duplicate historical one-minute candle timestamp during paper-strategy warm-up: ${candle.timestamp.toISOString()}.`);
        }
        timestamps.add(timestamp);
        return candle;
      });
  }

  private toCandle(record: HistoricalCandleWarmupRecord): Candle {
    if (!(record.candleTime instanceof Date) || Number.isNaN(record.candleTime.getTime())) {
      throw new Error('Historical warm-up candle has an invalid timestamp.');
    }
    const candle: Candle = {
      timestamp: new Date(record.candleTime.getTime()),
      open: Number(record.open),
      high: Number(record.high),
      low: Number(record.low),
      close: Number(record.close),
      volume: Number(record.volume),
      openInterest: record.openInterest === undefined || record.openInterest === null ? undefined : Number(record.openInterest),
    };
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
      || (candle.openInterest !== undefined && !Number.isFinite(candle.openInterest))) {
      throw new Error(`Historical warm-up candle has invalid numeric values at ${candle.timestamp.toISOString()}.`);
    }
    return candle;
  }

  private isWithinMarketSession(timestamp: Date): boolean {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(timestamp).map((part) => [part.type, part.value])
    );
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return minute >= marketSessionStartMinute && minute < marketSessionEndMinuteExclusive;
  }
}
