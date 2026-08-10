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
import { OptionRiskControlConfiguration, OptionRiskControlTradeInput } from '../modules/options/dto/option-risk-control-simulation.dto';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import HistoricalOptionChargesCalculatorService from '../modules/options/services/historical-option-charges-calculator.service';
import OptionCapitalSimulatorService from '../modules/options/services/option-capital-simulator.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import OptionRiskControlSimulatorService from '../modules/options/services/option-risk-control-simulator.service';
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
interface Profile { id: string; label: string; configuration: OptionRiskControlConfiguration; }
interface Candidate extends OptionCapitalSimulationTradeInput { key: string; }
interface ProfileResult { profile: Profile; accepted: Candidate[]; rejected: Candidate[]; capital: ReturnType<OptionCapitalSimulatorService['simulate']>; dailyPnl: number[]; }
type CompleteSession = [date: string, candles: StoredCandle[]];

const profiles: readonly Profile[] = [
  { id: 'PROFILE 0', label: 'NO RISK CONTROLS', configuration: {} },
  { id: 'PROFILE A', label: 'CONSERVATIVE', configuration: { maxDailyLossAmount: 3000, maxTradesPerDay: 3, maxConsecutiveLosses: 2, coolOffMinutesAfterLoss: 30, maxSimultaneousPositions: 1 } },
  { id: 'PROFILE B', label: 'MODERATE', configuration: { maxDailyLossAmount: 5000, maxTradesPerDay: 5, maxConsecutiveLosses: 3, coolOffMinutesAfterLoss: 15, maxSimultaneousPositions: 2 } },
  { id: 'PROFILE C', label: 'PROFIT LOCK', configuration: { maxDailyLossAmount: 5000, maxTradesPerDay: 5, maxConsecutiveLosses: 3, coolOffMinutesAfterLoss: 15, maxSimultaneousPositions: 2, dailyProfitLockAmount: 4000 } },
];

function market(timestamp: Date): { date: string; minute: number } { const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value])); return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }; }
function money(value: number): string { return `₹${value.toFixed(2)}`; }
function percent(value: number): string { return `${value.toFixed(2)}%`; }
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: readonly number[]): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]; }
function keyOf(timestamp: Date, instrumentKey: string): string { return `${timestamp.getTime()}|${instrumentKey}`; }

function complete(candles: readonly StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime()); const first = market(sorted[0].candleTime); const last = market(sorted[sorted.length - 1].candleTime);
  return first.minute === sessionStartMinute && last.minute === sessionEndMinute && sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() - sorted[index - 1].candleTime.getTime() === 60_000);
}
function internal(sessions: readonly CompleteSession[]): Candle[] {
  return sessions.flatMap(([, candles]) => candles).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime()).map((candle) => {
    const volume = Number(candle.volume); const openInterest = candle.openInterest === null ? undefined : Number(candle.openInterest);
    if (!Number.isSafeInteger(volume) || (openInterest !== undefined && !Number.isSafeInteger(openInterest))) throw new Error('Stored candle volume or open interest exceeds JavaScript safe-integer precision.');
    return { timestamp: candle.candleTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume, openInterest };
  });
}
function scalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined { const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period); const value = indicator?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime()); return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined; }
function expiry(expiries: readonly string[], date: string): string { const value = expiries.filter((entry) => entry >= date).sort((a, b) => a.localeCompare(b))[0]; if (!value) throw new Error(`No expired option expiry is available on or after ${date}.`); return value; }
function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> { const found = cache.get(key); if (found) return found; const value = create(); cache.set(key, value); return value; }

