import { EventEmitter } from 'events';
import eventBus from '../../../core/events';
import { LiveCandleDto, LiveCandleTimeframe, NormalizedLiveTickDto } from '../dto/live-candle.dto';
import { MarketTickEvent } from '../processors/tick.processor';
import LiveCandleBuilderService from './live-candle-builder.service';

const supportedTimeframes: readonly LiveCandleTimeframe[] = ['1m', '2m', '3m', '5m'];

/** Bridges shared market ticks into completed in-memory candle events. */
export default class LiveCandleEventAdapterService {
  private started = false;
  private readonly emittedCandleKeys = new Set<string>();
  private readonly tickListener = (event: unknown): void => this.handleTick(event);

  constructor(
    private readonly candleBuilder: LiveCandleBuilderService,
    private readonly bus: EventEmitter = eventBus
  ) {}

  start(): void {
    if (this.started) return;
    this.bus.on('market.tick', this.tickListener);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.bus.off('market.tick', this.tickListener);
    this.started = false;
  }

  /** Flushes existing regular-session candles without accepting a post-market tick. */
  finishSession(instrumentKey?: string): void {
    this.candleBuilder.finishSession(instrumentKey).forEach((candle) => this.emitCompleted(candle));
  }

  private handleTick(event: unknown): void {
    const tick = this.normalizeTick(event);
    if (!tick) return;
    supportedTimeframes.forEach((timeframe) => {
      const result = this.candleBuilder.processTick(tick, timeframe);
      if (result.completedCandle) this.emitCompleted(result.completedCandle);
    });
  }

  private emitCompleted(candle: LiveCandleDto): void {
    const key = `${candle.instrumentKey}|${candle.timeframe}|${candle.candleTime.getTime()}`;
    if (this.emittedCandleKeys.has(key)) return;
    this.emittedCandleKeys.add(key);
    this.bus.emit('market.candle.completed', {
      ...candle,
      candleTime: new Date(candle.candleTime.getTime()),
      completed: true,
    } satisfies LiveCandleDto);
  }

  private normalizeTick(event: unknown): NormalizedLiveTickDto | undefined {
    if (!event || typeof event !== 'object') return undefined;
    const candidate = event as Partial<MarketTickEvent>;
    if (typeof candidate.instrumentKey !== 'string' || candidate.instrumentKey.trim().length === 0) return undefined;
    if (typeof candidate.timestamp !== 'string') return undefined;
    const timestamp = new Date(candidate.timestamp);
    if (Number.isNaN(timestamp.getTime())) return undefined;
    if (typeof candidate.ltp !== 'number' || !Number.isFinite(candidate.ltp) || candidate.ltp <= 0) return undefined;
    return { instrumentKey: candidate.instrumentKey, timestamp, ltp: candidate.ltp };
  }
}
