import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import { getHistoricalOptionStatutoryChargeRateConfig, HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS } from '../modules/options/config/historical-option-charge-rates.config';
import { OptionCapitalSimulationTradeInput } from '../modules/options/dto/option-capital-simulation.dto';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import HistoricalOptionChargesCalculatorService from '../modules/options/services/historical-option-charges-calculator.service';
import OptionCapitalSimulatorService from '../modules/options/services/option-capital-simulator.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import OptionSlippageCalculatorService from '../modules/options/services/option-slippage-calculator.service';
import OptionTradePnlCalculatorService from '../modules/options/services/option-trade-pnl-calculator.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

dotenv.config();

const initialCapital = 100_000;
const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const expectedSessionCount = 105;
const expectedOneMinuteCandleCount = 375;
const sessionStartMinute = 9 * 60 + 15;
const sessionEndMinute = 15 * 60 + 29;
const researchWindowSessions = 40;
const stepSessions = 20;
const exitPolicy = {
  type: 'TARGET_STOP' as const,
  targetPercent: 30,
  stopLossPercent: 20,
  maximumHoldingMinutes: 60,
};
const marketFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface StoredCandle {
  candleTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: bigint;
  openInterest: bigint | null;
}

interface CompleteSession {
  date: string;
  candles: StoredCandle[];
}

interface BaselineSignal {
  timestamp: Date;
  sessionDate: string;
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  spotPrice: number;
}

interface ResolvedTrade extends BaselineSignal {
  contract: OptionContract;
  lotSize: number;
  entryPremium: number;
  exit: OptionExitPolicyEvaluationResult;
}

interface Candidate extends OptionCapitalSimulationTradeInput {
  key: string;
}

interface TimeFilter {
  id: string;
  label: string;
  allows(minute: number): boolean;
}

interface WindowDefinition {
  index: number;
  sessions: readonly CompleteSession[];
}

interface WindowFilterResult {
  window: WindowDefinition;
  filter: TimeFilter;
  candidateSignals: number;
  acceptedSignals: number;
  filteredOutSignals: number;
  removedBuyCe: number;
  removedBuyPe: number;
  executedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalNetPnl: number;
  averageNetPnl: number;
  medianNetPnl: number;
  finalCapital: number;
  returnPercent: number;
  maximumDrawdownAmount: number;
  maximumDrawdownPercent: number;
}

interface StabilitySummary {
  filter: TimeFilter;
  windowsEvaluated: number;
  averageTrades: number;
  averageReturnPercent: number;
  averageNetPnl: number;
  averageWinRate: number;
  averageMaximumDrawdownPercent: number;
  positiveNetPnlWindows: number;
  higherReturnWindows: number;
  lowerDrawdownWindows: number;
  improvingBothWindows: number;
  removedBuyCe: number;
  removedBuyPe: number;
}

// Intervals are [start, end) in IST minutes. This assigns an exact 10:30
// timestamp to the excluded interval, avoiding overlap between configurations.
const timeFilters: readonly TimeFilter[] = [
  { id: 'ALL_DAY', label: 'ALL DAY (09:15-15:30)', allows: (minute) => minute >= 555 && minute < 930 },
  { id: 'MORNING_ONLY', label: 'MORNING ONLY (09:15-10:30)', allows: (minute) => minute >= 555 && minute < 630 },
  { id: 'EXCLUDE_1030_1200', label: 'EXCLUDE 10:30-12:00', allows: (minute) => (minute >= 555 && minute < 630) || (minute >= 720 && minute < 930) },
  { id: 'EXCLUDE_LATE_SESSION', label: 'EXCLUDE LATE SESSION (09:15-13:30)', allows: (minute) => minute >= 555 && minute < 810 },
  { id: 'CORE_SESSION', label: 'CORE SESSION (09:30-13:30)', allows: (minute) => minute >= 570 && minute < 810 },
  { id: 'AFTERNOON_ONLY', label: 'AFTERNOON ONLY (12:00-15:30)', allows: (minute) => minute >= 720 && minute < 930 },
];

