import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import eventBus from '../../../core/events';
import { MarketTickEvent } from '../../market-data/processors/tick.processor';
import { PaperPositionMonitoringResult } from '../types/paper-trading.types';
import PaperPositionMonitorService from './paper-position-monitor.service';
import PaperPortfolioService from './paper-portfolio.service';
import { ExecutionQuoteSnapshot } from '../dto/paper-fill-model.dto';
import { ExecutionFaultInjector, noExecutionFaults } from '../../execution/execution-fault-injection';
import { LiveGenerationCacheScope } from '../../market-data/utils/live-generation-cache';
import { isCurrentLiveGeneration } from '../../market-data/utils/live-generation';

/**
 * Bridges the shared market.tick stream into paper-position monitoring. This
 * class owns only one event listener; it does not own a WebSocket connection.
 */
export default class PaperMarketDataAdapterService {
  private started = false;
  /** Fail-closed startup: no tick/depth is ingested until the live runtime explicitly confirms recovery readiness via setMarketDataAvailable(true). */
  private marketDataAvailable = false;
  /** Serializes only awaitable durable exits; market quote processing remains synchronous. */
  private durableExitQueue: Promise<void> = Promise.resolve();
  private readonly tickListener = (tick: unknown): void => this.handleTick(tick);
  private readonly depthListener = (depth: unknown): void => this.handleDepth(depth);
  private readonly depthByInstrument = new Map<string, { bid?: number; ask?: number; bidSize?: number; askSize?: number; sourceTimestamp?: string; receivedTimestamp: Date; levels: readonly { bid?: number; ask?: number; bidSize?: number; askSize?: number }[]; generationId?: number }>();
  private readonly latestPremiumByInstrument = new Map<string, { premium: number; sourceTimestamp: Date; receivedTimestamp: Date; generationId?: number }>();
  private readonly executionQuotes = new Map<string, ExecutionQuoteSnapshot>();
  private readonly liveGenerationScope = new LiveGenerationCacheScope();

