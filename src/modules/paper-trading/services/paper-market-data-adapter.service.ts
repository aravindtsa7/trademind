import { EventEmitter } from 'events';
import eventBus from '../../../core/events';
import { MarketTickEvent } from '../../market-data/processors/tick.processor';
import { PaperPositionMonitoringResult } from '../types/paper-trading.types';
import PaperPositionMonitorService from './paper-position-monitor.service';

/**
 * Bridges the shared market.tick stream into paper-position monitoring. This
 * class owns only one event listener; it does not own a WebSocket connection.
 */
export default class PaperMarketDataAdapterService {
  private started = false;
  private marketDataAvailable = true;
  private readonly tickListener = (tick: unknown): void => this.handleTick(tick);

  constructor(
    private readonly positionMonitor: PaperPositionMonitorService,
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

  /** Reconnect safety gate; retains listeners but never advances paper exits over an unknown market-data interval. */
  setMarketDataAvailable(available: boolean): void { this.marketDataAvailable = available; }

  private handleTick(tick: unknown): void {
    if (!this.marketDataAvailable) return;
    const update = this.normalizeTick(tick);
    if (!update) return;
    const actions = this.positionMonitor.monitor(update);
    actions.filter((action) => action.action !== 'NONE').forEach((action) => {
      this.bus.emit('paper.order.action', action);
    });
  }

  private normalizeTick(tick: unknown): { instrumentKey: string; timestamp: Date; premium: number } | undefined {
    if (!tick || typeof tick !== 'object') return undefined;
    const candidate = tick as Partial<MarketTickEvent>;
    if (typeof candidate.instrumentKey !== 'string' || candidate.instrumentKey.trim().length === 0) return undefined;
    if (typeof candidate.ltp !== 'number' || !Number.isFinite(candidate.ltp) || candidate.ltp <= 0) return undefined;
    const timestamp = typeof candidate.timestamp === 'string' ? new Date(candidate.timestamp) : undefined;
    if (!timestamp || Number.isNaN(timestamp.getTime())) return undefined;
    return { instrumentKey: candidate.instrumentKey, timestamp, premium: candidate.ltp };
  }
}
