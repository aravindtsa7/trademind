import eventBus from '../../../core/events';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { LivePaperCompletedCandleInput, LivePaperStrategyResult } from '../dto/live-paper-strategy.dto';
import {
  PaperTradingRuntimeEventBus,
  PaperTradingRuntimeMarketDataAdapter,
  PaperTradingRuntimeOrderManager,
  PaperTradingRuntimeState,
  PaperTradingRuntimeStatus,
  PaperTradingRuntimeStopResult,
  PaperTradingRuntimeStrategyAdapter,
} from '../dto/paper-trading-runtime.dto';
import { PaperOrderStatus, PaperPositionMonitoringResult } from '../types/paper-trading.types';

/** Coordinates existing paper-trading components during a live session. */
export default class PaperTradingRuntimeService {
  private state = PaperTradingRuntimeState.STOPPED;
  private startedAt: Date | null = null;
  private stoppedAt: Date | null = null;
  private counters = {
    completedCandlesProcessed: 0,
    noTradeEvaluations: 0,
    filteredSignals: 0,
    paperOrdersCreated: 0,
    targetExits: 0,
    stopExits: 0,
    timeExits: 0,
  };
  private readonly actionListener = (event: unknown): void => this.handleOrderAction(event);

  constructor(
    private readonly strategyAdapter: PaperTradingRuntimeStrategyAdapter,
    private readonly marketDataAdapter: PaperTradingRuntimeMarketDataAdapter,
    private readonly orderManager: PaperTradingRuntimeOrderManager,
    private readonly bus: PaperTradingRuntimeEventBus = eventBus
  ) {}

  start(): PaperTradingRuntimeStatus {
    if (this.state === PaperTradingRuntimeState.RUNNING || this.state === PaperTradingRuntimeState.STARTING) return this.getStatus();
    if (this.state === PaperTradingRuntimeState.STOPPING) throw new Error('Paper trading runtime is stopping.');

    this.state = PaperTradingRuntimeState.STARTING;
    try {
      this.counters = {
        completedCandlesProcessed: 0,
        noTradeEvaluations: 0,
        filteredSignals: 0,
        paperOrdersCreated: 0,
        targetExits: 0,
        stopExits: 0,
        timeExits: 0,
      };
      this.marketDataAdapter.start();
      this.bus.on('paper.order.action', this.actionListener);
      this.startedAt = new Date();
      this.stoppedAt = null;
      this.state = PaperTradingRuntimeState.RUNNING;
      return this.getStatus();
    } catch (error) {
      this.bus.off('paper.order.action', this.actionListener);
      this.state = PaperTradingRuntimeState.STOPPED;
      throw error;
    }
  }

  stop(): PaperTradingRuntimeStopResult {
    if (this.state === PaperTradingRuntimeState.STOPPED || this.state === PaperTradingRuntimeState.STOPPING) {
      const status = this.getStatus();
      return { status, openOrdersRemaining: status.activeOrderCount };
    }

    this.state = PaperTradingRuntimeState.STOPPING;
    try {
      this.marketDataAdapter.stop();
    } finally {
      this.bus.off('paper.order.action', this.actionListener);
      this.stoppedAt = new Date();
      this.state = PaperTradingRuntimeState.STOPPED;
    }
    const status = this.getStatus();
    return { status, openOrdersRemaining: status.activeOrderCount };
  }

  getState(): PaperTradingRuntimeState {
    return this.state;
  }

  getStatus(): PaperTradingRuntimeStatus {
    return {
      state: this.state,
      startedAt: this.startedAt ? new Date(this.startedAt.getTime()) : null,
      stoppedAt: this.stoppedAt ? new Date(this.stoppedAt.getTime()) : null,
      ...this.counters,
      activeOrderCount: this.orderManager.getActiveOrders().length,
      warmupReady: this.strategyAdapter.isWarmupReady?.() ?? false,
    };
  }

  async processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> {
    if (this.state !== PaperTradingRuntimeState.RUNNING) {
      throw new Error('Paper trading runtime must be RUNNING before processing completed candles.');
    }
    const result = await this.strategyAdapter.processCompletedCandle(input);
    if (!result.processed) return result;

    this.counters.completedCandlesProcessed += 1;
    if (result.finalSignal === StrategySignal.NO_TRADE) this.counters.noTradeEvaluations += 1;
    if (!result.timeFilterAllowed && (result.rawEmaSignal === StrategySignal.BUY_CE || result.rawEmaSignal === StrategySignal.BUY_PE)) {
      this.counters.filteredSignals += 1;
    }
    if (result.orchestration) this.counters.paperOrdersCreated += 1;
    return result;
  }

  private handleOrderAction(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const action = (event as Partial<PaperPositionMonitoringResult>).action;
    if (action === PaperOrderStatus.TARGET_EXIT) this.counters.targetExits += 1;
    else if (action === PaperOrderStatus.STOP_EXIT) this.counters.stopExits += 1;
    else if (action === PaperOrderStatus.TIME_EXIT) this.counters.timeExits += 1;
  }
}
