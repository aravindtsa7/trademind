import { EventEmitter } from 'events';
import eventBus from '../../../core/events';
import { LiveCandleDto, LiveCandleTimeframe, NormalizedLiveTickDto } from '../dto/live-candle.dto';
import { MarketTickEvent } from '../processors/tick.processor';
import { LiveGenerationCacheScope } from '../utils/live-generation-cache';
import { isCurrentLiveGeneration } from '../utils/live-generation';
import LiveCandleBuilderService from './live-candle-builder.service';

const supportedTimeframes: readonly LiveCandleTimeframe[] = ['1m', '2m', '3m', '5m'];

/** Bridges shared market ticks into completed in-memory candle events. */
export default class LiveCandleEventAdapterService {
  private started = false;
  private readonly emittedCandleKeys = new Set<string>();
  private readonly liveGenerationScope = new LiveGenerationCacheScope();
  private readonly tickListener = (event: unknown): void => this.handleTick(event);

  constructor(
    private readonly candleBuilder: LiveCandleBuilderService,
    private readonly bus: EventEmitter = eventBus,
    /** Omitted for replay/offline adapters that have no live socket generation. */
    private readonly getActiveGenerationId?: () => number | undefined,
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
    if (this.getActiveGenerationId) {
      const activeGenerationId = this.getActiveGenerationId();
      if (!isCurrentLiveGeneration(this.liveGenerationScope.getGenerationId(), activeGenerationId)) {
        // The socket advanced without delivering a current-generation tick.
        // Retired-generation candles must not be surfaced by wall-clock EOD.
        this.retireLiveGenerationState();
        return;
      }
    }
    this.candleBuilder.finishSession(instrumentKey).forEach((candle) => this.emitCompleted(candle));
  }

  private handleTick(event: unknown): void {
    if (this.getActiveGenerationId && !this.acceptCurrentLiveGeneration(event)) return;
    const tick = this.normalizeTick(event);
    if (!tick) return;
    supportedTimeframes.forEach((timeframe) => {
      const result = this.candleBuilder.processTick(tick, timeframe);
      if (result.completedCandle) this.emitCompleted(result.completedCandle);
    });
  }

  private acceptCurrentLiveGeneration(event: unknown): boolean {
    if (!event || typeof event !== 'object') return false;
    const candidate = event as Partial<MarketTickEvent>;
    const activeGenerationId = this.getActiveGenerationId?.();
    if (!isCurrentLiveGeneration(candidate.generationId, activeGenerationId)) return false;
    return this.liveGenerationScope.accept(
      candidate.generationId,
      activeGenerationId,
      () => this.retireLiveGenerationState(),
    );
  }

  private retireLiveGenerationState(): void {
    // A live candle and its chronological watermark belong to one socket
    // generation. Retire both before a new generation can process or flush.
    this.candleBuilder.reset();
    this.emittedCandleKeys.clear();
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