function market(timestamp: Date): { date: string; minute: number } {
  const values = Object.fromEntries(marketFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
}

function money(value: number): string { return `Rs ${value.toFixed(2)}`; }
function percent(value: number): string { return `${value.toFixed(2)}%`; }
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function candidateKey(timestamp: Date, instrumentKey: string): string { return `${timestamp.getTime()}|${instrumentKey}`; }

function isCompleteSession(candles: readonly StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = market(sorted[0].candleTime);
  const last = market(sorted[sorted.length - 1].candleTime);
  return first.minute === sessionStartMinute && last.minute === sessionEndMinute && sorted.every(
    (candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000
  );
}

function toInternalCandles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap((session) => session.candles)
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map((candle) => {
      const volume = Number(candle.volume);
      const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
      if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
        throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
      }
      return {
        timestamp: candle.candleTime,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume,
        openInterest,
      };
    });
}

function indicatorValue(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  const value = indicator?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime());
  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}

function nearestExpiry(expiries: readonly string[], sessionDate: string): string {
  const value = expiries.filter((expiry) => expiry >= sessionDate).sort((left, right) => left.localeCompare(right))[0];
  if (!value) throw new Error(`No expired option expiry is available on or after ${sessionDate}.`);
  return value;
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const current = cache.get(key);
  if (current) return current;
  const promise = create();
  cache.set(key, promise);
  return promise;
}

async function loadSessions(): Promise<CompleteSession[]> {
  const repository = new HistoricalCandleRepository();
  const rows = await repository.findByInstrumentAndTimeframe(underlyingInstrumentKey, '1minute');
  const byDate = new Map<string, StoredCandle[]>();
  rows.forEach((candle) => {
    const date = market(candle.candleTime).date;
    byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  });
  const sessions = Array.from(byDate.entries())
    .filter(([, candles]) => isCompleteSession(candles))
    .map(([date, candles]) => ({ date, candles }))
    .sort((left, right) => left.date.localeCompare(right.date));

  if (sessions.length !== expectedSessionCount) {
    throw new Error(`Expected exactly ${expectedSessionCount} complete NIFTY sessions, found ${sessions.length}.`);
  }

  return sessions;
}

/**
 * Each rolling window calculates the unchanged baseline independently. This
 * avoids using indicator state from sessions before the window begins.
 */
function generateSignals(sessions: readonly CompleteSession[]): BaselineSignal[] {
  const oneMinute = toInternalCandles(sessions);
  const spotByTimestamp = new Map(oneMinute.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinute = new CandleTimeframeAggregatorService().aggregate(oneMinute, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinute, {
    indicators: [
      { type: IndicatorType.EMA, period: 15 },
      { type: IndicatorType.EMA, period: 35 },
      { type: IndicatorType.RSI, period: 14 },
    ],
  });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const signals: BaselineSignal[] = [];

  fiveMinute.forEach((candle, index) => {
    const previous = fiveMinute[index - 1];
    if (!previous) return;
    const previousFast = indicatorValue(indicators, IndicatorType.EMA, 15, previous.timestamp);
    const currentFast = indicatorValue(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = indicatorValue(indicators, IndicatorType.EMA, 35, previous.timestamp);
    const currentSlow = indicatorValue(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = indicatorValue(indicators, IndicatorType.RSI, 14, candle.timestamp);
    const spotPrice = spotByTimestamp.get(candle.timestamp.getTime());
    if ([previousFast, currentFast, previousSlow, currentSlow, rsi, spotPrice].some((value) => value === undefined)) return;

    const crossover = strategy.evaluate({
      fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: previousFast as number }, { timestamp: candle.timestamp, value: currentFast as number }] } as EmaResult,
      slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: previousSlow as number }, { timestamp: candle.timestamp, value: currentSlow as number }] } as EmaResult,
    });
    const allowed = (crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) || (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45);
    if (allowed && (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE)) {
      signals.push({ timestamp: candle.timestamp, sessionDate: market(candle.timestamp).date, signal: crossover.signal, spotPrice: spotPrice as number });
    }
  });

  return signals;
}

