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

const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const initialCapital = 100_000;
const expectedSessionCount = 105;
const researchSessionCount = 80;
const validationSessionCount = 25;
const expectedOneMinuteCandleCount = 375;
const sessionStartMinute = 9 * 60 + 15;
const sessionEndMinute = 15 * 60 + 29;
const exitPolicy = { type: 'TARGET_STOP' as const, targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 };
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

interface StoredCandle { candleTime: Date; open: { toString(): string }; high: { toString(): string }; low: { toString(): string }; close: { toString(): string }; volume: bigint; openInterest: bigint | null; }
interface CompleteSession { date: string; candles: StoredCandle[]; }
interface Signal { timestamp: Date; signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE; spotPrice: number; }
interface ResolvedTrade extends Signal { contract: OptionContract; lotSize: number; entryPremium: number; exit: OptionExitPolicyEvaluationResult; }
interface Candidate { key: string; signalTimestamp: Date; exitTimestamp: Date; signalType: StrategySignal.BUY_CE | StrategySignal.BUY_PE; instrumentKey: string; tradingSymbol: string; quantity: number; entryPremium: number; exitPremium: number; entryValue: number; grossPnl: number; totalCharges: number; netPnl: number; }
interface Resolution { resolved: ResolvedTrade[]; unavailable: ReadonlySet<string>; ambiguous: ReadonlySet<string>; }
interface DirectionMetrics { trades: number; pnl: number; winRate: number; }
interface Metrics { name: string; generatedSignals: number; filteredSignals: number; eligibleTrades: number; unavailable: number; ambiguous: number; executedTrades: number; wins: number; losses: number; winRate: number; grossPnl: number; totalCharges: number; netPnl: number; averageNetPnl: number; medianNetPnl: number; finalCapital: number; returnPercent: number; maximumDrawdownAmount: number; maximumDrawdownPercent: number; averageWinner: number; averageLoser: number; profitFactor: number | null; largestWinner: number; largestLoser: number; buyCe: DirectionMetrics; buyPe: DirectionMetrics; }

function market(timestamp: Date): { date: string; minute: number } { const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value])); return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }; }
function signalKey(signal: Pick<Signal, 'timestamp' | 'signal'>): string { return `${signal.timestamp.getTime()}|${signal.signal}`; }
function tradeKey(timestamp: Date, instrumentKey: string): string { return `${timestamp.getTime()}|${instrumentKey}`; }
function money(value: number): string { return `Rs ${value.toFixed(2)}`; }
function percent(value: number): string { return `${value.toFixed(2)}%`; }
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: readonly number[]): number { if (values.length === 0) return 0; const sorted = [...values].sort((left, right) => left - right); const index = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[index - 1] + sorted[index]) / 2 : sorted[index]; }

function complete(candles: readonly StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = market(sorted[0].candleTime); const last = market(sorted[sorted.length - 1].candleTime);
  return first.minute === sessionStartMinute && last.minute === sessionEndMinute && sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}

function candles(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap((session) => session.candles).sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime()).map((candle) => {
    const volume = Number(candle.volume); const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
    if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
    return { timestamp: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
  });
}

function value(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const result = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period)?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime());
  return result && 'value' in result && typeof result.value === 'number' ? result.value : undefined;
}

function signals(validationSessions: readonly CompleteSession[]): Signal[] {
  // This calculation receives only the frozen validation sessions: no earlier
  // performance output or validation result can influence its fixed parameters.
  const oneMinute = candles(validationSessions);
  const spot = new Map(oneMinute.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinute = new CandleTimeframeAggregatorService().aggregate(oneMinute, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinute, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }] });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const output: Signal[] = [];
  fiveMinute.forEach((candle, index) => {
    const previous = fiveMinute[index - 1]; if (!previous) return;
    const previousFast = value(indicators, IndicatorType.EMA, 15, previous.timestamp); const currentFast = value(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = value(indicators, IndicatorType.EMA, 35, previous.timestamp); const currentSlow = value(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = value(indicators, IndicatorType.RSI, 14, candle.timestamp); const spotPrice = spot.get(candle.timestamp.getTime());
    if ([previousFast, currentFast, previousSlow, currentSlow, rsi, spotPrice].some((entry) => entry === undefined)) return;
    const crossover = strategy.evaluate({
      fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: previousFast as number }, { timestamp: candle.timestamp, value: currentFast as number }] } as EmaResult,
      slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: previousSlow as number }, { timestamp: candle.timestamp, value: currentSlow as number }] } as EmaResult,
    });
    if ((crossover.signal === StrategySignal.BUY_CE && (rsi as number) > 55) || (crossover.signal === StrategySignal.BUY_PE && (rsi as number) < 45)) {
      if (crossover.signal === StrategySignal.BUY_CE || crossover.signal === StrategySignal.BUY_PE) output.push({ timestamp: candle.timestamp, signal: crossover.signal, spotPrice: spotPrice as number });
    }
  });
  return output;
}

