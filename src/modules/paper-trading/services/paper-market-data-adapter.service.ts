import { EventEmitter } from 'events';
import eventBus from '../../../core/events';
import { MarketTickEvent } from '../../market-data/processors/tick.processor';
import { PaperPositionMonitoringResult } from '../types/paper-trading.types';
import PaperPositionMonitorService from './paper-position-monitor.service';
import PaperPortfolioService from './paper-portfolio.service';

/**
 * Bridges the shared market.tick stream into paper-position monitoring. This
 * class owns only one event listener; it does not own a WebSocket connection.
 */
export default class PaperMarketDataAdapterService {
  private started = false;
  private marketDataAvailable = true;
  private readonly tickListener = (tick: unknown): void => this.handleTick(tick);
  private readonly depthListener = (depth: unknown): void => this.handleDepth(depth);
  private readonly depthByInstrument = new Map<string, { bid?: number; ask?: number; timestamp?: string }>();
  private readonly latestPremiumByInstrument = new Map<string, { premium: number; timestamp: Date }>();

  constructor(
    private readonly positionMonitor: PaperPositionMonitorService,
    private readonly bus: EventEmitter = eventBus,
    private readonly portfolio?: PaperPortfolioService,
    private readonly maxQuoteAgeMs = 2_000,
  ) {}

  start(): void {
    if (this.started) return;
    this.bus.on('market.tick', this.tickListener);
    this.bus.on('market.depth', this.depthListener);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.bus.off('market.tick', this.tickListener);
    this.bus.off('market.depth', this.depthListener);
    this.started = false;
  }

  /** Reconnect safety gate; retains listeners but never advances paper exits over an unknown market-data interval. */
  setMarketDataAvailable(available: boolean): void { this.marketDataAvailable = available; }

  private handleTick(tick: unknown): void {
    if (!this.marketDataAvailable) return;
    const update = this.normalizeTick(tick);
    if (!update) return;
    this.latestPremiumByInstrument.set(update.instrumentKey, { premium: update.premium, timestamp: new Date(update.timestamp.getTime()) });
    const depth = this.depthByInstrument.get(update.instrumentKey);
    const quoteTimestamp = depth?.timestamp ? new Date(depth.timestamp) : undefined;
    const ageMs = quoteTimestamp && !Number.isNaN(quoteTimestamp.getTime()) ? update.timestamp.getTime() - quoteTimestamp.getTime() : undefined;
    this.portfolio?.mark({ instrumentKey: update.instrumentKey, timestamp: update.timestamp, bid: depth?.bid, ask: depth?.ask, ltp: update.premium, ageMs, maxAgeMs: this.maxQuoteAgeMs });
    const actions = this.positionMonitor.monitor(update);
    actions.filter((action) => action.action !== 'NONE').forEach((action) => {
      this.bus.emit('paper.order.action', action);
    });
  }

  private handleDepth(depth: unknown): void {
    if (!depth || typeof depth !== 'object') return;
    const candidate = depth as { instrumentKey?: unknown; timestamp?: unknown; quotes?: Array<{ bidPrice?: unknown; askPrice?: unknown }> };
    if (typeof candidate.instrumentKey !== 'string') return;
    const top = candidate.quotes?.[0];
    const timestamp = typeof candidate.timestamp === 'string' ? candidate.timestamp : undefined;
    const quote = { bid: typeof top?.bidPrice === 'number' ? top.bidPrice : undefined, ask: typeof top?.askPrice === 'number' ? top.askPrice : undefined, timestamp };
    this.depthByInstrument.set(candidate.instrumentKey, quote);
    const latest = this.latestPremiumByInstrument.get(candidate.instrumentKey);
    const quoteTime = timestamp ? new Date(timestamp) : undefined;
    if (latest && quoteTime && !Number.isNaN(quoteTime.getTime())) {
      this.portfolio?.mark({ instrumentKey: candidate.instrumentKey, timestamp: quoteTime, bid: quote.bid, ask: quote.ask, ltp: latest.premium, ageMs: Math.max(0, quoteTime.getTime() - latest.timestamp.getTime()), maxAgeMs: this.maxQuoteAgeMs });
    }
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
