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
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import { OptionTradePnlDto } from '../modules/options/dto/option-trade-pnl.dto';
import HistoricalOptionChargesCalculatorService from '../modules/options/services/historical-option-charges-calculator.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import OptionTradePnlCalculatorService from '../modules/options/services/option-trade-pnl-calculator.service';
import { OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

dotenv.config();

const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandleCount = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
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

interface ScenarioTrade extends ResolvedTrade {
  scenario: BrokerageScenario;
  pnl: OptionTradePnlDto;
}

interface UnavailableRecord extends StrategySignalRecord {
  reason: string;
}

interface BrokerageScenario {
  id: 'STANDARD' | 'PLUS';
  label: string;
  configuration: typeof HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD;
}

interface ScenarioMetrics {
  scenario: BrokerageScenario;
  trades: readonly ScenarioTrade[];
  netProfitable: number;
  netLosing: number;
  breakeven: number;
  winRate: number;
  totalGrossPnl: number;
  totalCharges: number;
  totalNetPnl: number;
  averageNetPnl: number | null;
  medianNetPnl: number | null;
  averageWinner: number | null;
  averageLoser: number | null;
  largestWinner: number | null;
  largestLoser: number | null;
  averageGrossReturnPercent: number | null;
  medianGrossReturnPercent: number | null;
  averageNetReturnPercent: number | null;
  medianNetReturnPercent: number | null;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  averageWinToLossRatio: number | null;
}

type CompleteSession = [date: string, candles: StoredCandle[]];

const scenarios: readonly BrokerageScenario[] = [
  { id: 'STANDARD', label: 'STANDARD 20 rupees/order', configuration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD },
  { id: 'PLUS', label: 'PLUS 30 rupees/order', configuration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.PLUS },
];

function marketDateAndMinute(timestamp: Date): { date: string; minuteOfDay: number } {
  const values = Object.fromEntries(marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minuteOfDay: Number(values.hour) * 60 + Number(values.minute) };
}

function isCompleteSession(candles: readonly StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = marketDateAndMinute(sorted[0].candleTime);
  const last = marketDateAndMinute(sorted[sorted.length - 1].candleTime);
  return first.minuteOfDay === marketSessionStartMinute && last.minuteOfDay === marketSessionEndMinute &&
    sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}

function toInternalCandles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap(([, candles]) => candles)
    .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime())
    .map((candle) => {
      const volume = Number(candle.volume);
      const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
      if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) {
        throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
      }
      return { timestamp: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
    });
}

function scalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const entry = results.indicators.find((candidate) => candidate.config.type === type && 'period' in candidate.config && candidate.config.period === period);
  const value = entry?.result.values.find((candidate) => candidate.timestamp.getTime() === timestamp.getTime());
  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}

function closestExpiry(expiries: readonly string[], date: string): string {
  const expiry = expiries.filter((candidate) => candidate >= date).sort((left, right) => left.localeCompare(right))[0];
  if (!expiry) throw new Error(`No expired option expiry is available on or after ${date}.`);
  return expiry;
}

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const value = cache.get(key);
  if (value) return value;
  const created = create();
  cache.set(key, created);
  return created;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function money(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(2)}`;
}

function percent(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(2)}%`;
}

async function generateSignals(repository: HistoricalCandleRepository): Promise<StrategySignalRecord[]> {
  const grouped = new Map<string, StoredCandle[]>();
  (await repository.findByInstrumentAndTimeframe(underlyingInstrumentKey, sourceTimeframe)).forEach((candle) => {
    const date = marketDateAndMinute(candle.candleTime).date;
    grouped.set(date, [...(grouped.get(date) ?? []), candle]);
  });
  const sessions = Array.from(grouped.entries()).filter(([, candles]) => isCompleteSession(candles))
    .sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length === 0) throw new Error('No complete NIFTY sessions are available for net P&L research.');

  const oneMinuteCandles = toInternalCandles(sessions);
  const spots = new Map(oneMinuteCandles.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinuteCandles = new CandleTimeframeAggregatorService().aggregate(oneMinuteCandles, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinuteCandles, {
    indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }],
  });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const signals: StrategySignalRecord[] = [];

  fiveMinuteCandles.forEach((candle, index) => {
    const previous = fiveMinuteCandles[index - 1];
    if (!previous) return;
    const previousFast = scalar(indicators, IndicatorType.EMA, 15, previous.timestamp);
    const currentFast = scalar(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = scalar(indicators, IndicatorType.EMA, 35, previous.timestamp);
    const currentSlow = scalar(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = scalar(indicators, IndicatorType.RSI, 14, candle.timestamp);
    const spotPrice = spots.get(candle.timestamp.getTime());
    if ([previousFast, currentFast, previousSlow, currentSlow, rsi, spotPrice].some((value) => value === undefined)) return;
    const crossover = strategy.evaluate({
      fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: previousFast as number }, { timestamp: candle.timestamp, value: currentFast as number }] } as EmaResult,
      slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: previousSlow as number }, { timestamp: candle.timestamp, value: currentSlow as number }] } as EmaResult,
    });
    const confirmed = (crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) ||
      (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45);
    if (confirmed && (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE)) {
      signals.push({ timestamp: candle.timestamp, signal: crossover.signal, spotPrice: spotPrice as number });
    }
  });
  return signals;
}

