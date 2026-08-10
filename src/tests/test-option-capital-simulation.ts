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
import {
  getHistoricalOptionStatutoryChargeRateConfig,
  HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS,
} from '../modules/options/config/historical-option-charge-rates.config';
import { OptionCapitalSimulationResult, OptionCapitalSimulationTradeInput } from '../modules/options/dto/option-capital-simulation.dto';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import HistoricalOptionChargesCalculatorService from '../modules/options/services/historical-option-charges-calculator.service';
import OptionCapitalSimulatorService from '../modules/options/services/option-capital-simulator.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import OptionTradePnlCalculatorService from '../modules/options/services/option-trade-pnl-calculator.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

dotenv.config();

const initialCapital = 100_000;
const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandleCount = 375;
const sessionStartMinute = 9 * 60 + 15;
const sessionEndMinute = 15 * 60 + 29;
const exitPolicy = { type: 'TARGET_STOP' as const, targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 };
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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

interface StrategySignalRecord {
  timestamp: Date;
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  spotPrice: number;
}

interface ResolvedTrade extends StrategySignalRecord {
  contract: OptionContract;
  lotSize: number;
  entryPremium: number;
  exit: OptionExitPolicyEvaluationResult;
}

interface BrokerageScenario {
  id: 'STANDARD' | 'PLUS';
  label: string;
  configuration: typeof HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD;
}

interface UnavailableTrade extends StrategySignalRecord {
  reason: string;
}

type CompleteSession = [date: string, candles: StoredCandle[]];

const scenarios: readonly BrokerageScenario[] = [
  { id: 'STANDARD', label: 'STANDARD 20 rupees/order', configuration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD },
  { id: 'PLUS', label: 'PLUS 30 rupees/order', configuration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.PLUS },
];

function marketDateAndMinute(timestamp: Date): { date: string; minuteOfDay: number } {
  const parts = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) };
}