function nearestExpiry(expiries: readonly string[], date: string): string { const expiry = expiries.filter((entry) => entry >= date).sort((left, right) => left.localeCompare(right))[0]; if (!expiry) throw new Error(`No expiry exists on or after ${date}.`); return expiry; }
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> { const current = cache.get(key); if (current) return current; const created = load(); cache.set(key, created); return created; }

async function resolve(accessToken: string, source: readonly Signal[]): Promise<Resolution> {
  const optionClient = new UpstoxExpiredOptionClient(accessToken); const candleClient = new UpstoxExpiredOptionCandleClient(accessToken); const selector = new OptionContractSelectorService(); const exitEvaluator = new OptionExitPolicyEvaluatorService(); const instruments = new InstrumentRepository();
  const expiryCache = new Map<string, Promise<string[]>>(); const contractCache = new Map<string, Promise<OptionContract[]>>(); const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>(); const resolved: ResolvedTrade[] = []; const unavailable = new Set<string>(); const ambiguous = new Set<string>();
  for (const signal of source) try {
    const date = market(signal.timestamp).date;
    const expiries = await cached(expiryCache, underlyingInstrumentKey, () => optionClient.fetchAvailableExpiries(underlyingInstrumentKey));
    const expiry = nearestExpiry(expiries, date);
    const contracts = await cached(contractCache, `${underlyingInstrumentKey}|${expiry}`, () => optionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry));
    const underlying = contracts[0]?.underlying; if (!underlying) throw new Error('Missing expired-contract underlying.');
    const selection = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
    const contract = contracts.find((entry) => entry.instrumentKey === selection.instrumentKey); if (!contract) throw new Error('Selected option contract is missing.');
    const local = contract.lotSize === undefined ? await instruments.findByInstrumentKey(contract.instrumentKey) : null;
    const lotSize = contract.lotSize ?? local?.lotSize; if (!Number.isInteger(lotSize) || (lotSize as number) <= 0) throw new Error('No valid historical lot size.');
    const optionCandles = await cached(candleCache, `${contract.instrumentKey}|${date}`, () => candleClient.fetchCandles(contract.instrumentKey, date, date));
    const entry = optionCandles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime()); if (!entry) throw new Error('No aligned option entry candle.');
    const exit = exitEvaluator.evaluate({ signalTimestamp: signal.timestamp, entryPremium: entry.close, candles: optionCandles, exitPolicy });
    if (exit.ambiguous) { ambiguous.add(signalKey(signal)); continue; }
    if (exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null) { unavailable.add(signalKey(signal)); continue; }
    resolved.push({ ...signal, contract, lotSize: lotSize as number, entryPremium: entry.close, exit });
  } catch { unavailable.add(signalKey(signal)); }
  return { resolved, unavailable, ambiguous };
}

function candidates(trades: readonly ResolvedTrade[]): Candidate[] {
  const slippage = new OptionSlippageCalculatorService(); const chargeCalculator = new HistoricalOptionChargesCalculatorService(); const pnlCalculator = new OptionTradePnlCalculatorService();
  return trades.map((trade) => {
    const adjusted = slippage.calculate({ entryPremium: trade.entryPremium, exitPremium: trade.exit.exitPremium as number, slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 } });
    const charges = chargeCalculator.calculate({ tradeDate: trade.timestamp, entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, quantity: trade.lotSize, statutoryRateConfiguration: getHistoricalOptionStatutoryChargeRateConfig(trade.timestamp), brokerageConfiguration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD });
    const pnl = pnlCalculator.calculate({ entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, quantity: trade.lotSize, charges });
    return { key: tradeKey(trade.timestamp, trade.contract.instrumentKey), signalTimestamp: trade.timestamp, exitTimestamp: trade.exit.exitTimestamp as Date, signalType: trade.signal, instrumentKey: trade.contract.instrumentKey, tradingSymbol: trade.contract.tradingSymbol, quantity: trade.lotSize, entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, entryValue: pnl.entryValue, grossPnl: pnl.grossPnl, totalCharges: pnl.totalCharges, netPnl: pnl.netPnl };
  });
}

