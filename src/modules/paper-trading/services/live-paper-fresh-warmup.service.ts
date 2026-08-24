import UpstoxIntradayCandleClient from '../../historical-candles/client/upstox-intraday-candle.client';
import logger from '../../../core/logger/logger';
import { HistoricalCandleUpsertInput } from '../../historical-candles/repositories/historical-candle.repository';
import { Candle } from '../../indicators/types';
import {
  HistoricalCandleWarmupRecord,
  PaperStrategyWarmupRepository,
  PaperStrategyWarmupResult,
  PaperStrategyWarmupTarget,
  paperStrategyWarmupInstrumentKey,
  paperStrategyWarmupTimeframe,
} from '../dto/paper-strategy-warmup.dto';
import PaperStrategyWarmupService from './paper-strategy-warmup.service';
import CandleTimeframeAggregatorService from '../../indicators/services/candle-timeframe-aggregator.service';
import { expectedNifty1mCompletedMinute } from '../../historical-candles/utils/historical-session-completeness.util';

export interface LiveFreshWarmupRepository extends PaperStrategyWarmupRepository {
  bulkUpsert?(inputs: HistoricalCandleUpsertInput[]): Promise<unknown>;
}

export interface LiveFreshWarmupIntradayClient {
  fetchCurrentDayOneMinuteCandles(instrumentKey: string): Promise<readonly {
    candleTime: Date; open: number; high: number; low: number; close: number; volume: bigint; openInterest?: bigint;
  }[]>;
}

export interface LiveFreshWarmupRetryOptions {
  /** Includes the initial request. Defaults to 11 attempts over roughly 30 seconds. */
  maxIntradayAttempts?: number;
  intradayRetryIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  intervalMs: number;
  wait: (milliseconds: number) => Promise<void>;
}

export interface LivePaperFreshWarmupResult extends PaperStrategyWarmupResult {
  currentIstTimestamp: Date;
  latestUnderlyingHistoricalCandle: Date | null;
  latestCompletedOneMinuteExpected: Date | null;
  latestCompletedFiveMinuteAvailable: Date | null;
  warmupAgeMinutes: number | null;
  currentDaySource: 'HISTORICAL' | 'INTRADAY';
  currentDayRowsReturned: number;
  firstCurrentDayCandle: Date | null;
  lastCurrentDayCandle: Date | null;
  currentDayMissingMinuteCount: number;
  currentDayDuplicateCount: number;
  intradayBackfillAttempts: number;
  currentDayLagMinutes: number | null;
  intradayRetryReason: string | null;
  ready: boolean;
  freshnessReason: string;
  seededOneMinuteCandles: readonly Candle[];
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * Adds a current-session REST backfill to the established warm-up seed. Readiness
 * is intentionally a freshness property as well as an indicator-depth property.
 */
export default class LivePaperFreshWarmupService {
  constructor(
    private readonly repository: LiveFreshWarmupRepository,
    private readonly target: PaperStrategyWarmupTarget,
    private readonly client: LiveFreshWarmupIntradayClient = new UpstoxIntradayCandleClient(),
    private readonly retryOptions: LiveFreshWarmupRetryOptions = {},
  ) {}

  async warmUp(now = new Date()): Promise<LivePaperFreshWarmupResult> {
    const stored = await this.repository.findByInstrumentAndTimeframe(paperStrategyWarmupInstrumentKey, paperStrategyWarmupTimeframe);
    const market = ist(now);
    const expected = expectedNifty1mCompletedMinute(now);
    // A stored current-day forming candle must never become a warm-up input.
    const existing = expected === null ? stored : stored.filter((candle) => {
      const candleMarketTime = ist(candle.candleTime);
      return candleMarketTime.date !== market.date || candle.candleTime.getTime() <= expected.getTime();
    });
    let current: HistoricalCandleWarmupRecord[] = [];
    let backfillError: string | undefined;
    let currentDayRowsReturned = 0;
    let currentDayDuplicateCount = 0;
    let intradayBackfillAttempts = 0;
    let currentDayLagMinutes: number | null = null;
    let intradayRetryReason: string | null = null;

    if (expected !== null) {
      try {
        const retry = this.resolveRetryOptions();
        for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
          intradayBackfillAttempts = attempt;
          const returned = await this.client.fetchCurrentDayOneMinuteCandles(paperStrategyWarmupInstrumentKey);
          currentDayRowsReturned = returned.length;
          const normalized = normalizeCurrentDayRows(returned, market.date, expected);
          current = normalized.rows;
          currentDayDuplicateCount = normalized.duplicateCount;
          const candidateCoverage = merge(existing, current).filter((candle) => ist(candle.candleTime).date === market.date);
          const latestCurrent = candidateCoverage.at(-1)?.candleTime ?? null;
          currentDayLagMinutes = latestCurrent === null ? null : Math.max(0, Math.round((expected.getTime() - latestCurrent.getTime()) / 60_000));
          const newestPublicationLag = isOnlyNewestMinuteMissing(candidateCoverage, expected);
          const attemptRetryReason = newestPublicationLag ? 'NEWEST_COMPLETED_MINUTE_NOT_PUBLISHED' : null;
          if (attemptRetryReason) intradayRetryReason = attemptRetryReason;
          logger.info('Current-day intraday warm-up attempt', {
            instrumentKey: paperStrategyWarmupInstrumentKey,
            attempt,
            maxAttempts: retry.maxAttempts,
            latestReturnedMinute: latestCurrent?.toISOString() ?? null,
            expectedMinute: expected.toISOString(),
            lagMinutes: currentDayLagMinutes,
            retryReason: attemptRetryReason,
          });
          if (!newestPublicationLag || attempt === retry.maxAttempts) break;
          await retry.wait(retry.intervalMs);
        }
        if (current.length > 0 && this.repository.bulkUpsert) {
          await this.repository.bulkUpsert(current.map((candle) => ({
            create: { instrumentKey: paperStrategyWarmupInstrumentKey, timeframe: paperStrategyWarmupTimeframe, candleTime: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: BigInt(candle.volume as bigint), openInterest: candle.openInterest == null ? undefined : BigInt(candle.openInterest as bigint), source: 'REST' },
            update: { open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: BigInt(candle.volume as bigint), openInterest: candle.openInterest == null ? undefined : BigInt(candle.openInterest as bigint), source: 'REST' },
          })));
        }
      } catch (error) {
        backfillError = error instanceof Error ? error.message : 'Current-day historical backfill failed.';
      }
    }