function calculateMetrics(scenario: BrokerageScenario, trades: readonly ScenarioTrade[]): ScenarioMetrics {
  const net = trades.map((trade) => trade.pnl.netPnl);
  const gross = trades.map((trade) => trade.pnl.grossPnl);
  const winners = net.filter((value) => value > 0);
  const losers = net.filter((value) => value < 0);
  const grossProfit = total(gross.filter((value) => value > 0));
  const grossLoss = Math.abs(total(gross.filter((value) => value < 0)));
  const averageWinner = average(winners);
  const averageLoser = average(losers.map(Math.abs));
  return {
    scenario,
    trades,
    netProfitable: winners.length,
    netLosing: losers.length,
    breakeven: net.filter((value) => value === 0).length,
    winRate: percentage(winners.length, trades.length),
    totalGrossPnl: total(gross),
    totalCharges: total(trades.map((trade) => trade.pnl.totalCharges)),
    totalNetPnl: total(net),
    averageNetPnl: average(net),
    medianNetPnl: median(net),
    averageWinner,
    averageLoser,
    largestWinner: winners.length === 0 ? null : Math.max(...winners),
    largestLoser: losers.length === 0 ? null : Math.min(...losers),
    averageGrossReturnPercent: average(trades.map((trade) => trade.pnl.grossReturnPercent)),
    medianGrossReturnPercent: median(trades.map((trade) => trade.pnl.grossReturnPercent)),
    averageNetReturnPercent: average(trades.map((trade) => trade.pnl.netReturnPercent)),
    medianNetReturnPercent: median(trades.map((trade) => trade.pnl.netReturnPercent)),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? null : null) : grossProfit / grossLoss,
    averageWinToLossRatio: averageWinner === null || averageLoser === null || averageLoser === 0 ? null : averageWinner / averageLoser,
  };
}

function printTrade(trade: ScenarioTrade): void {
  const { pnl, exit, contract } = trade;
  console.log(`${trade.scenario.id} | ${marketDateAndMinute(trade.timestamp).date} ${trade.timestamp.toISOString()} | ${trade.signal} | spot=${trade.spotPrice.toFixed(2)} | ${contract.tradingSymbol} | key=${contract.instrumentKey} | expiry=${marketDateAndMinute(contract.expiry).date} | ${contract.optionType} ${contract.strikePrice} | lot=${trade.lotSize} qty=${pnl.quantity} | entry=${pnl.entryPremium.toFixed(2)} exit=${pnl.exitPremium.toFixed(2)} at=${exit.exitTimestamp?.toISOString() ?? 'N/A'} reason=${exit.exitReason} hold=${exit.holdingMinutes ?? 'N/A'}m | gross=${money(pnl.grossPnl)} (${percent(pnl.grossReturnPercent)}) | charges=b:${money(pnl.charges.brokerage)},stt:${money(pnl.charges.stt)},ex:${money(pnl.charges.exchangeTransactionCharges)},sebi:${money(pnl.charges.sebiCharges)},gst:${money(pnl.charges.gst)},stamp:${money(pnl.charges.stampDuty)},other:${money(pnl.charges.otherCharges)},total:${money(pnl.totalCharges)} | net=${money(pnl.netPnl)} (${percent(pnl.netReturnPercent)})`);
}

function printExitAnalysis(metrics: ScenarioMetrics): void {
  console.log('Exit analysis');
  (['TARGET', 'STOP_LOSS', 'TIME_EXIT'] as const).forEach((reason) => {
    const trades = metrics.trades.filter((trade) => trade.exit.exitReason === reason);
    const net = trades.map((trade) => trade.pnl.netPnl);
    console.log(`${reason}: trades=${trades.length}; totalNet=${money(total(net))}; avgNet=${money(average(net))}; winRate=${percent(percentage(net.filter((value) => value > 0).length, trades.length))}`);
  });
}

function printDirectionAnalysis(metrics: ScenarioMetrics): void {
  console.log('Direction analysis');
  ([StrategySignal.BUY_CE, StrategySignal.BUY_PE] as const).forEach((signal) => {
    const trades = metrics.trades.filter((trade) => trade.signal === signal);
    const net = trades.map((trade) => trade.pnl.netPnl);
    console.log(`${signal}: trades=${trades.length}; wins=${net.filter((value) => value > 0).length}; losses=${net.filter((value) => value < 0).length}; totalNet=${money(total(net))}; avgNet=${money(average(net))}`);
  });
}

