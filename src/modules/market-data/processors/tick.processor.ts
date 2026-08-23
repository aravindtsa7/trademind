import eventBus from '../../../core/events';
import { EventEmitter } from 'events';
import logger from '../../../core/logger/logger';
import { shouldEmitTradingLog } from '../../../core/logger/trading-log-mode';
import { recordMarketReplayEvent } from '../../market-replay/market-replay-recorder.service';
import { normalizeMarketDataTimestamp } from '../utils/market-data-timestamp';
import {
  LtpcDto,
  MarketDataFeedDto,
  MarketDataFeedResponseDto,
  OptionGreeksDto,
  QuoteDto,
} from '../protobuf/protobuf.decoder';

const supportedFeedTypes = new Set(['initial_feed', 'live_feed']);

export interface MarketTickEvent {
  instrumentKey: string;
  timestamp?: string;
  ltp?: number;
  lastTradedTime?: string;
  lastTradedQuantity?: string;
  closePrice?: number;
  generationId?: number;
}

export interface MarketGreeksEvent {
  instrumentKey: string;
  timestamp?: string;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
  generationId?: number;
}

export interface MarketDepthQuote {
  bidQuantity?: string;
  bidPrice?: number;
  askQuantity?: string;
  askPrice?: number;
}

export interface MarketDepthEvent {
  instrumentKey: string;
  timestamp?: string;
  quotes: MarketDepthQuote[];
  generationId?: number;
}

export default class TickProcessor {
  /**
   * `now` is this processor's packet-receive reference. Live callers invoke
   * `process()` synchronously as each packet arrives, so the default
   * `Date.now()` reference is that receive instant; replay supplies its own
   * deterministic clock so a recorded artifact is never judged against real
   * wall-clock time (see MarketReplayRunnerService).
   */
  constructor(private readonly bus: EventEmitter = eventBus, private readonly now: () => number = Date.now) {}
  process(message: MarketDataFeedResponseDto, generationId?: number): void {
    if (!this.isValidMessage(message)) {
      logger.warn('Ignoring invalid decoded market data message');
      return;
    }

    const feedType = message.type ?? 'initial_feed';
    if (!supportedFeedTypes.has(feedType)) {
      if (shouldEmitTradingLog('RAW_MARKET_DATA_PACKET')) logger.debug('Ignoring unsupported market data feed type', { feedType });
      return;
    }

    const referenceMs = this.now();
    const timestamp = normalizeMarketDataTimestamp(message.currentTs, referenceMs);
    if (!timestamp) {
      logger.warn('Ignoring market data message with invalid or future source timestamp');
      return;
    }

    Object.entries(message.feeds).forEach(([instrumentKey, feed]) => {
      this.publishTick(instrumentKey, timestamp, feed, generationId, referenceMs);
      this.publishGreeks(instrumentKey, timestamp, feed, generationId);
      this.publishDepth(instrumentKey, timestamp, feed, generationId);
    });
  }

  private isValidMessage(message: unknown): message is MarketDataFeedResponseDto {
    if (!message || typeof message !== 'object') {
      return false;
    }

    const candidate = message as Partial<MarketDataFeedResponseDto>;
    return Boolean(candidate.feeds && typeof candidate.feeds === 'object' && !Array.isArray(candidate.feeds));
  }

  private publishTick(
    instrumentKey: string,
    timestamp: string | undefined,
    feed: MarketDataFeedDto, generationId?: number,
    referenceMs?: number
  ): void {
    const ltpc = this.getLtpc(feed);
    if (!ltpc || !this.hasLtpcValue(ltpc)) {
      return;
    }

    const event: MarketTickEvent = {
      instrumentKey,
      timestamp,
      ltp: ltpc.ltp,
      lastTradedTime: normalizeMarketDataTimestamp(ltpc.ltt, referenceMs),
      lastTradedQuantity: ltpc.ltq,
      closePrice: ltpc.cp,
      generationId,
    };

    this.bus.emit('market.tick', event);
    recordMarketReplayEvent('TICK', {
      instrumentKey,
      sourceTimestamp: timestamp ?? null,
      receivedTimestamp: new Date().toISOString(),
      sequenceNumber: null,
      connectionGenerationId: generationId ?? null,
      payload: {
        ltp: event.ltp ?? null,
        lastTradedTime: event.lastTradedTime ?? null,
        lastTradedQuantity: event.lastTradedQuantity ?? null,
        closePrice: event.closePrice ?? null,
      },
    });
  }

  private publishGreeks(
    instrumentKey: string,
    timestamp: string | undefined,
    feed: MarketDataFeedDto, generationId?: number
  ): void {
    const greeks = feed.fullFeed?.marketFF?.optionGreeks ?? feed.firstLevelWithGreeks?.optionGreeks;
    if (!greeks || !this.hasGreekValue(greeks)) {
      return;
    }

    const event: MarketGreeksEvent = {
      instrumentKey,
      timestamp,
      delta: greeks.delta,
      theta: greeks.theta,
      gamma: greeks.gamma,
      vega: greeks.vega,
      rho: greeks.rho,
      generationId,
    };

    this.bus.emit('market.greeks', event);
  }

  private publishDepth(
    instrumentKey: string,
    timestamp: string | undefined,
    feed: MarketDataFeedDto, generationId?: number
  ): void {
    const depthQuotes = feed.fullFeed?.marketFF?.marketLevel?.bidAskQuote;
    const firstDepth = feed.firstLevelWithGreeks?.firstDepth;
    const quotes = depthQuotes?.map((quote) => this.normalizeQuote(quote)) ??
      (firstDepth ? [this.normalizeQuote(firstDepth)] : []);

    if (quotes.length === 0) {
      return;
    }

    const event: MarketDepthEvent = {
      instrumentKey,
      timestamp,
      quotes,
      generationId,
    };

    this.bus.emit('market.depth', event);
    recordMarketReplayEvent('DEPTH', {
      instrumentKey,
      sourceTimestamp: timestamp ?? null,
      receivedTimestamp: new Date().toISOString(),
      sequenceNumber: null,
      connectionGenerationId: generationId ?? null,
      payload: { quotes: event.quotes },
    });
  }

  private getLtpc(feed: MarketDataFeedDto): LtpcDto | undefined {
    return (
      feed.ltpc ??
      feed.fullFeed?.marketFF?.ltpc ??
      feed.fullFeed?.indexFF?.ltpc ??
      feed.firstLevelWithGreeks?.ltpc
    );
  }

  private hasLtpcValue(ltpc: LtpcDto): boolean {
    return (
      ltpc.ltp !== undefined ||
      ltpc.ltt !== undefined ||
      ltpc.ltq !== undefined ||
      ltpc.cp !== undefined
    );
  }

  private hasGreekValue(greeks: OptionGreeksDto): boolean {
    return (
      greeks.delta !== undefined ||
      greeks.theta !== undefined ||
      greeks.gamma !== undefined ||
      greeks.vega !== undefined ||
      greeks.rho !== undefined
    );
  }

  private normalizeQuote(quote: QuoteDto): MarketDepthQuote {
    return {
      bidQuantity: quote.bidQ,
      bidPrice: quote.bidP,
      askQuantity: quote.askQ,
      askPrice: quote.askP,
    };
  }
}
