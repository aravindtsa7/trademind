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
import { OptionCapitalSimulationResult, OptionCapitalSimulationTradeInput } from '../modules/options/dto/option-capital-simulation.dto';
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
const expectedOneMinuteCandleCount = 375;
const sessionStartMinute = 9 * 60 + 15;
const sessionEndMinute = 15 * 60 + 29;
const exitPolicy = { type: 'TARGET_STOP' as const, targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 };
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

interface StoredCandle { candleTime: Date; open: { toString(): string }; high: { toString(): string }; low: { toString(): string }; close: { toString(): string }; volume: bigint; openInterest: bigint | null; }
interface Signal { timestamp: Date; signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE; spotPrice: number; }
interface ResolvedTrade extends Signal { contract: OptionContract; lotSize: number; entryPremium: number; exit: OptionExitPolicyEvaluationResult; }
interface SlippageScenario { id: string; percent: number; }
interface StressMetrics { scenario: SlippageScenario; result: OptionCapitalSimulationResult; totalCharges: number; averageNetPnl: number; medianNetPnl: number; largestWinner: number | null; largestLoser: number | null; winRate: number; }
type CompleteSession = [date: string, candles: StoredCandle[]];

const slippageScenarios: readonly SlippageScenario[] = [
  { id: '0.00%', percent: 0 }, { id: '0.25%', percent: 0.25 }, { id: '0.50%', percent: 0.5 }, { id: '1.00%', percent: 1 }, { id: '2.00%', percent: 2 },
];

function market(timestamp: Date): { date: string; minuteOfDay: number } {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) };
}
function money(value: number): string { return `₹${value.toFixed(2)}`; }
function percent(value: number): string { return `${value.toFixed(2)}%`; }
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: readonly number[]): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]; }

function isCompleteSession(candles: readonly StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = market(sorted[0].candleTime);
  const last = market(sorted[sorted.length - 1].candleTime);
  return first.minuteOfDay === sessionStartMinute && last.minuteOfDay === sessionEndMinute && sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}
function toCandles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap(([, candles]) => candles).sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()).map((candle) => {
    const volume = Number(candle.volume); const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
    if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
    return { timestamp: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
  });
}
function scalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const result = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  const value = result?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime());
  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}
function expiryForDate(expiries: readonly string[], date: string): string {
  const expiry = expiries.filter((candidate) => candidate >= date).sort((left, right) => left.localeCompare(right))[0];
  if (!expiry) throw new Error(`No expired option expiry is available on or after ${date}.`);
  return expiry;
}
function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const current = cache.get(key); if (current) return current; const value = create(); cache.set(key, value); return value;
}

async function generateSignals(): Promise<Signal[]> {
  const byDate = new Map<string, StoredCandle[]>();
  (await new HistoricalCandleRepository().findByInstrumentAndTimeframe(underlyingInstrumentKey, '1minute')).forEach((candle) => {
    const date = market(candle.candleTime).date; byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  });
  const sessions = Array.from(byDate.entries()).filter(([, candles]) => isCompleteSession(candles)).sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length === 0) throw new Error('No complete NIFTY sessions are available for slippage stress research.');
  const oneMinute = toCandles(sessions);
  const spots = new Map(oneMinute.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinute = new CandleTimeframeAggregatorService().aggregate(oneMinute, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinute, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }] });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const signals: Signal[] = [];
  fiveMinute.forEach((candle, index) => {
    const previous = fiveMinute[index - 1]; if (!previous) return;
    const previousFast = scalar(indicators, IndicatorType.EMA, 15, previous.timestamp); const currentFast = scalar(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = scalar(indicators, IndicatorType.EMA, 35, previous.timestamp); const currentSlow = scalar(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = scalar(indicators, IndicatorType.RSI, 14, candle.timestamp); const spot = spots.get(candle.timestamp.getTime());
    if ([previousFast, currentFast, previousSlow, currentSlow, rsi, spot].some((value) => value === undefined)) return;
    const crossover = strategy.evaluate({
      fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: previousFast as number }, { timestamp: candle.timestamp, value: currentFast as number }] } as EmaResult,
      slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: previousSlow as number }, { timestamp: candle.timestamp, value: currentSlow as number }] } as EmaResult,
    });
    if ((crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) || (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45)) {
      if (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE) signals.push({ timestamp: candle.timestamp, signal: crossover.signal, spotPrice: spot as number });
    }
  });
  return signals;
}

