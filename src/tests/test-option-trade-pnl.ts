import dotenv from 'dotenv';
import axios from 'axios';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import { EmaResult } from '../modules/indicators/indicators/ema.indicator';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService, { IndicatorEngineResult } from '../modules/indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../modules/indicators/types';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import UpstoxOptionChargesClient from '../modules/options/client/upstox-option-charges.client';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult } from '../modules/options/dto/option-exit-policy.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import OptionExitPolicyEvaluatorService from '../modules/options/services/option-exit-policy-evaluator.service';
import OptionRoundTripChargesService from '../modules/options/services/option-round-trip-charges.service';
import OptionTradePnlCalculatorService from '../modules/options/services/option-trade-pnl-calculator.service';
import { OptionContractSelectionResult, OptionContract } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../modules/strategies/strategies/ema-cross.strategy';

dotenv.config();

const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const sourceTimeframe = '1minute';
const expectedOneMinuteCandleCount = 375;
const marketSessionStartMinute = 9 * 60 + 15;
const marketSessionEndMinute = 15 * 60 + 29;
const optionProduct = 'I';
const expiredOptionContractsUrl = 'https://api.upstox.com/v2/expired-instruments/option/contract';
const marketTimeFormatter = new Intl.DateTimeFormat('en-CA', {
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

type CompleteSession = [date: string, candles: StoredCandle[]];

interface StrategySignalRecord {
  timestamp: Date;
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
  spotPrice: number;
}

interface HistoricalTradeCandidate {
  signal: StrategySignalRecord;
  contract: OptionContractSelectionResult;
  lotSize: number;
  optionCandles: ExpiredOptionCandleDto[];
  exit: OptionExitPolicyEvaluationResult;
}

function getMarketDateAndMinute(timestamp: Date): { date: string; minuteOfDay: number } {
  const values = Object.fromEntries(
    marketTimeFormatter.formatToParts(timestamp).map((part) => [part.type, part.value])
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isCompleteTradingDay(candles: StoredCandle[]): boolean {
  if (candles.length !== expectedOneMinuteCandleCount) return false;
  const sorted = [...candles].sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());
  const first = getMarketDateAndMinute(sorted[0].candleTime);
  const last = getMarketDateAndMinute(sorted[sorted.length - 1].candleTime);
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

function getScalar(results: IndicatorEngineResult, type: IndicatorType, period: number, timestamp: Date): number | undefined {
  const indicator = results.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period);
  const value = indicator?.result.values.find((entry) => entry.timestamp.getTime() === timestamp.getTime());
  return value && 'value' in value && typeof value.value === 'number' ? value.value : undefined;
}

function generateSignals(sessions: readonly CompleteSession[]): StrategySignalRecord[] {
  const oneMinuteCandles = toInternalCandles(sessions);
  const spotByTimestamp = new Map(oneMinuteCandles.map((candle) => [candle.timestamp.getTime(), candle.close]));
  const fiveMinuteCandles = new CandleTimeframeAggregatorService().aggregate(oneMinuteCandles, '5m');
  const indicators = new IndicatorEngineService().calculate(fiveMinuteCandles, {
    indicators: [{ type: IndicatorType.EMA, period: 15 }, { type: IndicatorType.EMA, period: 35 }, { type: IndicatorType.RSI, period: 14 }],
  });
  const strategy = new EmaCrossStrategy({ fastPeriod: 15, slowPeriod: 35 });
  const signals: StrategySignalRecord[] = [];

  fiveMinuteCandles.forEach((candle, index) => {
    const previous = fiveMinuteCandles[index - 1];
    if (!previous) return;
    const previousFast = getScalar(indicators, IndicatorType.EMA, 15, previous.timestamp);
    const currentFast = getScalar(indicators, IndicatorType.EMA, 15, candle.timestamp);
    const previousSlow = getScalar(indicators, IndicatorType.EMA, 35, previous.timestamp);
    const currentSlow = getScalar(indicators, IndicatorType.EMA, 35, candle.timestamp);
    const rsi = getScalar(indicators, IndicatorType.RSI, 14, candle.timestamp);
    const spotPrice = spotByTimestamp.get(candle.timestamp.getTime());
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

function getExpiryForDate(expiries: readonly string[], date: string): string {
  const expiry = expiries.filter((candidate) => candidate >= date).sort((left, right) => left.localeCompare(right))[0];
  if (!expiry) throw new Error(`No expired option expiry is available on or after ${date}.`);
  return expiry;
}

function hasCompleteSixtyMinuteCoverage(candles: readonly ExpiredOptionCandleDto[], signalTimestamp: Date): boolean {
  const signalDate = getMarketDateAndMinute(signalTimestamp).date;
  const candleTimes = new Set(
    candles
      .filter((candle) => getMarketDateAndMinute(candle.candleTime).date === signalDate)
      .map((candle) => candle.candleTime.getTime())
  );
  return Array.from({ length: 61 }, (_, minute) => signalTimestamp.getTime() + minute * 60_000)
    .every((timestamp) => candleTimes.has(timestamp));
}

async function findCandidate(
  signals: readonly StrategySignalRecord[],
  expiredOptionClient: UpstoxExpiredOptionClient,
  expiredCandleClient: UpstoxExpiredOptionCandleClient,
  accessToken: string
): Promise<HistoricalTradeCandidate> {
  const selector = new OptionContractSelectorService();
  const exitEvaluator = new OptionExitPolicyEvaluatorService();
  const expiries = await expiredOptionClient.fetchAvailableExpiries(underlyingInstrumentKey);
  const contractsCache = new Map<string, Promise<OptionContract[]>>();
  const candleCache = new Map<string, Promise<ExpiredOptionCandleDto[]>>();
  const lotSizeCache = new Map<string, Promise<number>>();

  for (const signal of signals) {
    try {
      const date = getMarketDateAndMinute(signal.timestamp).date;
      const expiry = getExpiryForDate(expiries, date);
      const contracts = await getOrCreate(contractsCache, expiry, () =>
        expiredOptionClient.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry)
      );
      const underlying = contracts[0]?.underlying;
      if (!underlying) continue;
      const contract = selector.select({ underlying, spotPrice: signal.spotPrice, signal: signal.signal, timestamp: signal.timestamp, contracts });
      const lotSize = await getOrCreate(lotSizeCache, `${expiry}|${contract.instrumentKey}`, () =>
        fetchLotSizeFromContractMetadata(accessToken, expiry, contract.instrumentKey)
      );
      const optionCandles = await getOrCreate(candleCache, `${contract.instrumentKey}|${date}`, () =>
        expiredCandleClient.fetchCandles(contract.instrumentKey, date, date)
      );
      if (!hasCompleteSixtyMinuteCoverage(optionCandles, signal.timestamp)) continue;
      const entryCandle = optionCandles.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
      if (!entryCandle) continue;
      const exit = exitEvaluator.evaluate({
        signalTimestamp: signal.timestamp,
        entryPremium: entryCandle.close,
        candles: optionCandles,
        exitPolicy: { type: 'TARGET_STOP', targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 },
      });
      if (exit.ambiguous || exit.unavailable || exit.exitPremium === null || exit.exitTimestamp === null) continue;

      return { signal, contract, lotSize, optionCandles, exit };
    } catch {
      // This test searches for one fully resolvable historical validation trade.
    }
  }

  throw new Error('No baseline signal resolved to an option contract with lot metadata, 60-minute coverage, and a non-ambiguous exit.');
}

async function fetchLotSizeFromContractMetadata(
  accessToken: string,
  expiryDate: string,
  instrumentKey: string
): Promise<number> {
  const url = `${expiredOptionContractsUrl}?${new URLSearchParams({
    instrument_key: underlyingInstrumentKey,
    expiry_date: expiryDate,
  }).toString()}`;
  const response = await axios.get<unknown>(url, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    timeout: 10_000,
  });
  if (!response.data || typeof response.data !== 'object') {
    throw new Error('Expired option contract metadata response is invalid.');
  }
  const payload = response.data as { status?: unknown; data?: unknown };
  if (payload.status !== 'success' || !Array.isArray(payload.data)) {
    throw new Error('Expired option contract metadata response was not successful.');
  }
  const contract = payload.data.find((item): item is { instrument_key: unknown; lot_size: unknown } =>
    Boolean(item) && typeof item === 'object' && (item as { instrument_key?: unknown }).instrument_key === instrumentKey
  );
  if (
    !contract ||
    typeof contract.lot_size !== 'number' ||
    !Number.isInteger(contract.lot_size) ||
    contract.lot_size <= 0
  ) {
    throw new Error(`Lot size is unavailable for selected expired option contract ${instrumentKey}.`);
  }
  return contract.lot_size;
}

function getOrCreate<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const value = create();
  cache.set(key, value);
  return value;
}

function money(value: number): string {
  return value.toFixed(2);
}

function toBrokerageInstrumentToken(expiredInstrumentKey: string): string {
  const [segment, exchangeToken] = expiredInstrumentKey.split('|');
  if (!segment || !exchangeToken) {
    throw new Error(`Cannot derive a brokerage instrument token from ${expiredInstrumentKey}.`);
  }
  return `${segment}|${exchangeToken}`;
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  logger.info('Starting historical option trade P&L integration test', { underlyingInstrumentKey });

  const historicalRepository = new HistoricalCandleRepository();
  const storedCandles = await historicalRepository.findByInstrumentAndTimeframe(underlyingInstrumentKey, sourceTimeframe);
  const grouped = new Map<string, StoredCandle[]>();
  storedCandles.forEach((candle) => {
    const date = getMarketDateAndMinute(candle.candleTime).date;
    grouped.set(date, [...(grouped.get(date) ?? []), candle]);
  });
  const sessions = Array.from(grouped.entries()).filter(([, candles]) => isCompleteTradingDay(candles))
    .sort(([left], [right]) => left.localeCompare(right)) as CompleteSession[];
  if (sessions.length === 0) throw new Error('No complete NIFTY sessions are available for historical option trade P&L validation.');

  const signals = generateSignals(sessions);
  if (signals.length === 0) throw new Error('The EMA15/35 + RSI55/45 baseline produced no historical signals.');
  const expiredOptionClient = new UpstoxExpiredOptionClient(accessToken);
  const expiredCandleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const candidate = await findCandidate(signals, expiredOptionClient, expiredCandleClient, accessToken);
  const entryPremium = candidate.optionCandles.find((candle) => candle.candleTime.getTime() === candidate.signal.timestamp.getTime())?.close;
  if (entryPremium === undefined || candidate.exit.exitPremium === null || candidate.exit.exitTimestamp === null || candidate.exit.holdingMinutes === null) {
    throw new Error('The selected historical option trade does not contain complete execution prices.');
  }

  let roundTripCharges;
  const brokerageInstrumentToken = toBrokerageInstrumentToken(candidate.contract.instrumentKey);
  try {
    roundTripCharges = await new OptionRoundTripChargesService(new UpstoxOptionChargesClient(accessToken)).calculate({
      instrumentKey: brokerageInstrumentToken,
      quantity: candidate.lotSize,
      product: optionProduct,
      entryPrice: entryPremium,
      exitPrice: candidate.exit.exitPremium,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(
      `Upstox Brokerage Details cannot quote charges for expired historical option ${candidate.contract.instrumentKey} (brokerage token ${brokerageInstrumentToken}): ${errorMessage}. Actual historical charges cannot be calculated from this live quote endpoint.`
    );
  }
  const pnl = new OptionTradePnlCalculatorService().calculate({
    entryPremium,
    exitPremium: candidate.exit.exitPremium,
    quantity: candidate.lotSize,
    charges: roundTripCharges.combinedCharges,
  });

  console.log('\nHistorical Option Trade P&L Validation');
  console.log(`Signal: ${candidate.signal.timestamp.toISOString()} | ${candidate.signal.signal} | NIFTY spot=${money(candidate.signal.spotPrice)}`);
  console.log(`Contract: ${candidate.contract.tradingSymbol} | ${candidate.contract.instrumentKey} | expiry=${candidate.contract.expiry.toISOString().slice(0, 10)} | strike=${candidate.contract.strikePrice} | type=${candidate.contract.optionType} | lotSize=${candidate.lotSize} | quantity=${candidate.lotSize}`);
  console.log(`Brokerage instrument token: ${brokerageInstrumentToken}`);
  console.log(`Execution: entry=${money(entryPremium)} | exit=${money(candidate.exit.exitPremium)} | exitTimestamp=${candidate.exit.exitTimestamp.toISOString()} | reason=${candidate.exit.exitReason} | holdingMinutes=${candidate.exit.holdingMinutes}`);
  console.log(`Gross: entryValue=${money(pnl.entryValue)} | exitValue=${money(pnl.exitValue)} | grossPnl=${money(pnl.grossPnl)} | grossReturn=${money(pnl.grossReturnPercent)}%`);
  console.log(`Entry charges: ${JSON.stringify(candidateChargeSummary(roundTripCharges.entryCharges))}`);
  console.log(`Exit charges: ${JSON.stringify(candidateChargeSummary(roundTripCharges.exitCharges))}`);
  console.log(`Charges: brokerage=${money(roundTripCharges.combinedCharges.brokerage)} | stt=${money(roundTripCharges.combinedCharges.stt)} | exchangeTransactionCharges=${money(roundTripCharges.combinedCharges.exchangeTransactionCharges)} | sebiCharges=${money(roundTripCharges.combinedCharges.sebiCharges)} | gst=${money(roundTripCharges.combinedCharges.gst)} | stampDuty=${money(roundTripCharges.combinedCharges.stampDuty)} | otherCharges=${money(roundTripCharges.combinedCharges.otherCharges)} | mappedTotal=${money(roundTripCharges.totalCharges)} | brokerReportedCombined=${money(roundTripCharges.combinedReportedTotal)} | reconciliationDifference=${money(roundTripCharges.reconciliationDifference)}`);
  console.log(`Net: netPnl=${money(pnl.netPnl)} | netReturn=${money(pnl.netReturnPercent)}%`);
  logger.info('Historical option trade P&L integration test completed', { instrumentKey: candidate.contract.instrumentKey, exitReason: candidate.exit.exitReason, netPnl: pnl.netPnl });
}

function candidateChargeSummary(charges: { brokerage: number; stt: number; exchangeTransactionCharges: number; sebiCharges: number; gst: number; stampDuty: number; otherCharges: number; reportedTotalCharges: number }): Record<string, number> {
  return {
    brokerage: charges.brokerage,
    stt: charges.stt,
    exchangeTransactionCharges: charges.exchangeTransactionCharges,
    sebiCharges: charges.sebiCharges,
    gst: charges.gst,
    stampDuty: charges.stampDuty,
    otherCharges: charges.otherCharges,
    reportedTotalCharges: charges.reportedTotalCharges,
  };
}

run().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  logger.error('Historical option trade P&L integration test failed', { errorMessage });
  console.error('Historical option trade P&L integration test failed.', errorMessage);
  process.exitCode = 1;
});