  constructor(
    private readonly positionMonitor: PaperPositionMonitorService,
    private readonly bus: EventEmitter = eventBus,
    private readonly portfolio?: PaperPortfolioService,
    private readonly maxQuoteAgeMs = 2_000,
    private readonly now = () => new Date(),
    /** Live runtimes provide this so an old socket cannot qualify an entry quote. */
    private readonly getActiveGenerationId?: () => number | undefined,
    private readonly faultInjector: ExecutionFaultInjector = noExecutionFaults,
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
  setMarketDataAvailable(available: boolean): void {
    this.marketDataAvailable = available;
    if (!available) this.retireLiveMarketState();
  }

  /**
   * Shutdown/EOD waits only for already acknowledged durable mutations. The
   * caller decides the safe bounded timeout and fails closed on false.
   */
  async drainDurableExitQueue(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeoutMs must be a non-negative finite number.');
    await this.faultInjector.hit('DURING_SHUTDOWN_DRAIN', { timeoutMs });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.durableExitQueue.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handleTick(tick: unknown): void {
    if (!this.marketDataAvailable) return;
    const update = this.normalizeTick(tick);
    if (!update || !this.acceptLiveCacheGeneration(update.generationId)) return;
    const received = this.now();
    // A source timestamp after the adapter's own receive reference is a future/skewed reading;
    // it must never enter executable cache state, portfolio marking, or bid/ask persistence.
    // This boundary is intentionally strict (zero tolerance) and independent of the canonical
    // ingest layer's DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS (market-data-timestamp.ts):
    // canonical ingest tolerance and executable-quote/portfolio freshness are different
    // concerns, and a fill/mark must never treat a timestamp as current merely because it fell
    // inside an upstream canonical-ingest allowance.
    if (update.timestamp.getTime() > received.getTime()) return;
    this.latestPremiumByInstrument.set(update.instrumentKey, { premium: update.premium, sourceTimestamp: new Date(update.timestamp.getTime()), receivedTimestamp: new Date(received.getTime()), generationId:update.generationId });
    const depth = this.depthByInstrument.get(update.instrumentKey);
    const quoteTimestamp = depth?.sourceTimestamp ? new Date(depth.sourceTimestamp) : undefined;
    const ageMs = quoteTimestamp && !Number.isNaN(quoteTimestamp.getTime()) ? (ageAt(received, depth!.sourceTimestamp!) ?? undefined) : undefined;
    this.portfolio?.mark({ instrumentKey: update.instrumentKey, timestamp: update.timestamp, bid: depth?.bid, ask: depth?.ask, ltp: update.premium, ageMs, maxAgeMs: this.maxQuoteAgeMs });
    this.refreshExecutionQuote(update.instrumentKey);
    if (this.positionMonitor.hasDurableExitPersistence()) {
      // Work is serialized in event order. The first queued monitor reserves
      // OPEN -> EXIT_PENDING before its persistence await; later queued ticks
      // then observe a non-OPEN order and cannot create another exit.
      this.durableExitQueue = this.durableExitQueue
        .then(async () => {
          // The event was current when queued, but a reconnect may occur before
          // this serialized callback starts. Revalidate before any exit state
          // mutation; an already-started durable transaction remains atomic.
          if (!this.isActiveGeneration(update.generationId)) return;
          const actions = await this.positionMonitor.monitorDurably(update);
          this.emitActions(actions);
        })
        .catch(() => {
          // monitorDurably converts persistence failures into a fail-closed
          // RECONCILIATION_REQUIRED order. Never let a logging/event boundary
          // reject the queue and poison subsequent deterministic work.
        });
      return;
    }
    this.emitActions(this.positionMonitor.monitor(update));
  }

  private emitActions(actions: PaperPositionMonitoringResult[]): void {
    actions.filter((action) => action.action !== 'NONE').forEach((action) => this.bus.emit('paper.order.action', action));
  }

  private handleDepth(depth: unknown): void {
    if (!this.marketDataAvailable) return;
    if (!depth || typeof depth !== 'object') return;
    const candidate = depth as { instrumentKey?: unknown; timestamp?: unknown; generationId?: unknown; quotes?: Array<{ bidPrice?: unknown; askPrice?: unknown; bidQuantity?: unknown; askQuantity?: unknown }> };
    const generationId = typeof candidate.generationId === 'number' ? candidate.generationId : undefined;
    if (typeof candidate.instrumentKey !== 'string' || !this.acceptLiveCacheGeneration(generationId)) return;
    const top = candidate.quotes?.[0];
    const sourceTimestamp = typeof candidate.timestamp === 'string' ? candidate.timestamp : undefined;
    const received = this.now();
    // A source timestamp after the adapter's own receive reference is a future/skewed reading;
    // it must never enter executable cache state, portfolio marking, or bid/ask persistence.
    if (sourceTimestamp) { const sourceMs = new Date(sourceTimestamp).getTime(); if (Number.isFinite(sourceMs) && sourceMs > received.getTime()) return; }
    const levels = candidate.quotes?.map((value) => ({ bid: finite(value.bidPrice), ask: finite(value.askPrice), bidSize: numeric(value.bidQuantity), askSize: numeric(value.askQuantity) })) ?? [];
    const quote = { bid: typeof top?.bidPrice === 'number' ? top.bidPrice : undefined, ask: typeof top?.askPrice === 'number' ? top.askPrice : undefined, bidSize:numeric(top?.bidQuantity), askSize:numeric(top?.askQuantity), sourceTimestamp, receivedTimestamp:new Date(received.getTime()), levels, generationId };
    this.depthByInstrument.set(candidate.instrumentKey, quote);
    const latest = this.latestPremiumByInstrument.get(candidate.instrumentKey);
    const quoteTime = sourceTimestamp ? new Date(sourceTimestamp) : undefined;
    if (latest && quoteTime && !Number.isNaN(quoteTime.getTime())) {
      this.portfolio?.mark({ instrumentKey: candidate.instrumentKey, timestamp: quoteTime, bid: quote.bid, ask: quote.ask, ltp: latest.premium, ageMs: ageAt(received, latest.sourceTimestamp.toISOString()) ?? undefined, maxAgeMs: this.maxQuoteAgeMs });
    }
    this.refreshExecutionQuote(candidate.instrumentKey);
  }

  /** Snapshot is immutable, explicit about quality, and safe for PaperFillModel. Ages are recomputed against the current read time; nothing else about the cached observation is mutated. */
  getExecutionQuoteSnapshot(instrumentKey: string): ExecutionQuoteSnapshot | undefined {
    const quote = this.executionQuotes.get(instrumentKey);
    if (!quote || !this.isActiveGeneration(quote.connectionGenerationId ?? undefined)) return undefined;
    return this.currentSnapshot(quote);
  }

  /**
   * A cached snapshot's ages are only ever true as of the instant it was
   * written -- a silent instrument would otherwise report the same tiny age
   * forever. Every read re-derives ltp/bid/ask/depth/quote age from the
   * immutable source timestamps against this.now(), without touching
   * receivedTimestamp (which stays "when this snapshot was built") or any
   * other field.
   */
  private currentSnapshot(quote: ExecutionQuoteSnapshot): ExecutionQuoteSnapshot {
    const now = this.now();
    const ltpAgeMs = ageAt(now, quote.ltpSourceTimestamp ?? null);
    const depthAgeMs = ageAt(now, quote.depthSourceTimestamp ?? null);
    const quoteAgeMs = ageAt(now, quote.sourceTimestamp);
    return immutableSnapshot({ ...quote, ltpAgeMs, depthAgeMs, bidAgeMs: depthAgeMs, askAgeMs: depthAgeMs, quoteAgeMs });
  }

  /** Exposes the same canonical live-generation source used internally, so the fill boundary can validate a captured quote against the currently active generation instead of a second counter. */
  getActiveLiveGenerationId(): number | undefined {
    return this.getActiveGenerationId?.();
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
    const depth = this.depthByInstrument.get(instrumentKey); const cachedLtp = this.latestPremiumByInstrument.get(instrumentKey);
    // Never form an executable snapshot from an option LTP and depth book that
    // arrived on different WebSocket generations.
    const ltp = depth && cachedLtp && depth.generationId !== cachedLtp.generationId ? undefined : cachedLtp;
    const received = new Date(this.now().getTime());
    const ltpSourceTimestamp = ltp?.sourceTimestamp.toISOString() ?? null;
    const ltpReceivedTimestamp = ltp?.receivedTimestamp.toISOString() ?? null;
    const depthSourceTimestamp = depth?.sourceTimestamp ?? null;
    const depthReceivedTimestamp = depth?.receivedTimestamp.toISOString() ?? null;
    const ltpAgeMs = ageAt(received, ltpSourceTimestamp);
    const depthAgeMs = ageAt(received, depthSourceTimestamp);
    // For executable option entry/exit, book freshness—not a newer LTP—is the
    // authoritative age. A missing depth timestamp is intentionally unusable.
    const sourceTimestamp = depthSourceTimestamp;
    const age = depthAgeMs;
    const bid = finite(depth?.bid); const ask = finite(depth?.ask); const crossed = bid !== undefined && ask !== undefined && bid >= ask;
    const levels = depth?.levels ?? [];
    const hasSizedDepth = levels.some((level) => (level.bidSize ?? 0) > 0 || (level.askSize ?? 0) > 0);
    const quality = bid !== undefined || ask !== undefined ? (age === null || age > this.maxQuoteAgeMs ? 'STALE' : crossed ? 'CROSSED' : bid !== undefined && ask !== undefined ? (hasSizedDepth ? 'FRESH_DEPTH' : 'FRESH_TOP_OF_BOOK') : 'EMPTY') : ltp ? 'LTP_ONLY' : depth ? 'EMPTY' : 'UNAVAILABLE';
    const spreadAbsolute = bid !== undefined && ask !== undefined ? ask - bid : null;
    const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : null;
    const frozenLevels = Object.freeze(levels.map((level) => Object.freeze({ ...level })));
    const snapshot: Omit<ExecutionQuoteSnapshot, 'snapshotId'> = { instrumentKey, sourceTimestamp, receivedTimestamp:received.toISOString(), quoteAgeMs:age, ltpSourceTimestamp, ltpReceivedTimestamp, ltpAgeMs, bidSourceTimestamp:depthSourceTimestamp, bidReceivedTimestamp:depthReceivedTimestamp, bidAgeMs:depthAgeMs, askSourceTimestamp:depthSourceTimestamp, askReceivedTimestamp:depthReceivedTimestamp, askAgeMs:depthAgeMs, depthSourceTimestamp, depthReceivedTimestamp, depthAgeMs, ltp:ltp?.premium ?? null, bestBid:bid ?? null, bestAsk:ask ?? null, bidSize:depth?.bidSize ?? null, askSize:depth?.askSize ?? null, depthLevels:frozenLevels, spreadAbsolute, spreadPercent:spreadAbsolute !== null && mid && mid > 0 ? spreadAbsolute / mid * 100 : null, connectionGenerationId:depth?.generationId ?? null, dataQuality:quality as ExecutionQuoteSnapshot['dataQuality'] };
    this.executionQuotes.set(instrumentKey, immutableSnapshot({ ...snapshot, snapshotId: quoteSnapshotId(snapshot) }));
  }

  private normalizeTick(tick: unknown): { instrumentKey: string; timestamp: Date; premium: number; generationId?: number } | undefined {
    if (!tick || typeof tick !== 'object') return undefined;
    const candidate = tick as Partial<MarketTickEvent>;
    if (typeof candidate.instrumentKey !== 'string' || candidate.instrumentKey.trim().length === 0) return undefined;
    if (typeof candidate.ltp !== 'number' || !Number.isFinite(candidate.ltp) || candidate.ltp <= 0) return undefined;
    const timestamp = typeof candidate.timestamp === 'string' ? new Date(candidate.timestamp) : undefined;
    if (!timestamp || Number.isNaN(timestamp.getTime())) return undefined;
    return { instrumentKey: candidate.instrumentKey, timestamp, premium: candidate.ltp, generationId: typeof candidate.generationId === 'number' ? candidate.generationId : undefined };
  }

  private isActiveGeneration(generationId: number | undefined): boolean {
    if (!this.getActiveGenerationId) return true;
    return isCurrentLiveGeneration(generationId, this.getActiveGenerationId());
  }

  private acceptLiveCacheGeneration(generationId: number | undefined): boolean {
    if (!this.getActiveGenerationId) return true;
    const activeGenerationId = this.getActiveGenerationId();
    return this.liveGenerationScope.accept(generationId, activeGenerationId, () => {
      // LTP, book and derived execution snapshots form one atomic live quote
      // cache. The first accepted event for a new socket generation retires all
      // counterpart fields before portfolio marking or snapshot construction.
      this.retireLiveMarketState();
    });
  }

  private retireLiveMarketState(): void {
    this.latestPremiumByInstrument.clear();
    this.depthByInstrument.clear();
    this.executionQuotes.clear();
    this.portfolio?.invalidateMarketMarks();
  }
}

function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined; }
function numeric(value: unknown): number | undefined { const result = typeof value === 'string' ? Number(value) : value; return typeof result === 'number' && Number.isFinite(result) && result >= 0 ? result : undefined; }
/** A source timestamp after `received` is a poisoned/skewed reading, never a fresh one -- it must fail closed (null), not clamp to a fresh 0 via Math.max(0, ...). */
function ageAt(received: Date, sourceTimestamp: string | null): number | null { const source = sourceTimestamp ? new Date(sourceTimestamp).getTime() : Number.NaN; if (!Number.isFinite(source)) return null; const delta = received.getTime() - source; return delta < 0 ? null : delta; }
function quoteSnapshotId(snapshot: Omit<ExecutionQuoteSnapshot, 'snapshotId'>): string { return createHash('sha256').update(JSON.stringify({ instrumentKey:snapshot.instrumentKey, sourceTimestamp:snapshot.sourceTimestamp, receivedTimestamp:snapshot.receivedTimestamp, ltp:snapshot.ltp, bestBid:snapshot.bestBid, bestAsk:snapshot.bestAsk, bidSize:snapshot.bidSize, askSize:snapshot.askSize, depthLevels:snapshot.depthLevels, connectionGenerationId:snapshot.connectionGenerationId })).digest('hex').slice(0, 24); }
function immutableSnapshot(snapshot: ExecutionQuoteSnapshot): ExecutionQuoteSnapshot { return Object.freeze({ ...snapshot, depthLevels:Object.freeze(snapshot.depthLevels.map((level) => Object.freeze({ ...level }))) }); }
