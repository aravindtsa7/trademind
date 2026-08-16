import { EventEmitter } from 'events';
import eventBus from '../../../core/events';
import { MarketTickEvent } from '../../market-data/processors/tick.processor';
import { PaperPositionMonitoringResult } from '../types/paper-trading.types';
import PaperPositionMonitorService from './paper-position-monitor.service';
import PaperPortfolioService from './paper-portfolio.service';
import { ExecutionQuoteSnapshot } from '../dto/paper-fill-model.dto';

/**
 * Bridges the shared market.tick stream into paper-position monitoring. This
 * class owns only one event listener; it does not own a WebSocket connection.
 */
export default class PaperMarketDataAdapterService {
  private started = false;
  private marketDataAvailable = true;
  private readonly tickListener = (tick: unknown): void => this.handleTick(tick);
  private readonly depthListener = (depth: unknown): void => this.handleDepth(depth);
  private readonly depthByInstrument = new Map<string, { bid?: number; ask?: number; bidSize?: number; askSize?: number; timestamp?: string; levels: readonly { bid?: number; ask?: number; bidSize?: number; askSize?: number }[]; generationId?: number }>();
  private readonly latestPremiumByInstrument = new Map<string, { premium: number; timestamp: Date }>();
  private readonly executionQuotes = new Map<string, ExecutionQuoteSnapshot>();

  constructor(
    private readonly positionMonitor: PaperPositionMonitorService,
    private readonly bus: EventEmitter = eventBus,
    private readonly portfolio?: PaperPortfolioService,
    private readonly maxQuoteAgeMs = 2_000,
    private readonly now = () => new Date(),
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
    this.refreshExecutionQuote(update.instrumentKey);
    const actions = this.positionMonitor.monitor(update);
    actions.filter((action) => action.action !== 'NONE').forEach((action) => {
      this.bus.emit('paper.order.action', action);
    });
  }

  private handleDepth(depth: unknown): void {
    if (!depth || typeof depth !== 'object') return;
    const candidate = depth as { instrumentKey?: unknown; timestamp?: unknown; generationId?: unknown; quotes?: Array<{ bidPrice?: unknown; askPrice?: unknown; bidQuantity?: unknown; askQuantity?: unknown }> };
    if (typeof candidate.instrumentKey !== 'string') return;
    const top = candidate.quotes?.[0];
    const timestamp = typeof candidate.timestamp === 'string' ? candidate.timestamp : undefined;
    const levels = candidate.quotes?.map((value) => ({ bid: finite(value.bidPrice), ask: finite(value.askPrice), bidSize: numeric(value.bidQuantity), askSize: numeric(value.askQuantity) })) ?? [];
    const quote = { bid: typeof top?.bidPrice === 'number' ? top.bidPrice : undefined, ask: typeof top?.askPrice === 'number' ? top.askPrice : undefined, bidSize:numeric(top?.bidQuantity), askSize:numeric(top?.askQuantity), timestamp, levels, generationId: typeof candidate.generationId === 'number' ? candidate.generationId : undefined };
    this.depthByInstrument.set(candidate.instrumentKey, quote);
    const latest = this.latestPremiumByInstrument.get(candidate.instrumentKey);
    const quoteTime = timestamp ? new Date(timestamp) : undefined;
    if (latest && quoteTime && !Number.isNaN(quoteTime.getTime())) {
      this.portfolio?.mark({ instrumentKey: candidate.instrumentKey, timestamp: quoteTime, bid: quote.bid, ask: quote.ask, ltp: latest.premium, ageMs: Math.max(0, quoteTime.getTime() - latest.timestamp.getTime()), maxAgeMs: this.maxQuoteAgeMs });
    }
    this.refreshExecutionQuote(candidate.instrumentKey);
  }

  /** Snapshot is immutable, explicit about quality, and safe for PaperFillModel. */
  getExecutionQuoteSnapshot(instrumentKey: string): ExecutionQuoteSnapshot | undefined {
    const quote = this.executionQuotes.get(instrumentKey);
    return quote ? structuredClone(quote) : undefined;
  }

  /** Live-only bounded wait; replay supplies recorded snapshots directly. */
  async waitForExecutionQuote(instrumentKey: string, eligibleAt: Date, timeoutMs: number): Promise<ExecutionQuoteSnapshot | undefined> {
    const deadline = this.now().getTime() + timeoutMs;
    while (this.now().getTime() <= deadline) {
      const snapshot = this.getExecutionQuoteSnapshot(instrumentKey);
      const source = snapshot?.sourceTimestamp ? new Date(snapshot.sourceTimestamp).getTime() : Number.NaN;
      if (snapshot && Number.isFinite(source) && source >= eligibleAt.getTime()) return snapshot;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  private refreshExecutionQuote(instrumentKey: string): void {
    const depth = this.depthByInstrument.get(instrumentKey); const ltp = this.latestPremiumByInstrument.get(instrumentKey);
    const sourceTimestamp = depth?.timestamp ?? ltp?.timestamp.toISOString() ?? null;
    const source = sourceTimestamp ? new Date(sourceTimestamp) : undefined; const received = this.now();
    const age = source && !Number.isNaN(source.getTime()) ? Math.max(0, received.getTime() - source.getTime()) : null;
    const bid = finite(depth?.bid); const ask = finite(depth?.ask); const crossed = bid !== undefined && ask !== undefined && bid >= ask;
    const levels = depth?.levels ?? [];
    const hasSizedDepth = levels.some((level) => (level.bidSize ?? 0) > 0 || (level.askSize ?? 0) > 0);
    const quality = age !== null && age > this.maxQuoteAgeMs ? 'STALE' : crossed ? 'CROSSED' : bid !== undefined && ask !== undefined ? (hasSizedDepth ? 'FRESH_DEPTH' : 'FRESH_TOP_OF_BOOK') : ltp ? 'LTP_ONLY' : depth ? 'EMPTY' : 'UNAVAILABLE';
    const spreadAbsolute = bid !== undefined && ask !== undefined ? ask - bid : null;
    const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : null;
    const frozenLevels = Object.freeze(levels.map((level) => Object.freeze({ ...level })));
    this.executionQuotes.set(instrumentKey, Object.freeze({ instrumentKey, sourceTimestamp, receivedTimestamp:received.toISOString(), quoteAgeMs:age, ltp:ltp?.premium ?? null, bestBid:bid ?? null, bestAsk:ask ?? null, bidSize:depth?.bidSize ?? null, askSize:depth?.askSize ?? null, depthLevels:frozenLevels, spreadAbsolute, spreadPercent:spreadAbsolute !== null && mid && mid > 0 ? spreadAbsolute / mid * 100 : null, connectionGenerationId:depth?.generationId ?? null, dataQuality:quality }));
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

function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined; }
function numeric(value: unknown): number | undefined { const result = typeof value === 'string' ? Number(value) : value; return typeof result === 'number' && Number.isFinite(result) && result >= 0 ? result : undefined; }