async function signals(): Promise<Signal[]> {
  const byDate = new Map<string, StoredCandle[]>();
  (await new HistoricalCandleRepository().findByInstrumentAndTimeframe(underlyingInstrumentKey, '1minute')).forEach((candle) => { const date = market(candle.candleTime).date; byDate.set(date, [...(byDate.get(date) ?? []), candle]); });
  const sessions = Array.from(byDate.entries()).filter(([, candles]) => complete(candles)).sort(([a], [b]) => a.localeCompare(b)) as CompleteSession[];
  if (sessions.length === 0) throw new Error('No complete NIFTY sessions are available for risk-profile research.');
  const oneMinute = internal(sessions); const spots = new Map(oneMinute.map((candle) => [candle.timestamp.getTime(), candle.close])); const fiveMinute = new CandleTimeframeAggregatorService().aggregate(oneMinute, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinute, { indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }] }); const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 }); const result: Signal[] = [];
  fiveMinute.forEach((candle, index) => {
    const previous = fiveMinute[index - 1]; if (!previous) return; const prevFast = scalar(indicators, IndicatorType.EMA, 15, previous.timestamp); const nowFast = scalar(indicators, IndicatorType.EMA, 15, candle.timestamp); const prevSlow = scalar(indicators, IndicatorType.EMA, 35, previous.timestamp); const nowSlow = scalar(indicators, IndicatorType.EMA, 35, candle.timestamp); const rsi = scalar(indicators, IndicatorType.RSI, 14, candle.timestamp); const spot = spots.get(candle.timestamp.getTime());
    if ([prevFast, nowFast, prevSlow, nowSlow, rsi, spot].some((value) => value === undefined)) return;
    const cross = strategy.evaluate({ fastEma: { type: IndicatorType.EMA, period: 15, values: [{ timestamp: previous.timestamp, value: prevFast as number }, { timestamp: candle.timestamp, value: nowFast as number }] } as EmaResult, slowEma: { type: IndicatorType.EMA, period: 35, values: [{ timestamp: previous.timestamp, value: prevSlow as number }, { timestamp: candle.timestamp, value: nowSlow as number }] } as EmaResult });
    if ((cross.signal === StrategySignal.BUY_CE && (rsi as number) > 55) || (cross.signal === StrategySignal.BUY_PE && (rsi as number) < 45)) if (cross.signal === StrategySignal.BUY_CE || cross.signal === StrategySignal.BUY_PE) result.push({ timestamp: candle.timestamp, signal: cross.signal, spotPrice: spot as number });
  });
  return result;
}

async function resolve(accessToken: string, source: readonly Signal[]): Promise<{ trades: ResolvedTrade[]; unavailable: number; ambiguous: number }> {
  const optionClient = new UpstoxExpiredOptionClient(accessToken); const candleClient = new UpstoxExpiredOptionCandleClient(accessToken); const selector = new OptionContractSelectorService(); const exits = new OptionExitPolicyEvaluatorService(); const instruments = new InstrumentRepository();
  const expiryCache = new Map<string, Promise<string[]>>(); const contractsCache = new Map<string, Promise<OptionContract[]>>(); const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>(); const trades: ResolvedTrade[] = []; let unavailable = 0; let ambiguous = 0;
  for (const signal of source) try {
    const date = market(signal.timestamp).date; const expiries = await cached(expiryCache, underlyingInstrumentKey, () => optionClient.fetchAvailableExpiries(underlyingInstrumentKey)); const expiryDate = expiry(expiries, date); const contracts = await cached(contractsCache, `${underlyingInstrumentKey}|${expiryDate}`, () => optionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiryDate)); const underlying = contracts[0]?.underlying; if (!underlying) throw new Error('Missing underlying.');
    const selected = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts }); const contract = contracts.find((entry) => entry.instrumentKey === selected.instrumentKey); if (!contract) throw new Error('Missing selected contract.'); const local = contract.lotSize === undefined ? await instruments.findByInstrumentKey(contract.instrumentKey) : null; const lotSize = contract.lotSize ?? local?.lotSize; if (lotSize === undefined || !Number.isInteger(lotSize) || lotSize <= 0) throw new Error('Missing lot size.');
    const candles = await cached(candleCache, `${contract.instrumentKey}|${date}`, () => candleClient.fetchCandles(contract.instrumentKey, date, date)); const entry = candles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime()); if (!entry) throw new Error('Missing aligned candle.'); const exit = exits.evaluate({ signalTimestamp: signal.timestamp, entryPremium: entry.close, candles, exitPolicy });
    if (exit.ambiguous) { ambiguous += 1; } else if (exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null) { unavailable += 1; } else { trades.push({ ...signal, contract, lotSize, entryPremium: entry.close, exit }); }
  } catch { unavailable += 1; }
  return { trades, unavailable, ambiguous };
}

