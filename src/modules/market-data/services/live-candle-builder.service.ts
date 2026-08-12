import {
  LiveCandleDto,
  LiveCandleProcessResult,
  LiveCandleTimeframe,
  NormalizedLiveTickDto,
} from '../dto/live-candle.dto';

interface ActiveCandle extends LiveCandleDto {
  lastTickTimestamp: number;
}

const sessionStartMinute = 9 * 60 + 15;
const sessionEndMinuteExclusive = 15 * 60 + 30;
const timeframeMinutes: Record<LiveCandleTimeframe, number> = { '1m': 1, '3m': 3, '5m': 5 };

/**
 * Builds IST session-anchored candles from chronological ticks. Ticks outside
 * [09:15, 15:30) IST and ticks at/before the last accepted timestamp for an
 * instrument/timeframe are ignored. The first received value wins a duplicate.
 */
export default class LiveCandleBuilderService {
  private readonly activeCandles = new Map<string, ActiveCandle>();
  private readonly lastAcceptedTickTimestamps = new Map<string, number>();

  processTick(tick: NormalizedLiveTickDto, timeframe: LiveCandleTimeframe): LiveCandleProcessResult {
    this.validateTick(tick);
    const interval = timeframeMinutes[timeframe];
    if (!interval) throw new Error(`Unsupported live candle timeframe: ${String(timeframe)}.`);
    const market = getIstMarketTime(tick.timestamp);
    if (market.minute < sessionStartMinute || market.minute >= sessionEndMinuteExclusive) {
      return { ignored: true, ignoreReason: 'OUTSIDE_MARKET_SESSION' };
    }

    const key = this.key(tick.instrumentKey, timeframe);
    const tickTimestamp = tick.timestamp.getTime();
    const previousTickTimestamp = this.lastAcceptedTickTimestamps.get(key);
    if (previousTickTimestamp !== undefined && tickTimestamp <= previousTickTimestamp) {
      return { ignored: true, ignoreReason: tickTimestamp === previousTickTimestamp ? 'DUPLICATE_TICK' : 'OUT_OF_ORDER_TICK' };
    }

    const candleTime = getBucketStart(market, interval);
    const active = this.activeCandles.get(key);
    this.lastAcceptedTickTimestamps.set(key, tickTimestamp);

    if (!active) {
      const created = this.createActive(tick, timeframe, candleTime);
      this.activeCandles.set(key, created);
      return { ignored: false, activeCandle: cloneCandle(created) };
    }

    const activeTime = active.candleTime.getTime();
    const newTime = candleTime.getTime();
    if (newTime === activeTime) {
      active.high = Math.max(active.high, tick.ltp);
      active.low = Math.min(active.low, tick.ltp);
      active.close = tick.ltp;
      active.lastTickTimestamp = tickTimestamp;
      return { ignored: false, activeCandle: cloneCandle(active) };
    }
    if (newTime < activeTime) {
      // Defensive fallback: the timestamp guard above normally handles this.
      return { ignored: true, ignoreReason: 'OUT_OF_ORDER_TICK' };
    }

    const completed = { ...cloneCandle(active), completed: true };
    const created = this.createActive(tick, timeframe, candleTime);
    this.activeCandles.set(key, created);
    return { ignored: false, completedCandle: completed, activeCandle: cloneCandle(created) };
  }

  getActiveCandle(instrumentKey: string, timeframe: LiveCandleTimeframe): LiveCandleDto | undefined {
    const active = this.activeCandles.get(this.key(instrumentKey, timeframe));
    return active ? cloneCandle(active) : undefined;
  }

  /** Completes only already-observed in-session candles at the official session boundary. */
  finishSession(instrumentKey?: string): LiveCandleDto[] {
    const completed: LiveCandleDto[] = [];
    for (const [key, candle] of this.activeCandles) {
      if (instrumentKey !== undefined && candle.instrumentKey !== instrumentKey) continue;
      completed.push({ ...cloneCandle(candle), completed: true });
      this.activeCandles.delete(key);
    }
    return completed;
  }

  reset(instrumentKey?: string, timeframe?: LiveCandleTimeframe): void {
    if (instrumentKey !== undefined && timeframe !== undefined) {
      const key = this.key(instrumentKey, timeframe);
      this.activeCandles.delete(key);
      this.lastAcceptedTickTimestamps.delete(key);
      return;
    }
    for (const key of this.activeCandles.keys()) {
      if ((instrumentKey === undefined || key.startsWith(`${instrumentKey}|`)) && (timeframe === undefined || key.endsWith(`|${timeframe}`))) {
        this.activeCandles.delete(key);
        this.lastAcceptedTickTimestamps.delete(key);
      }
    }
  }

  private createActive(tick: NormalizedLiveTickDto, timeframe: LiveCandleTimeframe, candleTime: Date): ActiveCandle {
    return { instrumentKey: tick.instrumentKey, timeframe, candleTime, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, completed: false, lastTickTimestamp: tick.timestamp.getTime() };
  }

  private key(instrumentKey: string, timeframe: LiveCandleTimeframe): string { return `${instrumentKey}|${timeframe}`; }

  private validateTick(tick: NormalizedLiveTickDto): void {
    if (!tick || typeof tick !== 'object') throw new Error('Live tick is required.');
    if (typeof tick.instrumentKey !== 'string' || tick.instrumentKey.trim().length === 0) throw new Error('Live tick instrumentKey must be a non-empty string.');
    if (!(tick.timestamp instanceof Date) || Number.isNaN(tick.timestamp.getTime())) throw new Error('Live tick timestamp must be valid.');
    if (!Number.isFinite(tick.ltp) || tick.ltp <= 0) throw new Error('Live tick ltp must be positive and finite.');
  }
}

function getIstMarketTime(timestamp: Date): { year: number; month: number; day: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function getBucketStart(market: ReturnType<typeof getIstMarketTime>, interval: number): Date {
  const minute = sessionStartMinute + Math.floor((market.minute - sessionStartMinute) / interval) * interval;
  const hour = Math.floor(minute / 60); const minuteOfHour = minute % 60;
  // India has a fixed +05:30 offset and no daylight-saving transition.
  return new Date(Date.UTC(market.year, market.month - 1, market.day, hour, minuteOfHour) - (5 * 60 + 30) * 60_000);
}

function cloneCandle(candle: LiveCandleDto): LiveCandleDto {
  return { instrumentKey: candle.instrumentKey, timeframe: candle.timeframe, candleTime: new Date(candle.candleTime.getTime()), open: candle.open, high: candle.high, low: candle.low, close: candle.close, completed: candle.completed };
}
