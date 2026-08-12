import { EventEmitter } from 'events';
import eventBus from '../../../core/events';
import { LiveCandleDto } from '../../market-data/dto/live-candle.dto';
import { Candle } from '../../indicators/types';
import { OptionContract } from '../../options/types';
import { LivePaperCompletedCandleInput, LivePaperStrategyResult } from '../dto/live-paper-strategy.dto';
import { PaperTradingRuntimeState } from '../dto/paper-trading-runtime.dto';

const niftyInstrumentKey = 'NSE_INDEX|Nifty 50';

export interface PaperRuntimeCandleContractsProvider {
  getContracts(): readonly OptionContract[] | Promise<readonly OptionContract[]>;
}

export interface PaperRuntimeCandleRuntime {
  getState(): PaperTradingRuntimeState;
  processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult>;
}

/** Bridges completed NIFTY 5m candles into the running paper-trading runtime. */
export default class PaperRuntimeCandleAdapterService {
  private started = false;
  private pending = Promise.resolve();
  private readonly candleListener = (event: unknown): void => {
    this.pending = this.pending.then(() => this.handleCandle(event));
  };

  constructor(
    private readonly runtime: PaperRuntimeCandleRuntime,
    private readonly contractsProvider: PaperRuntimeCandleContractsProvider,
    private readonly bus: EventEmitter = eventBus
  ) {}

  start(): void {
    if (this.started) return;
    this.bus.on('market.candle.completed', this.candleListener);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.bus.off('market.candle.completed', this.candleListener);
    this.started = false;
  }

  /** Allows EOD to include the final emitted 5m candle before stopping runtime state. */
  async drain(): Promise<void> { await this.pending; }

  private async handleCandle(event: unknown): Promise<void> {
    const candle = this.normalizeCandle(event);
    if (!candle || this.runtime.getState() !== PaperTradingRuntimeState.RUNNING) return;
    try {
      const contracts = await this.contractsProvider.getContracts();
      const result = await this.runtime.processCompletedCandle({
        candle: toIndicatorCandle(candle),
        completed: true,
        contracts,
      });
      this.bus.emit('paper.strategy.evaluated', {
        candleTimestamp: new Date(result.candleTimestamp.getTime()),
        spotPrice: result.spotPrice,
        rawSignal: result.rawEmaSignal,
        finalSignal: result.finalSignal,
        timeFilterAllowed: result.timeFilterAllowed,
        reasons: [...result.reasons],
        paperOrderId: result.orchestration?.order.id,
      });
    } catch (error) {
      this.bus.emit('paper.strategy.error', {
        instrumentKey: candle.instrumentKey,
        candleTimestamp: new Date(candle.candleTime.getTime()),
        message: error instanceof Error ? error.message : 'Paper strategy evaluation failed.',
      });
    }
  }

  private normalizeCandle(event: unknown): LiveCandleDto | undefined {
    if (!event || typeof event !== 'object') return undefined;
    const candidate = event as Partial<LiveCandleDto>;
    if (candidate.instrumentKey !== niftyInstrumentKey || candidate.timeframe !== '5m' || candidate.completed !== true) return undefined;
    if (!(candidate.candleTime instanceof Date) || Number.isNaN(candidate.candleTime.getTime())) return undefined;
    if (![candidate.open, candidate.high, candidate.low, candidate.close].every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
    if ((candidate.close as number) <= 0 || (candidate.high as number) < (candidate.low as number) || (candidate.open as number) < (candidate.low as number) || (candidate.open as number) > (candidate.high as number) || (candidate.close as number) < (candidate.low as number) || (candidate.close as number) > (candidate.high as number)) return undefined;
    return {
      instrumentKey: candidate.instrumentKey,
      timeframe: '5m',
      candleTime: new Date(candidate.candleTime.getTime()),
      open: candidate.open as number,
      high: candidate.high as number,
      low: candidate.low as number,
      close: candidate.close as number,
      completed: true,
    };
  }
}

function toIndicatorCandle(candle: LiveCandleDto): Candle {
  // EMA/RSI do not use volume. Zero explicitly represents unavailable index volume,
  // not an invented traded-volume value.
  return { timestamp: new Date(candle.candleTime.getTime()), open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: 0 };
}