async function resolveTrades(accessToken: string, signals: readonly BaselineSignal[]): Promise<{ trades: ResolvedTrade[]; unavailable: number; ambiguous: number }> {
  const optionClient = new UpstoxExpiredOptionClient(accessToken);
  const candleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();
  const exits = new OptionExitPolicyEvaluatorService();
  const instrumentRepository = new InstrumentRepository();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractCache = new Map<string, Promise<OptionContract[]>>();
  const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const trades: ResolvedTrade[] = [];
  let unavailable = 0;
  let ambiguous = 0;

  for (const signal of signals) {
    try {
      const expiries = await cached(expiryCache, underlyingInstrumentKey, () => optionClient.fetchAvailableExpiries(underlyingInstrumentKey));
      const expiry = nearestExpiry(expiries, signal.sessionDate);
      const contracts = await cached(contractCache, `${underlyingInstrumentKey}|${expiry}`, () => optionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
      const underlying = contracts[0]?.underlying;
      if (!underlying) throw new Error('Expired option response has no underlying.');
      const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const contract = contracts.find((entry) => entry.instrumentKey === selected.instrumentKey);
      if (!contract) throw new Error('Selected option contract could not be resolved.');
      const localInstrument = contract.lotSize === undefined ? await instrumentRepository.findByInstrumentKey(contract.instrumentKey) : null;
      const lotSize = contract.lotSize ?? localInstrument?.lotSize;
      if (!Number.isInteger(lotSize) || (lotSize as number) <= 0) throw new Error('No valid historical option lot size is available.');
      const candles = await cached(candleCache, `${contract.instrumentKey}|${signal.sessionDate}`, () => candleClient.fetchCandles(contract.instrumentKey, signal.sessionDate, signal.sessionDate));
      const entry = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
      if (!entry) throw new Error('No option candle aligns with the signal timestamp.');
      const exit = exits.evaluate({ signalTimestamp: signal.timestamp, entryPremium: entry.close, candles, exitPolicy });
      if (exit.ambiguous) { ambiguous += 1; continue; }
      if (exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null) { unavailable += 1; continue; }
      trades.push({ ...signal, contract, lotSize: lotSize as number, entryPremium: entry.close, exit });
    } catch {
      unavailable += 1;
    }
  }
  return { trades, unavailable, ambiguous };
}

function buildCandidates(trades: readonly ResolvedTrade[]): Candidate[] {
  const slippage = new OptionSlippageCalculatorService();
  const charges = new HistoricalOptionChargesCalculatorService();
  const pnl = new OptionTradePnlCalculatorService();
  return trades.map((trade) => {
    const adjusted = slippage.calculate({
      entryPremium: trade.entryPremium,
      exitPremium: trade.exit.exitPremium as number,
      slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 },
    });
    const chargeBreakdown = charges.calculate({
      tradeDate: trade.timestamp,
      entryPremium: adjusted.adjustedEntryPremium,
      exitPremium: adjusted.adjustedExitPremium,
      quantity: trade.lotSize,
      statutoryRateConfiguration: getHistoricalOptionStatutoryChargeRateConfig(trade.timestamp),
      brokerageConfiguration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD,
    });
    const outcome = pnl.calculate({
      entryPremium: adjusted.adjustedEntryPremium,
      exitPremium: adjusted.adjustedExitPremium,
      quantity: trade.lotSize,
      charges: chargeBreakdown,
    });
    return {
      key: candidateKey(trade.timestamp, trade.contract.instrumentKey),
      signalTimestamp: trade.timestamp,
      exitTimestamp: trade.exit.exitTimestamp as Date,
      signalType: trade.signal,
      instrumentKey: trade.contract.instrumentKey,
      tradingSymbol: trade.contract.tradingSymbol,
      quantity: trade.lotSize,
      entryPremium: adjusted.adjustedEntryPremium,
      exitPremium: adjusted.adjustedExitPremium,
      entryValue: outcome.entryValue,
      totalCharges: outcome.totalCharges,
      netPnl: outcome.netPnl,
    };
  });
}