    const merged = merge(existing, current);
    const latest = merged.at(-1)?.candleTime ?? null;
    const currentDayCoverage = merged.filter((candle) => ist(candle.candleTime).date === market.date);
    const currentDayContinuous = expected !== null && hasContinuousCoverage(currentDayCoverage, expected);
    const currentDayMissingMinuteCount = expected === null ? 0 : missingMinuteCount(currentDayCoverage, expected);
    const fresh = expected === null
      ? { ready: false, reason: 'WAITING_FOR_FIRST_COMPLETED_CURRENT_DAY_MINUTE' }
      : backfillError
        ? { ready: false, reason: `CURRENT_DAY_BACKFILL_FAILED: ${backfillError}` }
        : latest?.getTime() !== expected.getTime() || !currentDayContinuous
          ? { ready: false, reason: `STALE_CURRENT_DAY_HISTORY: expected=${expected.toISOString()} actual=${latest?.toISOString() ?? 'NONE'}` }
          : { ready: true, reason: 'FRESH_CURRENT_DAY_HISTORY' };

    // Never feed a gapped current day into the indicator aggregator.  The
    // previous completed-session seed remains useful for diagnostics, but the
    // strict freshness gate still prevents any strategy evaluation.
    const indicatorSeedRows = currentDayContinuous
      ? merged
      : merged.filter((candle) => ist(candle.candleTime).date !== market.date);

    // The established service continues to own the exact 5m indicator seed.
    const result = await new PaperStrategyWarmupService({
      findByInstrumentAndTimeframe: async () => indicatorSeedRows,
    }, this.target).warmUp();
    const seededOneMinuteCandles = indicatorSeedRows.map(toCandle);
    const latestFive = latestCompletedFiveMinute(seededOneMinuteCandles, now);
    const expectedFive = expected === null ? null : expectedCompletedFiveMinute(expected);
    const currentFiveMinuteFresh = expectedFive !== null && latestFive?.getTime() === expectedFive.getTime();
    const age = latest ? (now.getTime() - latest.getTime()) / 60_000 : null;
    return {
      ...result,
      currentIstTimestamp: new Date(now.getTime()),
      latestUnderlyingHistoricalCandle: latest ? new Date(latest.getTime()) : null,
      latestCompletedOneMinuteExpected: expected ? new Date(expected.getTime()) : null,
      latestCompletedFiveMinuteAvailable: latestFive,
      warmupAgeMinutes: age,
      currentDaySource: expected === null ? 'HISTORICAL' : 'INTRADAY',
      currentDayRowsReturned,
      firstCurrentDayCandle: current.at(0)?.candleTime ? new Date(current[0].candleTime.getTime()) : null,
      lastCurrentDayCandle: current.at(-1)?.candleTime ? new Date(current[current.length - 1].candleTime.getTime()) : null,
      currentDayMissingMinuteCount,
      currentDayDuplicateCount,
      intradayBackfillAttempts,
      currentDayLagMinutes,
      intradayRetryReason,
      ready: fresh.ready && currentFiveMinuteFresh && result.warmupReady,
      freshnessReason: !fresh.ready
        ? fresh.reason
        : !currentFiveMinuteFresh
          ? `STALE_CURRENT_DAY_5M_HISTORY: expected=${expectedFive?.toISOString() ?? 'NONE'} actual=${latestFive?.toISOString() ?? 'NONE'}`
          : !result.warmupReady
            ? 'INDICATOR_WARMUP_NOT_READY'
            : fresh.reason,
      seededOneMinuteCandles,
    };
  }