function buildCandidates(trades: readonly ResolvedTrade[]): Candidate[] {
  const slippage = new OptionSlippageCalculatorService(); const charges = new HistoricalOptionChargesCalculatorService(); const pnl = new OptionTradePnlCalculatorService();
  return trades.map((trade) => {
    const adjusted = slippage.calculate({ entryPremium: trade.entryPremium, exitPremium: trade.exit.exitPremium as number, slippage: { entrySlippagePercent: 1, exitSlippagePercent: 1 } }); const chargeBreakdown = charges.calculate({ tradeDate: trade.timestamp, entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, quantity: trade.lotSize, statutoryRateConfiguration: getHistoricalOptionStatutoryChargeRateConfig(trade.timestamp), brokerageConfiguration: HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD }); const outcome = pnl.calculate({ entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, quantity: trade.lotSize, charges: chargeBreakdown });
    return { key: keyOf(trade.timestamp, trade.contract.instrumentKey), signalTimestamp: trade.timestamp, exitTimestamp: trade.exit.exitTimestamp as Date, signalType: trade.signal, instrumentKey: trade.contract.instrumentKey, tradingSymbol: trade.contract.tradingSymbol, quantity: trade.lotSize, entryPremium: adjusted.adjustedEntryPremium, exitPremium: adjusted.adjustedExitPremium, entryValue: outcome.entryValue, totalCharges: outcome.totalCharges, netPnl: outcome.netPnl };
  });
}

function runProfile(profile: Profile, candidates: readonly Candidate[]): ProfileResult {
  const lookup = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const riskInput: OptionRiskControlTradeInput[] = candidates.map((candidate) => ({ signalTimestamp: candidate.signalTimestamp, exitTimestamp: candidate.exitTimestamp, netPnl: candidate.netPnl, instrumentKey: candidate.instrumentKey, tradingSymbol: candidate.tradingSymbol }));
  const risk = new OptionRiskControlSimulatorService().simulate({ trades: riskInput, configuration: profile.configuration });
  const accepted = risk.acceptedTrades.map((trade) => lookup.get(keyOf(trade.signalTimestamp, trade.instrumentKey)) as Candidate);
  const rejected = risk.rejectedTrades.map((trade) => lookup.get(keyOf(trade.signalTimestamp, trade.instrumentKey)) as Candidate);
  const capital = new OptionCapitalSimulatorService().simulate({ initialCapital, trades: accepted });
  return { profile, accepted, rejected, capital, dailyPnl: risk.dailySummaries.map((summary) => summary.realizedDailyPnl) };
}