function createWindows(sessions: readonly CompleteSession[]): WindowDefinition[] {
  const windows: WindowDefinition[] = [];
  for (let start = 0; start + researchWindowSessions <= sessions.length; start += stepSessions) {
    windows.push({ index: windows.length + 1, sessions: sessions.slice(start, start + researchWindowSessions) });
  }
  if (windows.length === 0) throw new Error('Not enough complete sessions for a 40-session chronological research window.');
  return windows;
}

function runFilter(window: WindowDefinition, filter: TimeFilter, signals: readonly BaselineSignal[], candidates: readonly Candidate[]): WindowFilterResult {
  const acceptedSignals = signals.filter((signal) => filter.allows(market(signal.timestamp).minute));
  const acceptedTimes = new Set(acceptedSignals.map((signal) => signal.timestamp.getTime()));
  const allowedCandidates = candidates.filter((candidate) => acceptedTimes.has(candidate.signalTimestamp.getTime()));
  const capital = new OptionCapitalSimulatorService().simulate({ initialCapital, trades: allowedCandidates });
  const executed = capital.trades.filter((trade) => trade.executed);
  const netPnl = executed.map((trade) => trade.netPnl);
  const filteredOut = signals.filter((signal) => !filter.allows(market(signal.timestamp).minute));
  const wins = executed.filter((trade) => trade.netPnl > 0).length;
  const losses = executed.filter((trade) => trade.netPnl < 0).length;
  return {
    window,
    filter,
    candidateSignals: signals.length,
    acceptedSignals: acceptedSignals.length,
    filteredOutSignals: filteredOut.length,
    removedBuyCe: filteredOut.filter((signal) => signal.signal === StrategySignal.BUY_CE).length,
    removedBuyPe: filteredOut.filter((signal) => signal.signal === StrategySignal.BUY_PE).length,
    executedTrades: capital.executedTrades,
    wins,
    losses,
    winRate: executed.length === 0 ? 0 : wins / executed.length * 100,
    totalNetPnl: capital.totalNetPnl,
    averageNetPnl: average(netPnl),
    medianNetPnl: median(netPnl),
    finalCapital: capital.finalCapital,
    returnPercent: capital.returnPercent,
    maximumDrawdownAmount: capital.maximumDrawdownAmount,
    maximumDrawdownPercent: capital.maximumDrawdownPercent,
  };
}

function summarize(filter: TimeFilter, results: readonly WindowFilterResult[], allDay: ReadonlyMap<number, WindowFilterResult>): StabilitySummary {
  let higherReturnWindows = 0;
  let lowerDrawdownWindows = 0;
  let improvingBothWindows = 0;
  results.forEach((result) => {
    const baseline = allDay.get(result.window.index);
    if (!baseline || filter.id === 'ALL_DAY') return;
    const higherReturn = result.returnPercent > baseline.returnPercent;
    const lowerDrawdown = result.maximumDrawdownPercent < baseline.maximumDrawdownPercent;
    if (higherReturn) higherReturnWindows += 1;
    if (lowerDrawdown) lowerDrawdownWindows += 1;
    if (higherReturn && lowerDrawdown) improvingBothWindows += 1;
  });
  return {
    filter,
    windowsEvaluated: results.length,
    averageTrades: average(results.map((result) => result.executedTrades)),
    averageReturnPercent: average(results.map((result) => result.returnPercent)),
    averageNetPnl: average(results.map((result) => result.totalNetPnl)),
    averageWinRate: average(results.map((result) => result.winRate)),
    averageMaximumDrawdownPercent: average(results.map((result) => result.maximumDrawdownPercent)),
    positiveNetPnlWindows: results.filter((result) => result.totalNetPnl > 0).length,
    higherReturnWindows,
    lowerDrawdownWindows,
    improvingBothWindows,
    removedBuyCe: results.reduce((sum, result) => sum + result.removedBuyCe, 0),
    removedBuyPe: results.reduce((sum, result) => sum + result.removedBuyPe, 0),
  };
}