function direction(candidates: readonly Candidate[], type: StrategySignal.BUY_CE | StrategySignal.BUY_PE): DirectionMetrics { const selected = candidates.filter((candidate) => candidate.signalType === type); const wins = selected.filter((candidate) => candidate.netPnl > 0).length; return { trades: selected.length, pnl: selected.reduce((sum, candidate) => sum + candidate.netPnl, 0), winRate: selected.length === 0 ? 0 : wins / selected.length * 100 }; }

function calculate(name: string, source: readonly Signal[], accepted: readonly Signal[], resolution: Resolution, allCandidates: readonly Candidate[]): Metrics {
  const acceptedKeys = new Set(accepted.map(signalKey));
  const validTrades = resolution.resolved.filter((trade) => acceptedKeys.has(signalKey(trade)));
  const validKeys = new Set(validTrades.map((trade) => tradeKey(trade.timestamp, trade.contract.instrumentKey)));
  const selected = allCandidates.filter((candidate) => validKeys.has(candidate.key));
  const capital = new OptionCapitalSimulatorService().simulate({ initialCapital, trades: selected });
  const executedKeys = new Set(capital.trades.filter((trade) => trade.executed).map((trade) => tradeKey(trade.signalTimestamp, trade.instrumentKey)));
  const executed = selected.filter((candidate) => executedKeys.has(candidate.key));
  const positive = executed.filter((candidate) => candidate.netPnl > 0); const negative = executed.filter((candidate) => candidate.netPnl < 0); const net = executed.map((candidate) => candidate.netPnl);
  const profit = positive.reduce((sum, candidate) => sum + candidate.netPnl, 0); const loss = negative.reduce((sum, candidate) => sum + candidate.netPnl, 0);
  return { name, generatedSignals: source.length, filteredSignals: source.length - accepted.length, eligibleTrades: selected.length, unavailable: accepted.filter((signal) => resolution.unavailable.has(signalKey(signal))).length, ambiguous: accepted.filter((signal) => resolution.ambiguous.has(signalKey(signal))).length, executedTrades: executed.length, wins: positive.length, losses: negative.length, winRate: executed.length === 0 ? 0 : positive.length / executed.length * 100, grossPnl: executed.reduce((sum, candidate) => sum + candidate.grossPnl, 0), totalCharges: executed.reduce((sum, candidate) => sum + candidate.totalCharges, 0), netPnl: capital.totalNetPnl, averageNetPnl: average(net), medianNetPnl: median(net), finalCapital: capital.finalCapital, returnPercent: capital.returnPercent, maximumDrawdownAmount: capital.maximumDrawdownAmount, maximumDrawdownPercent: capital.maximumDrawdownPercent, averageWinner: average(positive.map((candidate) => candidate.netPnl)), averageLoser: average(negative.map((candidate) => candidate.netPnl)), profitFactor: loss === 0 ? (profit > 0 ? null : 0) : profit / Math.abs(loss), largestWinner: positive.length === 0 ? 0 : Math.max(...positive.map((candidate) => candidate.netPnl)), largestLoser: negative.length === 0 ? 0 : Math.min(...negative.map((candidate) => candidate.netPnl)), buyCe: direction(executed, StrategySignal.BUY_CE), buyPe: direction(executed, StrategySignal.BUY_PE) };
}