function formatMoney(value: number): string {
  return `₹${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function isCompleteSession(candles: readonly StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = marketDateAndMinute(sorted[0].candleTime);
  const last = marketDateAndMinute(sorted[sorted.length - 1].candleTime);
  return first.minuteOfDay === sessionStartMinute && last.minuteOfDay === sessionEndMinute &&
    sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}

function toInternalCandles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap(([, candles]) => candles).sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()).map((candle) => {
    const volume = Number(candle.volume);
    const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
    if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
      throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
    }
    return { timestamp: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
  });
}

function scalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  const value = indicator?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime());
  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}

function nearestExpiry(expiries: readonly string[], date: string): string {
  const expiry = expiries.filter((value) => value >= date).sort((left, right) => left.localeCompare(right))[0];
  if (!expiry) throw new Error(`No expired option expiry is available on or after ${date}.`);
  return expiry;
}

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, request: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const created = request();
  cache.set(key, created);
  return created;
}

async function generateSignals(): Promise<StrategySignalRecord[]> {
  const grouped = new Map<string, StoredCandle[]>();
  (await new HistoricalCandleRepository().findByInstrumentAndTimeframe(underlyingInstrumentKey, sourceTimeframe)).forEach((candle) => {
    const date = marketDateAndMinute(candle.candleTime).date;
    grouped.set(date, [...(grouped.get(date) ?? []), candle]);
  });
  const sessions = Array.from(grouped.entries()).filter(([, candles]) => isCompleteSession(candles))
    .sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length === 0) throw new Error('No complete NIFTY sessions are available for capital simulation research.');

  const oneMinute = toInternalCandles(sessions);
  const spotByTimestamp = new Map(oneMinute.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinute = new CandleTimeframeAggregatorService().aggregate(oneMinute, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinute, {
    indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }],
  });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const signals: StrategySignalRecord[] = [];
  fiveMinute.forEach((candle, index) => {
    const previous = fiveMinute[index - 1];
    if (!previous) return;
    const previousFast = scalar(indicators, IndicatorType.EMA, 15, previous.timestamp);
    const currentFast = scalar(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = scalar(indicators, IndicatorType.EMA, 35, previous.timestamp);
    const currentSlow = scalar(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = scalar(indicators, IndicatorType.RSI, 14, candle.timestamp);
    const spotPrice = spotByTimestamp.get(candle.timestamp.getTime());
    if ([previousFast, currentFast, previousSlow, currentSlow, rsi, spotPrice].some((value) => value === undefined)) return;
    const crossover = strategy.evaluate({
      fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: previousFast as number }, { timestamp: candle.timestamp, value: currentFast as number }] } as EmaResult,
      slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: previousSlow as number }, { timestamp: candle.timestamp, value: currentSlow as number }] } as EmaResult,
    });
    const accepted = (crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) ||
      (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45);
    if (accepted && (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE)) {
      signals.push({ timestamp: candle.timestamp, signal: crossover.signal, spotPrice: spotPrice as number });
    }
  });
  return signals;
}

async function resolveTrades(accessToken: string, signals: readonly StrategySignalRecord[]): Promise<{
  resolved: ResolvedTrade[];
  unavailable: UnavailableTrade[];
  ambiguous: StrategySignalRecord[];
}> {
  const contractClient = new UpstoxExpiredOptionClient(accessToken);
  const candleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();
  const exitEvaluator = new OptionExitPolicyEvaluatorService();
  const instrumentRepository = new InstrumentRepository();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractCache = new Map<string, Promise<OptionContract[]>>();
  const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const resolved: ResolvedTrade[] = [];
  const unavailable: UnavailableTrade[] = [];
  const ambiguous: StrategySignalRecord[] = [];

  for (const signal of signals) {
    try {
      const signalDate = marketDateAndMinute(signal.timestamp).date;
      const expiries = await getOrCreate(expiryCache, underlyingInstrumentKey, () => contractClient.fetchAvailableExpiries(underlyingInstrumentKey));
      const contracts = await getOrCreate(contractCache, `${underlyingInstrumentKey}|${nearestExpiry(expiries, signalDate)}`, () =>
        contractClient.fetchExpiredOptionContracts(underlyingInstrumentKey, nearestExpiry(expiries, signalDate))
      );
      const underlying = contracts[0]?.underlying;
      if (!underlying) throw new Error('Expired option contracts did not contain an underlying symbol.');
      const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const contract = contracts.find((candidate) => candidate.instrumentKey === selected.instrumentKey);
      if (!contract) throw new Error(`Selected contract ${selected.instrumentKey} is absent from the expired-contract response.`);
      const localInstrument = contract.lotSize === undefined ? await instrumentRepository.findByInstrumentKey(contract.instrumentKey) : null;
      const lotSize = contract.lotSize ?? localInstrument?.lotSize;
      if (lotSize === undefined || !Number.isInteger(lotSize) || lotSize <= 0) {
        throw new Error(`No valid historical lot size was supplied by Upstox or found locally for ${contract.instrumentKey}.`);
      }
      const candles = await getOrCreate(candleCache, `${contract.instrumentKey}|${signalDate}`, () => candleClient.fetchCandles(contract.instrumentKey, signalDate, signalDate));
      const entry = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
      if (!entry) throw new Error('No option candle aligns exactly with the signal timestamp.');
      const exit = exitEvaluator.evaluate({ signalTimestamp: signal.timestamp, entryPremium: entry.close, candles, exitPolicy });
      if (exit.ambiguous) {
        ambiguous.push(signal);
      } else if (exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null || exit.holdingMinutes === null) {
        unavailable.push({ ...signal, reason: 'Option exit was unavailable within the same trading session.' });
      } else {
        resolved.push({ ...signal, contract, lotSize, entryPremium: entry.close, exit });
      }
    } catch (error) {
      unavailable.push({ ...signal, reason: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
  return { resolved, unavailable, ambiguous };
}

function buildCandidates(trades: readonly ResolvedTrade[], scenario: BrokerageScenario): OptionCapitalSimulationTradeInput[] {
  const chargeCalculator = new HistoricalOptionChargesCalculatorService();
  const pnlCalculator = new OptionTradePnlCalculatorService();
  return trades.map((trade) => {
    const exitPremium = trade.exit.exitPremium as number;
    const charges = chargeCalculator.calculate({
      tradeDate: trade.timestamp,
      entryPremium: trade.entryPremium,
      exitPremium,
      quantity: trade.lotSize,
      statutoryRateConfiguration: getHistoricalOptionStatutoryChargeRateConfig(trade.timestamp),
      brokerageConfiguration: scenario.configuration,
    });
    const pnl = pnlCalculator.calculate({ entryPremium: trade.entryPremium, exitPremium, quantity: trade.lotSize, charges });
    return {
      signalTimestamp: trade.timestamp,
      exitTimestamp: trade.exit.exitTimestamp as Date,
      signalType: trade.signal,
      instrumentKey: trade.contract.instrumentKey,
      tradingSymbol: trade.contract.tradingSymbol,
      quantity: trade.lotSize,
      entryPremium: trade.entryPremium,
      exitPremium,
      entryValue: pnl.entryValue,
      totalCharges: pnl.totalCharges,
      netPnl: pnl.netPnl,
    };
  });
}

function printMonthlySummary(result: OptionCapitalSimulationResult): void {
  const months = new Map<string, typeof result.trades>();
  result.trades.forEach((trade) => {
    const month = marketDateAndMinute(trade.signalTimestamp).date.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), trade]);
  });
  console.log('Month | Candidates | Executed | Rejected | Wins | Losses | Net P&L | Month-end capital');
  Array.from(months.entries()).sort(([left], [right]) => left.localeCompare(right)).forEach(([month, trades]) => {
    const exits = result.equityEvents.filter((event) => marketDateAndMinute(event.timestamp).date.slice(0, 7) === month);
    const monthEndCapital = exits.length === 0 ? result.initialCapital : exits[exits.length - 1].equity;
    const executed = trades.filter((trade) => trade.executed);
    console.log(`${month} | ${trades.length} | ${executed.length} | ${trades.length - executed.length} | ${executed.filter((trade) => trade.netPnl > 0).length} | ${executed.filter((trade) => trade.netPnl < 0).length} | ${formatMoney(executed.reduce((sum, trade) => sum + trade.netPnl, 0))} | ${formatMoney(monthEndCapital)}`);
  });
}

function printScenario(scenario: BrokerageScenario, result: OptionCapitalSimulationResult): void {
  console.log(`\n${scenario.label}`);
  console.log(`Capital: initial=${formatMoney(result.initialCapital)}; final=${formatMoney(result.finalCapital)}; totalNet=${formatMoney(result.totalNetPnl)}; return=${formatPercent(result.returnPercent)}`);
  console.log(`Execution: candidates=${result.totalCandidateTrades}; executed=${result.executedTrades}; rejected=${result.rejectedTrades}; insufficientCapital=${result.insufficientCapitalRejectedTrades}; profitable=${result.profitableTrades}; losing=${result.losingTrades}; winRate=${formatPercent(result.executedTrades === 0 ? 0 : (result.profitableTrades / result.executedTrades) * 100)}`);
  console.log(`Capital utilization: maxDeployed=${formatMoney(result.maximumCapitalDeployed)}; avgDeployed=${formatMoney(result.averageCapitalDeployed)}; maxPositions=${result.maximumSimultaneousPositions}; minAvailable=${formatMoney(result.minimumAvailableCash)}`);
  console.log(`Risk: peakEquity=${formatMoney(result.peakEquity)}; minimumEquity=${formatMoney(result.minimumEquity)}; maxDrawdown=${formatMoney(result.maximumDrawdownAmount)}; maxDrawdownPct=${formatPercent(result.maximumDrawdownPercent)}`);
  console.log('Rejected trades');
  result.trades.filter((trade) => !trade.executed).forEach((trade) => {
    const requiredCapital = trade.entryValue + (trade.entryCharges ?? 0);
    console.log(`${trade.signalTimestamp.toISOString()} | ${trade.tradingSymbol} | required=${formatMoney(requiredCapital)} | available=${formatMoney(trade.capitalBefore)} | ${trade.rejectionReason}`);
  });
  if (result.rejectedTrades === 0) console.log('None');
  console.log('Monthly summary');
  printMonthlySummary(result);
  console.log('Chronological equity curve');
  result.equityEvents.forEach((event) => console.log(`${event.timestamp.toISOString()} | ${event.type} | available=${formatMoney(event.availableCash)} | deployed=${formatMoney(event.capitalDeployed)} | equity=${formatMoney(event.equity)}`));
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting 100000 rupee historical option capital simulation', { underlyingInstrumentKey, initialCapital });
  const signals = await generateSignals();
  if (signals.length === 0) throw new Error('The EMA15/35 + RSI55/45 baseline produced no historical signals.');
  const dataset = await resolveTrades(accessToken, signals);
  if (dataset.resolved.length === 0) throw new Error('No historical option trade was available for capital simulation.');

  const simulator = new OptionCapitalSimulatorService();
  const results = scenarios.map((scenario) => ({ scenario, result: simulator.simulate({ initialCapital, trades: buildCandidates(dataset.resolved, scenario) }) }));
  console.log(`\nResearch dataset: strategySignals=${signals.length}; eligibleEvaluatedTrades=${dataset.resolved.length}; pipelineUnavailable=${dataset.unavailable.length}; ambiguousExcluded=${dataset.ambiguous.length}`);
  results.forEach(({ scenario, result }) => printScenario(scenario, result));
  console.log('\nSTANDARD vs PLUS comparison');
  console.log('Scenario | Final capital | Total net P&L | Return | Executed | Rejected | Max drawdown | Max positions');
  results.forEach(({ scenario, result }) => console.log(`${scenario.label} | ${formatMoney(result.finalCapital)} | ${formatMoney(result.totalNetPnl)} | ${formatPercent(result.returnPercent)} | ${result.executedTrades} | ${result.rejectedTrades} | ${formatMoney(result.maximumDrawdownAmount)} | ${result.maximumSimultaneousPositions}`));
  console.log('This is a historical one-lot cash simulation only; it does not include slippage, risk limits, capital compounding, or live order execution.');
  logger.info('Historical option capital simulation completed', { strategySignals: signals.length, eligibleTrades: dataset.resolved.length, unavailable: dataset.unavailable.length, ambiguous: dataset.ambiguous.length });
}

run().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  logger.error('Historical option capital simulation failed', { errorMessage });
  console.error('Historical option capital simulation failed.', errorMessage);
  process.exitCode = 1;
});