function printWindowResult(result: WindowFilterResult): void {
  const start = result.window.sessions[0].date;
  const end = result.window.sessions[result.window.sessions.length - 1].date;
  console.log(`${result.filter.id} | candidate=${result.candidateSignals} accepted=${result.acceptedSignals} filtered=${result.filteredOutSignals} (CE=${result.removedBuyCe}, PE=${result.removedBuyPe}) | executed=${result.executedTrades} wins=${result.wins} losses=${result.losses} winRate=${percent(result.winRate)} | net=${money(result.totalNetPnl)} avg=${money(result.averageNetPnl)} median=${money(result.medianNetPnl)} | final=${money(result.finalCapital)} return=${percent(result.returnPercent)} | maxDD=${money(result.maximumDrawdownAmount)} (${percent(result.maximumDrawdownPercent)}) | ${start} to ${end}`);
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting option time-of-day filter stability research', { underlyingInstrumentKey, initialCapital, researchWindowSessions, stepSessions });

  const sessions = await loadSessions();
  const windows = createWindows(sessions);
  const signalsByWindow = new Map<number, BaselineSignal[]>();
  windows.forEach((window) => signalsByWindow.set(window.index, generateSignals(window.sessions)));
  const uniqueSignals = Array.from(
    new Map(
      Array.from(signalsByWindow.values()).flat().map((signal) => [`${signal.timestamp.getTime()}|${signal.signal}`, signal])
    ).values()
  );
  const resolved = await resolveTrades(accessToken, uniqueSignals);
  if (resolved.trades.length === 0) throw new Error('No eligible historical option trades were resolved.');
  const candidates = buildCandidates(resolved.trades);
  const byFilter = new Map<string, WindowFilterResult[]>();

  console.log(`Dataset: completeSessions=${sessions.length}; uniqueWindowSignals=${uniqueSignals.length}; resolvedTrades=${candidates.length}; unavailable=${resolved.unavailable}; ambiguousExcluded=${resolved.ambiguous}; brokerage=STANDARD Rs20/order; slippage=1.00% entry/exit; capital=Rs100000.`);
  for (const window of windows) {
    console.log(`\nWindow ${window.index}: ${window.sessions[0].date} to ${window.sessions[window.sessions.length - 1].date} (${window.sessions.length} sessions)`);
    const windowSignals = signalsByWindow.get(window.index) ?? [];
    timeFilters.forEach((filter) => {
      const result = runFilter(window, filter, windowSignals, candidates);
      byFilter.set(filter.id, [...(byFilter.get(filter.id) ?? []), result]);
      printWindowResult(result);
    });
  }

  const allDay = new Map((byFilter.get('ALL_DAY') ?? []).map((result) => [result.window.index, result]));
  const summaries = timeFilters.map((filter) => summarize(filter, byFilter.get(filter.id) ?? [], allDay));
  console.log('\nStability summary');
  console.log('Configuration | Windows | Avg trades | Avg return % | Avg net P&L | Avg win rate | Avg max DD % | Positive windows | Higher return vs ALL | Lower DD vs ALL | Both | Removed CE | Removed PE');
  summaries.forEach((summary) => {
    console.log(`${summary.filter.label} | ${summary.windowsEvaluated} | ${summary.averageTrades.toFixed(2)} | ${percent(summary.averageReturnPercent)} | ${money(summary.averageNetPnl)} | ${percent(summary.averageWinRate)} | ${percent(summary.averageMaximumDrawdownPercent)} | ${summary.positiveNetPnlWindows} | ${summary.higherReturnWindows} | ${summary.lowerDrawdownWindows} | ${summary.improvingBothWindows} | ${summary.removedBuyCe} | ${summary.removedBuyPe}`);
  });
  console.log('\nThis is chronological historical stability research only. No time filter is promoted automatically.');
  logger.info('Option time-of-day filter stability research completed', { completeSessions: sessions.length, uniqueWindowSignals: uniqueSignals.length, resolvedTrades: candidates.length, windows: windows.length });
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  logger.error('Option time-of-day filter stability research failed', { message });
  console.error('Option time-of-day filter stability research failed.', message);
  process.exitCode = 1;
});