function printProfile(result: ProfileResult): void {
  const { capital } = result; const executed = capital.trades.filter((trade) => trade.executed); const net = executed.map((trade) => trade.netPnl); const profitableDays = result.dailyPnl.filter((value) => value > 0).length; const losingDays = result.dailyPnl.filter((value) => value < 0).length;
  const risk = new OptionRiskControlSimulatorService().simulate({ trades: result.accepted.concat(result.rejected).map((trade) => ({ signalTimestamp: trade.signalTimestamp, exitTimestamp: trade.exitTimestamp, netPnl: trade.netPnl, instrumentKey: trade.instrumentKey, tradingSymbol: trade.tradingSymbol })), configuration: result.profile.configuration });
  console.log(`\n${result.profile.id} — ${result.profile.label}`);
  console.log(`Risk decisions: candidates=${risk.totalCandidates}; accepted=${risk.totalAccepted}; rejected=${risk.totalRejected}`);
  console.log(`Rejected reasons: dailyLoss=${risk.rejectionCounts.DAILY_LOSS_LIMIT}; dailyTradeCap=${risk.rejectionCounts.MAX_TRADES_PER_DAY}; consecutiveLoss=${risk.rejectionCounts.MAX_CONSECUTIVE_LOSSES}; coolOff=${risk.rejectionCounts.COOL_OFF_AFTER_LOSS}; simultaneous=${risk.rejectionCounts.MAX_SIMULTANEOUS_POSITIONS}; profitLock=${risk.rejectionCounts.DAILY_PROFIT_LOCK}`);
  console.log(`Performance: profitable=${capital.profitableTrades}; losing=${capital.losingTrades}; winRate=${percent(executed.length === 0 ? 0 : capital.profitableTrades / executed.length * 100)}; totalNet=${money(capital.totalNetPnl)}; avgNet=${money(average(net))}; medianNet=${money(median(net))}`);
  console.log(`Capital: initial=${money(capital.initialCapital)}; final=${money(capital.finalCapital)}; return=${percent(capital.returnPercent)}; maxDD=${money(capital.maximumDrawdownAmount)} (${percent(capital.maximumDrawdownPercent)}); maxPositions=${capital.maximumSimultaneousPositions}; minAvailable=${money(capital.minimumAvailableCash)}`);
  console.log(`Daily: best=${money(Math.max(...result.dailyPnl))}; worst=${money(Math.min(...result.dailyPnl))}; avg=${money(average(result.dailyPnl))}; profitableDays=${profitableDays}; losingDays=${losingDays}`);
}

async function run(): Promise<void> {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim(); if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting historical option risk-profile research', { underlyingInstrumentKey, initialCapital });
  const sourceSignals = await signals(); const dataset = await resolve(token, sourceSignals); if (dataset.trades.length === 0) throw new Error('No evaluated historical option trades are available.');
  const candidates = buildCandidates(dataset.trades); const results = profiles.map((profile) => runProfile(profile, candidates)); const baseline = results[0];
  console.log(`\nDataset: strategySignals=${sourceSignals.length}; eligibleTrades=${candidates.length}; unavailable=${dataset.unavailable}; ambiguousExcluded=${dataset.ambiguous}; fixedSlippage=1.00% entry/exit; brokerage=STANDARD`);
  results.forEach(printProfile);
  console.log('\nSide-by-side comparison'); console.log('Profile | Accepted | Rejected | Final capital | Return % | Win rate | Max DD % | Avg net/trade');
  results.forEach((result) => { const executed = result.capital.trades.filter((trade) => trade.executed); const net = executed.map((trade) => trade.netPnl); console.log(`${result.profile.id} | ${result.accepted.length} | ${result.rejected.length} | ${money(result.capital.finalCapital)} | ${percent(result.capital.returnPercent)} | ${percent(executed.length === 0 ? 0 : result.capital.profitableTrades / executed.length * 100)} | ${percent(result.capital.maximumDrawdownPercent)} | ${money(average(net))}`); });
  console.log('\nChange versus no-risk-control baseline');
  results.forEach((result) => console.log(`${result.profile.id}: returnReduction=${percent(baseline.capital.returnPercent - result.capital.returnPercent)}; drawdownImprovement=${money(baseline.capital.maximumDrawdownAmount - result.capital.maximumDrawdownAmount)}; tradesRemoved=${baseline.accepted.length - result.accepted.length}; pnlRemoved=${money(result.rejected.reduce((sum, trade) => sum + trade.netPnl, 0))}`));
  console.log('This comparison does not declare a production profile; it measures historical one-lot risk-control trade-offs only.');
  logger.info('Historical option risk-profile research completed', { signals: sourceSignals.length, candidates: candidates.length, unavailable: dataset.unavailable, ambiguous: dataset.ambiguous });
}

run().catch((error) => { const message = error instanceof Error ? error.message : 'Unknown error'; logger.error('Historical option risk-profile research failed', { message }); console.error('Historical option risk-profile research failed.', message); process.exitCode = 1; });