function printMetrics(metrics: Metrics): void {
  const factor = metrics.profitFactor === null ? 'N/A (no losses)' : metrics.profitFactor.toFixed(2);
  console.log(`\n${metrics.name}`);
  console.log(`Signals: generated=${metrics.generatedSignals}; filtered=${metrics.filteredSignals}; eligibleOptionTrades=${metrics.eligibleTrades}; unavailable=${metrics.unavailable}; ambiguous=${metrics.ambiguous}`);
  console.log(`Execution: executed=${metrics.executedTrades}; wins=${metrics.wins}; losses=${metrics.losses}; winRate=${percent(metrics.winRate)}`);
  console.log(`Performance: gross=${money(metrics.grossPnl)}; charges=${money(metrics.totalCharges)}; net=${money(metrics.netPnl)}; avgNet=${money(metrics.averageNetPnl)}; medianNet=${money(metrics.medianNetPnl)}`);
  console.log(`Capital: initial=${money(initialCapital)}; final=${money(metrics.finalCapital)}; return=${percent(metrics.returnPercent)}; maxDD=${money(metrics.maximumDrawdownAmount)} (${percent(metrics.maximumDrawdownPercent)})`);
  console.log(`Trade quality: avgWinner=${money(metrics.averageWinner)}; avgLoser=${money(metrics.averageLoser)}; profitFactor=${factor}; largestWinner=${money(metrics.largestWinner)}; largestLoser=${money(metrics.largestLoser)}`);
  console.log(`BUY_CE: trades=${metrics.buyCe.trades}; pnl=${money(metrics.buyCe.pnl)}; winRate=${percent(metrics.buyCe.winRate)} | BUY_PE: trades=${metrics.buyPe.trades}; pnl=${money(metrics.buyPe.pnl)}; winRate=${percent(metrics.buyPe.winRate)}`);
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting final out-of-sample option validation', { underlyingInstrumentKey, researchSessionCount, validationSessionCount });
  const rows = await new HistoricalCandleRepository().findByInstrumentAndTimeframe(underlyingInstrumentKey, '1minute');
  const grouped = new Map<string, StoredCandle[]>(); rows.forEach((row) => { const date = market(row.candleTime).date; grouped.set(date, [...(grouped.get(date) ?? []), row]); });
  const sessions = Array.from(grouped.entries()).filter(([, sessionCandles]) => complete(sessionCandles)).map(([date, sessionCandles]) => ({ date, candles: sessionCandles })).sort((left, right) => left.date.localeCompare(right.date));
  if (sessions.length !== expectedSessionCount) throw new Error(`Expected ${expectedSessionCount} complete sessions, found ${sessions.length}.`);
  const research = sessions.slice(0, researchSessionCount); const validation = sessions.slice(researchSessionCount);
  if (validation.length !== validationSessionCount) throw new Error(`Expected ${validationSessionCount} final validation sessions, found ${validation.length}.`);
  console.log(`Frozen split: research/history=${research[0].date} to ${research[research.length - 1].date} (${research.length} sessions); FINAL OUT-OF-SAMPLE=${validation[0].date} to ${validation[validation.length - 1].date} (${validation.length} sessions).`);
  const generated = signals(validation);
  const candidateSignals = generated.filter((signal) => { const minute = market(signal.timestamp).minute; return (minute >= 555 && minute < 630) || (minute >= 720 && minute < 930); });
  const resolution = await resolve(accessToken, generated);
  const allCandidates = candidates(resolution.resolved);
  const baseline = calculate('A. BASELINE — ALL DAY', generated, generated, resolution, allCandidates);
  const candidate = calculate('B. RESEARCH CANDIDATE — EXCLUDE 10:30-12:00', generated, candidateSignals, resolution, allCandidates);
  printMetrics(baseline); printMetrics(candidate);
  console.log('\nCandidate vs baseline deltas');
  console.log(`Trade count: ${candidate.executedTrades - baseline.executedTrades}; win rate: ${percent(candidate.winRate - baseline.winRate)}; net P&L: ${money(candidate.netPnl - baseline.netPnl)}; return: ${percent(candidate.returnPercent - baseline.returnPercent)}; max DD: ${percent(candidate.maximumDrawdownPercent - baseline.maximumDrawdownPercent)}; profit factor: ${candidate.profitFactor === null || baseline.profitFactor === null ? 'N/A' : (candidate.profitFactor - baseline.profitFactor).toFixed(2)}`);
  const classification = candidate.netPnl > baseline.netPnl && candidate.maximumDrawdownPercent < baseline.maximumDrawdownPercent ? 'VALIDATION IMPROVED' : (candidate.netPnl > baseline.netPnl || candidate.maximumDrawdownPercent < baseline.maximumDrawdownPercent ? 'VALIDATION MIXED' : 'VALIDATION WORSE');
  console.log(`\n${classification}`);
  console.log('This final out-of-sample result does not make either configuration production-ready and must not be used for retuning.');
  logger.info('Final out-of-sample option validation completed', { generatedSignals: generated.length, baselineTrades: baseline.executedTrades, candidateTrades: candidate.executedTrades, classification });
}

run().catch((error) => { const message = error instanceof Error ? error.message : 'Unknown error'; logger.error('Final out-of-sample option validation failed', { message }); console.error('Final out-of-sample option validation failed.', message); process.exitCode = 1; });