  private resolveRetryOptions(): ResolvedRetryOptions {
    const maxAttempts = this.retryOptions.maxIntradayAttempts ?? positiveInteger(process.env.LIVE_WARMUP_INTRADAY_MAX_ATTEMPTS, 11);
    const intervalMs = this.retryOptions.intradayRetryIntervalMs ?? positiveInteger(process.env.LIVE_WARMUP_INTRADAY_RETRY_INTERVAL_MS, 3_000);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxIntradayAttempts must be a positive integer.');
    if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error('intradayRetryIntervalMs must be a non-negative integer.');
    return { maxAttempts, intervalMs, wait: this.retryOptions.wait ?? delay };
  }
}

function merge(existing: readonly HistoricalCandleWarmupRecord[], current: readonly HistoricalCandleWarmupRecord[]): HistoricalCandleWarmupRecord[] {
  const values = new Map<number, HistoricalCandleWarmupRecord>();
  existing.forEach((candle) => values.set(candle.candleTime.getTime(), { ...candle, candleTime: new Date(candle.candleTime.getTime()) }));
  // Authoritative current-day backfill wins an overlapping local row.
  current.forEach((candle) => values.set(candle.candleTime.getTime(), { ...candle, candleTime: new Date(candle.candleTime.getTime()) }));
  return [...values.values()].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
}
function toCandle(row: HistoricalCandleWarmupRecord): Candle { return { timestamp: new Date(row.candleTime.getTime()), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), openInterest: row.openInterest == null ? undefined : Number(row.openInterest) }; }
function ist(value: Date): { date: string; minute: number } { const p = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value])); return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) }; }
function latestCompletedFiveMinute(candles: readonly Candle[], now: Date): Date | null {
  const end = now.getTime(); const candidate = new CandleTimeframeAggregatorService().aggregate(candles, '5m', { incompleteLeadingBucket: 'discard', incompleteTrailingBucket: 'discard' }).filter((candle) => candle.timestamp.getTime() + 5 * 60_000 <= end).at(-1);
  return candidate ? new Date(candidate.timestamp.getTime()) : null;
}
function expectedCompletedFiveMinute(expected: Date): Date | null {
  const value = ist(expected); const offset = value.minute - (9 * 60 + 15);
  const completedBucketOffset = Math.floor((offset + 1) / 5) * 5 - 5;
  if (completedBucketOffset < 0) return null;
  const startMinute = 9 * 60 + 15 + completedBucketOffset;
  return new Date(`${value.date}T${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}:00+05:30`);
}
function normalizeCurrentDayRows(rows: readonly Awaited<ReturnType<LiveFreshWarmupIntradayClient['fetchCurrentDayOneMinuteCandles']>>[number][], date: string, expected: Date): { rows: HistoricalCandleWarmupRecord[]; duplicateCount: number } {
  const filtered = rows
    .filter((candle) => ist(candle.candleTime).date === date && candle.candleTime.getTime() >= sessionStart(date) && candle.candleTime.getTime() <= expected.getTime())
    .map((candle) => ({ ...candle, candleTime: new Date(candle.candleTime.getTime()) }));
  const unique = new Map<number, HistoricalCandleWarmupRecord>();
  filtered.forEach((candle) => unique.set(candle.candleTime.getTime(), candle));
  return { rows: [...unique.values()].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()), duplicateCount: filtered.length - unique.size };
}
function isOnlyNewestMinuteMissing(rows: readonly HistoricalCandleWarmupRecord[], expected: Date): boolean {
  const previous = new Date(expected.getTime() - 60_000);
  return missingMinuteCount(rows, expected) === 1 && rows.some((row) => row.candleTime.getTime() === previous.getTime()) && !rows.some((row) => row.candleTime.getTime() === expected.getTime()) && hasContinuousCoverage(rows, previous);
}
function hasContinuousCoverage(rows: readonly HistoricalCandleWarmupRecord[], expected: Date): boolean {
  const start = sessionStart(ist(expected).date);
  const expectedTimes = new Set<number>(); for (let value = start; value <= expected.getTime(); value += 60_000) expectedTimes.add(value);
  const observed = new Set(rows.map((row) => row.candleTime.getTime()));
  return observed.size === expectedTimes.size && [...expectedTimes].every((timestamp) => observed.has(timestamp));
}
function missingMinuteCount(rows: readonly HistoricalCandleWarmupRecord[], expected: Date): number {
  const start = sessionStart(ist(expected).date);
  const observed = new Set(rows.map((row) => row.candleTime.getTime()));
  let missing = 0;
  for (let value = start; value <= expected.getTime(); value += 60_000) if (!observed.has(value)) missing += 1;
  return missing;
}
function sessionStart(date: string): number { return new Date(`${date}T09:15:00+05:30`).getTime(); }
function positiveInteger(raw: string | undefined, fallback: number): number { const parsed = raw === undefined ? fallback : Number(raw); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