async function resolveTrades(accessToken: string, signals: readonly Signal[]): Promise<{ resolved: ResolvedTrade[]; unavailable: number; ambiguous: number }> {
  const contractsClient = new UpstoxExpiredOptionClient(accessToken); const candleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService(); const exitEvaluator = new OptionExitPolicyEvaluatorService(); const instruments = new InstrumentRepository();
  const expiryCache = new Map<string, Promise<string[]>>(); const contractsCache = new Map<string, Promise<OptionContract[]>>(); const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const resolved: ResolvedTrade[] = []; let unavailable = 0; let ambiguous = 0;
  for (const signal of signals) {
    try {
      const signalDate = market(signal.timestamp).date;
      const expiries = await cached(expiryCache, underlyingInstrumentKey, () => contractsClient.fetchAvailableExpiries(underlyingInstrumentKey));
      const expiry = expiryForDate(expiries, signalDate);
      const contracts = await cached(contractsCache, `${underlyingInstrumentKey}|${expiry}`, () => contractsClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
      const underlying = contracts[0]?.underlying; if (!underlying) throw new Error('Expired option contracts did not contain an underlying symbol.');
      const selection = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const contract = contracts.find((candidate) => candidate.instrumentKey === selection.instrumentKey); if (!contract) throw new Error('Selected contract is absent from the expired-contract response.');
      const local = contract.lotSize === undefined ? await instruments.findByInstrumentKey(contract.instrumentKey) : null;
      const lotSize = contract.lotSize ?? local?.lotSize; if (lotSize === undefined || !Number.isInteger(lotSize) || lotSize <= 0) throw new Error('No valid historical lot size is available.');
      const candles = await cached(candleCache, `${contract.instrumentKey}|${signalDate}`, () => candleClient.fetchCandles(contract.instrumentKey, signalDate, signalDate));
      const entry = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime()); if (!entry) throw new Error('No option candle aligns exactly with the signal timestamp.');
      const exit = exitEvaluator.evaluate({ signalTimestamp: signal.timestamp, entryPremium: entry.close, candles, exitPolicy });
      if (exit.ambiguous) { ambiguous += 1; continue; }
      if (exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null) { unavailable += 1; continue; }
      resolved.push({ ...signal, contract, lotSize, entryPremium: entry.close, exit });
    } catch { unavailable += 1; }
  }
  return { resolved, unavailable, ambiguous };
}

function candidates(trades: readonly ResolvedTrade[], scenario: SlippageScenario): { trades: OptionCapitalSimulationTradeInput[]; totalCharges: number } {
  const slippage = new OptionSlippageCalculatorService(); const chargesCalculator = new HistoricalOptionChargesCalculatorService(); const pnlCalculator = new OptionTradePnlCalculatorService();
  let totalCharges = 0;
  const values = trades.map((trade) => {
    const adjusted = slippage.calculate({ entryPremium: trade.entryPremium, exitPremium: trade.exit.exitPremium as number, slippage: { entrySlippagePercent: scenario.percent, exitSlippagePercent: scenario.percent } });
    const charges = chargesCalculator.calculate({ tradeDate: trade.timestamp, entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, quantity: trade.lotSize, statutoryRateConfiguration: getHistoricalOptionStatutoryChargeRateConfig(trade.timestamp), brokerageConfiguration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD });
    const pnl = pnlCalculator.calculate({ entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, quantity: trade.lotSize, charges });
    totalCharges += pnl.totalCharges;
    return { signalTimestamp: trade.timestamp, exitTimestamp: trade.exit.exitTimestamp as Date, signalType: trade.signal, instrumentKey: trade.contract.instrumentKey, tradingSymbol: trade.contract.tradingSymbol, quantity: trade.lotSize, entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, entryValue: pnl.entryValue, totalCharges: pnl.totalCharges, netPnl: pnl.netPnl };
  });
  return { trades: values, totalCharges };
}

function runScenario(scenario: SlippageScenario, dataset: readonly ResolvedTrade[]): StressMetrics {
  const built = candidates(dataset, scenario);
  const result = new OptionCapitalSimulatorService().simulate({ initialCapital, trades: built.trades });
  const executedNet = result.trades.filter((trade) => trade.executed).map((trade) => trade.netPnl);
  return { scenario, result, totalCharges: result.trades.filter((trade) => trade.executed).reduce((sum, trade) => sum + trade.totalCharges, 0), averageNetPnl: average(executedNet), medianNetPnl: median(executedNet), largestWinner: executedNet.filter((value) => value > 0).length ? Math.max(...executedNet.filter((value) => value > 0)) : null, largestLoser: executedNet.filter((value) => value < 0).length ? Math.min(...executedNet.filter((value) => value < 0)) : null, winRate: result.executedTrades === 0 ? 0 : (result.profitableTrades / result.executedTrades) * 100 };
}