function printMonthlyAnalysis(metrics: ScenarioMetrics): void {
  console.log('Monthly net results');
  const monthly = new Map<string, ScenarioTrade[]>();
  metrics.trades.forEach((trade) => {
    const month = marketDateAndMinute(trade.timestamp).date.slice(0, 7);
    monthly.set(month, [...(monthly.get(month) ?? []), trade]);
  });
  Array.from(monthly.entries()).sort(([left], [right]) => left.localeCompare(right)).forEach(([month, trades]) => {
    const net = trades.map((trade) => trade.pnl.netPnl);
    console.log(`${month}: trades=${trades.length}; wins=${net.filter((value) => value > 0).length}; losses=${net.filter((value) => value < 0).length}; gross=${money(total(trades.map((trade) => trade.pnl.grossPnl)))}; charges=${money(total(trades.map((trade) => trade.pnl.totalCharges)))}; net=${money(total(net))}; winRate=${percent(percentage(net.filter((value) => value > 0).length, trades.length))}`);
  });
}

function printMetrics(metrics: ScenarioMetrics): void {
  console.log(`\n${metrics.scenario.label}`);
  console.log(`Net outcomes: profitable=${metrics.netProfitable}; losing=${metrics.netLosing}; breakeven=${metrics.breakeven}; winRate=${percent(metrics.winRate)}`);
  console.log(`Money: gross=${money(metrics.totalGrossPnl)}; charges=${money(metrics.totalCharges)}; net=${money(metrics.totalNetPnl)}; avgNet=${money(metrics.averageNetPnl)}; medianNet=${money(metrics.medianNetPnl)}; avgWinner=${money(metrics.averageWinner)}; avgLoser=${money(metrics.averageLoser)}; largestWinner=${money(metrics.largestWinner)}; largestLoser=${money(metrics.largestLoser)}`);
  console.log(`Returns: avgGross=${percent(metrics.averageGrossReturnPercent)}; medianGross=${percent(metrics.medianGrossReturnPercent)}; avgNet=${percent(metrics.averageNetReturnPercent)}; medianNet=${percent(metrics.medianNetReturnPercent)}`);
  console.log(`Risk/reward (gross): grossProfit=${money(metrics.grossProfit)}; grossLoss=${money(metrics.grossLoss)}; profitFactor=${metrics.profitFactor === null ? 'N/A' : metrics.profitFactor.toFixed(2)}; avgNetWin/avgNetLoss=${metrics.averageWinToLossRatio === null ? 'N/A' : metrics.averageWinToLossRatio.toFixed(2)}`);
  printExitAnalysis(metrics);
  printDirectionAnalysis(metrics);
  printMonthlyAnalysis(metrics);
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');

  logger.info('Starting historical option net P&L research', { underlyingInstrumentKey });
  const signals = await generateSignals(new HistoricalCandleRepository());
  if (signals.length === 0) throw new Error('The EMA15/35 + RSI55/45 baseline produced no historical signals.');

  const expiredOptionClient = new UpstoxExpiredOptionClient(accessToken);
  const expiredCandleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();
  const exitEvaluator = new OptionExitPolicyEvaluatorService();
  const chargeCalculator = new HistoricalOptionChargesCalculatorService();
  const pnlCalculator = new OptionTradePnlCalculatorService();
  const instrumentRepository = new InstrumentRepository();
  const expiryCache = new Map<string, Promise<string[]>>();
  const contractsCache = new Map<string, Promise<OptionContract[]>>();
  const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const resolved: ResolvedTrade[] = [];
  const unavailable: UnavailableRecord[] = [];
  const ambiguous: StrategySignalRecord[] = [];

  for (const signal of signals) {
    try {
      const signalDate = marketDateAndMinute(signal.timestamp).date;
      const expiries = await getOrCreate(expiryCache, underlyingInstrumentKey, () => expiredOptionClient.fetchAvailableExpiries(underlyingInstrumentKey));
      const expiry = closestExpiry(expiries, signalDate);
      const contracts = await getOrCreate(contractsCache, `${underlyingInstrumentKey}|${expiry}`, () => expiredOptionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
      const underlying = contracts[0]?.underlying;
      if (!underlying) throw new Error('Expired option contracts did not contain an underlying symbol.');
      const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const selectedContract = contracts.find((contract) => contract.instrumentKey === selected.instrumentKey);
      if (!selectedContract) {
        throw new Error(`Selected contract ${selected.instrumentKey} is absent from the expired-contract response.`);
      }
      const instrument = selectedContract.lotSize === undefined
        ? await instrumentRepository.findByInstrumentKey(selected.instrumentKey)
        : null;
      const lotSize = selectedContract.lotSize ?? instrument?.lotSize;
      if (lotSize === undefined || !Number.isInteger(lotSize) || lotSize <= 0) {
        throw new Error(`No valid historical lot size was supplied by Upstox or found locally for ${selected.instrumentKey}.`);
      }
      const candles = await getOrCreate(candleCache, `${selected.instrumentKey}|${signalDate}`, () => expiredCandleClient.fetchCandles(selected.instrumentKey, signalDate, signalDate));
      const entry = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
      if (!entry) throw new Error('No option candle aligns exactly with the signal timestamp.');
      const exit = exitEvaluator.evaluate({ signalTimestamp: signal.timestamp, entryPremium: entry.close, candles, exitPolicy });
      if (exit.ambiguous) {
        ambiguous.push(signal);
        console.log(`AMBIGUOUS EXIT | ${signal.timestamp.toISOString()} | ${signal.signal} | ${selected.tradingSymbol} | ${exit.exitTimestamp?.toISOString() ?? 'unknown candle'}`);
        continue;
      }
      if (exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null || exit.holdingMinutes === null) {
        unavailable.push({ ...signal, reason: 'Option exit was unavailable within the same trading session.' });
        console.log(`UNAVAILABLE EXIT | ${signal.timestamp.toISOString()} | ${signal.signal} | ${selected.tradingSymbol}`);
        continue;
      }
      resolved.push({ ...signal, contract: selectedContract, lotSize, entryPremium: entry.close, exit });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      unavailable.push({ ...signal, reason });
      console.log(`UNAVAILABLE CONTRACT/CANDLES | ${signal.timestamp.toISOString()} | ${signal.signal} | ${reason}`);
    }
  }

  if (resolved.length === 0) throw new Error('No strategy signal could be fully evaluated with option contract, candle, lot-size, and exit data.');

  const scenarioTrades: ScenarioTrade[] = [];
  for (const trade of resolved) {
    const statutoryRateConfiguration = getHistoricalOptionStatutoryChargeRateConfig(trade.timestamp);
    for (const scenario of scenarios) {
      const charges = chargeCalculator.calculate({
        tradeDate: trade.timestamp,
        entryPremium: trade.entryPremium,
        exitPremium: trade.exit.exitPremium as number,
        quantity: trade.lotSize,
        statutoryRateConfiguration,
        brokerageConfiguration: scenario.configuration,
      });
      const pnl = pnlCalculator.calculate({
        entryPremium: trade.entryPremium,
        exitPremium: trade.exit.exitPremium as number,
        quantity: trade.lotSize,
        charges,
      });
      const scenarioTrade = { ...trade, scenario, pnl };
      scenarioTrades.push(scenarioTrade);
      printTrade(scenarioTrade);
    }
  }

  const metrics = scenarios.map((scenario) => calculateMetrics(scenario, scenarioTrades.filter((trade) => trade.scenario.id === scenario.id)));
  const grossPnl = scenarioTrades.filter((trade) => trade.scenario.id === 'STANDARD').map((trade) => trade.pnl.grossPnl);
  console.log(`\nGeneral: total strategy signals=${signals.length}; resolved contracts=${resolved.length}; evaluated trades=${resolved.length}; unavailable trades=${unavailable.length}; ambiguous trades=${ambiguous.length}; gross profitable=${grossPnl.filter((value) => value > 0).length}; gross losing=${grossPnl.filter((value) => value < 0).length}`);
  metrics.forEach(printMetrics);
  console.log('\nConcise comparison');
  console.log('Scenario | Trades | Win rate | Total gross P&L | Total charges | Total net P&L | Avg net/trade | Median net');
  metrics.forEach((metric) => console.log(`${metric.scenario.label} | ${metric.trades.length} | ${percent(metric.winRate)} | ${money(metric.totalGrossPnl)} | ${money(metric.totalCharges)} | ${money(metric.totalNetPnl)} | ${money(metric.averageNetPnl)} | ${money(metric.medianNetPnl)}`));

  if (unavailable.length > 0) {
    console.log('\nUnavailable option trades');
    unavailable.forEach((record) => console.log(`${record.timestamp.toISOString()} | ${record.signal} | ${record.reason}`));
  }
  if (ambiguous.length > 0) {
    console.log('\nAmbiguous option exits (excluded from P&L)');
    ambiguous.forEach((record) => console.log(`${record.timestamp.toISOString()} | ${record.signal}`));
  }
  console.log('This is historical one-lot option research only; it is not a capital simulation or production trading recommendation.');
  logger.info('Historical option net P&L research completed', { totalSignals: signals.length, resolvedTrades: resolved.length, unavailableTrades: unavailable.length, ambiguousTrades: ambiguous.length });
}

run().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  logger.error('Historical option net P&L research failed', { errorMessage });
  console.error('Historical option net P&L research failed.', errorMessage);
  process.exitCode = 1;
});