function printScenario(metrics: StressMetrics): void {
  const { result } = metrics;
  console.log(`\nSlippage ${metrics.scenario.id} entry / ${metrics.scenario.id} exit`);
  console.log(`Execution: candidates=${result.totalCandidateTrades}; executed=${result.executedTrades}; capitalRejects=${result.insufficientCapitalRejectedTrades}; profitable=${result.profitableTrades}; losing=${result.losingTrades}; winRate=${percent(metrics.winRate)}`);
  console.log(`Capital: final=${money(result.finalCapital)}; totalNet=${money(result.totalNetPnl)}; return=${percent(result.returnPercent)}`);
  console.log(`Costs: totalCharges=${money(metrics.totalCharges)}`);
  console.log(`Trade quality: avgNet=${money(metrics.averageNetPnl)}; medianNet=${money(metrics.medianNetPnl)}; largestWinner=${metrics.largestWinner === null ? 'N/A' : money(metrics.largestWinner)}; largestLoser=${metrics.largestLoser === null ? 'N/A' : money(metrics.largestLoser)}`);
  console.log(`Risk: maxDrawdown=${money(result.maximumDrawdownAmount)}; maxDrawdownPct=${percent(result.maximumDrawdownPercent)}; maxPositions=${result.maximumSimultaneousPositions}; minAvailable=${money(result.minimumAvailableCash)}`);
  if (result.totalNetPnl <= 0 || result.finalCapital <= initialCapital) console.log('FLAG: non-positive stressed net outcome; review sensitivity, do not treat as a live-profit expectation.');
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting historical option slippage stress research', { underlyingInstrumentKey, initialCapital });
  const signals = await generateSignals(); const dataset = await resolveTrades(accessToken, signals);
  if (dataset.resolved.length === 0) throw new Error('No historical option trades were available for slippage stress research.');
  const results = slippageScenarios.map((scenario) => runScenario(scenario, dataset.resolved));
  console.log(`\nDataset: strategySignals=${signals.length}; eligibleEvaluatedTrades=${dataset.resolved.length}; unavailable=${dataset.unavailable}; ambiguousExcluded=${dataset.ambiguous}`);
  results.forEach(printScenario);
  const baseline = results[0];
  console.log('\nComparison');
  console.log('Slippage | Final capital | Return % | Win rate | Avg net/trade | Max drawdown % | Executed | Capital rejects');
  results.forEach((metrics) => console.log(`${metrics.scenario.id} | ${money(metrics.result.finalCapital)} | ${percent(metrics.result.returnPercent)} | ${percent(metrics.winRate)} | ${money(metrics.averageNetPnl)} | ${percent(metrics.result.maximumDrawdownPercent)} | ${metrics.result.executedTrades} | ${metrics.result.insufficientCapitalRejectedTrades}`));
  console.log('\nDegradation versus 0.00% slippage');
  results.forEach((metrics) => {
    const netReduction = baseline.result.totalNetPnl - metrics.result.totalNetPnl;
    const netDegradation = baseline.result.totalNetPnl === 0 ? 0 : (netReduction / Math.abs(baseline.result.totalNetPnl)) * 100;
    console.log(`${metrics.scenario.id}: finalCapitalReduction=${money(baseline.result.finalCapital - metrics.result.finalCapital)}; netPnlReduction=${money(netReduction)}; netPnlDegradation=${percent(netDegradation)}; winRateChange=${percent(metrics.winRate - baseline.winRate)}; maxDrawdownChange=${money(metrics.result.maximumDrawdownAmount - baseline.result.maximumDrawdownAmount)}`);
  });
  console.log('These are deterministic historical one-lot execution-stress results, not live-profit expectations.');
  logger.info('Historical option slippage stress research completed', { strategySignals: signals.length, eligibleTrades: dataset.resolved.length, unavailable: dataset.unavailable, ambiguous: dataset.ambiguous });
}

run().catch((error) => { const errorMessage = error instanceof Error ? error.message : 'Unknown error'; logger.error('Historical option slippage stress research failed', { errorMessage }); console.error('Historical option slippage stress research failed.', errorMessage); process.exitCode = 1; });
